import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as resourcegroups from 'aws-cdk-lib/aws-resourcegroups';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as yaml from 'js-yaml';
import { Stack, StackProps, CfnJson, Fn, CfnOutput } from 'aws-cdk-lib';
import { readFileSync } from 'fs';
import { Construct } from 'constructs'
import { ContainerImageBuilderProps, ContainerImageBuilder } from './common/container-image-builder'
import { PetAdoptionsHistory } from './applications/pet-adoptions-history-application'
import { KubectlV34Layer } from '@aws-cdk/lambda-layer-kubectl-v34';

export class Applications extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope,id,props);

    const stackName = id;

    const roleArn = ssm.StringParameter.fromStringParameterAttributes(this, 'getParamClusterAdmin', { parameterName: "/eks/petsite/EKSMasterRoleArn"}).stringValue;
    const targetGroupArn = ssm.StringParameter.fromStringParameterAttributes(this, 'getParamTargetGroupArn', { parameterName: "/eks/petsite/TargetGroupArn"}).stringValue;
    const oidcProviderUrl = ssm.StringParameter.fromStringParameterAttributes(this, 'getOIDCProviderUrl', { parameterName: "/eks/petsite/OIDCProviderUrl"}).stringValue;
    const oidcProviderArn = ssm.StringParameter.fromStringParameterAttributes(this, 'getOIDCProviderArn', { parameterName: "/eks/petsite/OIDCProviderArn"}).stringValue;
    const rdsSecretArn = ssm.StringParameter.fromStringParameterAttributes(this, 'getRdsSecretArn', { parameterName: "/petstore/rdssecretarn"}).stringValue;
    const petHistoryTargetGroupArn = ssm.StringParameter.fromStringParameterAttributes(this, 'getPetHistoryParamTargetGroupArn', { parameterName: "/eks/pethistory/TargetGroupArn"}).stringValue;

    const cluster = eks.Cluster.fromClusterAttributes(this, 'MyCluster', {
      clusterName: 'PetSite',
      kubectlLayer: new KubectlV34Layer(this, 'kubectl'),
      kubectlRoleArn: roleArn,
    });
    // ClusterID is not available for creating the proper conditions https://github.com/aws/aws-cdk/issues/10347
    // Thsos might be an issue
    const clusterId = Fn.select(4, Fn.split('/', oidcProviderUrl)) // Remove https:// from the URL as workaround to get ClusterID

    const stack = Stack.of(this);
    const region = stack.region;

    const app_federatedPrincipal = new iam.FederatedPrincipal(
        oidcProviderArn,
        {
            StringEquals: new CfnJson(this, "App_FederatedPrincipalCondition", {
                value: {
                    [`oidc.eks.${region}.amazonaws.com/id/${clusterId}:aud` ]: "sts.amazonaws.com"
                }
            })
        }
    );
    const app_trustRelationship = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [ app_federatedPrincipal ],
        actions: ["sts:AssumeRoleWithWebIdentity"]
    })


    // FrontEnd SA (SSM, SQS, SNS)
    const petstoreserviceaccount = new iam.Role(this, 'PetSiteServiceAccount', {
//                assumedBy: eksFederatedPrincipal,
            assumedBy: new iam.AccountRootPrincipal(),
        managedPolicies: [
            iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSiteServiceAccount-AmazonSSMFullAccess', 'arn:aws:iam::aws:policy/AmazonSSMFullAccess'),
            iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSiteServiceAccount-AmazonSQSFullAccess', 'arn:aws:iam::aws:policy/AmazonSQSFullAccess'),
            iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSiteServiceAccount-AmazonSNSFullAccess', 'arn:aws:iam::aws:policy/AmazonSNSFullAccess'),
            iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSiteServiceAccount-AWSXRayDaemonWriteAccess', 'arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess')
        ],
    });
    petstoreserviceaccount.assumeRolePolicy?.addStatements(app_trustRelationship);

    const startStepFnExecutionPolicy = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
            'states:StartExecution'
        ],
        resources: ['*']
        });

    petstoreserviceaccount.addToPrincipalPolicy(startStepFnExecutionPolicy);

    // ⚠️ petsite 的 Waggle 聊天要调 AgentCore Runtime，这个权限**原先完全没有** ——
    //    该角色只挂了 SSM/SQS/SNS/X-Ray 四个托管策略，内联里与 bedrock 相关的语句为零，
    //    症状是聊天框每次都回
    //      [Sorry, the connection was interrupted. Please try again.]
    //    而那句话来自 WaggleController.cs 第 144 行的**通用 catch 兜底文案**，
    //    把所有异常类型都归成同一句，从前端完全看不出是权限问题。
    //    实际异常是：
    //      AccessDeniedException: User: arn:aws:sts::...:assumed-role/
    //        Applications-PetSiteServiceAccount... is not authorized to perform:
    //        bedrock-agentcore:InvokeAgentRuntime
    //    请求 0.08 秒就返回，不是超时（先前怀疑的 ALB 60s 空闲超时已当场排除）。
    //
    //    为什么此前的验证全部通过却漏掉它：我用 `aws bedrock-agentcore
    //    invoke-agent-runtime` 和 loadgen 的 genai 部分测的都是**我自己的凭证**
    //    （管理员权限），而 petsite 走的是 IRSA 服务账号角色 —— 两条不同的身份路径。
    //    教训：验证一个应用能否调某个服务，必须用**该应用自己的身份**去调。
    //
    //    只授 orchestrator：petsite 只读 /petstore/agent/waggleairuntimearn 这一个
    //    Runtime ARN；委派到 Nutrition/Adoption/Ordering/Concierge 是 orchestrator
    //    用**它自己的角色**经 Gateway 完成的，不需要 petsite 持有那四个的权限。
    //    两条资源都要：invoke 走的是 /runtimes/{arn}/invocations，
    //    而 runtime 与 runtime-endpoint 是两级资源，只授前者仍会被拒。
    const invokeWaggleRuntimePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime'
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${region}:${this.account}:runtime/WaggleAIOrchestrator-*`,
        `arn:aws:bedrock-agentcore:${region}:${this.account}:runtime/WaggleAIOrchestrator-*/runtime-endpoint/*`
      ]
    });

    petstoreserviceaccount.addToPrincipalPolicy(invokeWaggleRuntimePolicy);

    const petsiteAsset = new DockerImageAsset(this, 'petsiteAsset', {
        // 必须显式钉住 arm64：节点组是 t4g（AL2023_ARM_64_STANDARD），
        // 不指定 platform 时 DockerImageAsset 跟随**构建宿主**架构 ——
        // 在 x86 机器上构建会静默产出 amd64 镜像，放到 arm64 节点上根本起不来。
        // 其余四个 EKS 服务镜像都已显式钉 LINUX_ARM64，只有入口服务 petsite 漏了。
        platform: Platform.LINUX_ARM64,
        directory: "./resources/microservices/petsite/petsite/"
    });


    var manifest = readFileSync("./resources/k8s_petsite/deployment.yaml","utf8");
    var deploymentYaml = yaml.loadAll(manifest) as Record<string,any>[];

    deploymentYaml[0].metadata.annotations["eks.amazonaws.com/role-arn"] = new CfnJson(this, "deployment_Role", { value : `${petstoreserviceaccount.roleArn}` });
    deploymentYaml[2].spec.template.spec.containers[0].image = new CfnJson(this, "deployment_Image", { value : `${petsiteAsset.imageUri}` });
    deploymentYaml[3].spec.targetGroupARN = new CfnJson(this,"targetgroupArn", { value: `${targetGroupArn}`})

    const deploymentManifest = new eks.KubernetesManifest(this,"petsitedeployment",{
        cluster: cluster,
        manifest: deploymentYaml
    });

    // PetAdoptionsHistory application definitions-----------------------------------------------------------------------
    const petAdoptionsHistoryContainerImage = new ContainerImageBuilder(this, 'pet-adoptions-history-container-image', {
       repositoryName: "pet-adoptions-history",
       dockerImageAssetDirectory: "./resources/microservices/petadoptionshistory-py",
    });
    new ssm.StringParameter(this,"putPetAdoptionHistoryRepositoryName",{
        stringValue: petAdoptionsHistoryContainerImage.repositoryUri,
        parameterName: '/petstore/pethistoryrepositoryuri'
    });

    const petAdoptionsHistoryApplication = new PetAdoptionsHistory(this, 'pet-adoptions-history-application', {
        cluster: cluster,
        app_trustRelationship: app_trustRelationship,
        kubernetesManifestPath: "./resources/microservices/petadoptionshistory-py/deployment.yaml",
        otelConfigMapPath: "./resources/microservices/petadoptionshistory-py/otel-collector-config.yaml",
        rdsSecretArn: rdsSecretArn,
        region: region,
        imageUri: petAdoptionsHistoryContainerImage.imageUri,
        targetGroupArn: petHistoryTargetGroupArn
    });

    this.createSsmParameters(new Map(Object.entries({
        '/eks/petsite/stackname': stackName
    })));

    this.createOuputs(new Map(Object.entries({
        'PetSiteECRImageURL': petsiteAsset.imageUri,
        'PetStoreServiceAccountArn': petstoreserviceaccount.roleArn,
    })));
    // Creating AWS Resource Group for all the resources of stack.
    const applicationsCfnGroup = new resourcegroups.CfnGroup(this, 'ApplicationsCfnGroup', {
        name: stackName,
        description: 'Contains all the resources deployed by Cloudformation Stack ' + stackName,
        resourceQuery: {
          type: 'CLOUDFORMATION_STACK_1_0',
        }
    });
  }

  private createSsmParameters(params: Map<string, string>) {
    params.forEach((value, key) => {
        //const id = key.replace('/', '_');
        new ssm.StringParameter(this, key, { parameterName: key, stringValue: value });
    });
    }

    private createOuputs(params: Map<string, string>) {
    params.forEach((value, key) => {
        new CfnOutput(this, key, { value: value })
    });
    }
}