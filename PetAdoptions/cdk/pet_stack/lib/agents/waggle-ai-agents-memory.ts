/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

/**
 * One shared AgentCore Memory for the Waggle AI agents, scoped by `actorId` + `sessionId`.
 *
 * @packageDocumentation
 */
import { CfnOutput } from 'aws-cdk-lib';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnMemory } from 'aws-cdk-lib/aws-bedrockagentcore';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { AGENT_RUNTIME_ENV } from './agent-config';
import { AgentUtils } from './agent-utils';

/** agent 参数前缀，取自 agent-config.ts（`/petstore/agent`）。不复用现有 /petstore/* —— 那些指向 ClusterIP，VPC 内解析不了。 */
const AGENT_PARAM_PREFIX = AGENT_RUNTIME_ENV.PARAMETER_STORE_PREFIX;


export interface WaggleAIMemoryProperties {
    /** SSM parameter (short name under AGENT_PARAM_PREFIX) to publish the memory id. */
    readonly ssmMemoryIdParameterName: string;
    /** Short-term event retention in days (default 30). */
    readonly eventExpiryDays?: number;
}

/** Shared AgentCore Memory for the Waggle AI agents. */
export class WaggleAIMemory extends Construct {
    public readonly memoryId: string;

    constructor(scope: Construct, id: string, properties: WaggleAIMemoryProperties) {
        super(scope, id);

        // Execution role AgentCore Memory assumes to run long-term extraction (model invocation).
        const memoryRole = new Role(this, 'MemoryRole', {
            assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        });
        memoryRole.addToPrincipalPolicy(
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['bedrock:InvokeModel'],
                resources: [`arn:aws:bedrock:*::foundation-model/*`],
            }),
        );

        const memory = new CfnMemory(this, 'Memory', {
            name: 'WaggleAIMemory',
            description: 'Short + long term memory for the Waggle AI agents (actorId + sessionId scoped)',
            eventExpiryDuration: properties.eventExpiryDays ?? 30,
            memoryExecutionRoleArn: memoryRole.roleArn,
            memoryStrategies: [
                {
                    summaryMemoryStrategy: {
                        name: 'ConversationSummary',
                        namespaces: ['/waggleai/{actorId}/{sessionId}/summary'],
                    },
                },
                {
                    userPreferenceMemoryStrategy: {
                        name: 'PetPreferences',
                        namespaces: ['/waggleai/{actorId}/preferences'],
                    },
                },
            ],
        });

        this.memoryId = memory.attrMemoryId;

        AgentUtils.createSsmParameters(
            this,
            AGENT_PARAM_PREFIX,
            new Map([[properties.ssmMemoryIdParameterName, this.memoryId]]),
        );

        new CfnOutput(this, 'WaggleAIMemoryId', { value: this.memoryId });

        NagSuppressions.addResourceSuppressions(
            memoryRole,
            [{ id: 'AwsSolutions-IAM5', reason: 'Memory extraction invokes Bedrock foundation models' }],
            true,
        );
    }
}
