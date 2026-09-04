/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * One containerized agent (Python, ARM64) on Amazon Bedrock AgentCore Runtime.
 *
 * @packageDocumentation
 */
import { CfnOutput, Stack } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal, Effect, PrincipalWithConditions, Policy, IRole } from 'aws-cdk-lib/aws-iam';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import { AGENT_RUNTIME_ENV } from './agent-config';
import { NagSuppressions } from 'cdk-nag';
import { AgentUtils } from './agent-utils';
import { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';

/**
 * agent 侧的参数前缀 —— 取自 `agent-config.ts`，值是 `/petstore/agent`。
 *
 * ⚠️ 不能复用现有的 `/petstore/*`：那三个参数指向 **ClusterIP**，而
 * `.svc.cluster.local` 即使 Runtime 跑在 VPC 模式下也解析不了
 * （CoreDNS 在集群内，VPC ENI 走的是 Route53 Resolver）。
 * 所以 agent 用独立前缀，值指向 internal ALB。**现有参数保持不动。**
 */
const AGENT_PARAM_PREFIX = AGENT_RUNTIME_ENV.PARAMETER_STORE_PREFIX;

/** Properties for a single AgentCore agent runtime. */
export interface AgentRuntimeProperties {
    /** AgentCore runtime name (e.g. 'WaggleAIOrchestrator'). Must match `[A-Za-z0-9_]`. */
    readonly runtimeName: string;
    /** ECR repository URI for the agent container image (from the containers pipeline). */
    readonly ecrRepositoryUri: string;
    /** Security groups for the agent runtime ENIs. */
    readonly securityGroups: ISecurityGroup[];
    /** VPC for network placement. */
    readonly vpc: IVpc;
    /** Extra environment variables merged over the observability defaults. */
    readonly environmentVariables?: { [key: string]: string };
    /** Optional SSM parameter (short name under AGENT_PARAM_PREFIX) to publish the runtime ARN. */
    readonly ssmArnParameterName?: string;
    /** app:name tag (defaults to the runtime name). */
    readonly appName?: string;
    /**
     * 可选：外部传入的执行角色。
     *
     * ⚠️ 本地新增的逃生口，用来绕开一个**实测到的 IAM 传播竞态**：
     *    角色在同一次 CFN 部署里刚创建，AgentCore 的 CreateAgentRuntime 立刻去校验它，
     *    结果报 "Role validation failed ... verify that the role exists and its trust
     *    policy allows assumption by this service"。
     *    实测 5 个 runtime 里只有**第一个**失败、其余 4 个都进了 CREATING，
     *    说明信任策略本身正确，纯粹是时序问题。
     *    传入一个在**上一次部署**里就建好的角色即可确定性地避开。
     */
    readonly role?: IRole;
}

/** A Bedrock AgentCore Runtime for one Waggle AI agent (orchestrator or sub-agent). */
export class AgentRuntimeConstruct extends Construct {
    public readonly agentRuntime: CfnRuntime;

    constructor(scope: Construct, id: string, properties: AgentRuntimeProperties) {
        super(scope, id);

        const agentRuntimeRole = properties.role ?? new Role(this, 'AgentRuntimeRole', {
            assumedBy: new PrincipalWithConditions(new ServicePrincipal('bedrock-agentcore.amazonaws.com'), {
                StringEquals: { 'aws:SourceAccount': Stack.of(this).account },
                ArnLike: {
                    'aws:SourceArn': `arn:aws:bedrock-agentcore:${Stack.of(this).region}:${Stack.of(this).account}:*`,
                },
            }),
        });

        const agentPolicy = new Policy(this, 'AgentPolicy', {
            statements: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
                    resources: [
                        `arn:aws:ssm:${Stack.of(this).region}:${Stack.of(this).account}:parameter${AGENT_PARAM_PREFIX}/*`,
                    ],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'bedrock:InvokeModel',
                        'bedrock:InvokeModelWithResponseStream',
                        'bedrock:CountTokens',
                        'bedrock:ApplyGuardrail',
                    ],
                    resources: [
                        `arn:aws:bedrock:*::foundation-model/*`,
                        `arn:aws:bedrock:*:${Stack.of(this).account}:*`,
                    ],
                }),
                // Knowledge Base retrieval (nutrition RAG).
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
                    resources: [`arn:aws:bedrock:${Stack.of(this).region}:${Stack.of(this).account}:knowledge-base/*`],
                }),
                // Invoke other agent runtimes directly (fallback / non-gateway transport).
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['bedrock-agentcore:InvokeAgentRuntime'],
                    resources: [`arn:aws:bedrock-agentcore:${Stack.of(this).region}:${Stack.of(this).account}:*`],
                }),
                // Gateway inbound auth is AWS_IAM, so without InvokeGateway the invocations POST is 403.
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['bedrock-agentcore:InvokeGateway'],
                    resources: [
                        `arn:aws:bedrock-agentcore:${Stack.of(this).region}:${Stack.of(this).account}:gateway/*`,
                    ],
                }),
                // AgentCore Memory: store conversation events + retrieve memory (actorId + sessionId).
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'bedrock-agentcore:CreateEvent',
                        'bedrock-agentcore:ListEvents',
                        'bedrock-agentcore:GetEvent',
                        'bedrock-agentcore:RetrieveMemoryRecords',
                        'bedrock-agentcore:ListMemoryRecords',
                        'bedrock-agentcore:GetMemoryRecord',
                    ],
                    resources: [
                        `arn:aws:bedrock-agentcore:${Stack.of(this).region}:${Stack.of(this).account}:memory/*`,
                    ],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
                    resources: ['*'],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'],
                    resources: [
                        `arn:aws:logs:${Stack.of(this).region}:${Stack.of(this).account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
                    ],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['logs:DescribeLogGroups'],
                    resources: [`arn:aws:logs:${Stack.of(this).region}:${Stack.of(this).account}:log-group:*`],
                }),
                new PolicyStatement({ effect: Effect.ALLOW, actions: ['logs:PutResourcePolicy'], resources: ['*'] }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                    resources: [
                        `arn:aws:logs:${Stack.of(this).region}:${Stack.of(this).account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
                    ],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
                    resources: [`arn:aws:ecr:${Stack.of(this).region}:${Stack.of(this).account}:repository/*`],
                }),
                new PolicyStatement({ effect: Effect.ALLOW, actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'xray:PutTraceSegments',
                        'xray:PutTelemetryRecords',
                        'xray:GetSamplingRules',
                        'xray:GetSamplingTargets',
                    ],
                    resources: ['*'],
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['cloudwatch:PutMetricData'],
                    resources: ['*'],
                    conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'bedrock-agentcore:GetWorkloadAccessToken',
                        'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
                        'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
                    ],
                    resources: [
                        `arn:aws:bedrock-agentcore:${Stack.of(this).region}:${Stack.of(this).account}:workload-identity-directory/default`,
                        `arn:aws:bedrock-agentcore:${Stack.of(this).region}:${Stack.of(this).account}:workload-identity-directory/default/workload-identity/agentName-*`,
                    ],
                }),
            ],
            roles: [agentRuntimeRole],
        });

        this.agentRuntime = new CfnRuntime(this, 'Runtime', {
            agentRuntimeArtifact: {
                containerConfiguration: { containerUri: `${properties.ecrRepositoryUri}:latest` },
            },
            agentRuntimeName: properties.runtimeName,
            networkConfiguration: { networkMode: 'VPC' },
            roleArn: agentRuntimeRole.roleArn,
            description: `Waggle AI agent runtime: ${properties.runtimeName}`,
            environmentVariables: {
                OTEL_PYTHON_EXCLUDED_URLS: '/ping',
                // ⚠️ 键名必须是 PARAMETER_STORE_PREFIX —— 容器里 agent 代码读的是
                // os.getenv("PARAMETER_STORE_PREFIX")。键名拼错不会报错，只会让 agent
                // 拿不到前缀而回落默认值、去读错的参数，属于静默失败。
                PARAMETER_STORE_PREFIX: AGENT_PARAM_PREFIX,
                AWS_REGION: Stack.of(this).region,
                AGENT_OBSERVABILITY_ENABLED: 'true',
                AWS_AGENTIC_INSTRUMENTATION_OPT_IN: 'true',
                AWS_GENAI_CONTENT_EXTRACTION_OPT_OUT: 'true',
                UNIFIED_TRACES_DESTINATION_ENABLED: 'true',
                ...properties.environmentVariables,
            },
            protocolConfiguration: 'HTTP',
        });

        this.agentRuntime.addOverride('Properties.NetworkConfiguration.NetworkModeConfig', {
            SecurityGroups: properties.securityGroups.map((sg) => sg.securityGroupId),
            Subnets: properties.vpc.privateSubnets.map((subnet) => subnet.subnetId),
        });

        if (properties.ssmArnParameterName) {
            AgentUtils.createSsmParameters(
                this,
                AGENT_PARAM_PREFIX,
                new Map(Object.entries({ [properties.ssmArnParameterName]: this.agentRuntime.attrAgentRuntimeArn })),
            );
        }

        new CfnOutput(this, 'AgentRuntimeArn', {
            value: this.agentRuntime.attrAgentRuntimeArn,
            description: `ARN of the ${properties.runtimeName} AgentCore runtime`,
        });

        NagSuppressions.addResourceSuppressions(
            [agentRuntimeRole, agentPolicy],
            [
                { id: 'AwsSolutions-IAM4', reason: 'Managed policies acceptable for the agent runtime role' },
                { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions acceptable for the agent runtime role' },
            ],
            true,
        );

        AgentUtils.TagConstruct(this, {
            'app:owner': 'petstore',
            'app:project': 'workshop',
            'app:name': properties.appName ?? properties.runtimeName,
            'app:computeType': 'bedrock-agentcore',
            'app:hostType': 'managed',
        });
    }
}
