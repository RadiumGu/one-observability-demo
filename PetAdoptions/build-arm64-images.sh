#!/bin/bash
# ARM64 镜像构建脚本 - 所有微服务

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 配置
AWS_REGION="${AWS_REGION:-ap-northeast-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_TAG="${IMAGE_TAG:-latest}"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  构建 ARM64 镜像${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "AWS Region: $AWS_REGION"
echo "AWS Account: $AWS_ACCOUNT_ID"
echo "ECR Registry: $ECR_REGISTRY"
echo "Image Tag: $IMAGE_TAG"
echo ""

# 登录 ECR
echo -e "${YELLOW}[1/6] 登录 ECR...${NC}"
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY
echo -e "${GREEN}✓ ECR 登录成功${NC}"
echo ""

# 创建 ECR 仓库（如果不存在）
create_ecr_repo() {
    local repo_name=$1
    echo "检查 ECR 仓库: $repo_name"
    if ! aws ecr describe-repositories --repository-names $repo_name --region $AWS_REGION &>/dev/null; then
        echo "创建 ECR 仓库: $repo_name"
        aws ecr create-repository \
            --repository-name $repo_name \
            --region $AWS_REGION \
            --image-scanning-configuration scanOnPush=true \
            --encryption-configuration encryptionType=AES256
    fi
}

# 构建并推送镜像
build_and_push() {
    local service_name=$1
    local service_dir=$2
    local dockerfile=${3:-Dockerfile}
    
    echo -e "${YELLOW}构建 $service_name...${NC}"
    
    # 创建 ECR 仓库
    create_ecr_repo "petadoptions/$service_name"
    
    # 构建 ARM64 镜像
    cd ~/tech/one-observability-demo/PetAdoptions/$service_dir
    
    docker buildx build \
        --platform linux/arm64 \
        -t $ECR_REGISTRY/petadoptions/$service_name:$IMAGE_TAG \
        -t $ECR_REGISTRY/petadoptions/$service_name:arm64 \
        -f $dockerfile \
        --push \
        .
    
    echo -e "${GREEN}✓ $service_name 构建完成${NC}"
    echo ""
}

# 构建各个服务
echo -e "${YELLOW}[2/6] 构建 PayForAdoption 服务 (Go)...${NC}"
build_and_push "payforadoption" "payforadoption-go"

echo -e "${YELLOW}[3/6] 构建 ListAdoptions 服务 (Go)...${NC}"
build_and_push "listadoptions" "petlistadoptions-go"

echo -e "${YELLOW}[4/6] 构建 Search 服务 (Java)...${NC}"
build_and_push "petsearch" "petsearch-java"

echo -e "${YELLOW}[5/6] 构建 PetHistory 服务 (Python)...${NC}"
build_and_push "pethistory" "petadoptionshistory-py"

echo -e "${YELLOW}[6/6] 构建 PetSite 前端 (Node.js)...${NC}"
build_and_push "petsite" "petsite/petsite"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ✓ 所有镜像构建完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "镜像列表:"
echo "  - $ECR_REGISTRY/petadoptions/payforadoption:$IMAGE_TAG"
echo "  - $ECR_REGISTRY/petadoptions/listadoptions:$IMAGE_TAG"
echo "  - $ECR_REGISTRY/petadoptions/petsearch:$IMAGE_TAG"
echo "  - $ECR_REGISTRY/petadoptions/pethistory:$IMAGE_TAG"
echo "  - $ECR_REGISTRY/petadoptions/petsite:$IMAGE_TAG"
echo ""
echo "下一步："
echo "  1. 部署 CDK Stack: cd cdk/pet_stack && cdk deploy Services-PetStack"
echo "  2. 部署 K8s 资源: kubectl apply -f k8s-manifests/"
echo ""
