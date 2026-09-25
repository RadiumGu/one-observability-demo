"""
worker.py — 灾备切换 worker 的入口。

## 跑在哪

Temporal 服务端同一台 EC2(ap-northeast-2,私有 IP 固定为 10.20.1.10)。

⚠️ 这里刻意**不写实例 ID**:实例会被替换(2026-09-25 就替换过一次,
`i-06f0a3e4961b8061e` → `i-09380e417a0177ed4`),写死 ID 的注释会变成
误导人的过期事实。IP 是固定的(02-temporal.yaml 的 PrivateIpAddress),
所以用 IP 指代更稳。
2026-09-24 定的,备选是韩国 EKS 与东京 EKS,选这台的理由:

1. **切换时 EKS 可能正是要被操作的对象。** worker 放在韩国 EKS 上,
   就出现「执行切换的东西依赖被切换的东西」—— 拉起节点组这一步会把
   自己的运行环境卷进去。
2. **守夜灯站点常态 desired=0。** worker 放上面等于平时不存在,
   而切换恰恰是它最该在的时候。
3. 东京 EKS 可用,但灾难场景里东京可能正是失效的那一侧。

代价:这台 EC2 成了单点。**已知取舍** —— worker 的职责是发起切换而非
承载流量,且守夜灯站点本就定位为「切换时才全量拉起」。

## 环境(实测确认,不是假设)

    宿主系统 python3   3.9.25  ← 不能用，temporalio 要求 >=3.10
                               且 aws-cfn-bootstrap / ec2-utils 依赖它，
                               不许替换
    并装解释器          python3.12.14（AL2023 仓库里有 3.11~3.14）
    venv               /opt/dr-worker/venv
    temporalio         1.33.0（cp310-abi3 的 aarch64 轮子，实测可导入）
    Temporal gRPC      localhost:7233 ← worker 走 gRPC
                       ⚠️ 不是 7243，那是 HTTP API（temporal-mcp 用的）
                       也不是 8080，那是 Web UI

## ⚠️ 当前只跑 dry_run

本实例的 IAM 角色只有 Describe 权限(见 `infra/dr-korea/02-temporal.yaml`)。
`dry_run=False` 现在会 AccessDenied —— **刻意的**,权限按步骤逐个放开。
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal

from temporalio.client import Client
from temporalio.worker import Worker

from activities import (
    fetch_plan_body,
    promote_database,
    scale_up_nodegroup,
    verify_step,
)
from workflows import DrFailoverWorkflow

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("dr-worker")

#: worker 走 gRPC。默认 localhost 因为它与 Temporal 同机。
TEMPORAL_TARGET = os.environ.get("DR_TEMPORAL_TARGET", "localhost:7233")
NAMESPACE = os.environ.get("DR_TEMPORAL_NAMESPACE", "default")
#: 必须与发起方用的队列名一致。不一致的后果是 workflow 永远排队
#: 而**看起来是 RUNNING**（实测过），不会报任何错。
TASK_QUEUE = os.environ.get("DR_TEMPORAL_TASK_QUEUE", "dr-plan-queue")


async def main() -> None:
    client = await Client.connect(TEMPORAL_TARGET, namespace=NAMESPACE)
    logger.info(
        "已连上 Temporal target=%s namespace=%s task_queue=%s",
        TEMPORAL_TARGET,
        NAMESPACE,
        TASK_QUEUE,
    )

    worker = Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[DrFailoverWorkflow],
        activities=[
            fetch_plan_body,
            scale_up_nodegroup,
            promote_database,
            verify_step,
        ],
        # ── 2026-09-24：这两个数原来都是 1，那是个设计错误 ──────────────
        #
        # 当时的想法是「一次只做一个切换」。但 **workflow task 并发 ≠
        # 并发切换数**：workflow task 是「推进一步状态机」的短任务，
        # 把它限制成 1 防不住两个不同 workflow ID 同时跑（它们只是
        # 互相拖慢），却会造成**队头阻塞**。
        #
        # 实测到的后果：队列上有一个永久失败的 workflow（workflow type
        # 没注册，Temporal 会无限重试它的 workflow task）时，唯一的槽位
        # 被它占住，真正的切换 workflow 被拖了 3 分钟，历史里留下
        # WORKFLOW_TASK_TIMED_OUT —— 即使把 workflowTaskTimeout 从 10s
        # 调到 60s 也照样超时。在真实切换里这几分钟是有代价的。
        #
        # 「一次只做一个切换」的正确机制是 **workflow ID**：
        # 同一个 workflow ID 在运行中时，默认的重用策略会直接拒绝第二次
        # 启动（WorkflowExecutionAlreadyStarted），这才是真正的互斥。
        # 见 executor_temporal._build_start_args 里 workflow_id 的构造。
        max_concurrent_workflow_tasks=10,
        # activity 才是真正干活、可能长时间跑的那个。这里留小一点：
        # 切换步骤之间基本是串行的，给 5 个足够容纳重试与心跳。
        max_concurrent_activities=5,
    )

    stop = asyncio.Event()

    def _on_signal(signame: str) -> None:
        # 收到停止信号时优雅退出:让当前 activity 跑完而不是半途断开。
        # 半途断开的后果是 Temporal 要等 activity 超时才重派,
        # 而切换过程中多等几分钟是有代价的。
        logger.info("收到 %s，等当前任务结束后退出", signame)
        stop.set()

    loop = asyncio.get_running_loop()
    for s in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(s, _on_signal, s.name)

    logger.info("worker 开始轮询。⚠️ 当前实例角色只有 Describe 权限，只能跑 dry_run。")
    async with worker:
        await stop.wait()
    logger.info("worker 已退出")


if __name__ == "__main__":
    asyncio.run(main())
