# petsite 韩国守夜灯(pilot light)灾备站点

在 `ap-northeast-2`(首尔)为 `ap-northeast-1`(东京)的 petsite 建一个
**守夜灯式**灾备站点:平时 EKS 节点数为 0、数据库用最小规格跟着同步,
切换时由 Temporal workflow 按步骤拉起。

这些模板是在真实账号上逐个部署并**独立核实**过的(核实手段与部署手段不同),
不是只做过 `validate-template`。下面记的每个数字都是实测值。

---

## 目录

```
cloudformation/     10 个 CFN 栈，按编号顺序部署
worker/             跑在 Temporal 实例上的 Python worker + 幂等 provisioning 脚本
```

---

## 部署顺序与所在 region

⚠️ **不是所有栈都部在韩国。** 部错 region 会静默地什么都不做。

| 栈 | region | 产出 |
|---|---|---|
| `01-network.yaml` | ap-northeast-2 | VPC `10.20.0.0/16`、1 公有(仅放 NAT)+ 2 私有子网、SSM 三端点 |
| `02-temporal.yaml` | ap-northeast-2 | `t4g.large` 上自建 Temporal + PostgreSQL 16,UserData 里调 worker provisioning |
| `03-eks.yaml` | ap-northeast-2 | EKS 1.35,`endpointPublicAccess=false`,节点组 `min0/desired0/max3` |
| `04-aurora-dr.yaml` | ap-northeast-2 | Aurora 全局数据库的从集群(`db.serverless`) |
| `05-agentcore-prereq.yaml` | ap-northeast-2 | 代码包桶(`Retain`+版本)、执行角色、runtime 安全组 |
| `06-agentcore-runtime.yaml` | ap-northeast-2 | `AWS::BedrockAgentCore::Runtime`,`NODE_22`,VPC 模式 |
| `07-worker-permissions.yaml` | ap-northeast-2 | worker 的权限边界(**需 `CAPABILITY_NAMED_IAM`**) |
| `08-worker-k8s-readonly.yaml` | ap-northeast-2 | EKS AccessEntry + 控制面 443 窄入站 |
| `09-ecr-replication.yaml` | **ap-northeast-1** | ECR 跨 region 复制 —— **配在源 region** |
| `10-ecr-korea-repos.yaml` | ap-northeast-2 | 韩国侧 ECR 仓库(给一次性回填用) |
| `11-irsa-korea-oidc.yaml` | 任意(IAM 是全局的) | 把韩国集群的 OIDC provider 注册进 IAM |

```bash
# 示例（07 需要 NAMED_IAM，不是 IAM）
aws cloudformation deploy --region ap-northeast-2 \
  --stack-name dr-korea-worker-permissions \
  --template-file cloudformation/07-worker-permissions.yaml \
  --capabilities CAPABILITY_NAMED_IAM
```

---

## 三个只有实测才会发现的坑

### ① ECR 复制**不会**带走已有镜像

官方文档(`AmazonECR/latest/userguide/replication.html`)原文:

> Only repository content pushed or restored to a repository after replication
> is configured is replicated. **Any preexisting content in a repository isn't
> replicated.**

实测印证:对一个早已存在的镜像调
`aws ecr describe-image-replication-status`,`replicationStatuses` 是**空数组**。

所以配完 `09` 之后还必须做一次**一次性回填**。petsite 的 deployment 引用的是
内容哈希 tag 的镜像(早就推好了),一个都不会自动过去。
回填用 `skopeo copy`(registry 到 registry,不需要 docker daemon):

```bash
PW1=$(aws ecr get-login-password --region ap-northeast-1)
PW2=$(aws ecr get-login-password --region ap-northeast-2)
skopeo copy --src-creds "AWS:$PW1" --dest-creds "AWS:$PW2" \
  docker://<acct>.dkr.ecr.ap-northeast-1.amazonaws.com/<repo>:<tag> \
  docker://<acct>.dkr.ecr.ap-northeast-2.amazonaws.com/<repo>:<tag>
```

核实要比 digest,不能只看「拷贝成功」:两侧 `describe-images` 的
`imageDigest` 必须一致。

### ② 韩国侧的仓库名里仍然带着 `ap-northeast-1`

文档:复制**不支持改名**,仓库名跨 region 必须一致。而源仓库是 CDK bootstrap
建的 `cdk-hnb659fds-container-assets-<acct>-ap-northeast-1` —— 那串
`ap-northeast-1` 是**名字的一部分**,不是 region 参数。看着别扭,改了复制就失效。

### ③ 「节点起来了」≠「集群有可调度容量」

数 EC2 实例只证明 ASG 扩容成功。节点可能起来却没成为 Ready ——
对切换来说差别极大:可能有两台 EC2 和零个可调度节点。
`worker/activities.py` 的 `count_ready_nodes()` 直接查 k8s API 数
`status.conditions[type=Ready]`,需要三个前置条件缺一不可:

| 条件 | 缺了的表现 |
|---|---|
| EKS AccessEntry | 调不通 k8s API |
| 控制面 443 入站 | **`curl` 超时**(不是 refused —— 安全组静默丢包) |
| 能读 `nodes` 的 RBAC | **403** |

第三条要注意:`AmazonEKSViewPolicy` **不含 nodes**(官方资源表里没有),
而 `AmazonEKSAdminViewPolicy` 是 `*/*` 且文档明确写着包含 Secrets。
所以 `worker/k8s-node-reader-rbac.yaml` 自定义了一个只含 `nodes` 的
ClusterRole,绑到 k8s **组**(访问条目的 username 含 `{{SessionName}}`,
运行时才定,绑用户名绑不住)。

### ④ 缩容核实要看 ASG 的 `LifecycleState`,不是 EC2 的 `State`

实测缩到 `desired=0` 之后:

```
ASG:  {'Terminating:Wait': 1}      ← 真相
EC2:  i-xxxx  running              ← 分不出来
```

排空钩子 `HeartbeatTimeout=1800`、`DefaultResult=CONTINUE`,所以
**一台正在优雅排空的实例和一台缩容失败卡住的实例,在 EC2 那一层长得完全一样。**

---

## worker 怎么跑

`worker/provision-worker.sh` 是幂等的,既被 `02-temporal.yaml` 的 UserData 调用,
也能在活主机上重跑修复。幂等的判据是「连跑两遍服务启动时间不变」。

```
宿主 python3    3.9（AL2023 自带，cfn-bootstrap/ec2-utils 依赖它，**不要替换**）
并装解释器      python3.12（temporalio 要 >= 3.10）
venv            /opt/dr-worker/venv
worker 连       localhost:7233   ← gRPC，不是 7243（HTTP API）也不是 8080（UI）
```

`workflows.py` 的执行闸门是**两道**:

```python
_step_is_live(args, step) = (not args.dry_run) and (step in args.execute_steps)
```

全局 `dry_run=False` 也不够 —— 步骤还必须在放行名单里。数据库提升做成需要
signal 才推进的决策点(`ordered` / `allow_data_loss` / `abort`),**超时不放行**。

---

### ⑤ IRSA 的失效方式极其隐蔽(已修好,但值得单记)

IRSA 的信任链需要 IAM 里**注册了集群的 OIDC provider**。韩国集群建好之后
`list-open-id-connect-providers` 里一个 `ap-northeast-2` 都没有 ——
清单照抄过去,pod **能起来**、能过健康检查前半段,然后每一次 AWS 调用都 403。
**切换前做静态检查完全看不见。**

修法见 `cloudformation/11-irsa-korea-oidc.yaml` 与
`scripts/add_korea_irsa_trust.py`。两个要点:

- **不要写死 thumbprint。** `CreateOpenIDConnectProvider` 的 required 只有
  `['Url']`,AWS 会自己取。写死的值会随 CA 轮换而过期,**过期的表现也是 403**,
  和「没注册」无法区分。
- **信任策略不能用 CFN 改**(那些角色是别的栈建的),而
  `UpdateAssumeRolePolicy` **替换整个文档** —— 脚本必须只追加、改前备份、
  改后逐字核对原有语句还在。

核实不需要起 pod:token 由控制面签发,所以零节点就能验 ——
建 SA → TokenRequest(audience=`sts.amazonaws.com`)→
`sts assume-role-with-web-identity`。双向都要验:换个别的 SA 必须被
`AccessDenied` 拒掉,否则说明 `:sub` 没限制住。

---

## 还没做完的(应用层接管)

基础设施层是通的,但切换后 petsite 起不来,因为:

- **配置在 region 内**:SSM `/petstore` 前缀一批参数、Secrets Manager 的
  `DatabaseSecret…` 都在 `ap-northeast-1`。
- **依赖面远超 EKS+DB**:DynamoDB 表、EventBridge bus、SQS、S3、API Gateway、
  Bedrock AgentCore runtime ARN。
- **韩国侧没有公网入口**,切换时需临时建 internal ALB。
