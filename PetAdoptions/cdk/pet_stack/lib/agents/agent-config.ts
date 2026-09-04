/**
 * AgentCore 部署配置 —— 东京区适配 + VPC 集成 + 模型改区。
 *
 * 为什么单独一个配置文件而不是散落在各构造里：
 *   上游 waggle_ai_agents 的模型 ID 全部硬编码为 `us.` 前缀的跨区域推理 profile，
 *   而 `us.` profile **无法从 ap-northeast-1 调用**。改区只需覆盖环境变量（不动一行
 *   agent 代码），把这些覆盖集中在一处，改区/换模型时只有这一个文件要动。
 *
 * ⚠️ 两个约束互锁成唯一架构，不要试图简化：
 *   1. 安全硬约束「ALB 上不得新增公网入口」→ agent 只能走 internal ALB
 *   2. internal ALB（scheme=internal）只在 VPC 内可达 → Runtime 必须 networkMode: VPC
 *   若把 Runtime 设成 PUBLIC 模式，它**根本连不上** internal ALB，
 *   而唯一的"修复"就是开公网入口 —— 那正是被禁止的。
 *
 * ⚠️ `.svc.cluster.local` 对 AgentCore **不可用**，即使在 VPC 模式下：
 *   集群内 DNS 由 CoreDNS 提供，而 VPC 里的 ENI 用的是 Route53 Resolver。
 *   现有 /petstore/* 参数全部指向 ClusterIP DNS，所以 agent **不能直接复用它们**，
 *   必须另建一组指向 internal ALB 的参数（见 AGENT_BACKEND_SSM）。
 */

/** 东京区实测可调用的模型（2026-09-04 用 bedrock-runtime converse 逐个实调验证，非仅列表存在）。 */
export const TOKYO_MODEL_IDS = {
    /** 上游默认 us.anthropic.claude-sonnet-4-6 —— 东京对等，jp 前缀数据留日本境内 */
    CLAUDE: 'jp.anthropic.claude-sonnet-4-6',
    /** 上游默认 us.amazon.nova-2-lite-v1:0 —— 东京同版本 */
    NOVA_LITE: 'jp.amazon.nova-2-lite-v1:0',
    /** 上游默认 openai.gpt-oss-120b-1:0 —— 东京 ON_DEMAND 可直调，连 profile 都不需要 */
    GPT_OSS: 'openai.gpt-oss-120b-1:0',
    /**
     * 替代 us.meta.llama4-maverick-17b-instruct-v1:0。
     * **东京完全没有任何 Llama 模型**（inference profile 与 on-demand 都查过），
     * 这是 Step 0 唯一查出的真阻塞。LlamaIndex 是框架、跑在 Bedrock Converse 上，
     * 并不要求模型必须是 Llama —— adoption 是检索组装型任务，Haiku 足够且更省。
     */
    ADOPTION_SUBSTITUTE: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
} as const;

/**
 * 注入 AgentCore Runtime 的环境变量覆盖。
 * 键名取自上游 common/models.py 与 common/config.py —— 那两处的默认值都用
 * os.getenv 包着，所以**设这些变量即可改区，不改一行 agent 代码**。
 */
export const AGENT_MODEL_ENV: Record<string, string> = {
    // config.py 层（models.py 的 SONNET_4_6 / GPT_OSS 从这里取）
    BEDROCK_CLAUDE_MODEL_ID: TOKYO_MODEL_IDS.CLAUDE,
    BEDROCK_GPT_OSS_MODEL_ID: TOKYO_MODEL_IDS.GPT_OSS,
    BEDROCK_NOVA_LITE_MODEL_ID: TOKYO_MODEL_IDS.NOVA_LITE,
    // BEDROCK_LLAMA_MODEL_ID 刻意不设 —— 东京无 Llama，改为在下面按 agent 覆盖，
    // 让「这个模型在本区不可用」这件事显式体现在 ADOPTION_MODEL_ID 上，
    // 而不是悄悄给 LLAMA 变量塞一个非 Llama 的值（那会让读代码的人被误导）。

    // models.py 的 AGENT_MODELS 层（env 覆盖优先于上面的调色板）
    ORCHESTRATOR_MODEL_ID: TOKYO_MODEL_IDS.CLAUDE,
    NUTRITION_MODEL_ID: TOKYO_MODEL_IDS.CLAUDE,
    ORDERING_MODEL_ID: TOKYO_MODEL_IDS.NOVA_LITE,
    ADOPTION_MODEL_ID: TOKYO_MODEL_IDS.ADOPTION_SUBSTITUTE,
    CONCIERGE_MODEL_ID: TOKYO_MODEL_IDS.GPT_OSS,
};

/**
 * 非模型类但**必须显式设置**的环境变量。
 *
 * 这一组是逐个核对上游 24 个 os.getenv 调用后补上的 —— 漏掉其中任何一个，
 * 失败方式都是「静默走默认值」而不是报错，排查成本极高。
 */
export const AGENT_RUNTIME_ENV: Record<string, string> = {
    /**
     * ⚠️ 上游 config.py 的默认值是 **us-east-1**。不显式设置的话，
     * 所有 Bedrock 调用都会打到 us-east-1 —— 而 `jp.` 前缀的 inference profile
     * **在那里不存在**，五个 agent 全部失败，且报错是 ResourceNotFound 而不是
     * 「区域配错了」，很难一眼看出根因。
     */
    AWS_REGION: 'ap-northeast-1',

    /**
     * ⚠️ 必须指向 /petstore/agent 而不是默认的 /petstore。
     * 现有 /petstore/* 参数的值全是 `*.svc.cluster.local`（ClusterIP），
     * AgentCore 解析不了（见文件头注释）。另建的 /petstore/agent/* 才指向 internal ALB。
     * 不设这个 = agent 读到 ClusterIP URL = 所有后端调用超时。
     */
    PARAMETER_STORE_PREFIX: '/petstore/agent',

    /**
     * ⚠️ 上游默认 "local" —— 五个 agent 跑在**同一个容器**里，
     * 委派是进程内函数调用（delegate.py 用 lazy import 直接调）。
     *
     * 那样做的后果：图谱里只会有 **1 个 AgentRuntime 节点、零条 Delegates 边** ——
     * Stage 2 新增的 `Delegates` 边类型会永远为空，而它在 test_11 的
     * PENDING_FIRST_EDGE 里，永远为空就等于永远放弃对它的存在性检查。
     *
     * 设成 "gateway" 后 orchestrator 走 `POST {gateway}/{target}/invocations`
     * 并带 SigV4 签名 —— 委派变成真实的跨 Runtime HTTP 调用，在 aws/spans 里可见，
     * etl_agentcore 才建得出 Delegates 边。
     *
     * **这个项目的核心是依赖图谱，所以必须选 gateway。**
     */
    AGENT_TRANSPORT: 'gateway',

    /** Gateway 上四个子 agent 的路由名。与 delegate.py 的 _TARGETS 默认值一致，显式写出以防改名后失联。 */
    NUTRITION_TARGET: 'nutrition',
    ORDERING_TARGET: 'ordering',
    ADOPTION_TARGET: 'adoption',
    CONCIERGE_TARGET: 'concierge',

    /** 后端调用超时。默认值上游未写死，显式给一个防止 agent 被慢后端拖住整轮对话。 */
    HTTP_TIMEOUT: '30',
};

/**
 * 部署时才能填的环境变量 —— 它们的值是本次部署创建出来的资源 ID。
 * CDK 里用构造的 ref 填充，**不要硬编码**。
 *
 * ⚠️ `BEDROCK_LLAMA_MODEL_ID` 刻意不出现在任何一组里：东京无 Llama，
 *    adoption agent 通过 ADOPTION_MODEL_ID 直接指向替代模型。
 *    给 LLAMA 变量塞一个非 Llama 的值会让读代码的人被误导。
 */
export const AGENT_DEPLOY_TIME_ENV_KEYS = [
    'GATEWAY_URL',      // AgentCore Gateway 的 endpoint —— gateway transport 的前提
    'MEMORY_ID',        // AgentCore Memory
    'NUTRITION_KB_ID',  // Bedrock Knowledge Base（S3 Vectors）
    'GUARDRAIL_ID',
    'GUARDRAIL_VERSION',
    'IMAGES_CDN_URL',   // petfood 的图片 CDN，随 Stage 3 的 petfood 一起补
] as const;

/**
 * Runtime 的 VPC 网络配置。取值来自实测（2026-09-04）：
 *   EKS 集群 PetSite 的 VPC 与其四个**全私有**子网。
 */
export const AGENT_VPC_CONFIG = {
    vpcId: 'vpc-010ab37a3f9f74725',
    /** 四个子网 MapPublicIpOnLaunch 全部为 false —— 实测确认，Runtime 放这里不会获得公网 IP */
    subnetIds: [
        'subnet-02ebd1dd8d1681da8', // ap-northeast-1a  11.0.0.0/24
        'subnet-0600a43fa7ebf1ffe', // ap-northeast-1c  11.0.1.0/24
        'subnet-0f801fa79077eb277', // ap-northeast-1a  11.0.2.0/24  ← internal ALB 也在此
        'subnet-047a94f9c5ab6302a', // ap-northeast-1c  11.0.3.0/24  ← internal ALB 也在此
    ],
    /** EKS 集群安全组。Runtime 用它才能被 internal ALB 的 SG 放行 */
    clusterSecurityGroupId: 'sg-02df8bc13ac85c4cc',
    /** internal ALB 的安全组 —— 需要放行来自 Runtime ENI 的入站 */
    internalAlbSecurityGroupId: 'sg-06d40c8bcd96d347d',
} as const;

/** internal ALB 的 DNS。scheme=internal，**不对公网暴露**，符合安全硬约束。 */
export const INTERNAL_ALB_DNS =
    'internal-petsite-internal-lt-1660792065.ap-northeast-1.elb.amazonaws.com';

/**
 * agent 专用的后端 URL 参数。
 *
 * 为什么不复用现有 /petstore/* ：那些值指向 `*.svc.cluster.local`（ClusterIP），
 * AgentCore 解析不了（见文件头注释）。所以另建 /petstore/agent/* 一组，
 * 指向 internal ALB。**现有参数保持不动** —— 它们服务于集群内的 petsite，
 * 改掉会波及正在运行的应用。
 *
 * `listenerPort: null` 表示 internal ALB 上**尚未**有对应 listener，需要在 CDK 里补。
 * 只补 internal listener，绝不动公网 ALB。
 */
export const AGENT_BACKEND_SSM: Array<{
    /** SSM 参数名（agent 侧用 PARAMETER_STORE_PREFIX=/petstore/agent 读取短名） */
    shortName: string;
    /** 上游 config.py 的 _BACKEND_SSM_NAMES 里对应的逻辑键 */
    logicalKey: string;
    /** internal ALB 上的端口；null = 待新增 */
    listenerPort: number | null;
    path: string;
    note: string;
}> = [
    {
        shortName: 'searchapiurl',
        logicalKey: 'SEARCH_API_URL',
        listenerPort: 8081,
        path: '/api/search?',
        note: 'internal ALB :8081 → petsite-lt-search-tg，实测 2 个目标 healthy，无需新增',
    },
    {
        shortName: 'petlistadoptionsurl',
        logicalKey: 'ADOPTIONLIST_API_URL',
        listenerPort: null,
        path: '/api/adoptionlist/',
        note: '需在 internal ALB 新增 listener 指向 list-adoptions（ClusterIP:80）',
    },
    {
        shortName: 'paymentapiurl',
        logicalKey: 'PAYFORADOPTION_API_URL',
        listenerPort: null,
        path: '/api/home/completeadoption',
        note: '需在 internal ALB 新增 listener 指向 pay-for-adoption（ClusterIP:80）',
    },
    {
        shortName: 'petfoodapiurl',
        logicalKey: 'PETFOOD_API_URL',
        listenerPort: null,
        path: '/api/foods',
        note: '⏸ petfood 服务在 Stage 3 尚未移植。缺此参数时上游 config.py 返回 ""，'
            + '对应 tool 报 "not configured" 而**不崩溃** —— 所以 ordering agent 可先部分工作',
    },
    {
        shortName: 'petfoodcarturl',
        logicalKey: 'PETFOOD_CART_URL',
        listenerPort: null,
        path: '/api/cart',
        note: '同上，随 petfood 一起补',
    },
];

/**
 * KB 的向量库配置。照搬账号内已有范式而非另起一套 ——
 * `gp-incident-kb`（2026-03-31 建，索引 incidents-v1）已在东京跑了 5 个月，
 * 证明 S3 Vectors 在本区可用且本项目已掌握其建法。
 *
 * 选 S3 Vectors 而非 OpenSearch Serverless 是上游的选择，也正好避开后者的
 * 最低 OCU 月费（数百美元级）。
 */
export const AGENT_KB_CONFIG = {
    vectorBucketName: 'waggle-nutrition-kb',
    indexName: 'nutrition-v1',
    /** 东京实测可用的 embedding 模型 */
    embeddingModelId: 'amazon.titan-embed-text-v2:0',
    /** rag/knowledge/ 下 10 篇宠物营养知识文档，由 rag/setup_kb.py 灌入 */
    knowledgeDocCount: 10,
} as const;
