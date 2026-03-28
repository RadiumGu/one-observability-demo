import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
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
      port: 80,
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
    const httpsListener = alb.addListener('HttpsListener', {
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
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/petadoptionshistory/*'])],
      targetGroups: [petadoptionshistory_targetGroup],
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

    // 手动添加 NodeGroup，使用 ARM64 实例，部署在私有子网避免公网 IP
    const nodegroup = cluster.addNodegroupCapacity('workers', {
      instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.LARGE)],
      minSize: 4,
      maxSize: 6,
      desiredSize: 4,
      amiType: eks.NodegroupAmiType.AL2023_ARM_64_STANDARD,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },  // 强制使用私有子网
    });

    const clusterSG = ec2.SecurityGroup.fromSecurityGroupId(this, 'ClusterSG', cluster.clusterSecurityGroupId);
    clusterSG.addIngressRule(albSG, ec2.Port.allTraffic(), 'Allow traffic from the ALB');
    clusterSG.addIngressRule(ec2.Peer.ipv4(vpcCidr), ec2.Port.tcp(443), 'Allow local access to k8s api');

    // Add SSM Permissions to the node role
    nodegroup.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

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
    const payForAdoptionService = new PayForAdoptionServiceEks(this, 'pay-for-adoption', {
      cluster: cluster,
      cpu: '512m',
      memory: '1Gi',
      replicas: 2,
      healthCheck: '/health/status',
      instrumentation: 'otel',
      region: region,
      database: auroraCluster,
      serviceType: 'ClusterIP',
    });
    payForAdoptionService.addToPrincipalPolicy(readSSMParamsPolicy);
    payForAdoptionService.addToPrincipalPolicy(ddbSeedPolicy);
    payForAdoptionService.node.addDependency(waitForLBControllerReady);

    // ListAdoptions service - EKS deployment
    const listAdoptionsService = new ListAdoptionsServiceEks(this, 'list-adoptions', {
      cluster: cluster,
      cpu: '512m',
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
    const searchService = new SearchServiceEks(this, 'search-service', {
      cluster: cluster,
      cpu: '512m',
      memory: '1Gi',
      replicas: 2,
      healthCheck: '/health/status',
      instrumentation: 'otel',
      region: region,
      serviceType: 'ClusterIP',
    });
    searchService.addToPrincipalPolicy(readSSMParamsPolicy);
    searchService.node.addDependency(waitForLBControllerReady);

    // Traffic Generator service - EKS deployment
    const trafficGeneratorService = new TrafficGeneratorServiceEks(this, 'traffic-generator', {
      cluster: cluster,
      cpu: '256m',
      memory: '512Mi',
      replicas: 1,
      instrumentation: 'none',
      region: region,
      serviceType: 'ClusterIP',
    });
    trafficGeneratorService.addToPrincipalPolicy(readSSMParamsPolicy);
    trafficGeneratorService.node.addDependency(waitForLBControllerReady);

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
          '/petstore/searchapiurl': `http://search-service.default.svc.cluster.local/api/search?`,
          '/petstore/searchimage': 'petsearch-java:latest',
          '/petstore/petlistadoptionsurl': `http://list-adoptions.default.svc.cluster.local/api/adoptionlist/`,
          '/petstore/petlistadoptionsmetricsurl': `http://list-adoptions.default.svc.cluster.local/metrics`,
          '/petstore/paymentapiurl': `http://pay-for-adoption.default.svc.cluster.local/api/home/completeadoption`,
          '/petstore/payforadoptionmetricsurl': `http://pay-for-adoption.default.svc.cluster.local/metrics`,
          '/petstore/cleanupadoptionsurl': `http://pay-for-adoption.default.svc.cluster.local/api/home/cleanupadoptions`,
          '/petstore/petsearch-collector-manual-config': readFileSync('./resources/collector/ecs-xray-manual.yaml', 'utf8'),
          '/petstore/rdssecretarn': `${auroraCluster.secret?.secretArn}`,
          '/petstore/rdsendpoint': auroraCluster.clusterEndpoint.hostname,
          '/petstore/rds-reader-endpoint': auroraCluster.clusterReadEndpoint.hostname,
          '/petstore/stackname': stackName,
          // Use internal k8s service DNS to bypass ALB Cognito auth for traffic generator
          '/petstore/petsiteurl': 'http://service-petsite.default.svc.cluster.local',
          '/petstore/pethistoryurl': 'http://pethistory-service.default.svc.cluster.local:8080/petadoptionshistory',
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
