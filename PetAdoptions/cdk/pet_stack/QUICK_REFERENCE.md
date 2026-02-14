# 🎯 两层 ALB + 纯 EKS (Graviton) - 快速参考

## 📦 新架构概览

```
外部 ALB (public) + Cognito
      ↓
PetSite 前端 (EKS Graviton)
      ↓
内部 ALB (internal, VPC 内部)
      ↓
所有微服务 (EKS Graviton)
```

---

## 🚀 快速部署（5 步）

### 1️⃣ 构建 ARM64 镜像
```bash
docker buildx build --platform linux/arm64 -t <ECR>/service:arm64 . --push
```

### 2️⃣ 部署 CDK Stack
```bash
cd ~/tech/one-observability-demo/PetAdoptions/cdk/pet_stack
cp lib/services-eks-two-alb.ts lib/services.ts
npm run build
cdk deploy Services-PetStack
```

### 3️⃣ 部署 Kubernetes 服务
```bash
kubectl apply -f k8s-manifests/
```

### 4️⃣ 更新 Cognito 回调
```bash
aws cognito-idp update-user-pool-client \
  --user-pool-id $POOL_ID \
  --client-id $CLIENT_ID \
  --callback-urls "http://$EXTERNAL_ALB_DNS/oauth2/idpresponse"
```

### 5️⃣ 测试访问
```bash
# 访问前端（需要登录）
http://$EXTERNAL_ALB_DNS

# 内部 ALB（仅 VPC 内）
http://$INTERNAL_ALB_DNS/api/adoptionlist/
```

---

## 🔐 安全架构

```
Layer 4: Cognito OAuth2 认证
    ↓
Layer 3: 外部 ALB (internet-facing)
    ↓
Layer 2: PetSite 前端
    ↓
Layer 1: 内部 ALB (VPC 内部)
    ↓
Layer 0: 后端微服务 Pod
```

✅ **后端不暴露公网！**

---

## 💰 成本对比

| 架构 | 月度 | 年度 | 节省 |
|------|------|------|------|
| **原始** (5 ALB + ECS) | $414 | $4,968 | - |
| **统一 ALB** (1 ALB + ECS) | $269 | $3,228 | 35% |
| **两层 ALB + EKS** ⭐ | **$188** | **$2,256** | **55%** |

---

## 📊 关键指标

### 计算成本
- **ECS Fargate**: $0.04/vCPU/小时
- **Graviton EC2**: $0.0128/vCPU/小时
- **节省**: 68% ↓

### 性能提升
- **Graviton vs x86**: +40% 性能
- **功耗**: -60%

### ALB 成本
- **外部 ALB**: ~$35/月
- **内部 ALB**: ~$35/月
- **总计**: ~$70/月

---

## 🎯 核心改进

| 维度 | 改进 |
|------|------|
| **安全** | 后端不暴露公网，纵深防御 4 层 |
| **成本** | 年度节省 $2,712 (55%) |
| **性能** | Graviton +40% 性能 |
| **管理** | 统一到 EKS，kubectl 一站式 |
| **扩展** | 支持 Service Mesh, GitOps |

---

## 🛠️ 常用命令

### CDK 相关
```bash
# 编译
npm run build

# 预览变更
cdk diff Services-PetStack

# 部署
cdk deploy Services-PetStack

# 销毁
cdk destroy Services-PetStack
```

### Kubernetes 相关
```bash
# 获取集群凭证
aws eks update-kubeconfig --name PetSite

# 查看 Pod
kubectl get pods -n petadoptions -o wide

# 查看 Ingress
kubectl get ingress -n petadoptions

# 查看 Graviton 节点
kubectl get nodes -l arch=arm64

# 查看 Pod 日志
kubectl logs <POD_NAME> -n petadoptions

# 进入 Pod
kubectl exec -it <POD_NAME> -n petadoptions -- /bin/bash
```

### 验证命令
```bash
# 检查 ALB
aws elbv2 describe-load-balancers

# 检查 Target Groups
aws elbv2 describe-target-groups

# 检查 Target Health
aws elbv2 describe-target-health --target-group-arn <ARN>

# 检查 Cognito
aws cognito-idp describe-user-pool --user-pool-id <POOL_ID>
```

---

## 🔍 故障排查速查

### Pod 无法启动
```bash
kubectl describe pod <POD_NAME> -n petadoptions
kubectl logs <POD_NAME> -n petadoptions
```
**常见原因**: 镜像不是 ARM64、环境变量错误

### Ingress 无 ALB
```bash
kubectl describe ingress <INGRESS_NAME> -n petadoptions
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
```
**常见原因**: AWS LB Controller 未安装、权限不足

### Target 不健康
```bash
aws elbv2 describe-target-health --target-group-arn <TG_ARN>
```
**常见原因**: 健康检查路径错误、Security Group 问题

### 内部 ALB 无法访问
**检查**: Security Group 是否允许 VPC CIDR 访问端口 80

---

## 📝 部署检查清单

### CDK Stack
- [ ] 外部 ALB 创建（Internet-facing）
- [ ] 内部 ALB 创建（Internal）
- [ ] EKS Graviton Node Group 创建
- [ ] Cognito User Pool 创建
- [ ] 所有 Target Groups 创建（7 个）
- [ ] SSM Parameters 更新

### Kubernetes
- [ ] 所有 Pod 运行在 ARM64 节点
- [ ] 所有 Pod 状态为 Running
- [ ] Internal Ingress 创建 ALB
- [ ] External Ingress 创建 ALB
- [ ] ALB 关联正确的 Target Groups

### 功能测试
- [ ] 外部 ALB → Cognito 登录
- [ ] 登录后访问 PetSite
- [ ] 前端调用后端 API 正常
- [ ] 后端服务无法从公网访问
- [ ] 内部 ALB 可以从 VPC 访问

---

## 🎓 学习资源

### AWS 文档
- [EKS Graviton 最佳实践](https://docs.aws.amazon.com/eks/latest/userguide/arm-support.html)
- [AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/)
- [Cognito + ALB 集成](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)

### 项目文档
- **DEPLOYMENT_GUIDE_V2.md** - 详细部署流程
- **ARCHITECTURE_EVOLUTION.md** - 三代架构对比
- **lib/services-eks-two-alb.ts** - CDK 代码

---

## 🆘 需要帮助？

1. **部署问题** → 查看 DEPLOYMENT_GUIDE_V2.md "故障排查" 章节
2. **架构理解** → 查看 ARCHITECTURE_EVOLUTION.md
3. **成本问题** → 查看 "成本对比" 章节
4. **性能问题** → 检查 Graviton 节点是否正常运行

---

## 📍 关键 SSM 参数

```
/petstore/internal-alb-dns          - 内部 ALB DNS
/eks/petsite/ExternalTargetGroupArn - 外部 ALB TG ARN
/eks/petsite/InternalListTGArn      - List 服务 TG ARN
/eks/petsite/InternalSearchTGArn    - Search 服务 TG ARN
/eks/petsite/InternalPayForTGArn    - PayFor 服务 TG ARN
/petstore/cognito/userpool_id       - Cognito User Pool ID
/petstore/cognito/client_id         - Cognito Client ID
```

---

## 🎯 下一步

### 立即行动
1. 构建 ARM64 镜像
2. 准备 Kubernetes Manifests
3. 部署 CDK Stack
4. 验证功能

### 后续优化
1. 配置 HTTPS + ACM
2. 启用 HPA (自动扩缩容)
3. 配置 Service Mesh (Istio)
4. 实施 GitOps (ArgoCD)

---

**版本**: v2.0  
**架构**: 两层 ALB + 纯 EKS (Graviton)  
**作者**: 小乖乖 🐱  
**更新**: 2026-02-14
