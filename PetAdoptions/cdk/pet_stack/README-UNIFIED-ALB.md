# 统一 ALB + Cognito 认证改造

## 📦 包含的文件

### 核心文件
- **lib/services-unified-alb.ts** - 新的统一架构 CDK Stack
- **DEPLOYMENT_GUIDE.md** - 详细部署指南和配置说明
- **ARCHITECTURE_COMPARISON.md** - 架构对比和改动详情

### 工具脚本
- **deploy-unified-alb.sh** - 一键部署脚本
- **rollback.sh** - 快速回滚脚本

## 🎯 改造目标

将现有的 **5 个独立 ALB** 合并为 **1 个统一 ALB**，并添加 **Cognito 认证**，实现：

✅ **降低成本 76%** (约 $145/月)  
✅ **统一认证入口** (Cognito OAuth2)  
✅ **简化架构** (合并 ECS 集群)  
✅ **提升安全性** (ALB 层认证)  

## 🚀 快速开始

### 方式 1: 使用自动化脚本（推荐）

```bash
cd ~/tech/one-observability-demo/PetAdoptions/cdk/pet_stack

# 运行部署脚本
./deploy-unified-alb.sh
```

脚本会自动：
1. ✓ 备份现有配置
2. ✓ 应用新架构文件
3. ✓ 编译 TypeScript
4. ✓ 预览变更（可选）
5. ✓ 执行部署
6. ✓ 显示后续步骤

### 方式 2: 手动部署

```bash
# 1. 备份现有文件
cp lib/services.ts lib/services-backup-$(date +%Y%m%d).ts

# 2. 应用新架构
cp lib/services-unified-alb.ts lib/services.ts

# 3. 编译
npm run build

# 4. 预览变更
cdk diff Services-PetStack

# 5. 部署
cdk deploy Services-PetStack --require-approval never
```

## 📋 部署后配置

部署完成后，**必须**执行以下步骤：

### 1. 更新 Cognito 回调 URL

```bash
# 获取部署信息
ALB_DNS=$(aws cloudformation describe-stacks \
  --stack-name Services-PetStack \
  --query 'Stacks[0].Outputs[?OutputKey==`UnifiedALBDnsName`].OutputValue' \
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
  --callback-urls "http://$ALB_DNS/oauth2/idpresponse" \
  --logout-urls "http://$ALB_DNS/" \
  --supported-identity-providers COGNITO
```

### 2. 创建测试用户

```bash
# 创建用户
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username testuser \
  --user-attributes Name=email,Value=test@example.com \
  --temporary-password 'TempPass123!' \
  --message-action SUPPRESS

# 设置永久密码
aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username testuser \
  --password 'SecurePass123!' \
  --permanent
```

### 3. 测试访问

```bash
echo "应用地址: http://$ALB_DNS"
```

浏览器访问 → Cognito 登录页 → 输入 testuser / SecurePass123! → 成功登录 🎉

## 🔄 架构对比

### 之前
```
互联网
  │
  ├── PetSite ALB ─→ EKS
  ├── List ALB ─→ ECS Cluster 1
  ├── Search ALB ─→ ECS Cluster 2
  ├── PayFor ALB ─→ ECS Cluster 3
  └── Traffic ALB ─→ ECS Cluster 4

❌ 5 个 ALB
❌ 4 个 ECS 集群
❌ 无认证
```

### 之后
```
互联网
  │
  └── 统一 ALB (Cognito 认证)
       │
       ├── /* ─→ PetSite (EKS)
       ├── /api/adoptionlist/* ─→ ListAdoptions
       ├── /api/search* ─→ Search
       ├── /api/payforadoption/* ─→ PayForAdoption
       ├── /petadoptionshistory/* ─→ PetHistory
       └── [共享 ECS 集群]

✅ 1 个 ALB
✅ 1 个共享 ECS 集群
✅ Cognito OAuth2 认证
```

## 🛡️ 安全改进

| 特性 | 之前 | 之后 |
|------|------|------|
| 认证 | ❌ 无 | ✅ Cognito OAuth2 |
| 会话管理 | ❌ 无 | ✅ ALB Cookie |
| 密码策略 | ❌ 无 | ✅ 强密码要求 |
| 多因素认证 | ❌ 不支持 | ✅ 可选 MFA |
| 社交登录 | ❌ 不支持 | ✅ 可扩展 |

## 💰 成本对比

### 之前
- ALB: $16.20 × 5 = **$81/月**
- LCU: $22 × 5 = **$110/月**
- **总计**: ~**$191/月**

### 之后
- ALB: $16.20 × 1 = **$16.20/月**
- LCU: ~$30/月（合并后）
- Cognito: 50,000 MAU 免费
- **总计**: ~**$46/月**

💡 **节省**: ~**$145/月** (76% ↓)

## 📍 路径路由规则

| 优先级 | 路径模式 | 目标服务 |
|--------|---------|----------|
| 10 | `/api/payforadoption/*`, `/api/home/*` | PayForAdoption |
| 20 | `/api/adoptionlist/*` | ListAdoptions |
| 30 | `/api/search*` | Search |
| 40 | `/traffic/*` | Traffic |
| 50 | `/petadoptionshistory/*` | PetHistory |
| 100 | `/*` | PetSite (默认) |

## 🔧 验证部署

```bash
# 检查 ALB 状态
aws elbv2 describe-load-balancers \
  --names PetAdoptions-Unified-ALB \
  --query 'LoadBalancers[0].[State.Code,DNSName]'

# 检查 Target Groups
aws elbv2 describe-target-groups \
  --query 'TargetGroups[?contains(TargetGroupName, `PetAdoptions`)].TargetGroupName'

# 检查 ECS 服务
aws ecs describe-services \
  --cluster PetAdoptions-Shared-Cluster \
  --services pay-for-adoption-service list-adoptions-service search-service \
  --query 'services[].[serviceName,status,runningCount]'

# 检查 Cognito 用户池
aws cognito-idp describe-user-pool \
  --user-pool-id $USER_POOL_ID \
  --query 'UserPool.[Name,Status]'
```

## 🔄 回滚步骤

如果需要回滚到原架构：

```bash
# 运行回滚脚本
./rollback.sh
```

或手动回滚：

```bash
# 1. 恢复备份
cp lib/services-backup-YYYYMMDD.ts lib/services.ts

# 2. 编译
npm run build

# 3. 重新部署
cdk deploy Services-PetStack
```

## 📚 详细文档

- **[DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)** - 完整部署流程、配置和故障排查
- **[ARCHITECTURE_COMPARISON.md](./ARCHITECTURE_COMPARISON.md)** - 架构详细对比和代码改动

## ⚠️ 重要注意事项

### 部署前
1. ✅ 在测试环境先验证
2. ✅ 备份 RDS 数据（自动快照）
3. ✅ 通知相关团队（预计 10-15 分钟中断）
4. ✅ 确认有 CDK 和 AWS CLI 权限

### 部署后
1. ✅ 更新 Cognito 回调 URL（必须）
2. ✅ 创建至少一个测试用户
3. ✅ 验证所有服务路径可访问
4. ✅ 检查 Target Group 健康状态
5. ✅ 更新监控 Dashboard（如有）
6. ✅ 更新 DNS 记录（如有自定义域名）

## 🚨 故障排查

### 问题 1: Cognito 登录后报错 "redirect_mismatch"
**原因**: 回调 URL 未更新  
**解决**: 运行步骤 1 的更新命令

### 问题 2: ALB 返回 503
**原因**: Target Group 不健康  
**解决**: 
```bash
# 检查健康状态
aws elbv2 describe-target-health --target-group-arn <ARN>

# 查看 ECS 任务日志
aws logs tail /ecs/PayForAdoption --follow
```

### 问题 3: 部署卡住
**原因**: CloudFormation 等待资源删除  
**解决**: 
- 检查 CloudFormation 控制台事件
- 旧 ALB 删除需要 2-5 分钟
- 如超过 30 分钟，可能需要手动干预

## 🎓 后续改进建议

### 短期（1-2 周）
- [ ] 配置 HTTPS + ACM 证书
- [ ] 添加 CloudWatch Dashboard
- [ ] 配置告警（Target 不健康、登录失败）

### 中期（1-2 月）
- [ ] 关联 AWS WAF（防护常见攻击）
- [ ] 启用 ALB 访问日志到 S3
- [ ] 添加社交登录（Google, GitHub）

### 长期（3+ 月）
- [ ] 自定义 Cognito UI（品牌化）
- [ ] 启用 MFA（多因素认证）
- [ ] 集成企业 SAML/OIDC

## 📞 支持

如有问题：
1. 查看 [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) 的故障排查章节
2. 运行 `cdk doctor` 检查环境
3. 查看 CloudFormation 事件和 CloudWatch Logs

---

**版本**: 1.0  
**更新**: 2026-02-14  
**作者**: 小乖乖 🐱  
**测试状态**: ⚠️ 待验证（请先在非生产环境测试）
