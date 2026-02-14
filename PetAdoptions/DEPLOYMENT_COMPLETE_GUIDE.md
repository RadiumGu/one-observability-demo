# 🚀 ARM64 镜像构建和 K8s 部署指南

## 📦 文件清单

### 新增文件
- **build-arm64-images.sh** - ARM64 镜像构建脚本
- **deploy-k8s.sh** - Kubernetes 资源部署脚本
- **k8s-manifests/** - Kubernetes 资源清单目录
  - 00-namespace.yaml - Namespace
  - 01-payforadoption.yaml - PayForAdoption 服务
  - 02-listadoptions.yaml - ListAdoptions 服务
  - 03-petsearch.yaml - PetSearch 服务
  - 04-petsite.yaml - PetSite 前端
  - 05-configmap.yaml - 配置信息
  - 06-internal-ingress.yaml - 内部 ALB Ingress
  - 07-external-ingress.yaml - 外部 ALB Ingress

## 🎯 完整部署流程

### 阶段 1: 准备环境（10 分钟）

#### 1.1 确保 Docker Buildx 可用
```bash
docker buildx version
# 如果没有，运行:
docker buildx create --use
```

#### 1.2 配置 AWS 凭证
```bash
aws configure list
aws sts get-caller-identity
```

#### 1.3 确保 kubectl 和 EKS 访问
```bash
aws eks update-kubeconfig --name PetSite --region <REGION>
kubectl cluster-info
kubectl get nodes
```

---

### 阶段 2: 构建 ARM64 镜像（30-60 分钟）

#### 2.1 运行构建脚本
```bash
cd ~/tech/one-observability-demo/PetAdoptions

# 设置环境变量
export AWS_REGION=ap-northeast-1  # 你的 region
export IMAGE_TAG=v1.0.0            # 可选，默认 latest

# 运行构建
./build-arm64-images.sh
```

**脚本会自动**:
- 登录 ECR
- 创建 ECR 仓库（如果不存在）
- 构建 ARM64 镜像（5 个微服务）
- 推送到 ECR

#### 2.2 验证镜像
```bash
# 列出 ECR 仓库
aws ecr describe-repositories --region $AWS_REGION | grep petadoptions

# 查看镜像
aws ecr list-images --repository-name petadoptions/payforadoption --region $AWS_REGION
aws ecr list-images --repository-name petadoptions/listadoptions --region $AWS_REGION
aws ecr list-images --repository-name petadoptions/petsearch --region $AWS_REGION
aws ecr list-images --repository-name petadoptions/petsite --region $AWS_REGION
```

---

### 阶段 3: 部署 CDK Stack（15-20 分钟）

#### 3.1 应用新架构代码
```bash
cd ~/tech/one-observability-demo/PetAdoptions/cdk/pet_stack

# 备份原始文件
cp lib/services.ts lib/services-backup-original.ts

# 应用两层 ALB + 纯 EKS 架构
cp lib/services-eks-two-alb.ts lib/services.ts
```

#### 3.2 编译并部署
```bash
# 编译
npm run build

# 预览变更
cdk diff Services-PetStack

# 部署
cdk deploy Services-PetStack --require-approval never
```

#### 3.3 记录输出信息
部署完成后，记录以下输出:
- `ExternalALBDnsName` - 外部 ALB DNS
- `InternalALBDnsName` - 内部 ALB DNS
- `CognitoUserPoolId` - User Pool ID
- `CognitoUserPoolClientId` - Client ID
- `CognitoUserPoolDomain` - Cognito Domain

---

### 阶段 4: 部署 Kubernetes 资源（10-15 分钟）

#### 4.1 运行部署脚本
```bash
cd ~/tech/one-observability-demo/PetAdoptions

# 设置环境变量（如果需要）
export AWS_REGION=ap-northeast-1

# 运行部署
./deploy-k8s.sh
```

**脚本会自动**:
- 检查集群连接
- 获取 RDS Endpoint 和配置信息
- 替换 manifests 中的占位符
- 部署 Namespace, ConfigMap
- 部署所有微服务
- 部署 Internal 和 External Ingress
- 验证部署状态
- 输出 ALB DNS 地址

#### 4.2 验证部署
```bash
# 查看 Pod 状态（所有 Pod 应该 Running）
kubectl get pods -n petadoptions

# 查看 Service
kubectl get svc -n petadoptions

# 查看 Ingress
kubectl get ingress -n petadoptions

# 查看 Pod 在哪个节点（应该在 ARM64 节点）
kubectl get pods -n petadoptions -o wide

# 查看 Pod 日志
kubectl logs -n petadoptions deployment/payforadoption
kubectl logs -n petadoptions deployment/petsite
```

---

### 阶段 5: 配置 Cognito 认证（5 分钟）

#### 5.1 更新 Cognito 回调 URL
```bash
# 获取外部 ALB DNS
EXTERNAL_ALB_DNS=$(kubectl get ingress external-alb-ingress -n petadoptions -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

echo "外部 ALB DNS: $EXTERNAL_ALB_DNS"

# 获取 Cognito 信息
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

#### 5.2 创建测试用户
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

#### 5.3 配置外部 Ingress 的 Cognito 认证（可选，CDK 已配置）
如果需要通过 Kubernetes Ingress 配置 Cognito 认证：

```bash
# 获取 User Pool ARN
USER_POOL_ARN="arn:aws:cognito-idp:$AWS_REGION:$AWS_ACCOUNT_ID:userpool/$USER_POOL_ID"
COGNITO_DOMAIN=$(aws cloudformation describe-stacks \
  --stack-name Services-PetStack \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolDomain`].OutputValue' \
  --output text)

# 编辑 external Ingress
kubectl edit ingress external-alb-ingress -n petadoptions

# 取消注释并替换 Cognito 注解:
# alb.ingress.kubernetes.io/auth-type: cognito
# alb.ingress.kubernetes.io/auth-idp-cognito: '{"userPoolArn":"<USER_POOL_ARN>","userPoolClientId":"<CLIENT_ID>","userPoolDomain":"<COGNITO_DOMAIN>"}'
```

---

### 阶段 6: 验证部署（10 分钟）

#### 6.1 测试外部 ALB（前端）
```bash
# 获取外部 ALB DNS
EXTERNAL_ALB_DNS=$(kubectl get ingress external-alb-ingress -n petadoptions -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

echo "访问地址: http://$EXTERNAL_ALB_DNS"

# 测试（应该跳转到 Cognito 登录）
curl -I http://$EXTERNAL_ALB_DNS
```

#### 6.2 测试内部 ALB（后端 API）
```bash
# 获取内部 ALB DNS
INTERNAL_ALB_DNS=$(kubectl get ingress internal-alb-ingress -n petadoptions -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

echo "内部 ALB DNS: $INTERNAL_ALB_DNS"

# 从 VPC 内部测试（从某个 Pod 内）
kubectl run -it --rm curl --image=curlimages/curl --restart=Never -- \
  curl http://$INTERNAL_ALB_DNS/api/adoptionlist/
```

#### 6.3 检查 Target Health
```bash
# 列出 Target Groups
aws elbv2 describe-target-groups \
  --query 'TargetGroups[?contains(LoadBalancerArns[0], `PetAdoptions`)].TargetGroupArn' \
  --output text | while read TG_ARN; do
    echo "Target Group: $TG_ARN"
    aws elbv2 describe-target-health --target-group-arn $TG_ARN \
      --query 'TargetHealthDescriptions[*].[Target.Id,TargetHealth.State]' \
      --output table
    echo ""
done
```

---

## 🎯 部署验证检查清单

### CDK Stack
- [ ] 外部 ALB 创建成功（Internet-facing）
- [ ] 内部 ALB 创建成功（Internal）
- [ ] EKS Graviton Node Group 创建（2-10 节点）
- [ ] Cognito User Pool 和 Client 创建
- [ ] SSM Parameters 更新完成

### Kubernetes 资源
- [ ] Namespace `petadoptions` 创建
- [ ] ConfigMap 包含正确的配置
- [ ] 所有 Deployment 创建（4 个）
- [ ] 所有 Service 创建（4 个）
- [ ] Internal Ingress 创建 ALB
- [ ] External Ingress 创建 ALB
- [ ] 所有 Pod 状态为 Running
- [ ] 所有 Pod 运行在 ARM64 节点

### 功能验证
- [ ] 外部 ALB → 跳转到 Cognito 登录
- [ ] 登录成功 → 访问 PetSite 前端
- [ ] 前端调用后端 API 成功（通过内部 ALB）
- [ ] 后端服务无法从公网直接访问 ✅
- [ ] 内部 ALB 只能从 VPC 内访问 ✅

---

## 🛠️ 故障排查

### 问题 1: 镜像构建失败
**症状**: Docker buildx 报错

**解决**:
```bash
# 检查 buildx
docker buildx ls

# 创建新的 builder
docker buildx create --name arm64-builder --use
docker buildx inspect --bootstrap
```

### 问题 2: Pod 无法启动（ImagePullBackOff）
**症状**: Pod 状态为 ImagePullBackOff

**排查**:
```bash
# 查看 Pod 详情
kubectl describe pod <POD_NAME> -n petadoptions

# 检查 ECR 权限
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY

# 检查镜像是否存在
aws ecr describe-images --repository-name petadoptions/payforadoption --region $AWS_REGION
```

### 问题 3: Ingress 未创建 ALB
**症状**: `kubectl get ingress` 没有 ADDRESS

**排查**:
```bash
# 检查 AWS Load Balancer Controller
kubectl get pods -n kube-system | grep aws-load-balancer-controller

# 查看 Controller 日志
kubectl logs -n kube-system deployment/aws-load-balancer-controller

# 检查 IAM 权限
kubectl describe sa alb-ingress-controller -n kube-system
```

### 问题 4: Target Group 不健康
**症状**: ALB 返回 503

**排查**:
```bash
# 检查 Target Health
aws elbv2 describe-target-health --target-group-arn <TG_ARN>

# 检查 Pod 健康检查
kubectl logs -n petadoptions <POD_NAME>

# 进入 Pod 测试
kubectl exec -it -n petadoptions <POD_NAME> -- /bin/sh
wget -O- http://localhost:80/health/status
```

---

## 📝 清理资源

如果需要清理所有资源：

```bash
# 删除 Kubernetes 资源
kubectl delete namespace petadoptions

# 删除 CDK Stack
cd ~/tech/one-observability-demo/PetAdoptions/cdk/pet_stack
cdk destroy Services-PetStack

# 删除 ECR 镜像
aws ecr batch-delete-image \
  --repository-name petadoptions/payforadoption \
  --image-ids imageTag=latest \
  --region $AWS_REGION
# (重复其他仓库)
```

---

## 📊 监控和日志

### 查看 Pod 日志
```bash
# 实时查看
kubectl logs -f -n petadoptions deployment/payforadoption

# 查看所有 Pod
kubectl logs -n petadoptions -l app=payforadoption --tail=100
```

### CloudWatch 日志
```bash
# 查看 EKS 日志
aws logs tail /aws/eks/PetSite/cluster --follow
```

### 监控指标
```bash
# Pod 资源使用
kubectl top pods -n petadoptions

# Node 资源使用
kubectl top nodes
```

---

**创建时间**: 2026-02-14  
**作者**: 小乖乖 🐱  
**版本**: v1.0
