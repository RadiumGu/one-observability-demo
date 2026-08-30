#!/bin/bash
# Kubernetes 资源部署脚本
# 部署 PetAdoptions 微服务到 petadoptions namespace

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFESTS_DIR="${SCRIPT_DIR}/k8s-manifests"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署 PetAdoptions Kubernetes 资源${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# 检查 kubectl
if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}错误: kubectl 未安装${NC}"
    exit 1
fi

# 检查集群连接
echo -e "${YELLOW}[1/9] 检查集群连接...${NC}"
if ! kubectl cluster-info &> /dev/null; then
    echo -e "${RED}错误: 无法连接到 Kubernetes 集群${NC}"
    echo "请运行: aws eks update-kubeconfig --name PetSite --region <REGION>"
    exit 1
fi
echo -e "${GREEN}✓ 集群连接正常${NC}"
echo ""

# 获取配置信息
echo -e "${YELLOW}[2/9] 获取配置信息...${NC}"
AWS_REGION=${AWS_REGION:-$(aws configure get region)}
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "AWS Region: $AWS_REGION"
echo "AWS Account: $AWS_ACCOUNT_ID"
echo ""

# 替换 manifests 中的占位符
echo -e "${YELLOW}[3/9] 准备 Kubernetes Manifests...${NC}"
mkdir -p /tmp/k8s-manifests-deploy
cp ${MANIFESTS_DIR}/*.yaml /tmp/k8s-manifests-deploy/

# 获取 SSM 参数用于替换
RDS_SECRET_ARN=$(aws ssm get-parameter --name /petstore/rdssecretarn --query Parameter.Value --output text 2>/dev/null || echo "")
UPDATE_ADOPTION_URL=$(aws ssm get-parameter --name /petstore/updateadoptionstatusurl --query Parameter.Value --output text 2>/dev/null || echo "")
ALB_DNS=$(aws elbv2 describe-load-balancers --names "Servic-PetSi-*" --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null || echo "")
PETSITE_TG_ARN=$(aws elbv2 describe-target-groups --query "TargetGroups[?contains(TargetGroupName, 'PetSi')].TargetGroupArn | [0]" --output text 2>/dev/null || echo "")
PETHISTORY_TG_ARN=$(aws elbv2 describe-target-groups --query "TargetGroups[?contains(TargetGroupName, 'PetAd')].TargetGroupArn | [0]" --output text 2>/dev/null || echo "")

# 获取 IRSA role ARNs
PETSITE_ROLE=$(kubectl get sa petsite-sa -n petadoptions -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}' 2>/dev/null || echo "")
PAYFORADOPTION_ROLE=$(kubectl get sa pay-for-adoption-sa -n petadoptions -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}' 2>/dev/null || echo "")
LISTADOPTIONS_ROLE=$(kubectl get sa list-adoptions-sa -n petadoptions -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}' 2>/dev/null || echo "")
SEARCHSERVICE_ROLE=$(kubectl get sa search-service-sa -n petadoptions -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}' 2>/dev/null || echo "")
PETHISTORY_ROLE=$(kubectl get sa pethistory-sa -n petadoptions -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}' 2>/dev/null || echo "")
TRAFFICGENERATOR_ROLE=$(kubectl get sa traffic-generator-sa -n petadoptions -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}' 2>/dev/null || echo "")

# 替换占位符
find /tmp/k8s-manifests-deploy -name "*.yaml" -type f -exec sed -i \
    -e "s|<AWS_ACCOUNT_ID>|$AWS_ACCOUNT_ID|g" \
    -e "s|<AWS_REGION>|$AWS_REGION|g" \
    -e "s|REPLACE_WITH_RDS_SECRET_ARN|$RDS_SECRET_ARN|g" \
    -e "s|REPLACE_WITH_UPDATE_ADOPTION_URL|$UPDATE_ADOPTION_URL|g" \
    -e "s|REPLACE_WITH_ALB_DNS|http://$ALB_DNS|g" \
    -e "s|REPLACE_WITH_PETSITE_TARGET_GROUP_ARN|$PETSITE_TG_ARN|g" \
    -e "s|REPLACE_WITH_PETHISTORY_TARGET_GROUP_ARN|$PETHISTORY_TG_ARN|g" \
    -e "s|REPLACE_WITH_PETSITE_ROLE_ARN|$PETSITE_ROLE|g" \
    -e "s|REPLACE_WITH_PAYFORADOPTION_ROLE_ARN|$PAYFORADOPTION_ROLE|g" \
    -e "s|REPLACE_WITH_LISTADOPTIONS_ROLE_ARN|$LISTADOPTIONS_ROLE|g" \
    -e "s|REPLACE_WITH_SEARCHSERVICE_ROLE_ARN|$SEARCHSERVICE_ROLE|g" \
    -e "s|REPLACE_WITH_PETHISTORY_ROLE_ARN|$PETHISTORY_ROLE|g" \
    -e "s|REPLACE_WITH_TRAFFICGENERATOR_ROLE_ARN|$TRAFFICGENERATOR_ROLE|g" \
    {} +

echo -e "${GREEN}✓ Manifests 准备完成${NC}"
echo ""

# 部署 namespace
echo -e "${YELLOW}[4/9] 创建 Namespace...${NC}"
kubectl apply -f /tmp/k8s-manifests-deploy/00-namespace.yaml
echo -e "${GREEN}✓ Namespace 创建完成${NC}"
echo ""

# 部署 ServiceAccounts
echo -e "${YELLOW}[5/9] 创建 ServiceAccounts...${NC}"
kubectl apply -f /tmp/k8s-manifests-deploy/00-serviceaccounts.yaml
echo -e "${GREEN}✓ ServiceAccounts 创建完成${NC}"
echo ""

# 部署 ConfigMap
echo -e "${YELLOW}[6/9] 创建 ConfigMap...${NC}"
kubectl apply -f /tmp/k8s-manifests-deploy/05-configmap.yaml
echo -e "${GREEN}✓ ConfigMap 创建完成${NC}"
echo ""

# 部署微服务
echo -e "${YELLOW}[7/9] 部署微服务...${NC}"
kubectl apply -f /tmp/k8s-manifests-deploy/01-payforadoption.yaml
kubectl apply -f /tmp/k8s-manifests-deploy/02-listadoptions.yaml
kubectl apply -f /tmp/k8s-manifests-deploy/03-petsearch.yaml
kubectl apply -f /tmp/k8s-manifests-deploy/04-petsite.yaml
kubectl apply -f /tmp/k8s-manifests-deploy/04-pethistory.yaml
kubectl apply -f /tmp/k8s-manifests-deploy/04-traffic-generator.yaml
echo -e "${GREEN}✓ 微服务部署完成${NC}"
echo ""

# 部署 HPA
echo -e "${YELLOW}[8/9] 部署 HPA...${NC}"
# PodDisruptionBudget 必须在 HPA 之前应用 —— 先立排空保护，
# 再开自动伸缩，避免伸缩过程中出现无保护的驱逐窗口。
kubectl apply -f /tmp/k8s-manifests-deploy/07-pdb.yaml

kubectl apply -f /tmp/k8s-manifests-deploy/08-hpa.yaml
echo -e "${GREEN}✓ HPA 部署完成${NC}"
echo ""

# 部署 TargetGroupBinding
echo -e "${YELLOW}[9/9] 部署 TargetGroupBinding...${NC}"
kubectl apply -f /tmp/k8s-manifests-deploy/09-targetgroupbinding.yaml
echo -e "${GREEN}✓ TargetGroupBinding 部署完成${NC}"
echo ""

# 验证部署
echo -e "${YELLOW}验证部署状态...${NC}"
echo ""
echo "等待 Pod 启动..."
sleep 15

echo ""
echo "Pod 状态:"
kubectl get pods -n petadoptions

echo ""
echo "Service 状态:"
kubectl get svc -n petadoptions

echo ""
echo "HPA 状态:"
kubectl get hpa -n petadoptions

echo ""
echo "TargetGroupBinding 状态:"
kubectl get targetgroupbinding -n petadoptions

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ✓ 部署完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}注意事项:${NC}"
echo "  1. ALB 已由 CDK 创建，通过 TargetGroupBinding 对接"
echo "  2. HTTP:80 已 redirect 到 HTTPS:443（Cognito 认证）"
echo "  3. 服务间调用通过 K8s 内部 DNS (.petadoptions.svc.cluster.local)"
echo "  4. SSM Parameter Store /petstore/* 存储服务端点配置"
echo ""

# 清理临时文件
rm -rf /tmp/k8s-manifests-deploy
