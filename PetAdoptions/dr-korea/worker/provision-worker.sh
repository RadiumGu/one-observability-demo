#!/usr/bin/env bash
#
# provision-worker.sh —— 在 Temporal 那台 EC2 上装好 DR worker。
#
# ## 为什么要有这个脚本
#
# 2026-09-24：worker 最初是用 SSM 手工装的，`/opt/dr-worker` 不在 IaC 里。
# 重启能保留它，但**实例真被重建时它不会自动回来** —— 而 worker 不在，
# 切换 workflow 会一直排队并且**看起来是 RUNNING**（实测过），
# 不报任何错。那是最糟的失效形态。
#
# ## 唯一来源
#
# 本脚本既由 02-temporal.yaml 的 UserData 在首次启动时调用，也可以在活主机
# 上直接重跑做修复。**刻意做成幂等**：每一步都先看「是不是已经成的」。
#
# 这样它能在不重建实例的前提下被真正验证过 —— 一段只在重建时才跑的
# provisioning 代码等于没验证过的代码。
#
# ## 环境事实（实测，不是假设）
#
#   宿主系统 python3   3.9.25  ← temporalio 要 >=3.10，不能用
#                              且 aws-cfn-bootstrap / ec2-utils 依赖它，
#                              **不许替换**
#   可装解释器          AL2023 仓库有 python3.11~3.14
#   选 3.12            temporalio 的轮子是 cp310-abi3，3.10+ 无差别；
#                      3.12 与项目里已跑通的 AgentCore runtime 对齐
#   架构                aarch64（manylinux_2_17_aarch64 轮子存在）
#   Temporal gRPC       localhost:7233 ← worker 走这个
#                       不是 7243（HTTP API）、不是 8080（UI）

set -euo pipefail

CODE_BUCKET="${DR_CODE_BUCKET:?需要 DR_CODE_BUCKET}"
CODE_PREFIX="${DR_CODE_PREFIX:-worker/}"
REGION="${DR_REGION:-ap-northeast-2}"
APP=/opt/dr-worker/app
VENV=/opt/dr-worker/venv
PY=python3.12

log() { echo "[provision-worker] $*"; }

# ── 1 解释器 ──────────────────────────────────────────────────────────────
# 幂等：已装就跳过。dnf install 本身幂等，但跳过能省掉一次元数据刷新。
if command -v "$PY" >/dev/null 2>&1; then
  log "已有 $PY（$($PY --version 2>&1)），跳过安装"
else
  log "装 $PY（增量，不动系统 python3）"
  dnf install -y -q "$PY" "${PY}-pip"
fi

# 守卫：装完必须真的能用，而且系统 python3 必须还在。
"$PY" --version >/dev/null || { log "错误：$PY 装了却不可用"; exit 1; }
python3 --version >/dev/null || { log "错误：系统 python3 被动过了"; exit 1; }

# ── 2 venv 与依赖 ─────────────────────────────────────────────────────────
if [ ! -x "$VENV/bin/python" ]; then
  log "建 venv"
  mkdir -p /opt/dr-worker
  "$PY" -m venv "$VENV"
fi

mkdir -p "$APP"
log "同步 worker 代码（S3 是唯一来源）"
aws s3 sync "s3://${CODE_BUCKET}/${CODE_PREFIX}" "$APP/" --region "$REGION" --only-show-errors

# requirements 变了才重装 —— pip install 不快，而 provisioning 可能被反复跑。
REQ="$APP/requirements.txt"
STAMP=/opt/dr-worker/.requirements.sha256
if [ -f "$REQ" ]; then
  new="$(sha256sum "$REQ" | cut -d' ' -f1)"
  old="$(cat "$STAMP" 2>/dev/null || true)"
  if [ "$new" != "$old" ]; then
    log "依赖有变，安装"
    "$VENV/bin/pip" install -q --upgrade pip
    "$VENV/bin/pip" install -q -r "$REQ"
    echo "$new" > "$STAMP"
  else
    log "依赖未变，跳过"
  fi
else
  log "错误：$REQ 不存在，S3 同步可能没成功"; exit 1
fi

# 守卫：不看 pip 说成功，而是真导入一次。
"$VENV/bin/python" -c 'import temporalio, boto3' || {
  log "错误：依赖装了却导不进来"; exit 1
}

# ── 3 systemd 单元 ────────────────────────────────────────────────────────
UNIT_SRC="$APP/dr-worker.service"
UNIT_DST=/etc/systemd/system/dr-worker.service
if [ ! -f "$UNIT_SRC" ]; then
  log "错误：$UNIT_SRC 不存在"; exit 1
fi
# 只在内容变了才 daemon-reload + restart —— 无谓重启会打断正在跑的切换。
if ! cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  log "单元有变，安装并重启"
  install -m 0644 "$UNIT_SRC" "$UNIT_DST"
  systemctl daemon-reload
  systemctl enable dr-worker
  systemctl restart dr-worker
else
  log "单元未变"
  systemctl enable dr-worker >/dev/null 2>&1 || true
  systemctl is-active --quiet dr-worker || { log "服务没在跑，拉起"; systemctl start dr-worker; }
fi

# ── 4 生效核实 —— 用与部署不同的手段 ──────────────────────────────────────
#
# 不看 systemctl start 的返回（本项目已实测六次「命令成功但没生效」），
# 而是查「任务队列上有没有 poller」—— 那是 worker 真的在接单的证据。
log "核实：等 worker 在任务队列上出现"
ok=0
for _ in $(seq 1 12); do
  sleep 5
  # ⚠️ taskQueueType 必须带前缀。裸 WORKFLOW 会被服务端拒绝（实测 code 3）。
  body="$(curl -s --max-time 8 \
    "http://localhost:7243/api/v1/namespaces/default/task-queues/dr-plan-queue?taskQueueType=TASK_QUEUE_TYPE_WORKFLOW" \
    2>/dev/null || true)"
  # ⚠️ 判据是「pollers 字段是否存在」，不是「数量是否为 0」。
  # 字段缺失时服务端什么都没报，报成 0 个 worker 是把未测量写成测量值。
  case "$body" in
    *'"pollers"'*) ok=1; break ;;
  esac
done

if [ "$ok" = "1" ]; then
  log "✅ worker 已在 dr-plan-queue 上接单"
else
  log "⚠️ 60s 内没看到 pollers 字段。这**不等于**「没有 worker」——"
  log "   也可能是 Temporal 还没起来。查：systemctl status dr-worker temporal"
  exit 1
fi
