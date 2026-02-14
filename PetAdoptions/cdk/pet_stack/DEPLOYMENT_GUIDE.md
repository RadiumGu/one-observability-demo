# 统一 ALB + Cognito 认证 - 部署指南

## 📋 架构改动概述

### 之前的架构：
- ❌ PetSite ALB
- ❌ List Service ALB (独立)
- ❌ Search Service ALB (独立)
- ❌ PayFor Service ALB (独立)
- ❌ Traffic Service ALB (独立)
- ❌ 无统一认证

### 新架构：
- ✅ **统一 ALB** (所有服务)
- ✅ **Cognito 用户池** (统一认证)
- ✅ **共享 ECS 集群** (降低成本)
- ✅ **路径路由** (智能分发)

## 🔐 安全改进

1. **统一认证入口**
   - 所有 HTTP 请求先经过 Cognito 认证
   - 支持邮箱/用户名登录
   - OAuth2 授权码流程

2. **安全组简化**
   - 单一 ALB 安全组
   - 统一管理入站规则

## 📍 路径路由规则

| 优先级 | 路径 | 目标服务 |
|--------|------|----------|
| 10 | `/api/payforadoption/*`, `/api/home/*` | PayForAdoption |
| 20 | `/api/adoptionlist/*` | ListAdoptions |
| 30 | `/api/search*` | Search |
| 40 | `/traffic/*` | Traffic Generator |
| 50 | `/petadoptionshistory/*` | PetHistory (EKS) |
| 100 | `/*` | PetSite (EKS, 默认) |

## 🚀 部署步骤

### 1. 备份当前配置

```bash
cd ~/tech/one-observability-demo/PetAdoptions/cdk/pet_stack
cp lib/services.ts lib/services-backup-$(date +%Y%m%d).ts
```

### 2. 替换 Stack 文件

```bash
# 方式 A: 完全替换（推荐全新部署）
cp lib/services-unified-alb.ts lib/services.ts

# 方式 B: 保留旧文件，修改 app 入口
# 编辑 app/pet_stack.ts，指向新的 Stack
```

### 3. 编译 TypeScript

```bash
npm run build
```

### 4. 预览变更

```bash
cdk diff Services-PetStack
```

⚠️ **重要**：会显示以下资源将被**删除**和**创建**：
- 删除：旧的 3 个独立 ALB
- 创建：新的统一 ALB + Cognito 资源

### 5. 部署新架构

```bash
# 全新部署（推荐）
cdk deploy Services-PetStack --require-approval never

# 如果需要保留数据，先备份
# - RDS 快照
# - DynamoDB 备份
# - S3 数据已有自动备份
```

## 🔑 部署后配置

### 1. 更新 Cognito 回调 URL

部署完成后，从输出中获取 `UnifiedALBDnsName`：

```bash
# 获取 ALB DNS
ALB_DNS=$(aws cloudformation describe-stacks \
  --stack-name Services-PetStack \
  --query 'Stacks[0].Outputs[?OutputKey==`UnifiedALBDnsName`].OutputValue' \
  --output text)

# 获取 User Pool Client ID
CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name Services-PetStack \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolClientId`].OutputValue' \
  --output text)

# 获取 User Pool ID
POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name Services-PetStack \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolId`].OutputValue' \
  --output text)

echo "ALB DNS: http://${ALB_DNS}"
echo "User Pool: ${POOL_ID}"
echo "Client ID: ${CLIENT_ID}"
```

### 2. 手动更新回调 URL（首次部署需要）

由于 CDK 部署时 ALB DNS 还不存在，需要手动更新：

```bash
# 更新 Cognito User Pool Client 的回调 URL
aws cognito-idp update-user-pool-client \
  --user-pool-id ${POOL_ID} \
  --client-id ${CLIENT_ID} \
  --callback-urls "http://${ALB_DNS}/oauth2/idpresponse" \
  --logout-urls "http://${ALB_DNS}/" \
  --supported-identity-providers COGNITO
```

或通过 AWS Console：
1. 进入 Cognito → User Pools → PetAdoptionsUserPool
2. 点击 App Integration → PetAdoptionsWebClient
3. 编辑 Hosted UI 设置
4. 添加 Callback URL: `http://<ALB_DNS>/oauth2/idpresponse`
5. 添加 Sign-out URL: `http://<ALB_DNS>/`

### 3. 创建测试用户

```bash
# 方式 A: 通过 CLI
aws cognito-idp admin-create-user \
  --user-pool-id ${POOL_ID} \
  --username testuser \
  --user-attributes Name=email,Value=test@example.com \
  --temporary-password 'TempPass123!' \
  --message-action SUPPRESS

# 设置永久密码
aws cognito-idp admin-set-user-password \
  --user-pool-id ${POOL_ID} \
  --username testuser \
  --password 'SecurePass123!' \
  --permanent

# 方式 B: 通过 Hosted UI 自助注册
# 访问输出中的 CognitoHostedUI URL
```

## 🧪 测试访问

### 1. 访问应用

```bash
# 获取应用 URL
echo "应用地址: http://${ALB_DNS}"
```

浏览器访问 → 自动跳转到 Cognito 登录页面 → 登录后返回应用

### 2. 测试各个服务路径

```bash
# PetSite (主页)
curl -I http://${ALB_DNS}/

# Search API
curl -I http://${ALB_DNS}/api/search?query=dog

# List Adoptions
curl -I http://${ALB_DNS}/api/adoptionlist/

# Pet History
curl -I http://${ALB_DNS}/petadoptionshistory/
```

所有请求都会返回 `302 Found`，重定向到 Cognito 登录页面（未认证时）。

## 📊 验证部署

```bash
# 1. 检查 ALB
aws elbv2 describe-load-balancers \
  --names PetAdoptions-Unified-ALB \
  --query 'LoadBalancers[0].[State.Code,DNSName]'

# 2. 检查 Target Groups
aws elbv2 describe-target-groups \
  --query 'TargetGroups[?starts_with(TargetGroupName, `PayForAdoption`) || starts_with(TargetGroupName, `ListAdoptions`) || starts_with(TargetGroupName, `Search`)].TargetGroupName'

# 3. 检查 ECS 服务健康状态
aws ecs describe-services \
  --cluster PetAdoptions-Shared-Cluster \
  --services pay-for-adoption-service list-adoptions-service search-service \
  --query 'services[].[serviceName,desiredCount,runningCount,status]'

# 4. 检查 Cognito 用户池
aws cognito-idp describe-user-pool \
  --user-pool-id ${POOL_ID} \
  --query 'UserPool.[Name,Status,EstimatedNumberOfUsers]'
```

## 🔄 迁移策略（如果是升级现有环境）

### 方案 A: 蓝绿部署（推荐）

1. 部署新 Stack（新名称）
2. 验证功能完整性
3. 更新 DNS/Route53
4. 删除旧 Stack

```bash
# 部署到新 Stack
cdk deploy Services-PetStack-V2 -c stack_suffix=v2

# 验证完成后删除旧 Stack
cdk destroy Services-PetStack
```

### 方案 B: 原地升级（高风险）

⚠️ **警告**：会导致短暂服务中断（~5-10分钟）

1. 导出数据（RDS/DynamoDB）
2. 执行 `cdk deploy Services-PetStack`
3. 旧 ALB 被删除，新 ALB 创建
4. 等待 ECS 任务健康
5. 更新 DNS（如果有）

## 🛠️ 故障排查

### 问题 1: Cognito 回调失败

**症状**：登录后出现 "redirect_mismatch" 错误

**解决**：
```bash
# 检查回调 URL 配置
aws cognito-idp describe-user-pool-client \
  --user-pool-id ${POOL_ID} \
  --client-id ${CLIENT_ID} \
  --query 'UserPoolClient.CallbackURLs'

# 应该包含：http://<ALB_DNS>/oauth2/idpresponse
```

### 问题 2: Target Group 不健康

**症状**：ALB 返回 503

**解决**：
```bash
# 检查 Target Health
aws elbv2 describe-target-health \
  --target-group-arn <TARGET_GROUP_ARN>

# 检查 ECS 任务日志
aws logs tail /ecs/PayForAdoption --follow
```

### 问题 3: 认证循环

**症状**：不断重定向到登录页

**解决**：
1. 检查浏览器 Cookie 设置
2. 清除浏览器缓存和 Cookie
3. 验证 User Pool Domain 配置

## 💰 成本优化

### 之前（5 个 ALB）
- ALB: $16.20/month × 5 = **$81/month**
- LCU: 约 $22/月 × 5 = **$110/month**
- **总计**: ~$191/month

### 现在（1 个 ALB）
- ALB: $16.20/month × 1 = **$16.20/month**
- LCU: 约 $30/月 (合并后略高) = **$30/month**
- Cognito: 50,000 MAU 免费，超出 $0.0055/MAU
- **总计**: ~$46/month（不含 Cognito）

**节省**: ~$145/month (~76% 成本降低)

## 🔗 输出参数

部署完成后，Stack 会输出以下参数：

| 参数 | 说明 |
|------|------|
| `UnifiedALBDnsName` | 统一 ALB 的 DNS 地址 |
| `CognitoUserPoolId` | 用户池 ID |
| `CognitoUserPoolClientId` | 应用客户端 ID |
| `CognitoHostedUI` | Cognito 登录页面 URL |
| `PetSiteUrl` | 应用主页 URL |

## 📝 后续改进建议

1. **HTTPS 支持**
   - 申请 ACM 证书
   - 配置 Route53 域名
   - 修改 Listener 为 443

2. **高级认证**
   - 添加社交登录（Google, Facebook）
   - 启用 MFA
   - 自定义登录页面

3. **监控告警**
   - ALB 访问日志到 S3
   - Cognito 登录失败告警
   - Target Group 健康检查告警

4. **WAF 防护**
   - 关联 AWS WAF
   - 配置速率限制
   - SQL 注入防护

## ✅ 完成检查清单

- [ ] 备份现有配置和数据
- [ ] 编译并预览变更 (`cdk diff`)
- [ ] 部署新 Stack (`cdk deploy`)
- [ ] 更新 Cognito 回调 URL
- [ ] 创建测试用户
- [ ] 测试登录流程
- [ ] 验证各服务路径
- [ ] 检查 Target Group 健康状态
- [ ] 更新应用配置（如有）
- [ ] 删除旧资源（如适用）
- [ ] 更新文档和团队通知

## 🆘 需要帮助？

如果遇到问题：
1. 检查 CloudWatch Logs
2. 查看 CloudFormation 事件
3. 运行 `cdk doctor` 检查环境
4. 确认 IAM 权限充足

---

**注意**：生产环境部署前，请在测试环境充分验证！
