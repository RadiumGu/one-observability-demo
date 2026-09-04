/*
 * WaggleAI agent 栈 —— 自包含，可独立于 ServicesEks2 部署与销毁。
 *
 * 为什么单独一个栈而不是塞进 services-eks.ts：
 *   ① 那个文件已经 1000+ 行，且管着 Aurora / EKS / 公网 ALB 等**不可重建**的资源。
 *      硬约束是「可重建的只有 EKS 里的 petsite 应用」，把 agent 混进去会让每次
 *      agent 迭代都要 `cdk deploy ServicesEks2`，风险面完全不成比例。
 *   ② 上游是 CDK Pipeline + Stage 模型（`stages/applications.ts` 里在微服务循环内
 *      顺带创建 runtime），本地是朴素的两栈结构（app/pet_stack.ts），
 *      照搬上游的接线位置无处可放。
 *
 * 现有资源全部**按 ID 导入**，绝不重建：VPC、子网、EKS 集群 SG、internal ALB 及其 SG。
 */
import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Repository, TagMutability } from 'aws-cdk-lib/aws-ecr';
import { CfnListener, CfnTargetGroup } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {
    CfnSecurityGroupIngress,
    Peer,
    Port,
    SecurityGroup,
    SubnetSelection,
    Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { PrincipalWithConditions, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import {
    AGENT_MODEL_ENV,
    AGENT_RUNTIME_ENV,
    AGENT_VPC_CONFIG,
    INTERNAL_ALB_DNS,
    WAGGLE_AI_AGENT_RUNTIMES,
} from './agent-config';
import { AgentUtils } from './agent-utils';
import { AgentRuntimeConstruct } from './waggle-ai-agents-runtime';
import { AgentGatewayTarget, WaggleAIGateway } from './waggle-ai-agents-gateway';
import { WaggleAIMemory } from './waggle-ai-agents-memory';
import { WaggleAIGuardrail } from './waggle-ai-agents-guardrail';
import { WaggleAINutritionKb } from './waggle-ai-nutrition-kb';
import { WaggleAIAutoReload } from './waggle-ai-agents-autoreload';

/** internal ALB 现有的 listener 端口，agent 需要能连上去。 */
const EXISTING_INTERNAL_ALB_PORTS = [80, 8081];

/**
 * 既有 internal ALB 的 ARN 后缀（实测取得）。
 * 用 formatArn 拼而不是硬编码整条 ARN，账号与区域仍来自 Stack 上下文。
 */
const ALB_SUFFIX = 'b651f61f074cbbfe';

/**
 * 需要在 internal ALB 上补 listener 的后端。
 *
 * 端口选择：现有已占用 80 与 8081，从 8082 起顺延。
 * 每个后端都要在集群里配一个 TargetGroupBinding 才会有目标 ——
 * 否则 listener 存在但目标组为空，返回 503。
 *
 * petfood 的两个后端（petfoodapiurl / petfoodcarturl）暂不在此 ——
 * 服务本身还没部署到 EKS。缺参数时上游 config.py 返回 ""，
 * 对应 tool 报 "not configured" 而**不崩溃**，所以 ordering agent 可先部分工作。
 */
const AGENT_ALB_BACKENDS: Array<{
    name: string;
    serviceName: string;
    servicePort: number;
    listenerPort: number;
    targetGroupName: string;
    healthCheckPath: string;
    ssmShortName: string;
}> = [
    {
        name: 'ListAdoptions',
        serviceName: 'list-adoptions',
        servicePort: 80,
        listenerPort: 8082,
        targetGroupName: 'petsite-lt-listadopt-tg',
        healthCheckPath: '/health/status',
        ssmShortName: 'petlistadoptionsurl',
    },
    {
        name: 'PayForAdoption',
        serviceName: 'pay-for-adoption',
        servicePort: 80,
        listenerPort: 8083,
        targetGroupName: 'petsite-lt-payadopt-tg',
        healthCheckPath: '/health/status',
        ssmShortName: 'paymentapiurl',
    },
];

export class WaggleAIAgents extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        // ── 导入现有网络，不重建 ────────────────────────────────────────────
        const vpc = Vpc.fromVpcAttributes(this, 'PetSiteVpc', {
            vpcId: AGENT_VPC_CONFIG.vpcId,
            availabilityZones: ['ap-northeast-1a', 'ap-northeast-1c'],
            // 四个子网**全部是私有的**（实测无公有子网），所以 privateSubnetIds 就是全部子网。
            // AgentRuntimeConstruct 内部用 `vpc.privateSubnets` 取值放进 NetworkModeConfig。
            privateSubnetIds: [...AGENT_VPC_CONFIG.subnetIds],
        });

        // ── agent runtime ENI 专属 SG ──────────────────────────────────────
        // 不复用集群 SG：那样一来 agent 与 EKS 节点的网络权限就绑死了，
        // 而且没法单独收回 agent 的访问权。独立 SG 让「谁能访问 ALB」这件事可审计。
        const agentSg = new SecurityGroup(this, 'AgentRuntimeSg', {
            vpc,
            // ⚠️ 必须是纯 ASCII：EC2 的 GroupDescription 不接受非 ASCII 字符
            //    （API 直接返回 "Character sets beyond ASCII are not supported"）。
            //    我第一次在这里写了破折号 U+2014，部署直接失败并让整个栈回滚。
            //    注释里写中文没问题，但**任何进 AWS API 的字符串都要用 ASCII**。
            description: 'WaggleAI AgentCore runtime ENIs - egress to internal ALB and AWS APIs',
            allowAllOutbound: true,
        });

        // ── 让 agent 能到达 internal ALB ───────────────────────────────────
        //
        // ⚠️ 这一步是必需的，原因是一个实测出来的事实：
        //    internal ALB（petsite-internal-lt）在 vpc-010ab37a3f9f74725（11.0.0.0/16），
        //    但它的 SG sg-06d40c8bcd96d347d **入站只允许 10.1.0.0/16** ——
        //    那是运维机所在的另一个 VPC（经对等/TGW 可达），
        //    **PetSite VPC 自己（11.0.x）反而连不上这个 ALB**。
        //    实测：从 10.1.2.48 访问 :80 与 :8081 都是 HTTP=200；
        //    而 Runtime 的 ENI 会落在 11.0.x 私有子网，按现有规则会被拒。
        //
        // 处置原则：
        //   · 规则写在**本栈**里（`CfnSecurityGroupIngress` 指向既有 SG 的 ID），
        //     不去改 ServicesEks2 —— 那个栈管着不可重建的资源。
        //     销毁本栈即自动回收这些规则，可逆。
        //   · 只允许**本栈新建的 agentSg**，不是整个 VPC CIDR —— 最小授权，且可审计。
        //   · ALB 仍是 `scheme=internal`，**没有新增任何公网入口**，符合硬约束。
        //   · 不手工 `aws ec2 authorize-security-group-ingress` —— 该 ALB 已有 6 个悬空
        //     CFN 物理 ID，手工改只会加深漂移。
        // ⚠️ SG **规则**描述的字符集比 GroupDescription 更严，只允许：
        //      a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*
        //    注意 **没有 `>`** —— 我一开始写 "runtimes -> internal ALB" 就因为这个箭头
        //    被拒（报 "Invalid rule description"），四条规则全部 CREATE_FAILED、整栈回滚。
        //    这与上面 GroupDescription 的 ASCII 限制是**两条不同的规则**，
        //    只把非 ASCII 改掉并不够。用 "to" 和 "port" 这类纯字母词最省事。
        for (const port of EXISTING_INTERNAL_ALB_PORTS) {
            new CfnSecurityGroupIngress(this, `InternalAlbIngress${port}`, {
                groupId: AGENT_VPC_CONFIG.internalAlbSecurityGroupId,
                ipProtocol: 'tcp',
                fromPort: port,
                toPort: port,
                sourceSecurityGroupId: agentSg.securityGroupId,
                description: `WaggleAI agent runtimes to internal ALB port ${port}`,
            });
        }

        // ── internal ALB 上给 agent 需要的后端补 listener ───────────────────
        //
        // 背景：agent 不能走 `.svc.cluster.local` —— CoreDNS 在集群内，
        // 而 Runtime 的 VPC ENI 用的是 Route53 Resolver，集群内域名解析不了。
        // 所以 agent 只能通过 internal ALB 访问后端服务。
        //
        // 现有 listener 只有两个（实测）：:80 -> petsite-lt-tg、:8081 -> petsite-lt-search-tg。
        // `AGENT_BACKEND_SSM` 里 searchapiurl 已有着落（:8081），
        // 其余三项 listenerPort 是 null，需要在这里补。
        //
        // ⚠️ 为什么写在本栈而不是 services-eks.ts：
        //    ALB 本体由 ServicesEks2 管，而那个栈还管着 Aurora / EKS / 公网 ALB
        //    等**不可重建**资源。只为加 listener 去 deploy 那个栈，风险面完全不成比例。
        //    这里用 CfnListener + CfnTargetGroup 引用**既有 ALB 的 ARN**，
        //    资源归本栈所有，销毁本栈即回收，且不碰 ALB 本体的定义。
        //
        // ⚠️ 也绝不手工 `aws elbv2 create-listener` —— 该 ALB 已有 6 个悬空 CFN
        //    物理 ID，手工新增只会加深漂移。
        //
        // 目标组建好后还需要在集群里建对应的 **TargetGroupBinding**（AWS LBC 的 CRD）
        // 才会把 Pod IP 注册进来 —— 那一步是 k8s 层，见 k8s-manifests/ 下的清单。
        // 只建目标组不建 TGB 的话，listener 会返回 503（目标组为空）。
        const albArn = Stack.of(this).formatArn({
            service: 'elasticloadbalancing',
            resource: 'loadbalancer/app/petsite-internal-lt',
            resourceName: ALB_SUFFIX,
        });

        for (const backend of AGENT_ALB_BACKENDS) {
            const tg = new CfnTargetGroup(this, `Tg-${backend.name}`, {
                name: backend.targetGroupName,
                port: backend.servicePort,
                protocol: 'HTTP',
                // ip 而非 instance：与现有 petsite-lt-tg / petsite-lt-search-tg 一致，
                // 这是 EKS + AWS LBC 的标准做法（直接注册 Pod IP，跳过 NodePort 一跳）。
                targetType: 'ip',
                vpcId: AGENT_VPC_CONFIG.vpcId,
                healthCheckPath: backend.healthCheckPath,
                healthCheckProtocol: 'HTTP',
                matcher: { httpCode: '200' },
            });

            new CfnListener(this, `Listener-${backend.name}`, {
                loadBalancerArn: albArn,
                port: backend.listenerPort,
                protocol: 'HTTP',
                defaultActions: [{ type: 'forward', targetGroupArn: tg.ref }],
            });

            // agent 通过这个 SSM 参数拿到后端地址
            AgentUtils.createSsmParameters(
                this,
                AGENT_RUNTIME_ENV.PARAMETER_STORE_PREFIX,
                new Map([[backend.ssmShortName, `http://${INTERNAL_ALB_DNS}:${backend.listenerPort}`]]),
            );

            // agent 的 ENI 要能连上这个新端口
            new CfnSecurityGroupIngress(this, `InternalAlbIngress${backend.listenerPort}`, {
                groupId: AGENT_VPC_CONFIG.internalAlbSecurityGroupId,
                ipProtocol: 'tcp',
                fromPort: backend.listenerPort,
                toPort: backend.listenerPort,
                sourceSecurityGroupId: agentSg.securityGroupId,
                description: `WaggleAI agent runtimes to internal ALB port ${backend.listenerPort} for ${backend.name}`,
            });

            new CfnOutput(this, `TargetGroupArn-${backend.name}`, {
                value: tg.ref,
                description: `Target group for ${backend.name}; bind it with a TargetGroupBinding on service ${backend.serviceName}`,
            });
        }

        // ── 五个 agent 的 ECR 仓库 ─────────────────────────────────────────
        // 上游靠 pipeline 的 containers.ts 阶段建仓库，本地没有那套，所以自建。
        // imageTagMutability 保持 MUTABLE：AgentCore 拉的是 `:latest`
        // （见 AgentRuntimeConstruct 的 containerUri），且 WaggleAIAutoReload
        // 正是靠「:latest 被重新推送」这个事件去触发 runtime 重载 ——
        // 设成 IMMUTABLE 会让整条自动重载链路失效。
        const repos = new Map<string, Repository>();
        for (const agent of WAGGLE_AI_AGENT_RUNTIMES) {
            const repo = new Repository(this, `Repo-${agent.runtimeName}`, {
                repositoryName: agent.ecrRepoName,
                imageTagMutability: TagMutability.MUTABLE,
                imageScanOnPush: true,
                // 本栈是可重建的，仓库随栈销毁；镜像可以从构建机重新推。
                removalPolicy: RemovalPolicy.DESTROY,
                emptyOnDelete: true,
            });
            repos.set(agent.runtimeName, repo);
        }

        // ── 五个 AgentCore Runtime ─────────────────────────────────────────
        //
        // ⚠️ **两阶段部署**，由 context `skip_agent_runtimes` 控制。
        //
        // 为什么必须分两阶段：Runtime 的 containerUri 是 `<repo>:latest`，
        // 而首次部署时 ECR 仓库刚建好、**里面是空的** ——
        // AgentCore 创建 Runtime 时拉不到镜像会失败，
        // 且失败发生在 CFN 创建中途，会让整个栈进入 ROLLBACK，连仓库一起回滚，
        // 于是「建仓库 -> 推镜像」这条路永远走不通，形成死锁。
        //
        // 正确顺序：
        //   ① cdk deploy WaggleAIAgents -c skip_agent_runtimes=true
        //      -> 建 5 个 ECR 仓库 + ALB listener/目标组 + SSM 参数（不建 Runtime/Gateway）
        //   ② 在构建机上 docker push 五个 arm64 镜像的 :latest
        //   ③ cdk deploy WaggleAIAgents        （不带该 context）
        //      -> 建 5 个 Runtime + Gateway + Memory + KB + Guardrail + AutoReload
        //
        // Gateway 也一并跳过 —— 它的 target 就是 Runtime 的 ARN，没有 Runtime 无从建立。
        const skipRuntimes = this.node.tryGetContext('skip_agent_runtimes') === 'true';

        // 五个执行角色**在两个阶段都创建** —— 这是为了确定性避开 IAM 传播竞态。
        // 阶段① 建角色（此时不建 runtime），到阶段③ 时它们已经存在好一段时间，
        // AgentCore 的 CreateAgentRuntime 去校验信任策略时不会再扑空。
        // 实测：把角色和 runtime 放在同一次部署里，第一个 runtime 必然报
        // "Role validation failed"，其余 4 个能进 CREATING —— 典型的时序问题。
        const agentRoles = new Map<string, Role>();
        for (const agent of WAGGLE_AI_AGENT_RUNTIMES) {
            agentRoles.set(
                agent.runtimeName,
                new Role(this, `Role-${agent.runtimeName}`, {
                    assumedBy: new PrincipalWithConditions(
                        new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
                        {
                            StringEquals: { 'aws:SourceAccount': Stack.of(this).account },
                            ArnLike: {
                                'aws:SourceArn': `arn:aws:bedrock-agentcore:${Stack.of(this).region}:${Stack.of(this).account}:*`,
                            },
                        },
                    ),
                }),
            );
        }

        const gatewayTargets: AgentGatewayTarget[] = [];
        for (const agent of skipRuntimes ? [] : WAGGLE_AI_AGENT_RUNTIMES) {
            const repo = repos.get(agent.runtimeName)!;
            const runtime = new AgentRuntimeConstruct(this, agent.runtimeName, {
                runtimeName: agent.runtimeName,
                appName: agent.ecrRepoName,
                ecrRepositoryUri: repo.repositoryUri,
                vpc,
                // networkMode 已由构造固定为 VPC，SecurityGroups/Subnets 由它 addOverride 注入
                securityGroups: [agentSg],
                environmentVariables: {
                    // 模型 ID（四个已在东京实调验证过，不是仅列表存在）
                    ...AGENT_MODEL_ENV,
                    // 运行时配置。含三个漏掉就**静默失败**的变量：
                    //   AWS_REGION（上游默认 us-east-1，不设则 jp. 前缀的 profile 不存在、五 agent 全挂）
                    //   PARAMETER_STORE_PREFIX（/petstore/agent）
                    //   AGENT_TRANSPORT（gateway）
                    ...AGENT_RUNTIME_ENV,
                    // 每个 agent 自己的覆盖项放最后，优先级最高
                    ...agent.env,
                },
                ssmArnParameterName: agent.ssmArnParameterName,
                role: agentRoles.get(agent.runtimeName),
            });
            // runtime 必须等仓库存在（否则创建时拉不到 :latest）
            runtime.node.addDependency(repo);

            gatewayTargets.push({
                targetName: agent.targetName,
                runtimeArn: runtime.agentRuntime.attrAgentRuntimeArn,
            });
        }

        // ── Gateway / Memory / KB / Guardrail 各一份，五个 agent 共用 ───────
        // Memory / KB / Guardrail 不依赖 Runtime，本可在阶段 ① 就建；
        // 但把它们和 Gateway 放同一个条件里，能让阶段 ① 的产物严格限定为
        // 「推镜像所必需的最小集合」，阶段 ① 失败时要回滚的东西也最少。
        if (skipRuntimes) {
            return;
        }

        new WaggleAIGateway(this, 'WaggleAIGateway', {
            targets: gatewayTargets,
            ssmGatewayUrlParameterName: 'waggleaigatewayurl',
        });

        new WaggleAIMemory(this, 'WaggleAIMemory', {
            ssmMemoryIdParameterName: 'waggleaimemoryid',
        });

        new WaggleAINutritionKb(this, 'WaggleAINutritionKb', {
            ssmKbIdParameterName: 'waggleainutritionkbid',
        });

        new WaggleAIGuardrail(this, 'WaggleAIGuardrail', {
            ssmGuardrailIdParameterName: 'waggleaiguardrailid',
            ssmGuardrailVersionParameterName: 'waggleaiguardrailversion',
        });

        // ── 新镜像推送后自动重载 runtime ───────────────────────────────────
        // 没有它，`docker push :latest` 之后 runtime 仍跑旧镜像 —— agent 代码改动永远不生效。
        const repoToRuntime: { [repoName: string]: string } = {};
        for (const agent of WAGGLE_AI_AGENT_RUNTIMES) {
            repoToRuntime[agent.ecrRepoName] = agent.runtimeName;
        }
        new WaggleAIAutoReload(this, 'WaggleAIAutoReload', { repoToRuntime });

        // ── 输出：构建机推镜像时要用 ───────────────────────────────────────
        for (const agent of WAGGLE_AI_AGENT_RUNTIMES) {
            new CfnOutput(this, `EcrUri-${agent.runtimeName}`, {
                value: repos.get(agent.runtimeName)!.repositoryUri,
                description: `ECR repo for ${agent.runtimeName} (build with deploy/Dockerfile.${agent.dockerfileSuffix})`,
            });
        }
        new CfnOutput(this, 'AgentRuntimeSecurityGroupId', {
            value: agentSg.securityGroupId,
            description: 'SG attached to agent runtime ENIs; allowed inbound on the internal ALB',
        });
    }
}
