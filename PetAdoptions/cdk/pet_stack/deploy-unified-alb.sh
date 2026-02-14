#!/bin/bash
set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Pet Adoptions - 统一 ALB 部署脚本${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# 检查当前目录
if [ ! -f "package.json" ]; then
    echo -e "${RED}错误: 请在 pet_stack 目录下运行此脚本${NC}"
    exit 1
fi

# 步骤 1: 备份现有配置
echo -e "${YELLOW}[1/8] 备份现有配置...${NC}"
BACKUP_FILE="lib/services-backup-$(date +%Y%m%d-%H%M%S).ts"
if [ -f "lib/services.ts" ]; then
    cp lib/services.ts "$BACKUP_FILE"
    echo -e "${GREEN}✓ 已备份到: $BACKUP_FILE${NC}"
else
    echo -e "${YELLOW}⚠ 未找到 services.ts，跳过备份${NC}"
fi
echo ""

# 步骤 2: 替换 Stack 文件
echo -e "${YELLOW}[2/8] 替换 Stack 文件...${NC}"
if [ -f "lib/services-unified-alb.ts" ]; then
    cp lib/services-unified-alb.ts lib/services.ts
    echo -e "${GREEN}✓ 已应用新架构文件${NC}"
else
    echo -e "${RED}错误: 未找到 services-unified-alb.ts${NC}"
    exit 1
fi
echo ""

# 步骤 3: 安装依赖（如果需要）
echo -e "${YELLOW}[3/8] 检查依赖...${NC}"
if [ ! -d "node_modules" ]; then
    echo "安装依赖..."
    npm install
else
    echo -e "${GREEN}✓ 依赖已安装${NC}"
fi
echo ""

# 步骤 4: 编译 TypeScript
echo -e "${YELLOW}[4/8] 编译 TypeScript...${NC}"
npm run build
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 编译成功${NC}"
else
    echo -e "${RED}✗ 编译失败，请检查代码${NC}"
    exit 1
fi
echo ""

# 步骤 5: 预览变更
echo -e "${YELLOW}[5/8] 预览 CDK 变更...${NC}"
echo -e "${YELLOW}注意: 将会删除旧的 ALB 并创建新的统一 ALB${NC}"
echo ""
read -p "是否查看详细变更? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    cdk diff Services-PetStack
    echo ""
fi

# 步骤 6: 确认部署
echo -e "${YELLOW}[6/8] 准备部署...${NC}"
echo -e "${YELLOW}警告: 部署将会:${NC}"
echo -e "  - 删除 4 个旧的独立 ALB"
echo -e "  - 创建 1 个新的统一 ALB"
echo -e "  - 创建 Cognito 用户池和认证配置"
echo -e "  - 合并 ECS 集群"
echo -e "  - 可能导致 5-10 分钟的服务中断"
echo ""
read -p "确认要继续部署吗? (yes/no) " -r
echo
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo -e "${YELLOW}部署已取消${NC}"
    exit 0
fi

# 步骤 7: 执行部署
echo -e "${YELLOW}[7/8] 开始部署...${NC}"
echo "这可能需要 15-20 分钟，请耐心等待..."
echo ""

cdk deploy Services-PetStack --require-approval never

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 部署成功！${NC}"
else
    echo -e "${RED}✗ 部署失败${NC}"
    echo -e "${YELLOW}可以尝试:${NC}"
    echo "  1. 查看 CloudFormation 控制台的错误详情"
    echo "  2. 运行: cdk deploy Services-PetStack --verbose"
    echo "  3. 如需回滚: 恢复备份文件并重新部署"
    exit 1
fi
echo ""

# 步骤 8: 获取输出信息
echo -e "${YELLOW}[8/8] 获取部署信息...${NC}"
echo ""

# 获取 Stack 输出
STACK_NAME="Services-PetStack"
echo "正在从 CloudFormation 获取输出..."
echo ""

# 获取 ALB DNS
ALB_DNS=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query 'Stacks[0].Outputs[?OutputKey==`UnifiedALBDnsName`].OutputValue' \
    --output text 2>/dev/null || echo "")

# 获取 Cognito 信息
USER_POOL_ID=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolId`].OutputValue' \
    --output text 2>/dev/null || echo "")

CLIENT_ID=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolClientId`].OutputValue' \
    --output text 2>/dev/null || echo "")

COGNITO_DOMAIN=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolDomain`].OutputValue' \
    --output text 2>/dev/null || echo "")

# 显示结果
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

if [ -n "$ALB_DNS" ]; then
    echo -e "${GREEN}✓ 应用 URL:${NC}"
    echo "  http://$ALB_DNS"
    echo ""
fi

if [ -n "$USER_POOL_ID" ]; then
    echo -e "${GREEN}✓ Cognito 配置:${NC}"
    echo "  User Pool ID: $USER_POOL_ID"
    echo "  Client ID: $CLIENT_ID"
    echo "  Domain: $COGNITO_DOMAIN"
    echo ""
fi

# 后续步骤
echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}  后续必要步骤:${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""

if [ -n "$ALB_DNS" ] && [ -n "$USER_POOL_ID" ]; then
    echo -e "${YELLOW}1. 更新 Cognito 回调 URL:${NC}"
    echo ""
    echo "   运行以下命令:"
    echo ""
    echo -e "${GREEN}   aws cognito-idp update-user-pool-client \\
     --user-pool-id $USER_POOL_ID \\
     --client-id $CLIENT_ID \\
     --callback-urls \"http://$ALB_DNS/oauth2/idpresponse\" \\
     --logout-urls \"http://$ALB_DNS/\" \\
     --supported-identity-providers COGNITO${NC}"
    echo ""
    
    echo -e "${YELLOW}2. 创建测试用户:${NC}"
    echo ""
    echo "   方式 A - 通过 CLI 创建:"
    echo ""
    echo -e "${GREEN}   aws cognito-idp admin-create-user \\
     --user-pool-id $USER_POOL_ID \\
     --username testuser \\
     --user-attributes Name=email,Value=test@example.com \\
     --temporary-password 'TempPass123!' \\
     --message-action SUPPRESS${NC}"
    echo ""
    echo -e "${GREEN}   aws cognito-idp admin-set-user-password \\
     --user-pool-id $USER_POOL_ID \\
     --username testuser \\
     --password 'SecurePass123!' \\
     --permanent${NC}"
    echo ""
    
    echo "   方式 B - 通过 Hosted UI 自助注册:"
    REGION=$(aws configure get region)
    echo "   https://$COGNITO_DOMAIN.auth.$REGION.amazoncognito.com/login?client_id=$CLIENT_ID&response_type=code&redirect_uri=http://$ALB_DNS/oauth2/idpresponse"
    echo ""
    
    echo -e "${YELLOW}3. 验证部署:${NC}"
    echo ""
    echo "   访问应用 URL 测试认证流程:"
    echo "   http://$ALB_DNS"
    echo ""
    
    echo -e "${YELLOW}4. 健康检查:${NC}"
    echo ""
    echo "   检查 Target Group 健康状态:"
    echo -e "${GREEN}   aws elbv2 describe-target-health --target-group-arn <TG_ARN>${NC}"
    echo ""
    echo "   查看 ECS 服务状态:"
    echo -e "${GREEN}   aws ecs describe-services --cluster PetAdoptions-Shared-Cluster --services pay-for-adoption-service list-adoptions-service search-service${NC}"
    echo ""
fi

# 保存输出到文件
OUTPUT_FILE="deployment-output-$(date +%Y%m%d-%H%M%S).txt"
cat > "$OUTPUT_FILE" <<EOF
Pet Adoptions 部署信息
部署时间: $(date)
========================================

应用 URL: http://$ALB_DNS
Cognito User Pool ID: $USER_POOL_ID
Cognito Client ID: $CLIENT_ID
Cognito Domain: $COGNITO_DOMAIN

========================================
完整输出请查看 CloudFormation 控制台
EOF

echo -e "${GREEN}✓ 部署信息已保存到: $OUTPUT_FILE${NC}"
echo ""

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  🎉 部署流程完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}提示:${NC}"
echo "  - 完整部署指南: DEPLOYMENT_GUIDE.md"
echo "  - 架构对比文档: ARCHITECTURE_COMPARISON.md"
echo "  - 如有问题，请查看 CloudWatch Logs 和 CloudFormation 事件"
echo ""
