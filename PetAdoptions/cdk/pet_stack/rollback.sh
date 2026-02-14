#!/bin/bash
set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${RED}========================================${NC}"
echo -e "${RED}  Pet Adoptions - 回滚脚本${NC}"
echo -e "${RED}========================================${NC}"
echo ""

# 检查备份文件
echo -e "${YELLOW}查找备份文件...${NC}"
BACKUP_FILES=(lib/services-backup-*.ts)

if [ ! -e "${BACKUP_FILES[0]}" ]; then
    echo -e "${RED}错误: 未找到任何备份文件${NC}"
    echo "备份文件应该位于: lib/services-backup-YYYYMMDD-HHMMSS.ts"
    exit 1
fi

# 显示可用的备份
echo -e "${GREEN}找到以下备份文件:${NC}"
echo ""
select BACKUP in "${BACKUP_FILES[@]}" "取消"; do
    case $BACKUP in
        "取消")
            echo -e "${YELLOW}已取消${NC}"
            exit 0
            ;;
        *)
            if [ -n "$BACKUP" ]; then
                SELECTED_BACKUP="$BACKUP"
                break
            fi
            ;;
    esac
done

echo ""
echo -e "${YELLOW}选择的备份文件: $SELECTED_BACKUP${NC}"
echo ""

# 确认回滚
echo -e "${RED}警告: 回滚将会:${NC}"
echo "  1. 恢复旧的 services.ts 文件"
echo "  2. 重新编译"
echo "  3. 部署旧架构（恢复 5 个 ALB）"
echo "  4. 删除统一 ALB 和 Cognito 用户池"
echo "  5. 可能导致服务中断 10-15 分钟"
echo ""
read -p "确认要回滚吗? (yes/no) " -r
echo
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo -e "${YELLOW}回滚已取消${NC}"
    exit 0
fi

# 备份当前的统一版本（以防需要再次切换）
echo -e "${YELLOW}[1/5] 备份当前文件...${NC}"
UNIFIED_BACKUP="lib/services-unified-backup-$(date +%Y%m%d-%H%M%S).ts"
cp lib/services.ts "$UNIFIED_BACKUP"
echo -e "${GREEN}✓ 当前版本已备份到: $UNIFIED_BACKUP${NC}"
echo ""

# 恢复备份
echo -e "${YELLOW}[2/5] 恢复备份文件...${NC}"
cp "$SELECTED_BACKUP" lib/services.ts
echo -e "${GREEN}✓ 已恢复: $SELECTED_BACKUP${NC}"
echo ""

# 编译
echo -e "${YELLOW}[3/5] 编译 TypeScript...${NC}"
npm run build
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 编译成功${NC}"
else
    echo -e "${RED}✗ 编译失败${NC}"
    echo "恢复统一版本..."
    cp "$UNIFIED_BACKUP" lib/services.ts
    exit 1
fi
echo ""

# 预览变更
echo -e "${YELLOW}[4/5] 预览回滚变更...${NC}"
read -p "是否查看详细变更? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    cdk diff Services-PetStack
    echo ""
fi

# 执行部署
echo -e "${YELLOW}[5/5] 执行回滚部署...${NC}"
echo "这可能需要 15-20 分钟..."
echo ""

cdk deploy Services-PetStack --require-approval never

if [ $? -eq 0 ]; then
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  ✓ 回滚成功！${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "架构已恢复到原有的多 ALB 配置"
    echo ""
    
    # 获取新的 ALB 信息
    echo "获取 ALB 信息..."
    STACK_NAME="Services-PetStack"
    PETSITE_URL=$(aws cloudformation describe-stacks \
        --stack-name $STACK_NAME \
        --query 'Stacks[0].Outputs[?OutputKey==`PetSiteUrl`].OutputValue' \
        --output text 2>/dev/null || echo "")
    
    if [ -n "$PETSITE_URL" ]; then
        echo "PetSite URL: $PETSITE_URL"
    fi
    
    echo ""
    echo -e "${YELLOW}注意:${NC}"
    echo "  - 如果之前有配置域名，需要更新 DNS 记录"
    echo "  - 检查所有服务的健康状态"
    echo "  - Cognito 用户池已删除，用户需要重新创建（如果再次部署统一版本）"
    
else
    echo -e "${RED}========================================${NC}"
    echo -e "${RED}  ✗ 回滚失败${NC}"
    echo -e "${RED}========================================${NC}"
    echo ""
    echo "请查看 CloudFormation 控制台的错误详情"
    echo ""
    echo "如需手动恢复:"
    echo "  1. 恢复文件: cp $UNIFIED_BACKUP lib/services.ts"
    echo "  2. 重新编译: npm run build"
    echo "  3. 重新部署: cdk deploy Services-PetStack"
    exit 1
fi
