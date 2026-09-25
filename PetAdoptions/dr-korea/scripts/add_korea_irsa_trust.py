#!/usr/bin/env python3.11
"""给 petsite 的 IRSA 角色补上韩国灾备集群的 OIDC provider。

## 为什么不用 CloudFormation

那 7 个角色是别的栈(`ServicesEks2` / `Applications`)建的。
CloudFormation **改不了自己不拥有的资源**,所以这一步只能用 API。
OIDC provider 本身是我们自己的资源,走 `11-irsa-korea-oidc.yaml`。

## 这个脚本动的是生产角色 —— 三条自保措施

`iam:UpdateAssumeRolePolicy` 会**替换整个信任策略文档**,不是追加。
写错就等于把东京生产站点的 IRSA 拆了。所以:

1. **只追加**:读出现有文档 → 判断是否已有韩国那条 → 没有才 append。
   从不「按模板重新生成」一份文档。
2. **改前备份**:每个角色的原始文档存成 JSON 文件,带时间戳。
3. **改后逐字核对**:重新读回来,断言东京那条语句**完全没变**,
   且只多了一条。任何一条不满足就报错退出。

## 幂等

已经有韩国那条的角色会被跳过。可以反复跑。

## 默认 dry-run

不带 `--apply` 只打印将要做什么。这和本项目其他危险操作的惯例一致。

## 与东京那条语句的一个刻意差异

东京那条(CDK 生成的)只限定了 `:aud`:

    "Condition": {"StringEquals": {"<issuer>:aud": "sts.amazonaws.com"}}

也就是说该集群里**任何** ServiceAccount 都能 assume 这个角色。
我给韩国加的那条**额外限定 `:sub`**:

    "<issuer>:sub": "system:serviceaccount:petadoptions:<sa-name>"

更严,且不影响东京。之所以不顺手把东京那条也收紧:那是别的栈管的资源,
改它属于越界,而且会和那个栈的下一次部署打架。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAPPING = HERE.parent / "infra" / "dr-korea" / "irsa-korea-mapping.json"
NAMESPACE = "petadoptions"


def _aws(*args: str) -> str:
    """跑 aws CLI。**不抑制 stderr** —— 错误文本往往就是答案。"""
    r = subprocess.run(
        ["aws", *args], capture_output=True, text=True, timeout=60, check=False
    )
    if r.returncode != 0:
        raise RuntimeError(f"aws {' '.join(args[:3])} 失败：{r.stderr.strip()}")
    return r.stdout


def korea_statement(provider_arn: str, oidc_host: str, sa: str) -> dict:
    """构造要追加的那一条语句。"""
    return {
        "Effect": "Allow",
        "Principal": {"Federated": provider_arn},
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Condition": {
            "StringEquals": {
                f"{oidc_host}:aud": "sts.amazonaws.com",
                # ⚠️ sub 的格式是 system:serviceaccount:<ns>:<sa>
                # 写错不会报错，只会永远拒绝 —— 和「没注册 provider」同一种表现。
                f"{oidc_host}:sub": f"system:serviceaccount:{NAMESPACE}:{sa}",
            }
        },
    }


def has_korea(doc: dict, provider_arn: str) -> bool:
    for st in doc.get("Statement", []):
        fed = (st.get("Principal") or {}).get("Federated")
        if fed == provider_arn:
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真的改（默认只打印）")
    ap.add_argument("--only", help="只处理这一个 ServiceAccount 名")
    ap.add_argument(
        "--backup-dir",
        default="",
        help="备份目录（--apply 时必填）",
    )
    args = ap.parse_args()

    if args.apply and not args.backup_dir:
        print("❌ --apply 必须同时给 --backup-dir —— 改生产角色不留备份是不可接受的")
        return 2

    data = json.loads(MAPPING.read_text(encoding="utf-8"))
    provider_arn = data["korea_provider_arn"]
    oidc_host = data["korea_oidc_host"]
    pairs = data["service_accounts"]

    if args.only:
        pairs = {k: v for k, v in pairs.items() if k == args.only}
        if not pairs:
            print(f"❌ 映射里没有 {args.only}")
            return 2

    backup = Path(args.backup_dir) if args.backup_dir else None
    if backup:
        backup.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    changed, skipped, failed = 0, 0, 0
    for sa, role in sorted(pairs.items()):
        doc = json.loads(
            _aws("iam", "get-role", "--role-name", role,
                 "--query", "Role.AssumeRolePolicyDocument", "--output", "json")
        )
        if has_korea(doc, provider_arn):
            print(f"  ⏭  {sa:24s} 已有韩国那条，跳过")
            skipped += 1
            continue

        before = json.dumps(doc, sort_keys=True)
        n_before = len(doc.get("Statement", []))
        new_doc = json.loads(before)  # 深拷贝，绝不原地改
        new_doc["Statement"].append(korea_statement(provider_arn, oidc_host, sa))

        if not args.apply:
            print(f"  [dry-run] {sa:24s} 会从 {n_before} 条语句变成 "
                  f"{len(new_doc['Statement'])} 条（role={role[:44]}…）")
            continue

        (backup / f"{role}.{stamp}.json").write_text(
            json.dumps(doc, indent=2), encoding="utf-8"
        )
        _aws("iam", "update-assume-role-policy", "--role-name", role,
             "--policy-document", json.dumps(new_doc))

        # ── 改后核对（这才是这个脚本能不能被信任的关键）──────────────────
        after = json.loads(
            _aws("iam", "get-role", "--role-name", role,
                 "--query", "Role.AssumeRolePolicyDocument", "--output", "json")
        )
        ok = True
        if len(after.get("Statement", [])) != n_before + 1:
            print(f"  ❌ {sa}: 语句数不对（{n_before} → "
                  f"{len(after.get('Statement', []))}，应为 {n_before + 1}）")
            ok = False
        # 原有每一条都必须逐字还在。
        orig = json.loads(before)["Statement"]
        after_norm = [json.dumps(s, sort_keys=True) for s in after["Statement"]]
        for st in orig:
            if json.dumps(st, sort_keys=True) not in after_norm:
                print(f"  ❌ {sa}: 原有语句被改动了！备份在 "
                      f"{backup / f'{role}.{stamp}.json'}")
                ok = False
        if not has_korea(after, provider_arn):
            print(f"  ❌ {sa}: 韩国那条没写进去")
            ok = False

        if ok:
            print(f"  ✅ {sa:24s} 已追加（{n_before} → {n_before + 1} 条）")
            changed += 1
        else:
            failed += 1

    print(f"\n  改动 {changed}，跳过 {skipped}，失败 {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
