import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sns from 'aws-cdk-lib/aws-sns'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions'
import * as ddb from 'aws-cdk-lib/aws-dynamodb'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3seeder from 'aws-cdk-lib/aws-s3-deployment'
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as yaml from 'js-yaml';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as applicationinsights from 'aws-cdk-lib/aws-applicationinsights';
import * as resourcegroups from 'aws-cdk-lib/aws-resourcegroups';

import { Construct } from 'constructs'
import { StatusUpdaterService } from './services/status-updater-service'
import { PetAdoptionsStepFn } from './services/stepfn'
import { CfnJson, RemovalPolicy, Fn, Duration, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { readFileSync } from 'fs';
import 'ts-replace-all'
import { TreatMissingData, ComparisonOperator } from 'aws-cdk-lib/aws-cloudwatch';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';

export class Services extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const stackName = id;

        // Create SQS resource to send Pet adoption messages to
        const sqsQueue = new sqs.Queue(this, 'sqs_petadoption', {
            visibilityTimeout: Duration.seconds(300)
        });

        // Create SNS and an email topic to send notifications to
        const topic_petadoption = new sns.Topic(this, 'topic_petadoption');
        var topic_email = this.node.tryGetContext('snstopic_email');
        if (topic_email == undefined) {
            topic_email = "someone@example.com";
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
                type: ddb.AttributeType.STRING
            },
            sortKey: {
                name: 'petid',
                type: ddb.AttributeType.STRING
            },
            removalPolicy: RemovalPolicy.DESTROY
        });

        dynamodb_petadoption.metric('WriteThrottleEvents', { statistic: "avg" }).createAlarm(this, 'WriteThrottleEvents-BasicAlarm', {
            threshold: 0,
            treatMissingData: TreatMissingData.NOT_BREACHING,
            comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 1,
            alarmName: `${dynamodb_petadoption.tableName}-WriteThrottleEvents-BasicAlarm`,
        });

        dynamodb_petadoption.metric('ReadThrottleEvents', { statistic: "avg" }).createAlarm(this, 'ReadThrottleEvents-BasicAlarm', {
            threshold: 0,
            treatMissingData: TreatMissingData.NOT_BREACHING,
            comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 1,
            alarmName: `${dynamodb_petadoption.tableName}-ReadThrottleEvents-BasicAlarm`,
        });

        // Seeds the S3 bucket with pet images
        new s3seeder.BucketDeployment(this, "s3seeder_petadoption", {
            destinationBucket: s3_observabilitypetadoptions,
            sources: [s3seeder.Source.asset('./resources/kitten.zip'), s3seeder.Source.asset('./resources/puppies.zip'), s3seeder.Source.asset('./resources/bunnies.zip')]
        });

        var cidrRange = this.node.tryGetContext('vpc_cidr');
        if (cidrRange == undefined) {
            cidrRange = "11.0.0.0/16";
        }
        // The VPC where all the microservices will be deployed into
        const theVPC = new ec2.Vpc(this, 'Microservices', {
            ipAddresses: ec2.IpAddresses.cidr(cidrRange),
            natGateways: 1,
            maxAzs: 2
        });

        // Disable Map IP on launch for all public subnets
        const publicSubnets = theVPC.selectSubnets({
            subnetType: ec2.SubnetType.PUBLIC,
        });

        for (const subnet of publicSubnets.subnets) {
            const cfnSubnet = subnet.node.defaultChild as ec2.CfnSubnet;
            cfnSubnet.mapPublicIpOnLaunch = false;
        }

        // Create RDS Aurora PG cluster
        const rdssecuritygroup = new ec2.SecurityGroup(this, 'petadoptionsrdsSG', {
            vpc: theVPC
        });

        rdssecuritygroup.addIngressRule(ec2.Peer.ipv4(theVPC.vpcCidrBlock), ec2.Port.tcp(5432), 'Allow Aurora PG access from within the VPC CIDR range');

        var rdsUsername = this.node.tryGetContext('rdsusername');
        if (rdsUsername == undefined) {
            rdsUsername = "petadmin"
        }

        const auroraCluster = new rds.DatabaseCluster(this, 'Database', {
            engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_6 }),
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
            actions: [
                'ssm:GetParametersByPath',
                'ssm:GetParameters',
                'ssm:GetParameter',
                'ec2:DescribeVpcs'
            ],
            resources: ['*']
        });

        const ddbSeedPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'dynamodb:BatchWriteItem',
                'dynamodb:ListTables',
                "dynamodb:Scan",
                "dynamodb:Query"
            ],
            resources: ['*']
        });

        const stack = Stack.of(this);
        const region = stack.region;

        // ====================================================================
        // 🔐 创建 Cognito 用户池用于外部 ALB 认证
        // ====================================================================
        const userPool = new cognito.UserPool(this, 'PetAdoptionsUserPool', {
            userPoolName: 'PetAdoptionsUserPool',
            selfSignUpEnabled: true,
            signInAliases: {
                email: true,
                username: true
            },
            autoVerify: {
                email: true
            },
            standardAttributes: {
                email: {
                    required: true,
                    mutable: true
                }
            },
            passwordPolicy: {
                minLength: 8,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: false
            },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            removalPolicy: RemovalPolicy.DESTROY
        });

        // 创建用户池域名（用于 Cognito Hosted UI）
        const userPoolDomain = userPool.addDomain('PetAdoptionsDomain', {
            cognitoDomain: {
                domainPrefix: `petadoptions-${stack.account}-${region}`.toLowerCase()
            }
        });

        // 创建用户池客户端
        const userPoolClient = new cognito.UserPoolClient(this, 'PetAdoptionsUserPoolClient', {
            userPool: userPool,
            userPoolClientName: 'PetAdoptionsWebClient',
            generateSecret: true,
            oAuth: {
                flows: {
                    authorizationCodeGrant: true
                },
                scopes: [
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.PROFILE
                ],
                callbackUrls: ['https://example.com/callback'], // 稍后会被外部 ALB DNS 替换
                logoutUrls: ['https://example.com/logout']
            },
            authFlows: {
                userPassword: true,
                userSrp: true
            }
        });

        //PetStatusUpdater Lambda Function and APIGW--------------------------------------
        const statusUpdaterService = new StatusUpdaterService(this, 'status-updater-service', {
            tableName: dynamodb_petadoption.tableName
        });

        // ====================================================================
        // 🌐 外部 ALB (Internet-facing) - 只暴露 PetSite 前端
        // ====================================================================
        const externalAlbSG = new ec2.SecurityGroup(this, 'ExternalALBSecurityGroup', {
            vpc: theVPC,
            securityGroupName: 'ExternalALBSecurityGroup',
            description: 'External ALB for PetSite with Cognito Auth',
            allowAllOutbound: true
        });
        externalAlbSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from Internet');
        externalAlbSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from Internet');

        const externalAlb = new elbv2.ApplicationLoadBalancer(this, 'ExternalALB', {
            vpc: theVPC,
            internetFacing: true,
            securityGroup: externalAlbSG,
            loadBalancerName: 'PetAdoptions-External-ALB'
        });

        // 外部 ALB Target Group - PetSite 前端
        const externalPetSiteTG = new elbv2.ApplicationTargetGroup(this, 'ExternalPetSiteTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            targetGroupName: 'External-PetSite-TG',
            healthCheck: {
                path: '/',
                interval: Duration.seconds(30),
                timeout: Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3
            }
        });

        // 配置 Cognito 认证的外部 Listener
        const externalHttpListener = externalAlb.addListener('ExternalHttpListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.authenticateCognito({
                userPool: userPool,
                userPoolClient: userPoolClient,
                userPoolDomain: userPoolDomain,
                next: elbv2.ListenerAction.forward([externalPetSiteTG])
            })
        });

        // ====================================================================
        // 🏢 内部 ALB (Internal) - 服务间通信
        // ====================================================================
        const internalAlbSG = new ec2.SecurityGroup(this, 'InternalALBSecurityGroup', {
            vpc: theVPC,
            securityGroupName: 'InternalALBSecurityGroup',
            description: 'Internal ALB for microservices communication',
            allowAllOutbound: true
        });
        // 允许来自 VPC 内的流量
        internalAlbSG.addIngressRule(ec2.Peer.ipv4(theVPC.vpcCidrBlock), ec2.Port.tcp(80), 'Allow HTTP from VPC');

        const internalAlb = new elbv2.ApplicationLoadBalancer(this, 'InternalALB', {
            vpc: theVPC,
            internetFacing: false,  // 内部 ALB
            securityGroup: internalAlbSG,
            loadBalancerName: 'PetAdoptions-Internal-ALB'
        });

        // 内部 ALB 的各微服务 Target Groups
        const internalListTG = new elbv2.ApplicationTargetGroup(this, 'InternalListTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            targetGroupName: 'Internal-List-TG',
            healthCheck: {
                path: '/health/status',
                interval: Duration.seconds(30)
            }
        });

        const internalSearchTG = new elbv2.ApplicationTargetGroup(this, 'InternalSearchTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            targetGroupName: 'Internal-Search-TG',
            healthCheck: {
                path: '/health/status',
                interval: Duration.seconds(30)
            }
        });

        const internalPayForTG = new elbv2.ApplicationTargetGroup(this, 'InternalPayForTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            targetGroupName: 'Internal-PayFor-TG',
            healthCheck: {
                path: '/health/status',
                interval: Duration.seconds(30)
            }
        });

        const internalTrafficTG = new elbv2.ApplicationTargetGroup(this, 'InternalTrafficTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            targetGroupName: 'Internal-Traffic-TG',
            healthCheck: {
                path: '/',
                interval: Duration.seconds(60)
            }
        });

        const internalPetHistoryTG = new elbv2.ApplicationTargetGroup(this, 'InternalPetHistoryTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            targetGroupName: 'Internal-PetHistory-TG',
            healthCheck: {
                path: '/health/status',
                interval: Duration.seconds(30)
            }
        });

        // 内部 ALB Listener 配置（基于 Host/Path 路由）
        const internalHttpListener = internalAlb.addListener('InternalHttpListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.fixedResponse(404, {
                contentType: 'text/plain',
                messageBody: 'Service not found'
            })
        });

        // 内部 ALB 路径路由规则
        internalHttpListener.addTargetGroups('ListServiceRule', {
            priority: 10,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/api/adoptionlist/*'])
            ],
            targetGroups: [internalListTG]
        });

        internalHttpListener.addTargetGroups('SearchServiceRule', {
            priority: 20,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/api/search*'])
            ],
            targetGroups: [internalSearchTG]
        });

        internalHttpListener.addTargetGroups('PayForServiceRule', {
            priority: 30,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/api/payforadoption/*', '/api/home/*'])
            ],
            targetGroups: [internalPayForTG]
        });

        internalHttpListener.addTargetGroups('TrafficServiceRule', {
            priority: 40,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/traffic/*'])
            ],
            targetGroups: [internalTrafficTG]
        });

        internalHttpListener.addTargetGroups('PetHistoryServiceRule', {
            priority: 50,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/petadoptionshistory/*'])
            ],
            targetGroups: [internalPetHistoryTG]
        });

        // ====================================================================
        // 🎯 EKS 集群配置 (Graviton EC2)
        // ====================================================================
        const clusterAdmin = new iam.Role(this, 'AdminRole', {
            assumedBy: new iam.AccountRootPrincipal()
        });

        new ssm.StringParameter(this, "putParam", {
            stringValue: clusterAdmin.roleArn,
            parameterName: '/eks/petsite/EKSMasterRoleArn'
        })

        const secretsKey = new kms.Key(this, 'SecretsKey');
        
        // 创建 EKS 集群，使用 Graviton 实例
        const cluster = new eks.Cluster(this, 'petsite', {
            clusterName: 'PetSite',
            mastersRole: clusterAdmin,
            vpc: theVPC,
            defaultCapacity: 0,  // 不使用默认 capacity，自定义 Graviton
            secretsEncryptionKey: secretsKey,
            version: eks.KubernetesVersion.V1_31,
            kubectlLayer: new KubectlV31Layer(this, 'kubectl'),
            authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
        });

        // 添加 Graviton Node Group (ARM64)
        const gravitonNodeGroup = cluster.addNodegroupCapacity('GravitonNodeGroup', {
            instanceTypes: [
                ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),   // 通用负载
                ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.LARGE),     // 更高内存
            ],
            minSize: 2,
            maxSize: 10,
            desiredSize: 3,
            amiType: eks.NodegroupAmiType.AL2_ARM_64,  // ARM64 AMI
            diskSize: 50,
            labels: {
                'workload': 'graviton',
                'arch': 'arm64'
            },
            tags: {
                'Name': 'PetAdoptions-Graviton-Node',
                'Architecture': 'ARM64'
            }
        });

        const clusterSG = ec2.SecurityGroup.fromSecurityGroupId(this, 'ClusterSG', cluster.clusterSecurityGroupId);
        clusterSG.addIngressRule(externalAlbSG, ec2.Port.allTraffic(), 'Allow traffic from External ALB');
        clusterSG.addIngressRule(internalAlbSG, ec2.Port.allTraffic(), 'Allow traffic from Internal ALB');
        clusterSG.addIngressRule(ec2.Peer.ipv4(theVPC.vpcCidrBlock), ec2.Port.tcp(443), 'Allow local access to k8s api');

        // Add SSM Permissions to the node role
        gravitonNodeGroup.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"));

        // From https://github.com/aws-samples/ssm-agent-daemonset-installer
        var ssmAgentSetup = yaml.loadAll(readFileSync("./resources/setup-ssm-agent.yaml", "utf8")) as Record<string, any>[];

        const ssmAgentSetupManifest = new eks.KubernetesManifest(this, "ssmAgentdeployment", {
            cluster: cluster,
            manifest: ssmAgentSetup
        });

        // ClusterID is not available for creating the proper conditions
        const clusterId = Fn.select(4, Fn.split('/', cluster.clusterOpenIdConnectIssuerUrl))

        const cw_federatedPrincipal = new iam.FederatedPrincipal(
            cluster.openIdConnectProvider.openIdConnectProviderArn,
            {
                StringEquals: new CfnJson(this, "CW_FederatedPrincipalCondition", {
                    value: {
                        [`oidc.eks.${region}.amazonaws.com/id/${clusterId}:aud`]: "sts.amazonaws.com"
                    }
                })
            }
        );
        const cw_trustRelationship = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [cw_federatedPrincipal],
            actions: ["sts:AssumeRoleWithWebIdentity"]
        });

        // Create IAM roles for Service Accounts
        const cwserviceaccount = new iam.Role(this, 'CWServiceAccount', {
            assumedBy: new iam.AccountRootPrincipal(),
            managedPolicies: [
                iam.ManagedPolicy.fromManagedPolicyArn(this, 'CWServiceAccount-CloudWatchAgentServerPolicy', 'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy')
            ],
        });
        cwserviceaccount.assumeRolePolicy?.addStatements(cw_trustRelationship);

        const xray_federatedPrincipal = new iam.FederatedPrincipal(
            cluster.openIdConnectProvider.openIdConnectProviderArn,
            {
                StringEquals: new CfnJson(this, "Xray_FederatedPrincipalCondition", {
                    value: {
                        [`oidc.eks.${region}.amazonaws.com/id/${clusterId}:aud`]: "sts.amazonaws.com"
                    }
                })
            }
        );
        const xray_trustRelationship = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [xray_federatedPrincipal],
            actions: ["sts:AssumeRoleWithWebIdentity"]
        });

        const xrayserviceaccount = new iam.Role(this, 'XRayServiceAccount', {
            assumedBy: new iam.AccountRootPrincipal(),
            managedPolicies: [
                iam.ManagedPolicy.fromManagedPolicyArn(this, 'XRayServiceAccount-AWSXRayDaemonWriteAccess', 'arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess')
            ],
        });
        xrayserviceaccount.assumeRolePolicy?.addStatements(xray_trustRelationship);

        const loadbalancer_federatedPrincipal = new iam.FederatedPrincipal(
            cluster.openIdConnectProvider.openIdConnectProviderArn,
            {
                StringEquals: new CfnJson(this, "LB_FederatedPrincipalCondition", {
                    value: {
                        [`oidc.eks.${region}.amazonaws.com/id/${clusterId}:aud`]: "sts.amazonaws.com"
                    }
                })
            }
        );
        const loadBalancer_trustRelationship = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [loadbalancer_federatedPrincipal],
            actions: ["sts:AssumeRoleWithWebIdentity"]
        });

        const loadBalancerPolicyDoc = iam.PolicyDocument.fromJson(JSON.parse(readFileSync("./resources/load_balancer/iam_policy.json", "utf8")));
        const loadBalancerPolicy = new iam.ManagedPolicy(this, 'LoadBalancerSAPolicy', { document: loadBalancerPolicyDoc });
        const loadBalancerserviceaccount = new iam.Role(this, 'LoadBalancerServiceAccount', {
            assumedBy: new iam.AccountRootPrincipal(),
            managedPolicies: [loadBalancerPolicy]
        });

        loadBalancerserviceaccount.assumeRolePolicy?.addStatements(loadBalancer_trustRelationship);

        const eksAdminArn = this.node.tryGetContext('admin_role');
        if ((eksAdminArn != undefined) && (eksAdminArn.length > 0)) {
            const adminRole = iam.Role.fromRoleArn(this, "ekdAdminRoleArn", eksAdminArn, { mutable: false });
            cluster.grantAccess('TeamRoleAccess', adminRole.roleArn, [
                eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
                    accessScopeType: eks.AccessScopeType.CLUSTER
                })
            ]);
        }

        var xRayYaml = yaml.loadAll(readFileSync("./resources/k8s_petsite/xray-daemon-config.yaml", "utf8")) as Record<string, any>[];
        xRayYaml[0].metadata.annotations["eks.amazonaws.com/role-arn"] = new CfnJson(this, "xray_Role", { value: `${xrayserviceaccount.roleArn}` });

        const xrayManifest = new eks.KubernetesManifest(this, "xraydeployment", {
            cluster: cluster,
            manifest: xRayYaml
        });

        var loadBalancerServiceAccountYaml = yaml.loadAll(readFileSync("./resources/load_balancer/service_account.yaml", "utf8")) as Record<string, any>[];
        loadBalancerServiceAccountYaml[0].metadata.annotations["eks.amazonaws.com/role-arn"] = new CfnJson(this, "loadBalancer_Role", { value: `${loadBalancerserviceaccount.roleArn}` });

        const loadBalancerServiceAccount = new eks.KubernetesManifest(this, "loadBalancerServiceAccount", {
            cluster: cluster,
            manifest: loadBalancerServiceAccountYaml
        });

        const waitForLBServiceAccount = new eks.KubernetesObjectValue(this, 'LBServiceAccount', {
            cluster: cluster,
            objectName: "alb-ingress-controller",
            objectType: "serviceaccount",
            objectNamespace: "kube-system",
            jsonPath: "@"
        });

        const loadBalancerCRDYaml = yaml.loadAll(readFileSync("./resources/load_balancer/crds.yaml", "utf8")) as Record<string, any>[];
        const loadBalancerCRDManifest = new eks.KubernetesManifest(this, "loadBalancerCRD", {
            cluster: cluster,
            manifest: loadBalancerCRDYaml
        });

        const awsLoadBalancerManifest = new eks.HelmChart(this, "AWSLoadBalancerController", {
            cluster: cluster,
            chart: "aws-load-balancer-controller",
            repository: "https://aws.github.io/eks-charts",
            namespace: "kube-system",
            values: {
                clusterName: "PetSite",
                serviceAccount: {
                    create: false,
                    name: "alb-ingress-controller"
                },
                wait: true
            }
        });
        awsLoadBalancerManifest.node.addDependency(loadBalancerCRDManifest);
        awsLoadBalancerManifest.node.addDependency(loadBalancerServiceAccount);
        awsLoadBalancerManifest.node.addDependency(waitForLBServiceAccount);

        // CloudWatch Observability Addon
        const otelAddon = new eks.CfnAddon(this, 'otelObservabilityAddon', {
            addonName: 'amazon-cloudwatch-observability',
            addonVersion: 'v4.4.0-eksbuild.1',
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
                        Action: [
                            'sts:AssumeRole',
                            'sts:TagSession',
                        ],
                    },
                ],
            },
            managedPolicyArns: [
                'arn:aws:iam::aws:policy/CloudWatchNetworkFlowMonitorAgentPublishPolicy',
            ],
        });

        const podIdentityAgentAddon = new eks.CfnAddon(this, 'PodIdentityAgentAddon', {
            addonName: 'eks-pod-identity-agent',
            addonVersion: 'v1.3.4-eksbuild.1',
            clusterName: cluster.clusterName,
            resolveConflicts: 'OVERWRITE',
            preserveOnDelete: false,
        });

        const networkFlowMonitoringAgentAddon = new eks.CfnAddon(this, 'NetworkFlowMonitoringAgentAddon', {
            addonName: 'aws-network-flow-monitoring-agent',
            addonVersion: 'v1.0.1-eksbuild.2',
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

        // Lambda for custom widgets
        const customWidgetResourceControllerPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'eks:DescribeNodegroup',
                'eks:ListNodegroups',
                'eks:DescribeUpdate',
                'eks:UpdateNodegroupConfig',
                'eks:DescribeCluster',
                'eks:ListClusters'
            ],
            resources: ['*']
        });
        
        var customWidgetLambdaRole = new iam.Role(this, 'customWidgetLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });
        customWidgetLambdaRole.addToPrincipalPolicy(customWidgetResourceControllerPolicy);

        var petsiteApplicationResourceController = new lambda.Function(this, 'petsite-application-resource-controler', {
            code: lambda.Code.fromAsset(path.join(__dirname, '/../resources/resource-controller-widget')),
            handler: 'petsite-application-resource-controler.lambda_handler',
            memorySize: 128,
            runtime: lambda.Runtime.PYTHON_3_9,
            role: customWidgetLambdaRole,
            timeout: Duration.minutes(10)
        });
        petsiteApplicationResourceController.addEnvironment("EKS_CLUSTER_NAME", cluster.clusterName);
        petsiteApplicationResourceController.addEnvironment("ECS_CLUSTER_ARNS", "");  // No ECS clusters

        var customWidgetFunction = new lambda.Function(this, 'cloudwatch-custom-widget', {
            code: lambda.Code.fromAsset(path.join(__dirname, '/../resources/resource-controller-widget')),
            handler: 'cloudwatch-custom-widget.lambda_handler',
            memorySize: 128,
            runtime: lambda.Runtime.PYTHON_3_9,
            role: customWidgetLambdaRole,
            timeout: Duration.seconds(60)
        });
        customWidgetFunction.addEnvironment("CONTROLER_LAMBDA_ARN", petsiteApplicationResourceController.functionArn);
        customWidgetFunction.addEnvironment("EKS_CLUSTER_NAME", cluster.clusterName);
        customWidgetFunction.addEnvironment("ECS_CLUSTER_ARNS", "");  // No ECS clusters

        var costControlDashboardBody = readFileSync("./resources/cw_dashboard_cost_control.json", "utf-8");
        costControlDashboardBody = costControlDashboardBody.replaceAll("{{YOUR_LAMBDA_ARN}}", customWidgetFunction.functionArn);

        const petSiteCostControlDashboard = new cloudwatch.CfnDashboard(this, "PetSiteCostControlDashboard", {
            dashboardName: `PetSite_Cost_Control_Dashboard_${region}`,
            dashboardBody: costControlDashboardBody
        });

        // Creating AWS Resource Group
        const servicesCfnGroup = new resourcegroups.CfnGroup(this, 'ServicesCfnGroup', {
            name: stackName,
            description: 'Contains all the resources deployed by Cloudformation Stack ' + stackName,
            resourceQuery: {
                type: 'CLOUDFORMATION_STACK_1_0',
            }
        });
        
        const servicesCfnApplication = new applicationinsights.CfnApplication(this, 'ServicesApplicationInsights', {
            resourceGroupName: servicesCfnGroup.name,
            autoConfigurationEnabled: true,
            cweMonitorEnabled: true,
            opsCenterEnabled: true,
        });
        
        servicesCfnGroup.node.addDependency(petSiteCostControlDashboard);
        servicesCfnApplication.node.addDependency(servicesCfnGroup);

        // DynamoDB query Lambda
        var dynamodbQueryLambdaRole = new iam.Role(this, 'dynamodbQueryLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromManagedPolicyArn(this, 'manageddynamodbread', 'arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess'),
                iam.ManagedPolicy.fromManagedPolicyArn(this, 'lambdaBasicExecRoletoddb', 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')
            ]
        });

        var dynamodbQueryFunction = new lambda.Function(this, 'dynamodb-query-function', {
            code: lambda.Code.fromAsset(path.join(__dirname, '/../resources/application-insights')),
            handler: 'dynamodb-query-function.lambda_handler',
            memorySize: 128,
            runtime: lambda.Runtime.PYTHON_3_9,
            role: dynamodbQueryLambdaRole,
            timeout: Duration.seconds(900)
        });
        dynamodbQueryFunction.addEnvironment("DYNAMODB_TABLE_NAME", dynamodb_petadoption.tableName);

        // Outputs
        this.createOuputs(new Map(Object.entries({
            'ExternalALBDnsName': externalAlb.loadBalancerDnsName,
            'InternalALBDnsName': internalAlb.loadBalancerDnsName,
            'ExternalALBArn': externalAlb.loadBalancerArn,
            'InternalALBArn': internalAlb.loadBalancerArn,
            'CognitoUserPoolId': userPool.userPoolId,
            'CognitoUserPoolClientId': userPoolClient.userPoolClientId,
            'CognitoUserPoolDomain': userPoolDomain.domainName,
            'CognitoHostedUI': `https://${userPoolDomain.domainName}.auth.${region}.amazoncognito.com/login?client_id=${userPoolClient.userPoolClientId}&response_type=code&redirect_uri=http://${externalAlb.loadBalancerDnsName}/oauth2/idpresponse`,
            'CWServiceAccountArn': cwserviceaccount.roleArn,
            'NetworkFlowMonitorServiceAccountArn': networkFlowMonitorRole.attrArn,
            'XRayServiceAccountArn': xrayserviceaccount.roleArn,
            'OIDCProviderUrl': cluster.clusterOpenIdConnectIssuerUrl,
            'OIDCProviderArn': cluster.openIdConnectProvider.openIdConnectProviderArn,
            'PetSiteUrl': `http://${externalAlb.loadBalancerDnsName}`,
            'DynamoDBQueryFunction': dynamodbQueryFunction.functionName,
            'EKSClusterName': cluster.clusterName
        })));

        const petAdoptionsStepFn = new PetAdoptionsStepFn(this, 'StepFn');

        // SSM Parameters
        this.createSsmParameters(new Map(Object.entries({
            '/petstore/trafficdelaytime': "1",
            '/petstore/rumscript': " ",
            '/petstore/petadoptionsstepfnarn': petAdoptionsStepFn.stepFn.stateMachineArn,
            '/petstore/updateadoptionstatusurl': statusUpdaterService.api.url,
            '/petstore/queueurl': sqsQueue.queueUrl,
            '/petstore/snsarn': topic_petadoption.topicArn,
            '/petstore/dynamodbtablename': dynamodb_petadoption.tableName,
            '/petstore/s3bucketname': s3_observabilitypetadoptions.bucketName,
            '/petstore/searchapiurl': `http://${internalAlb.loadBalancerDnsName}/api/search?`,
            '/petstore/petlistadoptionsurl': `http://${internalAlb.loadBalancerDnsName}/api/adoptionlist/`,
            '/petstore/paymentapiurl': `http://${internalAlb.loadBalancerDnsName}/api/home/completeadoption`,
            '/petstore/cleanupadoptionsurl': `http://${internalAlb.loadBalancerDnsName}/api/home/cleanupadoptions`,
            '/petstore/rdssecretarn': `${auroraCluster.secret?.secretArn}`,
            '/petstore/rdsendpoint': auroraCluster.clusterEndpoint.hostname,
            '/petstore/rds-reader-endpoint': auroraCluster.clusterReadEndpoint.hostname,
            '/petstore/stackname': stackName,
            '/petstore/petsiteurl': `http://${externalAlb.loadBalancerDnsName}`,
            '/petstore/internal-alb-dns': internalAlb.loadBalancerDnsName,
            '/eks/petsite/OIDCProviderUrl': cluster.clusterOpenIdConnectIssuerUrl,
            '/eks/petsite/OIDCProviderArn': cluster.openIdConnectProvider.openIdConnectProviderArn,
            '/eks/petsite/ExternalTargetGroupArn': externalPetSiteTG.targetGroupArn,
            '/eks/petsite/InternalListTGArn': internalListTG.targetGroupArn,
            '/eks/petsite/InternalSearchTGArn': internalSearchTG.targetGroupArn,
            '/eks/petsite/InternalPayForTGArn': internalPayForTG.targetGroupArn,
            '/eks/petsite/InternalTrafficTGArn': internalTrafficTG.targetGroupArn,
            '/eks/petsite/InternalPetHistoryTGArn': internalPetHistoryTG.targetGroupArn,
            '/petstore/cognito/userpool_id': userPool.userPoolId,
            '/petstore/cognito/client_id': userPoolClient.userPoolClientId,
            '/petstore/cognito/domain': userPoolDomain.domainName,
            '/petstore/errormode1': "false"
        })));

        this.createOuputs(new Map(Object.entries({
            'QueueURL': sqsQueue.queueUrl,
            'UpdateAdoptionStatusurl': statusUpdaterService.api.url,
            'SNSTopicARN': topic_petadoption.topicArn,
            'RDSServerName': auroraCluster.clusterEndpoint.hostname
        })));
    }

    private createSsmParameters(params: Map<string, string>) {
        params.forEach((value, key) => {
            new ssm.StringParameter(this, key, { parameterName: key, stringValue: value });
        });
    }

    private createOuputs(params: Map<string, string>) {
        params.forEach((value, key) => {
            new CfnOutput(this, key, { value: value })
        });
    }
}
