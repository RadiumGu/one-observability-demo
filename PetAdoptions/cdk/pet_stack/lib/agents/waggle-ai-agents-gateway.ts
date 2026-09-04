/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * One AgentCore Gateway fronting the Waggle AI agent runtimes as HTTP targets.
 *
 * @packageDocumentation
 */
import { CfnOutput, CfnResource, Stack } from 'aws-cdk-lib';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { AGENT_RUNTIME_ENV } from './agent-config';
import { AgentUtils } from './agent-utils';

/** agent 参数前缀，取自 agent-config.ts（`/petstore/agent`）。不复用现有 /petstore/* —— 那些指向 ClusterIP，VPC 内解析不了。 */
const AGENT_PARAM_PREFIX = AGENT_RUNTIME_ENV.PARAMETER_STORE_PREFIX;


/** One agent runtime exposed as a Gateway HTTP target. */
export interface AgentGatewayTarget {
    /** Target name — becomes the path segment: `{gatewayUrl}/{targetName}/invocations`. */
    readonly targetName: string;
    /** The agent's AgentCore runtime ARN. */
    readonly runtimeArn: string;
}

export interface WaggleAIGatewayProperties {
    readonly targets: AgentGatewayTarget[];
    /** SSM parameter (short name under AGENT_PARAM_PREFIX) to publish the gateway URL. */
    readonly ssmGatewayUrlParameterName: string;
}

/** AgentCore Gateway + HTTP runtime targets for the Waggle AI agents. */
export class WaggleAIGateway extends Construct {
    public readonly gatewayUrl: string;

    constructor(scope: Construct, id: string, properties: WaggleAIGatewayProperties) {
        super(scope, id);
        const { region, account } = Stack.of(this);

        // Gateway execution role: invoke the target agent runtimes.
        const gatewayRole = new Role(this, 'GatewayRole', {
            assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        gatewayRole.addToPrincipalPolicy(
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['bedrock-agentcore:InvokeAgentRuntime'],
                resources: [`arn:aws:bedrock-agentcore:${region}:${account}:runtime/*`],
            }),
        );

        const gateway = new CfnResource(this, 'Gateway', {
            type: 'AWS::BedrockAgentCore::Gateway',
            properties: {
                Name: 'WaggleAIGateway',
                Description: 'Ingress + agent-to-agent routing for the Waggle AI multi-agent system',
                AuthorizerType: 'AWS_IAM', // IAM (SigV4) inbound auth
                RoleArn: gatewayRole.roleArn,
                // No ProtocolType: an MCP-protocol gateway rejects HTTP `agentcoreRuntime` targets.
            },
        });

        const gatewayId = gateway.getAtt('GatewayIdentifier').toString();
        this.gatewayUrl = gateway.getAtt('GatewayUrl').toString();

        for (const t of properties.targets) {
            const target = new CfnResource(this, `Target-${t.targetName}`, {
                type: 'AWS::BedrockAgentCore::GatewayTarget',
                properties: {
                    GatewayIdentifier: gatewayId,
                    Name: t.targetName,
                    Description: `HTTP runtime target -> ${t.targetName}`,
                    CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
                    // HTTP agentcoreRuntime target (raw CFN); an optional Qualifier could pin a version.
                    TargetConfiguration: { Http: { AgentcoreRuntime: { Arn: t.runtimeArn } } },
                },
            });
            target.addDependency(gateway);
        }

        // Created but not attached: ENFORCE with no authored policies would deny all traffic.
        //
        // ⚠️ 本地改动：上游用 `new CfnPolicyEngine(...)`（`aws-cdk-lib/aws-bedrockagentcore`），
        //    但本地 aws-cdk-lib 是 **2.238.0，还没有 `CfnPolicyEngine` 这个 L1 类**
        //    （该模块实际导出的只有 CfnBrowserCustom / CfnCodeInterpreterCustom / CfnGateway /
        //     CfnGatewayTarget / CfnMemory / CfnRuntime / CfnRuntimeEndpoint / CfnWorkloadIdentity）。
        //
        //    为它把 aws-cdk-lib 升到 2.268.0 不划算：这个资源**上游自己就刻意不挂载**，
        //    除了输出一个 ARN 不产生任何功能，而升级会波及整个 PetSite 栈
        //    （Aurora / EKS / ALB 构造全在同一个 aws-cdk-lib 上）。
        //
        //    改用 CfnResource escape hatch —— 已实测 `AWS::BedrockAgentCore::PolicyEngine`
        //    在 ap-northeast-1 注册且状态 LIVE。本文件第 11 行本来就 import 了 CfnResource，
        //    上游自身也在用同类逃生舱，写法一致。
        const policyEngine = new CfnResource(this, 'PolicyEngine', {
            type: 'AWS::BedrockAgentCore::PolicyEngine',
            properties: {
                Name: 'WaggleAIPolicyEngine',
                Description:
                    'AuthZ policy engine for the Waggle AI gateway (attach in ENFORCE once policies are authored)',
            },
        });

        AgentUtils.createSsmParameters(
            this,
            AGENT_PARAM_PREFIX,
            new Map([[properties.ssmGatewayUrlParameterName, this.gatewayUrl]]),
        );
        new CfnOutput(this, 'WaggleAIPolicyEngineArn', { value: policyEngine.getAtt('PolicyEngineArn').toString() });

        new CfnOutput(this, 'WaggleAIGatewayUrl', { value: this.gatewayUrl });

        NagSuppressions.addResourceSuppressions(
            gatewayRole,
            [{ id: 'AwsSolutions-IAM5', reason: 'Gateway invokes the Waggle AI agent runtimes' }],
            true,
        );
    }
}
