# 🏗️ 两层 ALB + 纯 EKS (Graviton) 架构 - 部署指南

## 📋 新架构设计

### 🎯 核心理念
- **外部 ALB**: Internet-facing, HTTPS + Cognito 认证，只暴露 PetSite 前端
- **内部 ALB**: Internal, VPC 内部，Host/Path 路由到各微服务
- **纯 EKS**: 删除所有 ECS 集群，统一到 EKS + Graviton EC2
- **安全隔离**: 后端服务不直接暴露公网，只能通过内部 ALB 访问

---

## 🌐 架构图

```
互联网用户
    │
    ▼ HTTPS + Cognito 认证
┌─────────────────────────┐
│  外部 ALB (Public)       │  ← Internet-facing
│  只暴露: PetSite 前端    │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  PetSite Pod (EKS)      │  ← 前端应用
│  React / Next.js        │
└────────┬────────────────┘
         │ 调用后端 API
         ▼
┌─────────────────────────┐
│  内部 ALB (Internal)    │  ← VPC 内部，不暴露公网
│  Host/Path 路由         │
└────────┬────────────────┘
         │
    ┌────┴────┬────────┬────────┬────────┐
    ▼         ▼        ▼        ▼        ▼
┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐
│  List  ││ Search ││ PayFor ││Traffic ││History │
│  Pod   ││  Pod   ││  Pod   ││  Pod   ││  Pod   │
└────────┘└────────┘└────────┘└────────┘└────────┘
    │         │        │        │        │
    └─────────┴────────┴────────┴────────┘
                │
                ▼
        ┌───────────────┐
        │  RDS Aurora   │
        │  DynamoDB     │
        │  S3, SNS, SQS │
        └───────────────┘

所有服务运行在 EKS Graviton 节点上 (ARM64)
```

---

## 🔐 安全层级

```
Layer 4: 用户认证
  ↓ Cognito OAuth2
Layer 3: 外部 ALB (Cognito 认证检查)
  ↓ 只转发到 PetSite 前端
Layer 2: PetSite 前端 (EKS)
  ↓ 调用后端 API
Layer 1: 内部 ALB (VPC 内部)
  ↓ 路由到微服务
Layer 0: 微服务 Pod (EKS)
  ↓ 访问数据层
Data Layer: RDS, DynamoDB, S3
```

---

## 🎯 架构优势

### ✅ 安全性提升
- **外部隔离**: 后端服务不直接暴露公网
- **统一认证**: 只在外部 ALB 做 Cognito 认证
- **内部通信**: 服务间通过内部 ALB，无需公网认证
- **纵深防御**: 多层防护（Cognito → 外部 ALB → 内部 ALB → Pod）

### ✅ 架构简化
- **无 ECS**: 删除所有 ECS 集群和 Fargate 任务
- **统一平台**: 所有服务运行在 EKS
- **统一管理**: kubectl 统一管理所有服务
- **统一监控**: 使用 EKS 原生监控工具

### ✅ 成本优化
- **Graviton**: 比 x86 便宜 20%，性能提升 40%
- **无 Fargate**: 按需付费 → 预留实例（更便宜）
- **统一集群**: 共享计算资源，提升利用率

---

## 📦 核心改动

### 删除的组件
- ❌ ECS Cluster (PayForAdoption)
- ❌ ECS Cluster (PetListAdoptions)
- ❌ ECS Cluster (PetSearch)
- ❌ ECS Fargate Tasks
- ❌ 所有 ECS 相关配置

### 新增的组件
- ✅ 外部 ALB (Internet-facing) + Cognito
- ✅ 内部 ALB (Internal) + Host/Path 路由
- ✅ EKS Graviton Node Group (T4G/M6G, ARM64)
- ✅ 微服务 Target Groups (内部 ALB)

### 保留的组件
- ✅ EKS Cluster (已有)
- ✅ RDS Aurora PostgreSQL
- ✅ DynamoDB, S3, SNS, SQS
- ✅ Lambda Functions
- ✅ Step Functions

---

## 🚀 部署步骤

### 1. 准备 Kubernetes Manifests

创建微服务的 Deployment 和 Service manifests（需要你提供或修改现有的）：

```bash
mkdir -p ~/tech/one-observability-demo/PetAdoptions/cdk/pet_stack/k8s-manifests
```

#### List Service (list-adoption-service.yaml)
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: list-adoption-service
  namespace: petadoptions
spec:
  replicas: 2
  selector:
    matchLabels:
      app: list-adoption
  template:
    metadata:
      labels:
        app: list-adoption
    spec:
      nodeSelector:
        arch: arm64  # Graviton 节点
      containers:
      - name: list-adoption
        image: <YOUR_ECR_REPO>/list-adoption-service:arm64
        ports:
        - containerPort: 80
        env:
        - name: RDS_ENDPOINT
          valueFrom:
            secretKeyRef:
              name: rds-secret
              key: endpoint
        livenessProbe:
          httpGet:
            path: /health/status
            port: 80
          initialDelaySeconds: 30
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: list-adoption-service
  namespace: petadoptions
  annotations:
    alb.ingress.kubernetes.io/target-type: ip
spec:
  type: NodePort
  selector:
    app: list-adoption
  ports:
  - port: 80
    targetPort: 80
```

类似地创建：
- `search-service.yaml`
- `payfor-service.yaml`
- `traffic-service.yaml`
- `pethistory-service.yaml`

#### Internal ALB Ingress (internal-alb-ingress.yaml)
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: internal-alb-ingress
  namespace: petadoptions
  annotations:
    alb.ingress.kubernetes.io/scheme: internal  # 内部 ALB
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/healthcheck-path: /health/status
    alb.ingress.kubernetes.io/load-balancer-name: PetAdoptions-Internal-ALB
    alb.ingress.kubernetes.io/group.name: petadoptions-internal
spec:
  ingressClassName: alb
  rules:
  - http:
      paths:
      - path: /api/adoptionlist/*
        pathType: Prefix
        backend:
          service:
            name: list-adoption-service
            port:
              number: 80
      - path: /api/search*
        pathType: Prefix
        backend:
          service:
            name: search-service
            port:
              number: 80
      - path: /api/payforadoption/*
        pathType: Prefix
        backend:
          service:
            name: payfor-service
            port:
              number: 80
      - path: /api/home/*
        pathType: Prefix
        backend:
          service:
            name: payfor-service
            port:
              number: 80
      - path: /traffic/*
        pathType: Prefix
        backend:
          service:
            name: traffic-service
            port:
              number: 80
      - path: /petadoptionshistory/*
        pathType: Prefix
        backend:
          service:
            name: pethistory-service
            port:
              number: 80
```

#### External ALB Ingress (external-alb-ingress.yaml)
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: external-alb-ingress
  namespace: petadoptions
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing  # 外部 ALB
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/load-balancer-name: PetAdoptions-External-ALB
    alb.ingress.kubernetes.io/group.name: petadoptions-external
    alb.ingress.kubernetes.io/auth-type: cognito
    alb.ingress.kubernetes.io/auth-idp-cognito: '{"userPoolArn":"<USER_POOL_ARN>","userPoolClientId":"<CLIENT_ID>","userPoolDomain":"<DOMAIN>"}'
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
spec:
  ingressClassName: alb
  rules:
  - http:
      paths:
      - path: /*
        pathType: Prefix
        backend:
          service:
            name: petsite-service
            port:
              number: 80
```

### 2. 构建 ARM64 容器镜像

所有微服务需要构建 ARM64 版本：

```bash
# 使用 Docker Buildx 构建 ARM64 镜像
docker buildx build --platform linux/arm64 -t <ECR_REPO>/list-adoption-service:arm64 .
docker buildx build --platform linux/arm64 -t <ECR_REPO>/search-service:arm64 .
docker buildx build --platform linux/arm64 -t <ECR_REPO>/payfor-service:arm64 .
docker buildx build --platform linux/arm64 -t <ECR_REPO>/traffic-service:arm64 .

# 推送到 ECR
docker push <ECR_REPO>/list-adoption-service:arm64
```

或使用 multi-arch 镜像：
```bash
docker buildx build --platform linux/amd64,linux/arm64 -t <ECR_REPO>/service:latest --push .
```

### 3. 部署 CDK Stack

```bash
cd ~/tech/one-observability-demo/PetAdoptions/cdk/pet_stack

# 备份旧文件
cp lib/services.ts lib/services-backup-$(date +%Y%m%d).ts

# 应用新架构
cp lib/services-eks-two-alb.ts lib/services.ts

# 编译
npm run build

# 预览变更
cdk diff Services-PetStack

# 部署
cdk deploy Services-PetStack --require-approval never
```

**预计变更**:
- ❌ 删除: 3 个 ECS 集群
- ❌ 删除: 所有 ECS Fargate 任务
- ✅ 创建: 外部 ALB + Cognito 认证
- ✅ 创建: 内部 ALB
- ✅ 创建: EKS Graviton Node Group
- ✅ 创建: 6 个 Target Groups（内部 ALB）
- ✅ 创建: 1 个 Target Group（外部 ALB）

### 4. 部署 Kubernetes 资源

```bash
# 获取 EKS 集群凭证
aws eks update-kubeconfig --name PetSite --region <REGION>

# 创建 namespace
kubectl create namespace petadoptions

# 部署微服务
kubectl apply -f k8s-manifests/list-adoption-service.yaml
kubectl apply -f k8s-manifests/search-service.yaml
kubectl apply -f k8s-manifests/payfor-service.yaml
kubectl apply -f k8s-manifests/traffic-service.yaml
kubectl apply -f k8s-manifests/pethistory-service.yaml
kubectl apply -f k8s-manifests/petsite-service.yaml

# 部署 Ingress (会自动创建 ALB)
kubectl apply -f k8s-manifests/internal-alb-ingress.yaml
kubectl apply -f k8s-manifests/external-alb-ingress.yaml
```

### 5. 验证部署

```bash
# 检查 Pod 状态
kubectl get pods -n petadoptions

# 检查 Service
kubectl get svc -n petadoptions

# 检查 Ingress
kubectl get ingress -n petadoptions

# 检查 Graviton 节点
kubectl get nodes -l arch=arm64

# 查看 Pod 在哪个节点
kubectl get pods -n petadoptions -o wide
```

### 6. 更新 Cognito 回调 URL

```bash
# 获取外部 ALB DNS
EXTERNAL_ALB_DNS=$(aws cloudformation describe-stacks \
  --stack-name Services-PetStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ExternalALBDnsName`].OutputValue' \
  --output text)

USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name Services-PetStack \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolId`].OutputValue' \
  --output text)

CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name Services-PetStack \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolClientId`].OutputValue' \
  --output text)

# 更新回调 URL
aws cognito-idp update-user-pool-client \
  --user-pool-id $USER_POOL_ID \
  --client-id $CLIENT_ID \
  --callback-urls "http://$EXTERNAL_ALB_DNS/oauth2/idpresponse" \
  --logout-urls "http://$EXTERNAL_ALB_DNS/" \
  --supported-identity-providers COGNITO
```

### 7. 创建测试用户

```bash
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username testuser \
  --user-attributes Name=email,Value=test@example.com \
  --temporary-password 'TempPass123!' \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username testuser \
  --password 'SecurePass123!' \
  --permanent
```

### 8. 测试访问

```bash
echo "外部访问（需要认证）:"
echo "http://$EXTERNAL_ALB_DNS"

# 测试后端服务（需要从 VPC 内部）
INTERNAL_ALB_DNS=$(aws cloudformation describe-stacks \
  --stack-name Services-PetStack \
  --query 'Stacks[0].Outputs[?OutputKey==`InternalALBDnsName`].OutputValue' \
  --output text)

echo "内部 ALB（VPC 内部访问）:"
echo "http://$INTERNAL_ALB_DNS/api/adoptionlist/"
echo "http://$INTERNAL_ALB_DNS/api/search?query=dog"
```

---

## 🔍 验证清单

### CDK Stack 验证
- [ ] 外部 ALB 创建成功（Internet-facing）
- [ ] 内部 ALB 创建成功（Internal）
- [ ] EKS Graviton Node Group 创建（2-10 节点）
- [ ] Cognito User Pool 和 Client 创建
- [ ] 所有 Target Groups 创建（7 个）
- [ ] SSM Parameters 更新

### Kubernetes 验证
- [ ] 所有 Pod 运行在 ARM64 节点上
- [ ] 所有 Pod 状态为 Running
- [ ] 所有 Service 创建成功
- [ ] Internal ALB Ingress 创建成功
- [ ] External ALB Ingress 创建成功
- [ ] Ingress 关联到正确的 ALB

### 功能验证
- [ ] 访问外部 ALB → 重定向到 Cognito 登录
- [ ] 登录成功 → 访问 PetSite 前端
- [ ] 前端调用后端 API → 通过内部 ALB
- [ ] 后端服务无法直接从公网访问
- [ ] 服务间通信正常（通过内部 ALB）

---

## 💰 成本对比

### 之前 (ECS + 多 ALB)
- ECS Fargate: ~$150/月
- ALB (5 个): ~$191/月
- **总计**: ~$341/月

### 之后 (EKS Graviton + 2 ALB)
- EKS 控制平面: $73/月
- Graviton EC2 (3 × t4g.medium): ~$45/月
- ALB (2 个): ~$70/月
- **总计**: ~$188/月

**节省**: ~$153/月 (45% ↓)

---

## 🛠️ 故障排查

### 问题 1: Pod 无法启动
**症状**: Pod 状态为 CrashLoopBackOff 或 ImagePullBackOff

**排查**:
```bash
kubectl describe pod <POD_NAME> -n petadoptions
kubectl logs <POD_NAME> -n petadoptions
```

**常见原因**:
- 镜像不是 ARM64 架构
- 镜像不存在或 ECR 权限问题
- 环境变量配置错误
- 健康检查路径错误

### 问题 2: Ingress 未创建 ALB
**症状**: `kubectl get ingress` 没有 ADDRESS

**排查**:
```bash
kubectl describe ingress internal-alb-ingress -n petadoptions
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
```

**常见原因**:
- AWS Load Balancer Controller 未安装
- ServiceAccount 权限不足
- Subnet 标签缺失
- Security Group 配置错误

### 问题 3: 外部 ALB 无法访问
**症状**: 访问外部 ALB DNS 超时或 503

**排查**:
```bash
# 检查 Target Health
aws elbv2 describe-target-health --target-group-arn <TG_ARN>

# 检查 Pod
kubectl get pods -n petadoptions -l app=petsite

# 检查 Service
kubectl get svc petsite-service -n petadoptions
```

### 问题 4: 内部 ALB 无法从 PetSite 访问
**症状**: 前端调用后端 API 失败

**排查**:
```bash
# 从 PetSite Pod 测试内部 ALB
kubectl exec -it <PETSITE_POD> -n petadoptions -- curl http://<INTERNAL_ALB_DNS>/api/adoptionlist/

# 检查 Security Group
# 确保 PetSite Pod 所在的 Security Group 可以访问内部 ALB
```

---

## 📊 架构对比

| 维度 | 旧架构 (ECS + 多 ALB) | 新架构 (EKS + 两层 ALB) |
|------|----------------------|------------------------|
| **计算平台** | ECS Fargate + EKS | 纯 EKS (Graviton) |
| **ALB 数量** | 5 个 | 2 个（外部+内部） |
| **认证方式** | 无统一认证 | Cognito (外部 ALB) |
| **后端暴露** | 直接暴露公网 | VPC 内部（内部 ALB） |
| **架构** | x86 | ARM64 (Graviton) |
| **管理工具** | ECS CLI + kubectl | kubectl |
| **月度成本** | ~$341 | ~$188 |
| **安全性** | 中 | 高 |

---

## 🎯 后续优化

### 短期（1-2 周）
- [ ] 配置 HTTPS + ACM 证书（外部 ALB）
- [ ] 配置 WAF（外部 ALB）
- [ ] 启用 ALB 访问日志
- [ ] 配置 HPA (Horizontal Pod Autoscaler)

### 中期（1-2 月）
- [ ] 配置 Service Mesh (Istio/Linkerd)
- [ ] 启用 mTLS（服务间通信）
- [ ] 配置 Network Policy
- [ ] 集成 ArgoCD (GitOps)

### 长期（3+ 月）
- [ ] 多集群架构（生产/预发布/测试）
- [ ] 跨区域部署（高可用）
- [ ] 实施 FinOps（成本优化）
- [ ] 零信任网络架构

---

**文档版本**: v2.0  
**更新时间**: 2026-02-14  
**架构**: 两层 ALB + 纯 EKS (Graviton)  
**作者**: 小乖乖 🐱
