#!/bin/bash
# Kubernetes 资源部署脚本

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署 Kubernetes 资源${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# 检查 kubectl
if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}错误: kubectl 未安装${NC}"
    exit 1
fi

# 检查集群连接
echo -e "${YELLOW}[1/8] 检查集群连接...${NC}"
if ! kubectl cluster-info &> /dev/null; then
    echo -e "${RED}错误: 无法连接到 Kubernetes 集群${NC}"
    echo "请运行: aws eks update-kubeconfig --name PetSite --region <REGION>"
    exit 1
fi
echo -e "${GREEN}✓ 集群连接正常${NC}"
echo ""

# 获取配置信息
echo -e "${YELLOW}[2/8] 获取配置信息...${NC}"
AWS_REGION=${AWS_REGION:-$(aws configure get region)}
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
RDS_ENDPOINT=$(aws ssm get-parameter --name /petstore/rdsendpoint --query Parameter.Value --output text 2>/dev/null || echo "")
INTERNAL_ALB_DNS=$(aws ssm get-parameter --name /petstore/internal-alb-dns --query Parameter.Value --output text 2>/dev/null || echo "")

echo "AWS Region: $AWS_REGION"
echo "AWS Account: $AWS_ACCOUNT_ID"
echo "RDS Endpoint: $RDS_ENDPOINT"
echo "Internal ALB DNS: $INTERNAL_ALB_DNS"
echo ""

# 替换 manifests 中的占位符
echo -e "${YELLOW}[3/8] 准备 Kubernetes Manifests...${NC}"
cd ~/tech/one-observability-demo/PetAdoptions/k8s-manifests

# 创建临时目录
mkdir -p /tmp/k8s-manifests-deploy
cp *.yaml /tmp/k8s-manifests-deploy/

# 替换占位符
find /tmp/k8s-manifests-deploy -name "*.yaml" -type f -exec sed -i \
    -e "s/<AWS_ACCOUNT_ID>/$AWS_ACCOUNT_ID/g" \
    -e "s/<AWS_REGION>/$AWS_REGION/g" \
    -e "s/REPLACE_WITH_RDS_ENDPOINT/$RDS_ENDPOINT/g" \
    -e "s/REPLACE_WITH_INTERNAL_ALB_DNS/$INTERNAL_ALB_DNS/g" \
    -e "s/REPLACE_WITH_AWS_REGION/$AWS_REGION/g" \
    {} +

echo -e "${GREEN}✓ Manifests 准备完成${NC}"
echo ""

# 部署 namespace
echo -e "${YELLOW}[4/8] 创建 Namespace...${NC}"
kubectl apply -f /tmp/k8s-manifests-deploy/00-namespace.yaml
echo -e "${GREEN}✓ Namespace 创建完成${NC}"
echo ""

# 部署 ConfigMap
echo -e "${YELLOW}[5/8] 创建 ConfigMap...${NC}"
kubectl apply -f /tmp/k8s-manifests-deploy/05-configmap.yaml
echo -e "${GREEN}✓ ConfigMap 创建完成${NC}"
echo ""

# 部署微服务
echo -e "${YELLOW}[6/8] 部署微服务...${NC}"
kubectl apply -f /tmp/k8s-manifests-deploy/01-payforadoption.yaml
kubectl apply -f /tmp/k8s-manifests-deploy/02-listadoptions.yaml
kubectl apply -f /tmp/k8s-manifests-deploy/03-petsearch.yaml
kubectl apply -f /tmp/k8s-manifests-deploy/04-petsite.yaml
echo -e "${GREEN}✓ 微服务部署完成${NC}"
echo ""

# 部署 Ingress
echo -e "${YELLOW}[7/8] 部署 Ingress...${NC}"
kubectl apply -f /tmp/k8s-manifests-deploy/06-internal-ingress.yaml
kubectl apply -f /tmp/k8s-manifests-deploy/07-external-ingress.yaml
echo -e "${GREEN}✓ Ingress 部署完成${NC}"
echo ""

# 验证部署
echo -e "${YELLOW}[8/8] 验证部署状态...${NC}"
echo ""
echo "等待 Pod 启动..."
sleep 10

echo ""
echo "Pod 状态:"
kubectl get pods -n petadoptions

echo ""
echo "Service 状态:"
kubectl get svc -n petadoptions

echo ""
echo "Ingress 状态:"
kubectl get ingress -n petadoptions

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  ✓ 部署完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# 获取 ALB DNS
echo "等待 Ingress 分配 ALB DNS (最多 3 分钟)..."
for i in {1..18}; do
    EXTERNAL_ALB=$(kubectl get ingress external-alb-ingress -n petadoptions -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
    INTERNAL_ALB=$(kubectl get ingress internal-alb-ingress -n petadoptions -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
    
    if [ -n "$EXTERNAL_ALB" ] && [ -n "$INTERNAL_ALB" ]; then
        break
    fi
    sleep 10
done

echo ""
if [ -n "$EXTERNAL_ALB" ]; then
    echo -e "${GREEN}外部 ALB DNS:${NC} $EXTERNAL_ALB"
    echo "访问地址: http://$EXTERNAL_ALB"
else
    echo -e "${YELLOW}外部 ALB DNS 尚未分配，请稍后运行:${NC}"
    echo "kubectl get ingress external-alb-ingress -n petadoptions"
fi

echo ""
if [ -n "$INTERNAL_ALB" ]; then
    echo -e "${GREEN}内部 ALB DNS:${NC} $INTERNAL_ALB"
else
    echo -e "${YELLOW}内部 ALB DNS 尚未分配，请稍后运行:${NC}"
    echo "kubectl get ingress internal-alb-ingress -n petadoptions"
fi

echo ""
echo -e "${YELLOW}后续步骤:${NC}"
echo "1. 更新 Cognito 回调 URL (使用外部 ALB DNS)"
echo "2. 配置外部 Ingress 的 Cognito 认证注解"
echo "3. 测试访问前端和后端 API"
echo ""

# 清理临时文件
rm -rf /tmp/k8s-manifests-deploy
