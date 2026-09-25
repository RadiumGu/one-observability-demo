"""
workflows.py — 灾备切换的 Temporal workflow 定义。

## 这个 workflow 存在的理由

region 切换要几十分钟、跨多个需要人判断的点。放在一个进程里跑,进程死了
就断在中途,而且没有任何地方记得走到了第几步 —— 那是 `StrandsExecutor`
的形态。交给 Temporal 以后,进度在服务端,worker 重启能接着走。

## ⚠️ 两条从实测里来的硬约束

**① workflow 里不许做任何不确定的事。** Temporal 靠重放历史来恢复状态,
所以 workflow 函数必须是确定性的:不能直接调 AWS、不能 `time.time()`、
不能 `random`。所有副作用走 activity。这不是风格建议,违反了会在重放时
产生不一致而让 workflow 卡死。

**② 启动成功不等于在执行。** 实测(1.29.7):在**没有任何 worker** 的任务
队列上起 workflow 也会返回 `started: true` / `status: RUNNING`,那个执行
会一直挂着等一个不存在的 worker,直到保留期到点。所以发起方必须独立确认
有 worker 接单 —— 见 `executor_temporal.interpret_task_queue_pollers`。

## 决策点的设计

切换里有些步骤**不能由程序自己决定**。最尖锐的是数据库提升:

    有序切换(failover-global-cluster)        无数据丢失,但要求主集群还活着
    --allow-data-loss 变体                   主集群已失联时才用,会丢数据

「用哪个」取决于「主 region 到底是挂了还是只是不可达」—— 而这两者
**在指标上无法区分**,这正是本项目的核心立场。所以这里不猜:
workflow 停下来等一个 signal,由人给出裁决。

超时不放行:等不到 signal 就超时失败,而不是「超时了就按 allow-data-loss 走」。
自动选择丢数据的那条路是最坏的默认值。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

# activity 的导入必须放在 sandbox 豁免里 —— workflow 沙箱会拦截
# 带副作用的模块导入。这是 temporalio 的标准写法,不是绕过检查。
with workflow.unsafe.imports_passed_through():
    from activities import (
        ActivityInput,
        StepResult,
        fetch_plan_body,
        promote_database,
        scale_up_nodegroup,
        verify_step,
    )


# ── 决策点 ────────────────────────────────────────────────────────────────

#: 数据库提升方式的裁决。signal 只接受这两个值之一。
DECISION_ORDERED = "ordered"
DECISION_ALLOW_DATA_LOSS = "allow_data_loss"
DECISION_ABORT = "abort"

_VALID_DECISIONS = frozenset({DECISION_ORDERED, DECISION_ALLOW_DATA_LOSS, DECISION_ABORT})


@dataclass
class FailoverInput:
    """启动参数。

    ⚠️ 计划正文**不在这里**,只有引用。
    原因:本服务端 workflowExecutionRetentionTtl = 86400s(1 天,实测),
    而 payload 上限拿不到 —— describe_namespace 的 namespaceInfo 里没有
    limits 字段(实测推翻了我原先的假设)。所以正文另存,这里只放 S3 引用。
    """

    plan_ref: str
    dry_run: bool = True
    #: 等人给裁决的上限。等不到就失败,**不自动选择丢数据的那条路**。
    decision_timeout_seconds: int = 1800

    #: ── 按步骤放行 ────────────────────────────────────────────────────
    #:
    #: 只有名字出现在这里的步骤才会**真执行**,其余一律 dry_run ——
    #: 即使 `dry_run=False`。
    #:
    #: 2026-09-24 加的,动机是安全而不是灵活性:做「拉起节点组」的演练时,
    #: 若只有一个全局 `dry_run=False` 开关,同一次运行就会把
    #: `promote_database` 也真执行 —— 那是**切换生产数据库**。
    #: 一次节点组演练绝不该有能力做那件事。
    #:
    #: 所以放行是**按名字逐个给**的:要执行某一步,必须显式写出它的名字。
    #: 漏写的后果是「那一步没真跑」(安全),而不是「意外跑了」(危险)。
    execute_steps: list[str] = field(default_factory=list)


def _step_is_live(args: FailoverInput, step: str) -> bool:
    """这一步该真执行还是 dry_run。

    两个条件都满足才真执行:全局 `dry_run=False`,**并且**步骤名在
    `execute_steps` 里。两道闸门是刻意的 —— 单独任何一个被误设都不足以
    让危险步骤真跑。
    """
    return (not args.dry_run) and (step in args.execute_steps)


@dataclass
class FailoverResult:
    plan_ref: str
    dry_run: bool
    #: 这次放行了哪些步骤真执行。事后复盘要能看出「这是一次什么演练」。
    executed_steps: list[str] = field(default_factory=list)
    steps: list[StepResult] = field(default_factory=list)
    #: 人给的裁决。None 表示没走到那个点。
    database_decision: str | None = None
    aborted: bool = False


# ── activity 的重试与超时策略 ──────────────────────────────────────────────
#
# 读类 activity 可以放心重试。写类**默认只试一次** —— 一个已经把节点组
# 拉起来的调用重试第二遍未必幂等,而 DR 步骤的重试代价是真实的。
# 需要重试的写操作要自己在 activity 内部做幂等。

_READ_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=2),
    maximum_attempts=5,
)
_WRITE_RETRY = RetryPolicy(maximum_attempts=1)


@workflow.defn(name="DrFailoverWorkflow")
class DrFailoverWorkflow:
    """执行一份灾备计划。

    ⚠️ 当前阶段只跑 dry_run。写类 activity 里真正调 AWS 的部分尚未启用 ——
    worker 的实例角色目前只有 Describe 权限,见 infra/dr-korea/02-temporal.yaml。
    """

    def __init__(self) -> None:
        self._decision: str | None = None
        self._steps: list[StepResult] = []

    # ── signal:人给裁决 ──────────────────────────────────────────────────

    @workflow.signal(name="database_decision")
    def set_database_decision(self, decision: str) -> None:
        """人工裁决数据库提升方式。

        非法值**直接忽略并记日志**,不抛异常 —— signal handler 里抛异常会
        让 workflow task 失败并无限重试该 handler,把一次手滑变成卡死。
        """
        if decision not in _VALID_DECISIONS:
            workflow.logger.warning(
                "收到非法裁决 %r，已忽略。合法值：%s", decision, sorted(_VALID_DECISIONS)
            )
            return
        self._decision = decision

    @workflow.query(name="pending_decision")
    def pending_decision(self) -> dict[str, Any]:
        """让外部能查「现在卡在哪、等什么」,而不用翻历史。"""
        return {
            "waiting_for_database_decision": self._decision is None,
            "decision": self._decision,
            "steps_done": len(self._steps),
        }

    # ── 主流程 ────────────────────────────────────────────────────────────

    @workflow.run
    async def run(self, args: FailoverInput) -> FailoverResult:
        result = FailoverResult(
            plan_ref=args.plan_ref,
            dry_run=args.dry_run,
            executed_steps=list(args.execute_steps),
        )

        # ① 取计划正文。放在 activity 里是因为它要访问 S3 ——
        #    workflow 函数本身不许做 I/O。
        plan = await workflow.execute_activity(
            fetch_plan_body,
            ActivityInput(
                plan_ref=args.plan_ref,
                dry_run=not _step_is_live(args, "fetch_plan_body"),
            ),
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=_READ_RETRY,
        )
        self._steps.append(plan)
        result.steps = list(self._steps)

        # ② 拉起 EKS 节点组。守夜灯站点常态 desired=0,切换时才拉。
        scale = await workflow.execute_activity(
            scale_up_nodegroup,
            ActivityInput(
                plan_ref=args.plan_ref,
                dry_run=not _step_is_live(args, "scale_up_nodegroup"),
            ),
            # 节点起来要几分钟,给宽一点;activity 内部发心跳。
            start_to_close_timeout=timedelta(minutes=20),
            heartbeat_timeout=timedelta(minutes=2),
            retry_policy=_WRITE_RETRY,
        )
        self._steps.append(scale)
        result.steps = list(self._steps)

        # ③ ⚠️ 决策点:等人裁决数据库怎么提升。
        #
        #    这里**刻意不设默认值**。等不到就失败,不是「超时按 allow-data-loss
        #    走」—— 自动选择丢数据的那条路是最坏的默认值。
        workflow.logger.info(
            "等待人工裁决数据库提升方式（signal database_decision，合法值 %s）",
            sorted(_VALID_DECISIONS),
        )
        try:
            await workflow.wait_condition(
                lambda: self._decision is not None,
                timeout=timedelta(seconds=args.decision_timeout_seconds),
            )
        except TimeoutError:
            # 明确失败，且把「为什么失败」写进异常 —— 让看到失败的人
            # 知道是没人放行，而不是某个 AWS 调用挂了。
            raise workflow.ApplicationError(
                f"等待 database_decision signal 超过 {args.decision_timeout_seconds}s。"
                "切换未继续。这是刻意的：数据库提升方式必须由人裁决，"
                "因为「主 region 挂了」与「主 region 只是不可达」在指标上无法区分。",
                non_retryable=True,
            ) from None

        assert self._decision is not None  # wait_condition 已保证
        result.database_decision = self._decision

        if self._decision == DECISION_ABORT:
            result.aborted = True
            workflow.logger.info("裁决为 abort，切换在数据库提升前停止。")
            return result

        # ④ 提升数据库。用哪个变体由上面的裁决决定。
        promote = await workflow.execute_activity(
            promote_database,
            ActivityInput(
                plan_ref=args.plan_ref,
                # ⚠️ 这一步要真执行，必须在 execute_steps 里显式写出
                # "promote_database"。一次节点组演练不该有能力切换生产数据库。
                dry_run=not _step_is_live(args, "promote_database"),
                decision=self._decision,
            ),
            start_to_close_timeout=timedelta(minutes=30),
            heartbeat_timeout=timedelta(minutes=2),
            retry_policy=_WRITE_RETRY,
        )
        self._steps.append(promote)
        result.steps = list(self._steps)

        # ⑤ 核实。**与执行不同的手段** —— 这是本项目的纪律:
        #    已实测六次「命令成功但没生效」。
        verify = await workflow.execute_activity(
            verify_step,
            ActivityInput(
                plan_ref=args.plan_ref,
                dry_run=not _step_is_live(args, "verify_step"),
            ),
            start_to_close_timeout=timedelta(minutes=10),
            retry_policy=_READ_RETRY,
        )
        self._steps.append(verify)
        result.steps = list(self._steps)

        return result
