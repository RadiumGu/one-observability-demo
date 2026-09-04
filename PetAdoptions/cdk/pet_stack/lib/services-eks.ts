import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3seeder from 'aws-cdk-lib/aws-s3-deployment';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as yaml from 'js-yaml';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as applicationinsights from 'aws-cdk-lib/aws-applicationinsights';
import * as resourcegroups from 'aws-cdk-lib/aws-resourcegroups';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';
import { PayForAdoptionServiceEks } from './services/pay-for-adoption-service-eks';
import { ListAdoptionsServiceEks } from './services/list-adoptions-service-eks';
import { SearchServiceEks } from './services/search-service-eks';
import { TrafficGeneratorServiceEks } from './services/traffic-generator-service-eks';
import { PetFoodServiceEks } from './services/petfood-service-eks';
import { StatusUpdaterService } from './services/status-updater-service';
import { PetAdoptionsStepFn } from './services/stepfn';
import { KubernetesVersion } from 'aws-cdk-lib/aws-eks';
import { CfnJson, RemovalPolicy, Fn, Duration, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { readFileSync } from 'fs';
import 'ts-replace-all';
import { TreatMissingData, ComparisonOperator } from 'aws-cdk-lib/aws-cloudwatch';
import { KubectlV34Layer } from '@aws-cdk/lambda-layer-kubectl-v34';

export class ServicesEks2 extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const stackName = id;

    const vpcCidr: string = this.node.tryGetContext('vpc_cidr') ?? '10.20.0.0/16';

    // Create SQS resource to send Pet adoption messages to
    const dlq = new sqs.Queue(this, 'sqs_petadoption_dlq', {
      retentionPeriod: Duration.days(14),
    });

    const sqsQueue = new sqs.Queue(this, 'sqs_petadoption', {
      visibilityTimeout: Duration.seconds(300),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // Create SNS and an email topic to send notifications to
    const topic_petadoption = new sns.Topic(this, 'topic_petadoption');
    var topic_email = this.node.tryGetContext('snstopic_email');
    if (topic_email == undefined) {
      topic_email = 'someone@example.com';
    }
    topic_petadoption.addSubscription(new subs.EmailSubscription(topic_email));

    // Creates an S3 bucket to store pet images
    const s3_observabilitypetadoptions = new s3.Bucket(this, 's3bucket_petadoption', {
      publicReadAccess: false,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Creates the DynamoDB table for Petadoption data
    const dynamodb_petadoption = new ddb.Table(this, 'ddb_petadoption', {
      partitionKey: {
        name: 'pettype',
        type: ddb.AttributeType.STRING,
      },
      sortKey: {
        name: 'petid',
        type: ddb.AttributeType.STRING,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    dynamodb_petadoption.metric('WriteThrottleEvents', { statistic: 'avg' }).createAlarm(this, 'WriteThrottleEvents-BasicAlarm', {
      threshold: 0,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmName: `${dynamodb_petadoption.tableName}-WriteThrottleEvents-BasicAlarm`,
    });

    dynamodb_petadoption.metric('ReadThrottleEvents', { statistic: 'avg' }).createAlarm(this, 'ReadThrottleEvents-BasicAlarm', {
      threshold: 0,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmName: `${dynamodb_petadoption.tableName}-ReadThrottleEvents-BasicAlarm`,
    });

    // Seeds the S3 bucket with pet images
    new s3seeder.BucketDeployment(this, 's3seeder_petadoption', {
      destinationBucket: s3_observabilitypetadoptions,
      sources: [s3seeder.Source.asset('./resources/kitten.zip'), s3seeder.Source.asset('./resources/puppies.zip'), s3seeder.Source.asset('./resources/bunnies.zip')],
    });

    // 使用现有 VPC (graph-dp-vpc-exploration) 而不是创建新 VPC
    // VPC CIDR is read from cdk.json context key 'vpc_cidr'
    const theVPC = new ec2.Vpc(this, 'PetSiteVPC', {
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // 禁用公有子网的自动分配公网 IP，避免安全警告
    const publicSubnets = theVPC.selectSubnets({
      subnetType: ec2.SubnetType.PUBLIC,
    });
    for (const subnet of publicSubnets.subnets) {
      const cfnSubnet = subnet.node.defaultChild as ec2.CfnSubnet;
      cfnSubnet.mapPublicIpOnLaunch = false;
    }

    // Create RDS Aurora PG cluster
    const rdssecuritygroup = new ec2.SecurityGroup(this, 'petadoptionsrdsSG', {
      vpc: theVPC,
    });

    rdssecuritygroup.addIngressRule(ec2.Peer.ipv4(vpcCidr), ec2.Port.tcp(5432), 'Allow Aurora PG access from within the VPC CIDR range');

    var rdsUsername = this.node.tryGetContext('rdsusername');
    if (rdsUsername == undefined) {
      rdsUsername = 'petadmin';
    }

    const auroraCluster = new rds.DatabaseCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_11 }),
      parameterGroup: rds.ParameterGroup.fromParameterGroupName(this, 'ParameterGroup', 'default.aurora-postgresql16'),
      vpc: theVPC,
      securityGroups: [rdssecuritygroup],
      defaultDatabaseName: 'adoptions',
      databaseInsightsMode: rds.DatabaseInsightsMode.ADVANCED,
      performanceInsightRetention: rds.PerformanceInsightRetention.MONTHS_15,
      writer: rds.ClusterInstance.provisioned('writer', {
        autoMinorVersionUpgrade: true,
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      }),
      readers: [
        rds.ClusterInstance.provisioned('reader1', {
          promotionTier: 1,
          instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
        }),
      ],
    });

    const readSSMParamsPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParametersByPath', 'ssm:GetParameters', 'ssm:GetParameter', 'ec2:DescribeVpcs'],
      resources: ['*'],
    });

    const ddbSeedPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:BatchWriteItem', 'dynamodb:ListTables', 'dynamodb:Scan', 'dynamodb:Query'],
      resources: ['*'],
    });

    const stack = Stack.of(this);
    const region = stack.region;

    // PetSite - Create ALB and Target Groups
    const albSG = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc: theVPC,
      allowAllOutbound: true,
    });
    albSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));  // HTTPS
    albSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));   // HTTP (重定向)

    const alb = new elbv2.ApplicationLoadBalancer(this, 'PetSiteLoadBalancer', {
      vpc: theVPC,
      internetFacing: true,
      securityGroup: albSG,
    });
    alb.node.addDependency(theVPC.internetConnectivityEstablished);

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'PetSiteTargetGroup', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      vpc: theVPC,
      targetType: elbv2.TargetType.IP,
    });

    new ssm.StringParameter(this, 'putParamTargetGroupArn', {
      stringValue: targetGroup.targetGroupArn,
      parameterName: '/eks/petsite/TargetGroupArn',
    });

    // HTTPS Listener (443) - ACM certificate ARN from cdk.json context key 'acm_certificate_arn'
    const acmCertificateArn = this.node.tryGetContext('acm_certificate_arn');
    if (!acmCertificateArn) {
      throw new Error("Required CDK context 'acm_certificate_arn' is not set. Pass it via cdk.json or --context acm_certificate_arn=<arn>");
    }
    const httpsListener = alb.addListener('HttpsListenerV2', {
      port: 443,
      open: true,
      certificates: [elbv2.ListenerCertificate.fromArn(acmCertificateArn)],
      defaultTargetGroups: [targetGroup],
    });

    // HTTP Listener (80) - 重定向到 HTTPS
    alb.addListener('HttpListener', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // PetAdoptionHistory - attach service to path /petadoptionhistory on PetSite ALB
    const petadoptionshistory_targetGroup = new elbv2.ApplicationTargetGroup(this, 'PetAdoptionsHistoryTargetGroup', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      vpc: theVPC,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health/status',
      },
    });

    httpsListener.addTargetGroups('PetAdoptionsHistoryTargetGroups', {
      priority: 40,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/petadoptionshistory/*'])],
      targetGroups: [petadoptionshistory_targetGroup],
    });

    // Streamlit (graph) - import existing TG
    const streamlitTG = elbv2.ApplicationTargetGroup.fromTargetGroupAttributes(this, 'StreamlitTG', {
      targetGroupArn: 'arn:aws:elasticloadbalancing:ap-northeast-1:926093770964:targetgroup/streamlit-demo-tg/aafb8e66ba257593',
    });
    httpsListener.addTargetGroups('StreamlitGraphRule', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/graph', '/graph/*'])],
      targetGroups: [streamlitTG],
    });

    // Neptune UI - import existing TG
    const neptuneTG = elbv2.ApplicationTargetGroup.fromTargetGroupAttributes(this, 'NeptuneUITG', {
      targetGroupArn: 'arn:aws:elasticloadbalancing:ap-northeast-1:926093770964:targetgroup/neptune-ui-tg/d124ff14d7b45d36',
    });
    httpsListener.addTargetGroups('NeptuneUIRule', {
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/neptune-ui', '/neptune-ui/*', '/neptune-api', '/neptune-api/*'])],
      targetGroups: [neptuneTG],
    });

    // Grafana (deepflow) - import existing TG
    const grafanaTG = elbv2.ApplicationTargetGroup.fromTargetGroupAttributes(this, 'GrafanaTG', {
      targetGroupArn: 'arn:aws:elasticloadbalancing:ap-northeast-1:926093770964:targetgroup/deepflow-grafana-tg/e8a80adef75f7bda',
    });
    httpsListener.addTargetGroups('GrafanaRule', {
      priority: 30,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/grafana', '/grafana/*'])],
      targetGroups: [grafanaTG],
    });

    new ssm.StringParameter(this, 'putPetHistoryParamTargetGroupArn', {
      stringValue: petadoptionshistory_targetGroup.targetGroupArn,
      parameterName: '/eks/pethistory/TargetGroupArn',
    });

    // PetSite - EKS Cluster
    const clusterAdmin = new iam.Role(this, 'AdminRole', {
      assumedBy: new iam.AccountRootPrincipal(),
    });

    new ssm.StringParameter(this, 'putParam', {
      stringValue: clusterAdmin.roleArn,
      parameterName: '/eks/petsite/EKSMasterRoleArn',
    });

    const secretsKey = new kms.Key(this, 'SecretsKey');
    const clusterName: string = this.node.tryGetContext('cluster_name') ?? 'PetSite';
    const cluster = new eks.Cluster(this, 'petsite', {
      clusterName: clusterName,
      mastersRole: clusterAdmin,
      vpc: theVPC,
      defaultCapacity: 0,  // 禁用默认 NodeGroup，手动创建以指定 AMI 类型
      secretsEncryptionKey: secretsKey,
      version: eks.KubernetesVersion.V1_34,
      kubectlLayer: new KubectlV34Layer(this, 'kubectl'),
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
    });

    // 创建清理 Lambda
    const cleanupLambda = new lambda.Function(this, 'GuardDutyCleanupLambda', {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      timeout: Duration.minutes(5),
      code: lambda.Code.fromInline(`
import boto3
import json

def handler(event, context):
    vpc_id = event['vpcId']
    region = event['region']
    ec2 = boto3.client('ec2', region_name=region)
    
    # 删除 GuardDuty VPC Endpoints
    try:
        endpoints = ec2.describe_vpc_endpoints(
            Filters=[
                {'Name': 'vpc-id', 'Values': [vpc_id]},
                {'Name': 'tag:GuardDutyManaged', 'Values': ['true']}
            ]
        )
        for ep in endpoints.get('VpcEndpoints', []):
            ec2.delete_vpc_endpoints(VpcEndpointIds=[ep['VpcEndpointId']])
            print(f"Deleted VPC Endpoint: {ep['VpcEndpointId']}")
    except Exception as e:
        print(f"Error deleting VPC endpoints: {e}")
    
    # 删除 GuardDuty Security Groups
    try:
        sgs = ec2.describe_security_groups(
            Filters=[
                {'Name': 'vpc-id', 'Values': [vpc_id]},
                {'Name': 'group-name', 'Values': ['GuardDutyManagedSecurityGroup-*']}
            ]
        )
        for sg in sgs.get('SecurityGroups', []):
            if sg['GroupName'].startswith('GuardDutyManagedSecurityGroup-'):
                ec2.delete_security_group(GroupId=sg['GroupId'])
                print(f"Deleted Security Group: {sg['GroupId']}")
    except Exception as e:
        print(f"Error deleting security groups: {e}")
    
    return {'statusCode': 200, 'body': json.dumps('Cleanup completed')}
`),
    });

    cleanupLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeVpcEndpoints', 'ec2:DeleteVpcEndpoints', 'ec2:DescribeSecurityGroups', 'ec2:DeleteSecurityGroup'],
      resources: ['*'],
    }));

    // 清理 GuardDuty 资源（在 VPC 删除前）
    const cleanupGuardDuty = new cr.AwsCustomResource(this, 'CleanupGuardDuty', {
      onDelete: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: cleanupLambda.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            vpcId: theVPC.vpcId,
            region: Stack.of(this).region
          })
        },
        physicalResourceId: cr.PhysicalResourceId.of('cleanup-guardduty'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [cleanupLambda.functionArn],
        })
      ]),
    });

    // 两个节点组按 AZ 拆分，各自只落在一个可用区 —— 这样 topologySpreadConstraints
    // 的 zone 维度才有真实的域可分散。
    //
    // ⚠️ 改 instanceTypes 是**替换**操作，不是在线调参。
    // 两个节点组都没有 launch template，而 EKS 托管节点组在这种情况下
    // instanceTypes 不可原地修改（update-nodegroup-config 不接受该字段）。
    // 因为这里没有显式指定 nodegroupName（物理名由 CloudFormation 生成，
    // 实测形如 petsiteNodegroupworkers1a60-ZJElxYDbKT8H），CFN 可以
    // **先建新节点组、再排空删除旧的**（create-then-delete），
    // 期间会短暂存在 8 个节点。旧节点排空会驱逐其上所有 Pod。
    //
    // 配套前置：k8s-manifests/07-pdb.yaml 为 5 个业务服务加了
    // minAvailable: 1 的 PodDisruptionBudget。此前整个集群只有 2 个 PDB
    // 且都在 kube-system —— petadoptions 的服务在排空时毫无保障，
    // 一次驱逐可以把两个副本同时赶走。改节点规格前必须先补上这个。
    //
    // large → xlarge 的两个理由（2026-08-30 实测）：
    //   ① 容量：t4g.large 可分配 1930m，而观测栈自己就要 2054m
    //      （cloudwatch 1300 + deepflow 550 + nfm 204）——比被观测的应用
    //      （petadoptions 1892m）还多。四节点 7720m 里 80% 已被 request 占掉，
    //      导致装不下一个 544m 的 Pod、search-service 两副本被挤在同一个 AZ。
    //      xlarge 约 3900m/节点，总量翻倍到约 15,600m，容量不再是约束。
    //   ② burstable 基线：credit 模式是 unlimited，持续超基线要付附加费。
    //      t4g.large 基线 30%×2vCPU = 600m，而 1c 节点实测 676m **已经在超**；
    //      t4g.xlarge 基线 40%×4vCPU = 1600m，覆盖现有全部实测用量
    //      （节点实际 133m/140m/249m/676m）。所以涨价的一部分被省下的
    //      附加费抵掉，不是净增。
    //
    // 成本（东京区按需，2026-08-30 经 Pricing API 核实）：
    //   t4g.large  $0.0864/hr × 4 = $0.3456/hr ≈ $252/月
    //   t4g.xlarge $0.1728/hr × 4 = $0.6912/hr ≈ $504/月   → 约 +$252/月

    // NodeGroup 1a - 仅部署在 ap-northeast-1a
    const nodegroupAZ1 = cluster.addNodegroupCapacity('workers-1a', {
      instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.XLARGE)],
      minSize: 2,
      maxSize: 3,
      desiredSize: 2,
      amiType: eks.NodegroupAmiType.AL2023_ARM_64_STANDARD,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        availabilityZones: ['ap-northeast-1a'],
      },
    });
    nodegroupAZ1.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    // NodeGroup 1c - 仅部署在 ap-northeast-1c
    const nodegroupAZ2 = cluster.addNodegroupCapacity('workers-1c', {
      instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.XLARGE)],
      minSize: 2,
      maxSize: 3,
      desiredSize: 2,
      amiType: eks.NodegroupAmiType.AL2023_ARM_64_STANDARD,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        availabilityZones: ['ap-northeast-1c'],
      },
    });
    nodegroupAZ2.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    const clusterSG = ec2.SecurityGroup.fromSecurityGroupId(this, 'ClusterSG', cluster.clusterSecurityGroupId);
    clusterSG.addIngressRule(albSG, ec2.Port.allTraffic(), 'Allow traffic from the ALB');
    clusterSG.addIngressRule(ec2.Peer.ipv4(vpcCidr), ec2.Port.tcp(443), 'Allow local access to k8s api');

    // From https://github.com/aws-samples/ssm-agent-daemonset-installer
    var ssmAgentSetup = yaml.loadAll(readFileSync('./resources/setup-ssm-agent.yaml', 'utf8')) as Record<string, any>[];

    const ssmAgentSetupManifest = new eks.KubernetesManifest(this, 'ssmAgentdeployment', {
      cluster: cluster,
      manifest: ssmAgentSetup,
    });

    // ClusterID is not available for creating the proper conditions https://github.com/aws/aws-cdk/issues/10347
    const clusterId = Fn.select(4, Fn.split('/', cluster.clusterOpenIdConnectIssuerUrl)); // Remove https:// from the URL as workaround to get ClusterID

    const cw_federatedPrincipal = new iam.FederatedPrincipal(
      cluster.openIdConnectProvider.openIdConnectProviderArn,
      {
        StringEquals: new CfnJson(this, 'CW_FederatedPrincipalCondition', {
          value: {
            [`oidc.eks.${region}.amazonaws.com/id/${clusterId}:aud`]: 'sts.amazonaws.com',
          },
        }),
      }
    );
    const cw_trustRelationship = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [cw_federatedPrincipal],
      actions: ['sts:AssumeRoleWithWebIdentity'],
    });

    // Create IAM roles for Service Accounts
    // Cloudwatch Agent SA
    const cwserviceaccount = new iam.Role(this, 'CWServiceAccount', {
      assumedBy: new iam.AccountRootPrincipal(),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(this, 'CWServiceAccount-CloudWatchAgentServerPolicy', 'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy'),
      ],
    });
    cwserviceaccount.assumeRolePolicy?.addStatements(cw_trustRelationship);

    const xray_federatedPrincipal = new iam.FederatedPrincipal(
      cluster.openIdConnectProvider.openIdConnectProviderArn,
      {
        StringEquals: new CfnJson(this, 'Xray_FederatedPrincipalCondition', {
          value: {
            [`oidc.eks.${region}.amazonaws.com/id/${clusterId}:aud`]: 'sts.amazonaws.com',
          },
        }),
      }
    );
    const xray_trustRelationship = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [xray_federatedPrincipal],
      actions: ['sts:AssumeRoleWithWebIdentity'],
    });

    // X-Ray Agent SA
    const xrayserviceaccount = new iam.Role(this, 'XRayServiceAccount', {
      assumedBy: new iam.AccountRootPrincipal(),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(this, 'XRayServiceAccount-AWSXRayDaemonWriteAccess', 'arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess'),
      ],
    });
    xrayserviceaccount.assumeRolePolicy?.addStatements(xray_trustRelationship);

    const loadbalancer_federatedPrincipal = new iam.FederatedPrincipal(
      cluster.openIdConnectProvider.openIdConnectProviderArn,
      {
        StringEquals: new CfnJson(this, 'LB_FederatedPrincipalCondition', {
          value: {
            [`oidc.eks.${region}.amazonaws.com/id/${clusterId}:aud`]: 'sts.amazonaws.com',
          },
        }),
      }
    );
    const loadBalancer_trustRelationship = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [loadbalancer_federatedPrincipal],
      actions: ['sts:AssumeRoleWithWebIdentity'],
    });

    const loadBalancerPolicyDoc = iam.PolicyDocument.fromJson(JSON.parse(readFileSync('./resources/load_balancer/iam_policy.json', 'utf8')));
    const loadBalancerPolicy = new iam.ManagedPolicy(this, 'LoadBalancerSAPolicy', { document: loadBalancerPolicyDoc });
    const loadBalancerserviceaccount = new iam.Role(this, 'LoadBalancerServiceAccount', {
      assumedBy: new iam.AccountRootPrincipal(),
      managedPolicies: [loadBalancerPolicy],
    });

    loadBalancerserviceaccount.assumeRolePolicy?.addStatements(loadBalancer_trustRelationship);

    const eksAdminArn = this.node.tryGetContext('admin_role');
    if (eksAdminArn != undefined && eksAdminArn.length > 0) {
      const adminRole = iam.Role.fromRoleArn(this, 'ekdAdminRoleArn', eksAdminArn, { mutable: false });
      cluster.grantAccess('TeamRoleAccess', adminRole.roleArn, [
        eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
          accessScopeType: eks.AccessScopeType.CLUSTER,
        }),
      ]);
    }

    var xRayYaml = yaml.loadAll(readFileSync('./resources/k8s_petsite/xray-daemon-config.yaml', 'utf8')) as Record<string, any>[];

    xRayYaml[0].metadata.annotations['eks.amazonaws.com/role-arn'] = new CfnJson(this, 'xray_Role', { value: `${xrayserviceaccount.roleArn}` });

    const xrayManifest = new eks.KubernetesManifest(this, 'xraydeployment', {
      cluster: cluster,
      manifest: xRayYaml,
    });

    var loadBalancerServiceAccountYaml = yaml.loadAll(readFileSync('./resources/load_balancer/service_account.yaml', 'utf8')) as Record<string, any>[];
    loadBalancerServiceAccountYaml[0].metadata.annotations['eks.amazonaws.com/role-arn'] = new CfnJson(this, 'loadBalancer_Role', { value: `${loadBalancerserviceaccount.roleArn}` });

    const loadBalancerServiceAccount = new eks.KubernetesManifest(this, 'loadBalancerServiceAccount', {
      cluster: cluster,
      manifest: loadBalancerServiceAccountYaml,
    });

    const waitForLBServiceAccount = new eks.KubernetesObjectValue(this, 'LBServiceAccount', {
      cluster: cluster,
      objectName: 'alb-ingress-controller',
      objectType: 'serviceaccount',
      objectNamespace: 'kube-system',
      jsonPath: '@',
    });

    const loadBalancerCRDYaml = yaml.loadAll(readFileSync('./resources/load_balancer/crds.yaml', 'utf8')) as Record<string, any>[];
    const loadBalancerCRDManifest = new eks.KubernetesManifest(this, 'loadBalancerCRD', {
      cluster: cluster,
      manifest: loadBalancerCRDYaml,
    });

    const awsLoadBalancerManifest = new eks.HelmChart(this, 'AWSLoadBalancerController', {
      cluster: cluster,
      chart: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      namespace: 'kube-system',
      wait: true,  // 等待 Helm Chart 完全就绪，确保 Webhook 可用
      timeout: Duration.minutes(15),  // 最大允许 15 分钟
      values: {
        clusterName: cluster.clusterName,
        fullnameOverride: 'aws-load-balancer-controller',
        serviceAccount: {
          create: false,
          name: 'alb-ingress-controller',
        },
        replicaCount: 2,
        vpcId: cluster.vpc.vpcId,
        region: this.region,
      },
    });
    awsLoadBalancerManifest.node.addDependency(loadBalancerCRDManifest);
    awsLoadBalancerManifest.node.addDependency(loadBalancerServiceAccount);
    awsLoadBalancerManifest.node.addDependency(waitForLBServiceAccount);

    // Wait for LB Controller deployment to have available replicas before creating LoadBalancer services
    const waitForLBControllerReady = new eks.KubernetesObjectValue(this, 'WaitForLBControllerReady', {
      cluster: cluster,
      objectName: 'aws-load-balancer-controller',
      objectType: 'deployment',
      objectNamespace: 'kube-system',
      jsonPath: '.status.availableReplicas',
    });
    waitForLBControllerReady.node.addDependency(awsLoadBalancerManifest);

    // NOTE: Amazon CloudWatch Observability Addon for CloudWatch Agent and Fluentbit
    const otelAddon = new eks.CfnAddon(this, 'otelObservabilityAddon', {
      addonName: 'amazon-cloudwatch-observability',
      addonVersion: 'v4.10.0-eksbuild.1',
      clusterName: cluster.clusterName,
      resolveConflicts: 'OVERWRITE',
      preserveOnDelete: false,
      serviceAccountRoleArn: cwserviceaccount.roleArn,
    });

    // IAM Role for Network Flow Monitor
    const networkFlowMonitorRole = new iam.CfnRole(this, 'NetworkFlowMonitorRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'pods.eks.amazonaws.com',
            },
            Action: ['sts:AssumeRole', 'sts:TagSession'],
          },
        ],
      },
      managedPolicyArns: ['arn:aws:iam::aws:policy/CloudWatchNetworkFlowMonitorAgentPublishPolicy'],
    });

    // Amazon EKS Pod Identity Agent Addon for Network Flow Monitor
    const podIdentityAgentAddon = new eks.CfnAddon(this, 'PodIdentityAgentAddon', {
      addonName: 'eks-pod-identity-agent',
      addonVersion: 'v1.3.10-eksbuild.2',
      clusterName: cluster.clusterName,
      resolveConflicts: 'OVERWRITE',
      preserveOnDelete: false,
    });

    // Amazon EKS AWS Network Flow Monitor Agent add-on
    const networkFlowMonitoringAgentAddon = new eks.CfnAddon(this, 'NetworkFlowMonitoringAgentAddon', {
      addonName: 'aws-network-flow-monitoring-agent',
      addonVersion: 'v1.1.3-eksbuild.1',
      clusterName: cluster.clusterName,
      resolveConflicts: 'OVERWRITE',
      preserveOnDelete: false,
      podIdentityAssociations: [
        {
          roleArn: networkFlowMonitorRole.attrArn,
          serviceAccount: 'aws-network-flow-monitor-agent-service-account',
        },
      ],
    });

    // ============================================================
    // MICROSERVICES - NOW DEPLOYED TO EKS INSTEAD OF ECS
    // ============================================================

    // PayForAdoption service - EKS deployment
    //
    // request 32m / limit 512m —— 实测右调（2026-08-30，压测中 metrics-server
    // 5 分钟 40 样本）：pod 级 p50 3m / p90 5m / p99 6m。
    // 原先 request 与 limit 同为 128m，相对实际用量虚高约 21 倍，
    // 而节点是按 request 预留的，这部分虚高直接变成不可用容量。
    // 32m 是刻意设的下限（低于此调度粒度失去意义），仍是 p99 的 5 倍余量；
    // HPA 阈值 60%×(32+32)=38m ≈ p99 的 6.4 倍，不会误触发。
    const payForAdoptionService = new PayForAdoptionServiceEks(this, 'pay-for-adoption', {
      cluster: cluster,
      cpu: '32m',
      cpuLimit: '512m',
      memory: '1Gi',
      replicas: 2,
      healthCheck: '/health/status',
      instrumentation: 'otel',
      region: region,
      database: auroraCluster,
      serviceType: 'ClusterIP',
      // ⚠️ 2026-09-04 移植上游 payforadoption-go 后**必须**有这 7 个变量。
      //
      // 上游把 config.go 的配置契约改了：SSM 参数路径原先是**硬编码**在
      // config.go 里的（"/petstore/updateadoptionstatusurl" 等 4 条），
      // 现在改为从环境变量读参数**名**、再与 PETSTORE_PARAM_PREFIX 拼出全路径，
      // 而且是**硬失败**的：
      //     for key := range envVars {
      //         if !viper.IsSet(key) { return cfg, fmt.Errorf("%s not set", key) }
      //     }
      // 配合 main.go 里三处 os.Exit(-1) —— 缺任何一个变量，Pod 直接 CrashLoopBackOff。
      //
      // 实测线上原本**只有 AWS_REGION**，所以不补这一组就是必然的断服。
      // 六个 SSM 参数本身都已存在（逐个 get-parameter 验证过），缺的只是
      // 「告诉程序参数叫什么名字」的这一层。
      //
      // 新契约比旧的多要两个参数：SQS_QUEUE_URL 与 PETSEARCH_URL（旧版只读 4 个）。
      additionalEnv: {
        PETSTORE_PARAM_PREFIX: '/petstore',
        UPDATE_ADOPTIONS_STATUS_URL_PARAMETER_NAME: 'updateadoptionstatusurl',
        RDS_SECRET_ARN_NAME: 'rdssecretarn',
        S3_BUCKET_PARAMETER_NAME: 's3bucketname',
        DYNAMODB_TABLE_PARAMETER_NAME: 'dynamodbtablename',
        SQS_QUEUE_URL_PARAMETER_NAME: 'queueurl',
        PETSEARCH_URL_PARAMETER_NAME: 'searchapiurl',
      },
    });
    payForAdoptionService.addToPrincipalPolicy(readSSMParamsPolicy);
    payForAdoptionService.addToPrincipalPolicy(ddbSeedPolicy);
    payForAdoptionService.node.addDependency(waitForLBControllerReady);

    // ListAdoptions service - EKS deployment
    //
    // request 48m / limit 512m —— 实测右调（同上窗口）：pod 级
    // p50 5m / p90 13m / p99 16m。它是三者中用量最高的（search 的最大调用方），
    // 所以 request 取 3×p99 而不是踩下限。
    // HPA 阈值 60%×(48+32)=48m = p99 的 3 倍，有响应能力又不会抖。
    const listAdoptionsService = new ListAdoptionsServiceEks(this, 'list-adoptions', {
      cluster: cluster,
      cpu: '48m',
      cpuLimit: '512m',
      memory: '1Gi',
      replicas: 2,
      healthCheck: '/health/status',
      instrumentation: 'otel',
      region: region,
      database: auroraCluster,
      serviceType: 'ClusterIP',
    });
    listAdoptionsService.addToPrincipalPolicy(readSSMParamsPolicy);
    listAdoptionsService.node.addDependency(waitForLBControllerReady);

    // Search service - EKS deployment
    //
    // request 与 limit 刻意不同 —— 见 EksServiceProps.cpuLimit 的说明。
    // 这两个值是 2026-08-29/30 实测后写回的线上现状，不是估算：
    //   · request 256m：metrics-server 5 分钟 40 样本，p50 16m / p90 47m / p99 73m。
    //     原先 512m 让全集群没有一个节点放得下这个 Pod（需 512+32=544m，
    //     最宽裕的节点只剩 537m），两个副本被挤在同一个 AZ、
    //     拓扑感知路由因此把流量确定性钉在单个 Pod 上（76/24）。
    //     降到 256m 后 1a 装得下，2 副本跨 AZ，拓扑提示才真正生效。
    //   · limit 512m：压测下瞬时打到过 520m。若跟 request 一起降到 256m
    //     甚至 CDK 原本声明的 128m，会被硬节流。
    //
    // ⚠️ 配套改动在 CDK 之外：search-service-hpa 的 averageUtilization
    //    已从 60% 等比提到 120%（120%×256m = 307m = 原先 60%×512m），
    //    保证绝对扩容阈值不变。HPA 由 PetAdoptions/k8s-manifests/08-hpa.yaml
    //    管理而非本 stack —— 改这里的 cpu 时必须同步改那个文件。
    const searchService = new SearchServiceEks(this, 'search-service', {
      cluster: cluster,
      cpu: '256m',
      cpuLimit: '512m',
      memory: '1Gi',
      replicas: 2,
      healthCheck: '/health/status',
      // 只有 search-service 需要这两个 —— 它是本 stack 里唯一的 JVM 服务。
      // 实测日志 `Started Application in 31.091 seconds`，而共用的
      // livenessProbe.initialDelaySeconds 默认 30 秒：首次 liveness 恰好在
      // 应用起来之前打，HPA 扩容造成 CPU 争抢时必然进重启循环。
      // 150 秒宽限 = 实测启动时间的约 5 倍，覆盖冷启动 + CPU 争抢的最坏情况；
      // 真起不来时仍会在 150 秒后重启，不会无限挂着。
      startupGraceSeconds: 150,
      // JVM 在 GC 停顿期间 1 秒（K8s 默认）极易超时被误杀，放到 5 秒。
      // liveness 仍是 periodSeconds 10 × failureThreshold 3 = 30 秒内发现真卡死。
      probeTimeoutSeconds: 5,
      instrumentation: 'otel',
      region: region,
      serviceType: 'ClusterIP',
    });
    searchService.addToPrincipalPolicy(readSSMParamsPolicy);
    searchService.node.addDependency(waitForLBControllerReady);

    // Traffic Generator service - EKS deployment
    const trafficGeneratorService = new TrafficGeneratorServiceEks(this, 'traffic-generator', {
      cluster: cluster,
      cpu: '64m',
      memory: '512Mi',
      replicas: 1,
      instrumentation: 'none',
      region: region,
      serviceType: 'ClusterIP',
    });
    trafficGeneratorService.addToPrincipalPolicy(readSSMParamsPolicy);
    trafficGeneratorService.node.addDependency(waitForLBControllerReady);

    // ── PetFood service（上游 2026-08 新增的 Rust 服务，本地从零编写 EKS 部署）──
    //
    // 上游 src/cdk/lib/microservices/petfood.ts 走 **ECS**（ECS 命中 15、EKS 命中 0），
    // 与本项目「所有容器跑现有 arm64 EKS，不得用 ECS」的硬约束冲突，
    // 所以只移植应用代码（46 文件），部署层用本地 EksService 基类重写。

    // 食品目录表。partition key 用 `id` —— 与上游 API_DOCUMENTATION.md 的 /api/foods/{id} 一致。
    const petfoodFoodsTable = new ddb.Table(this, 'ddb_petfood_foods', {
      partitionKey: { name: 'id', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ⚠️ 这两个 GSI **必须在 CDK 里声明**，理由有两层，第二层很隐蔽：
    //
    //  ① 应用真的会查它们。`food_repository.rs` 第 663/701 行分别对
    //     `PetTypeIndex` 和 `FoodTypeIndex` 发 Query。
    //     应用自带 `table_manager.rs` 也能建（就是 /api/admin/setup-tables 端点），
    //     但那是「应用建基础设施」的 split-brain：CDK 建表、应用建索引，
    //     谁都不掌握完整状态。实测表上 GlobalSecondaryIndexes 为 **null** ——
    //     那个 admin 端点从没被调用过，索引压根不存在。
    //
    //  ② **CDK 的 grantReadWriteData 只在表「已声明索引」时才授权 /index/*。**
    //     Table.grant() 内部是 `this.hasIndex ? [tableArn, tableArn + '/index/*'] : [tableArn]`，
    //     而 hasIndex 仅由 CDK 自己知道的索引置真。
    //     所以就算索引在运行时被应用建出来，IAM 也仍然拒绝：
    //       not authorized to perform: dynamodb:Query on resource:
    //         .../table/ServicesEks2-ddbpetfoodfoods.../index/PetTypeIndex
    //     实际策略里只有裸 table ARN，没有 /index/*。
    //
    //     在这里声明索引让 hasIndex 转真，petfood-service-eks.ts 第 41 行那句
    //     grantReadWriteData **自动**覆盖 /index/*，不需要再手写 addToPolicy。
    //     一处声明同时修掉「索引不存在」和「索引无权限」两个问题。
    //
    // 键与投影逐字对齐 table_manager.rs 第 83-111 行，避免应用与基础设施不一致。
    petfoodFoodsTable.addGlobalSecondaryIndex({
      indexName: 'PetTypeIndex',
      partitionKey: { name: 'pet_type', type: ddb.AttributeType.STRING },
      sortKey: { name: 'name', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });
    // ⚠️ 这两个 GSI 必须**分两次**部署到已存在的表上。DynamoDB 限制：
    //      "Cannot perform more than one GSI creation or deletion in a single update"
    //    一起加会让 UPDATE_FAILED 并整栈回滚（已实测，栈干净回滚未损表）。
    //    该限制**只作用于 UPDATE** —— 全新建表时两个一起声明合法，
    //    所以这里保留两个，新环境从零部署一次到位。
    //    若将来再往这张**已存在**的表加索引，仍需一次一个。
    //    第一个 GSI 落地后 hasIndex 即为真，IAM 的 /index/* 授权同时生效（已实测）。
    petfoodFoodsTable.addGlobalSecondaryIndex({
      indexName: 'FoodTypeIndex',
      partitionKey: { name: 'food_type', type: ddb.AttributeType.STRING },
      // ⚠️ 排序键是 `price` 且类型是 **NUMBER**，不是 `name`/STRING。
      //    我一开始按 PetTypeIndex 的模式推断成 name，核对 table_manager.rs
      //    第 113-118 行才发现不一样（price / KeyType::Range / ScalarAttributeType::N）。
      //    GSI 键写错部署时不报错，但运行时 Query 失败，且改键需删了重建索引。
      sortKey: { name: 'price', type: ddb.AttributeType.NUMBER },
      projectionType: ddb.ProjectionType.ALL,
    });

    // 购物车表。partition key 用 `user_id`，sort key 用 `item_id` ——
    // 一个用户的购物车是多条 item，按 user_id 查询整车、按复合键定位单项。
    const petfoodCartsTable = new ddb.Table(this, 'ddb_petfood_carts', {
      partitionKey: { name: 'user_id', type: ddb.AttributeType.STRING },
      sortKey: { name: 'item_id', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 领域事件总线。上游用三个配套 Lambda 消费它
    // （petfood-cleanup-processor-node / petfood-image-generator-python /
    //   petfood-stock-processor-node），那三个尚未移植 ——
    // 总线先建好，事件投递不会因为没有消费者而失败（EventBridge 无消费者时静默丢弃）。
    const petfoodEventBus = new events.EventBus(this, 'petfood_event_bus');

    const petFoodService = new PetFoodServiceEks(this, 'petfood', {
      cluster: cluster,
      // 构造要用它们授权（IRSA），所以必须传引用而不只是名字 ——
      // 名字通过 additionalEnv 给应用，引用通过 props 给 IAM。
      foodsTable: petfoodFoodsTable,
      cartsTable: petfoodCartsTable,
      eventBus: petfoodEventBus,
      // Rust 服务，稳态占用低；给 64m request / 512m limit 留突发余量。
      // 没有实测数据（服务尚未跑过），取值参照 payforadoption（32m/512m）略上调，
      // 首次压测后应按实际用量右调 —— 这与其余五个服务同样的纪律。
      cpu: '64m',
      cpuLimit: '512m',
      memory: '512Mi',
      memoryLimit: '1Gi',
      replicas: 2,
      // Service 80 → 容器 8080。容器端口保持上游的 PETFOOD_PORT 默认值，
      // 与 petsite 同形（见 eks-service.ts 里 containerPort 的注释）。
      port: 80,
      containerPort: 8080,
      // ⚠️ 必须是 `/health/status`，不是 `/health`。
      //    petfood 的 main.rs 第 228 行注册的是 `.route("/health/status", get(health_check))`，
      //    `/health` 本身**没有**路由，请求它返回 404。
      //    我原来写 `/health`，结果 kubelet 的 readiness/liveness 探针一直拿到 404：
      //      Liveness probe failed: HTTP probe failed with statuscode: 404
      //    而**应用其实完全健康**（配置全部解析成功、在正常处理请求）——
      //    Deployment 却停在 Available=False / MinimumReplicasUnavailable，
      //    滚动更新卡住、新旧 Pod 并存。
      //    上面三个服务（第 680/727/758 行）都用的 `/health/status`，只有这里写错了。
      healthCheck: '/health/status',
      instrumentation: 'otel',
      region: region,
      // ⚠️ ClusterIP —— 硬约束「ALB 上不得新增公网入口」。
      //    petsite 走集群内 DNS 访问它；AgentCore 需要时走 internal ALB。
      serviceType: 'ClusterIP',
      additionalEnv: {
        // 上游 config/mod.rs 的三级解析：SSM（prefix + 参数名）→ env → 默认值。
        // 这里直接给 env，省掉建 SSM 参数那一层（表名是本栈创建的，CDK 里能直接拿到）。
        PETFOOD_FOODS_TABLE_NAME: petfoodFoodsTable.tableName,
        PETFOOD_CARTS_TABLE_NAME: petfoodCartsTable.tableName,
        PETFOOD_EVENT_BUS_NAME: petfoodEventBus.eventBusName,
        // ⚠️ 刻意**不设** PETFOOD_PARAM_PREFIX。
        //
        //    petfood 的 `resolve_parameter_with_prefix`（src/config/mod.rs）有两条路：
        //      · prefix **非空** → 把上面那些 env 的**值当成 SSM 参数名**，
        //        去查 `{prefix}/{值}`，查不到就**返回空串**（不是回落到 env 值！）
        //      · prefix **为空** → 直接把 env 的值当结果用
        //
        //    我原来设了 `/petstore` 却又把**表名本身**塞进 env，于是它去查
        //      /petstore/ServicesEks2-ddbpetfoodfoods00C5D62B-4FH25BBOAEWX
        //    这个不存在的参数，拿到空串，最后死在
        //      Error: ValidationError { message: "Foods table name cannot be empty" }
        //
        //    两种修法都可行：建一堆 SSM 参数存表名、或者不要这层间接。
        //    选后者 —— 表名由 CDK 在同一个栈里创建，`table.tableName` 就是权威值，
        //    绕一趟 SSM 只是多一个可能不同步的副本和一次运行时依赖。
        //
        //    注意这**不影响** agent 侧：agent 读的是 `/petstore/agent/petfoodapiurl`
        //    那种「服务地址」参数，与这里的「表名」是两回事。
        PETFOOD_REGION: region,
        // 结构化日志 —— 让 CloudWatch Logs Insights 能按字段查询而非正则抠文本
        PETFOOD_ENABLE_JSON_LOGGING: 'true',
        PETFOOD_EVENTS_ENABLED: 'true',
        // ⚠️ 刻意**不设** PETFOOD_ASSETS_CDN_URL / PETFOOD_IMAGES_CDN_URL。
        //    上游默认值是 https://petfood-assets.s3.amazonaws.com，我们没有那个桶，
        //    所以图片会 404 —— 但服务照常起（已核实是三级降级、非 fail-fast）。
        //    建 CloudFront 或公开 S3 桶都属于「新增公网入口」，需用户明确许可，
        //    在拿到许可之前保持图片 404 是正确的默认。
      },
    });
    petFoodService.addToPrincipalPolicy(readSSMParamsPolicy);
    petFoodService.node.addDependency(waitForLBControllerReady);

    // PetStatusUpdater Lambda Function and APIGW
    const statusUpdaterService = new StatusUpdaterService(this, 'status-updater-service', {
      tableName: dynamodb_petadoption.tableName,
    });

    const customWidgetResourceControllerPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecs:ListServices',
        'ecs:UpdateService',
        'eks:DescribeNodegroup',
        'eks:ListNodegroups',
        'eks:DescribeUpdate',
        'eks:UpdateNodegroupConfig',
        'ecs:DescribeServices',
        'eks:DescribeCluster',
        'eks:ListClusters',
        'ecs:ListClusters',
      ],
      resources: ['*'],
    });
    var customWidgetLambdaRole = new iam.Role(this, 'customWidgetLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    customWidgetLambdaRole.addToPrincipalPolicy(customWidgetResourceControllerPolicy);

    var petsiteApplicationResourceController = new lambda.Function(this, 'petsite-application-resource-controler', {
      code: lambda.Code.fromAsset(path.join(__dirname, '/../resources/resource-controller-widget')),
      handler: 'petsite-application-resource-controler.lambda_handler',
      memorySize: 128,
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      role: customWidgetLambdaRole,
      timeout: Duration.minutes(10),
    });
    petsiteApplicationResourceController.addEnvironment('EKS_CLUSTER_NAME', cluster.clusterName);
    // No more ECS clusters - all services are on EKS
    petsiteApplicationResourceController.addEnvironment('ECS_CLUSTER_ARNS', '');

    var customWidgetFunction = new lambda.Function(this, 'cloudwatch-custom-widget', {
      code: lambda.Code.fromAsset(path.join(__dirname, '/../resources/resource-controller-widget')),
      handler: 'cloudwatch-custom-widget.lambda_handler',
      memorySize: 128,
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      role: customWidgetLambdaRole,
      timeout: Duration.seconds(60),
    });
    customWidgetFunction.addEnvironment('CONTROLER_LAMBDA_ARN', petsiteApplicationResourceController.functionArn);
    customWidgetFunction.addEnvironment('EKS_CLUSTER_NAME', cluster.clusterName);
    // No more ECS clusters - all services are on EKS
    customWidgetFunction.addEnvironment('ECS_CLUSTER_ARNS', '');

    var costControlDashboardBody = readFileSync('./resources/cw_dashboard_cost_control.json', 'utf-8');
    costControlDashboardBody = costControlDashboardBody.replaceAll('{{YOUR_LAMBDA_ARN}}', customWidgetFunction.functionArn);

    const petSiteCostControlDashboard = new cloudwatch.CfnDashboard(this, 'PetSiteCostControlDashboard', {
      dashboardName: `PetSite_Cost_Control_Dashboard_${region}`,
      dashboardBody: costControlDashboardBody,
    });

    // Creating AWS Resource Group for all the resources of stack.
    const servicesCfnGroup = new resourcegroups.CfnGroup(this, 'ServicesCfnGroup', {
      name: stackName,
      description: 'Contains all the resources deployed by Cloudformation Stack ' + stackName,
      resourceQuery: {
        type: 'CLOUDFORMATION_STACK_1_0',
      },
    });
    // Enabling CloudWatch Application Insights for Resource Group
    const servicesCfnApplication = new applicationinsights.CfnApplication(this, 'ServicesApplicationInsights', {
      resourceGroupName: servicesCfnGroup.name,
      autoConfigurationEnabled: true,
      cweMonitorEnabled: true,
      opsCenterEnabled: true,
    });
    // Adding dependency to create these resources at last
    servicesCfnGroup.node.addDependency(petSiteCostControlDashboard);
    servicesCfnApplication.node.addDependency(servicesCfnGroup);
    // Adding a Lambda function to produce the errors - manually executed
    var dynamodbQueryLambdaRole = new iam.Role(this, 'dynamodbQueryLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(this, 'manageddynamodbread', 'arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess'),
        iam.ManagedPolicy.fromManagedPolicyArn(this, 'lambdaBasicExecRoletoddb', 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    var dynamodbQueryFunction = new lambda.Function(this, 'dynamodb-query-function', {
      code: lambda.Code.fromAsset(path.join(__dirname, '/../resources/application-insights')),
      handler: 'dynamodb-query-function.lambda_handler',
      memorySize: 128,
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      role: dynamodbQueryLambdaRole,
      timeout: Duration.seconds(900),
    });
    dynamodbQueryFunction.addEnvironment('DYNAMODB_TABLE_NAME', dynamodb_petadoption.tableName);

    this.createOuputs(
      new Map(
        Object.entries({
          CWServiceAccountArn: cwserviceaccount.roleArn,
          NetworkFlowMonitorServiceAccountArn: networkFlowMonitorRole.attrArn,
          XRayServiceAccountArn: xrayserviceaccount.roleArn,
          OIDCProviderUrl: cluster.clusterOpenIdConnectIssuerUrl,
          OIDCProviderArn: cluster.openIdConnectProvider.openIdConnectProviderArn,
          PetSiteUrl: `http://${alb.loadBalancerDnsName}`,
          DynamoDBQueryFunction: dynamodbQueryFunction.functionName,
        })
      )
    );

    const petAdoptionsStepFn = new PetAdoptionsStepFn(this, 'StepFn');

    // Note: For EKS services, we use Kubernetes internal service DNS names
    // The actual NLB DNS names will be available after deployment
    // For now, we use placeholder URLs that should be updated after deployment
    this.createSsmParameters(
      new Map(
        Object.entries({
          '/petstore/trafficdelaytime': '1',
          '/petstore/rumscript': ' ',
          '/petstore/petadoptionsstepfnarn': petAdoptionsStepFn.stepFn.stateMachineArn,
          '/petstore/updateadoptionstatusurl': statusUpdaterService.api.url,
          '/petstore/queueurl': sqsQueue.queueUrl,
          '/petstore/snsarn': topic_petadoption.topicArn,
          '/petstore/dynamodbtablename': dynamodb_petadoption.tableName,
          '/petstore/s3bucketname': s3_observabilitypetadoptions.bucketName,
          // EKS internal service URLs - services communicate via k8s service discovery
          '/petstore/searchapiurl': `http://search-service.petadoptions.svc.cluster.local/api/search?`,
          '/petstore/searchimage': 'petsearch-java:latest',
          '/petstore/petlistadoptionsurl': `http://list-adoptions.petadoptions.svc.cluster.local/api/adoptionlist/`,
          '/petstore/petlistadoptionsmetricsurl': `http://list-adoptions.petadoptions.svc.cluster.local/metrics`,
          '/petstore/paymentapiurl': `http://pay-for-adoption.petadoptions.svc.cluster.local/api/home/completeadoption`,
          '/petstore/payforadoptionmetricsurl': `http://pay-for-adoption.petadoptions.svc.cluster.local/metrics`,
          '/petstore/cleanupadoptionsurl': `http://pay-for-adoption.petadoptions.svc.cluster.local/api/home/cleanupadoptions`,
          '/petstore/petsearch-collector-manual-config': readFileSync('./resources/collector/ecs-xray-manual.yaml', 'utf8'),
          '/petstore/rdssecretarn': `${auroraCluster.secret?.secretArn}`,
          '/petstore/rdsendpoint': auroraCluster.clusterEndpoint.hostname,
          '/petstore/rds-reader-endpoint': auroraCluster.clusterReadEndpoint.hostname,
          '/petstore/stackname': stackName,
          // Use internal k8s service DNS to bypass ALB Cognito auth for traffic generator
          '/petstore/petsiteurl': 'http://service-petsite.petadoptions.svc.cluster.local',
          '/petstore/pethistoryurl': 'http://pethistory-service.petadoptions.svc.cluster.local:8080/petadoptionshistory',
          '/eks/petsite/OIDCProviderUrl': cluster.clusterOpenIdConnectIssuerUrl,
          '/eks/petsite/OIDCProviderArn': cluster.openIdConnectProvider.openIdConnectProviderArn,
          '/petstore/errormode1': 'false',
        })
      )
    );

    this.createOuputs(
      new Map(
        Object.entries({
          QueueURL: sqsQueue.queueUrl,
          UpdateAdoptionStatusurl: statusUpdaterService.api.url,
          SNSTopicARN: topic_petadoption.topicArn,
          RDSServerName: auroraCluster.clusterEndpoint.hostname,
        })
      )
    );
  }

  private createSsmParameters(params: Map<string, string>) {
    params.forEach((value, key) => {
      new ssm.StringParameter(this, key, { parameterName: key, stringValue: value });
    });
  }

  private createOuputs(params: Map<string, string>) {
    params.forEach((value, key) => {
      new CfnOutput(this, key, { value: value });
    });
  }
}
