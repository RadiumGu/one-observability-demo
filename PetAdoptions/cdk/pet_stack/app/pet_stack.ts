#!/usr/bin/env node
import 'source-map-support/register';
import { Services } from '../lib/services';
import { ServicesEks2 } from '../lib/services-eks';
import { Applications } from '../lib/applications';
//import { EKSPetsite } from '../lib/ekspetsite'
import { App, Tags, Aspects } from 'aws-cdk-lib';
//import { AwsSolutionsChecks } from 'cdk-nag';

const app = new App();

// Choose deployment mode: 'ecs' or 'eks'
// Use 'eks' to deploy all microservices to EKS cluster
// Use 'ecs' to deploy microservices to ECS Fargate (original behavior)
const deploymentMode = app.node.tryGetContext('deployment_mode') || 'eks';

if (deploymentMode === 'eks') {
  // EKS-only deployment - all microservices on EKS
  const stackName = "ServicesEks2";
  const stack = new ServicesEks2(app, stackName, { 
    env: { 
      account: process.env.CDK_DEFAULT_ACCOUNT, 
      region: process.env.CDK_DEFAULT_REGION 
  }});
  Tags.of(stack).add("DeploymentMode", "eks");
} else {
  // Original ECS deployment
  const stackName = "Services";
  const stack = new Services(app, stackName, { 
    env: { 
      account: process.env.CDK_DEFAULT_ACCOUNT, 
      region: process.env.CDK_DEFAULT_REGION 
  }});
  Tags.of(stack).add("DeploymentMode", "ecs");
}

const applications = new Applications(app, "Applications", {
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
}});

Tags.of(app).add("Workshop","true")
//Aspects.of(stack).add(new AwsSolutionsChecks({verbose: true}));
//Aspects.of(applications).add(new AwsSolutionsChecks({verbose: true}));
