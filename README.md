## One Observability Demo

This repo contains a sample application which is used in the One Observability Demo workshop here - https://observability.workshop.aws/

## ⚠️ 本仓库与上游 aws-samples/one-observability-demo 的区别

**这是一个针对特定私有环境定制的分支，不适合直接用于 workshop，也不打算合并回上游。**

上游是通用教学素材，会在任意账号里从零部署；本分支跑在一套已存在
5 个月的东京区（ap-northeast-1）EKS 集群上，很多取舍是被现有环境**倒逼**的。
下面按「为什么与上游不同」分类，每条都有实测依据。

### 一、被硬约束逼出来的差异

| 约束 | 上游做法 | 本分支做法 |
|---|---|---|
| **不得新增公网入口**（公司安全会告警） | petfood/agent 走公网 ALB 或 CloudFront | 只用 **internal ALB**，新增端口 `:8081`~`:8084` 且 SG 仅对调用方开放 |
| **不得使用 ECS** | `src/cdk/lib/microservices/petfood.ts` 走 ECS（ECS 命中 15、EKS 命中 0） | 只移植应用代码，**部署层用本地 `EksService` 基类重写**，全部容器跑现有 arm64 EKS |
| **不引入 CloudFront** | 宠物/食品图经 `*_CDN_URL` 指向 CloudFront 分发 | 宠物图用 **S3 presigned URL**；食品图改为 petsite 自己 `wwwroot` 下的 SVG（走现有 ALB） |
| **arm64 节点** | 镜像未限定架构 | 全部镜像 `Platform.LINUX_ARM64`，petfood-rs 另修了一个 arm64 硬 bug |

### 二、刻意**不**跟随上游的改动

- **`petlistadoptions` 保持 Go**，未跟随上游整体重写为 Python。
  逐项证伪后确认上游那次重写是等价重写而非功能扩展：对外接口完全一致
  （`/health/status`、`/api/adoptionlist/`、`/metrics`）；配置热加载对本环境无收益；
  凭据轮换刷新逻辑**实测不必要**（该 Aurora 密钥 `RotationEnabled` /
  `RotationLambdaARN` / `LastRotated` / `NextRotation` 全为 null）。
  只采纳了与语言无关的 12 个 dbload 脚本。
- **petsite 保留 X-Ray SDK 埋点，petsearch 保留 OTel agent** —— 结论相反但依据同一个：
  **遥测必须有出口**。petsite 是单容器无 sidecar，只能发给集群级 `xray-daemon`
  （default 命名空间 UDP 2000）；petsearch **有** `aws-otel-collector` sidecar，
  走 OTLP `localhost:4317`。上游把两边对应的埋点栈都删了，照搬任一边都会让服务
  从 X-Ray 服务图消失，进而让依赖图谱静默残缺。
- **保留 `getPetUrl` 的 1% 故障注入**。那是 demo 刻意埋的教学素材
  （源码注释 `Forced exception to show S3 bucket creation error.`，
  条件 `Math.random()*9999 < 100`）。上游把 `getPetUrl` 改成拼 CloudFront URL 后
  这段整体消失，本分支保留 presigned 方案因而也保留了它。
- **不升级 `aws-cdk-lib`**（保持 2.238.0）。`CfnPolicyEngine` 在此版本不存在，
  但上游自己的注释说明该资源刻意不挂载（`ENFORCE with no authored policies
  would deny all traffic`），除输出 ARN 外无功能。改用 `CfnResource` escape hatch，
  已实测 `AWS::BedrockAgentCore::PolicyEngine` 在东京区 LIVE。

### 三、本分支新增（上游没有）

- **AgentCore（Waggle AI）全套 CDK 构造**：5 个 Runtime + Gateway + 5 target +
  Knowledge Base + Memory + Guardrail。
  `AGENT_TRANSPORT` 设为 **`gateway`** 而非上游默认的 `local` ——
  后者是五个 agent 同容器、委派走进程内调用，依赖图里只会有 1 个节点、
  **0 条 `Delegates` 边**。改用 gateway 后实测产出 2 条 `Delegates`。
- **petfood 的 EKS 部署层**（上游只有 ECS 版），含两个 DynamoDB GSI 的声明式定义。
- **依赖关系验证工具链**（在配套的 graph-dependency-platform 仓库）：
  用 Chaos Mesh `NetworkChaos` 逐条验证图数据库里的依赖边，标注
  confirmed / refuted / inconclusive。

### 四、修掉的上游缺陷（可能同样适用于上游）

这些不是环境适配，是**真实 bug**，commit message 里有完整实测证据：

| 缺陷 | 症状 | 根因 |
|---|---|---|
| petsite 缺 `bedrock-agentcore:InvokeAgentRuntime` 权限 | Waggle 聊天每次回「connection was interrupted」 | IRSA 角色只挂 SSM/SQS/SNS/X-Ray，CDK 从未授予 |
| 首页 hero 图 403 | 破图 | 取 `peturl` 的 authority 丢掉了 presigned 签名；且前缀写成 `kittens/`（桶里是 `kitten/`） |
| 食品页 Close 按钮无效 | 弹窗关不掉 | 视图用 Bootstrap **5** 的 `data-bs-dismiss`，而打包的是 **v4.3.1** |
| 完成领养每次 400 | 点「领养」失败 | 服务端要求 `petId`+`petType`+`userId` 三者齐全，petsite 只传前两个 |
| 每分钟约 42 次无效 SSM 调用 | 日志噪声 | `_Layout.cshtml` 查一个不存在的 `/petstore/rumscriptparameter`（真实名 `rumscript`），且无缓存、每渲染一页调一次、`catch{}` 吞掉一切 |
| pethistory 长连接无法从失败事务恢复 | 单个 Pod 永久 500 而 `ready=true` | `except psycopg.OperationalError` 抓不到 `InFailedSqlTransaction` —— 实测二者是 `DatabaseError` 下的**兄弟分支**，`issubclass(...)` 为 `False` |
| `transactions` 表缺 `pet_type`/`user_id` | Housekeeping 无法重置宠物可用性 | 上游代码假定 6 列，而线上表是旧版建的 4 列，且建表语句是 `CREATE TABLE IF NOT EXISTS` —— 新列永远不会补上 |

### 想用上游原版？

`git remote` 里 `origin` 指向上游，直接从那里取：

```bash
git remote -v          # origin = aws-samples/one-observability-demo
git fetch origin
git checkout origin/main
```

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## Instructions

To deploy this workshop on your own account you need to have an IAM role with elevated priviliges and the `aws-cli` installed. Then, from the root
of the repository run the following command:

```
aws cloudformation create-stack --stack-name Observability-Workshop --template-body file://codepipeline-stack.yaml --capabilities CAPABILITY_NAMED_IAM --parameters ParameterKey=UserRoleArn,ParameterValue=$(aws iam get-role --role-name $(aws sts get-caller-identity --query Arn --output text | awk -F/ '{print $(NF-1)}') --query Role.Arn --output text)
```

You can replace the role specified in the paramter `UserRoleArn` with any other role with access to AWS CloudShell if you need so.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

