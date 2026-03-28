#!/usr/bin/env node
import 'source-map-support/register';
import { ServicesEks2 } from '../lib/services-eks';
import { Applications } from '../lib/applications';
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

Tags.of(app).add("Workshop","true");
