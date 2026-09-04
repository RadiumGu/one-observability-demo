#!/usr/bin/env node
import 'source-map-support/register';
import { ServicesEks2 } from '../lib/services-eks';
import { Applications } from '../lib/applications';
import { WaggleAIAgents } from '../lib/agents/waggle-ai-agents-stack';
import { App, Tags } from 'aws-cdk-lib';

const app = new App();

// EKS-only deployment - all microservices on EKS
const stackName = "ServicesEks2";
const stack = new ServicesEks2(app, stackName, { 
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
}});
Tags.of(stack).add("DeploymentMode", "eks");

const applications = new Applications(app, "Applications", {
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
}});

// WaggleAI agent 栈 —— 自包含，可独立部署/销毁，不与 ServicesEks2 的
// 不可重建资源（Aurora / EKS / 公网 ALB）耦合。
const waggleAgents = new WaggleAIAgents(app, "WaggleAIAgents", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
}});
Tags.of(waggleAgents).add("Component", "waggle-ai-agents");

Tags.of(app).add("Workshop","true");
