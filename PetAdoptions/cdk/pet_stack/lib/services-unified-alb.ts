import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
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
import { PayForAdoptionService } from './services/pay-for-adoption-service'
import { ListAdoptionsService } from './services/list-adoptions-service'
import { SearchService } from './services/search-service'
import { TrafficGeneratorService } from './services/traffic-generator-service'
import { StatusUpdaterService } from './services/status-updater-service'
import { PetAdoptionsStepFn } from './services/stepfn'
import { KubernetesVersion } from 'aws-cdk-lib/aws-eks';
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

        const repositoryURI = "public.ecr.aws/one-observability-workshop";

        const stack = Stack.of(this);
        const region = stack.region;

        const ecsServicesSecurityGroup = new ec2.SecurityGroup(this, 'ECSServicesSG', {
            vpc: theVPC
        });

        ecsServicesSecurityGroup.addIngressRule(ec2.Peer.ipv4(theVPC.vpcCidrBlock), ec2.Port.tcp(80));

        // ====================================================================
        // 🔐 创建 Cognito 用户池用于统一认证
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
                callbackUrls: ['https://example.com/callback'], // 稍后会被 ALB DNS 替换
                logoutUrls: ['https://example.com/logout']
            },
            authFlows: {
                userPassword: true,
                userSrp: true
            }
        });

        // ====================================================================
        // 🌐 创建统一的 ALB 并配置 Cognito 认证
        // ====================================================================
        const albSG = new ec2.SecurityGroup(this, 'UnifiedALBSecurityGroup', {
            vpc: theVPC,
            securityGroupName: 'UnifiedALBSecurityGroup',
            allowAllOutbound: true,
            description: 'Security Group for Unified ALB with Cognito Auth'
        });
        albSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from anywhere');
        albSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from anywhere');

        // 创建统一的 ALB
        const unifiedAlb = new elbv2.ApplicationLoadBalancer(this, 'UnifiedALB', {
            vpc: theVPC,
            internetFacing: true,
            securityGroup: albSG,
            loadBalancerName: 'PetAdoptions-Unified-ALB'
        });

        // 更新 Cognito 回调 URL 为实际的 ALB DNS
        // 注意：这里需要在部署后手动更新，或者使用自定义资源
        new CfnOutput(this, 'CognitoCallbackUrlToUpdate', {
            value: `https://${unifiedAlb.loadBalancerDnsName}/oauth2/idpresponse`,
            description: '请将此 URL 添加到 Cognito User Pool Client 的回调 URL 中'
        });

        // ====================================================================
        // 创建共享的 ECS 集群（所有服务可以共用一个集群）
        // ====================================================================
        const sharedEcsCluster = new ecs.Cluster(this, "SharedECSCluster", {
            vpc: theVPC,
            containerInsightsV2: ecs.ContainerInsights.ENHANCED,
            clusterName: 'PetAdoptions-Shared-Cluster'
        });

        // ====================================================================
        // 部署各个服务到共享集群
        // ====================================================================
        
        // PayForAdoption service
        const payForAdoptionService = new PayForAdoptionService(this, 'pay-for-adoption-service', {
            cluster: sharedEcsCluster,
            logGroupName: "/ecs/PayForAdoption",
            cpu: 1024,
            memoryLimitMiB: 2048,
            healthCheck: '/health/status',
            instrumentation: 'otel',
            database: auroraCluster,
            desiredTaskCount: 2,
            region: region,
            securityGroup: ecsServicesSecurityGroup
        });
        payForAdoptionService.taskDefinition.taskRole?.addToPrincipalPolicy(readSSMParamsPolicy);
        payForAdoptionService.taskDefinition.taskRole?.addToPrincipalPolicy(ddbSeedPolicy);

        // ListAdoptions service
        const listAdoptionsService = new ListAdoptionsService(this, 'list-adoptions-service', {
            cluster: sharedEcsCluster,
            logGroupName: "/ecs/PetListAdoptions",
            cpu: 1024,
            memoryLimitMiB: 2048,
            healthCheck: '/health/status',
            instrumentation: 'otel',
            database: auroraCluster,
            desiredTaskCount: 2,
            region: region,
            securityGroup: ecsServicesSecurityGroup
        });
        listAdoptionsService.taskDefinition.taskRole?.addToPrincipalPolicy(readSSMParamsPolicy);

        // Search service
        const searchService = new SearchService(this, 'search-service', {
            cluster: sharedEcsCluster,
            logGroupName: "/ecs/PetSearch",
            cpu: 1024,
            memoryLimitMiB: 2048,
            healthCheck: '/health/status',
            desiredTaskCount: 2,
            instrumentation: 'otel',
            region: region,
            securityGroup: ecsServicesSecurityGroup
        })
        searchService.taskDefinition.taskRole?.addToPrincipalPolicy(readSSMParamsPolicy);

        // Traffic Generator service
        const trafficGeneratorService = new TrafficGeneratorService(this, 'traffic-generator-service', {
            cluster: sharedEcsCluster,
            logGroupName: "/ecs/PetTrafficGenerator",
            cpu: 256,
            memoryLimitMiB: 512,
            instrumentation: 'none',
            desiredTaskCount: 1,
            region: region,
            securityGroup: ecsServicesSecurityGroup
        })
        trafficGeneratorService.taskDefinition.taskRole?.addToPrincipalPolicy(readSSMParamsPolicy);

        //PetStatusUpdater Lambda Function and APIGW
        const statusUpdaterService = new StatusUpdaterService(this, 'status-updater-service', {
            tableName: dynamodb_petadoption.tableName
        });

        // ====================================================================
        // 🎯 在统一 ALB 上创建 Target Groups 和配置路由规则
        // ====================================================================

        // PayForAdoption Target Group
        const payForAdoptionTG = new elbv2.ApplicationTargetGroup(this, 'PayForAdoptionTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/health/status',
                interval: Duration.seconds(30),
                timeout: Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3
            },
            deregistrationDelay: Duration.seconds(30),
            targetGroupName: 'PayForAdoption-TG'
        });
        payForAdoptionService.service.attachToApplicationTargetGroup(payForAdoptionTG);

        // ListAdoptions Target Group
        const listAdoptionsTG = new elbv2.ApplicationTargetGroup(this, 'ListAdoptionsTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/health/status',
                interval: Duration.seconds(30),
                timeout: Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3
            },
            deregistrationDelay: Duration.seconds(30),
            targetGroupName: 'ListAdoptions-TG'
        });
        listAdoptionsService.service.attachToApplicationTargetGroup(listAdoptionsTG);

        // Search Target Group
        const searchTG = new elbv2.ApplicationTargetGroup(this, 'SearchTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/health/status',
                interval: Duration.seconds(30),
                timeout: Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3
            },
            deregistrationDelay: Duration.seconds(30),
            targetGroupName: 'Search-TG'
        });
        searchService.service.attachToApplicationTargetGroup(searchTG);

        // Traffic Generator Target Group
        const trafficTG = new elbv2.ApplicationTargetGroup(this, 'TrafficTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/',
                interval: Duration.seconds(60),
                timeout: Duration.seconds(10),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3
            },
            deregistrationDelay: Duration.seconds(30),
            targetGroupName: 'Traffic-TG'
        });
        trafficGeneratorService.service.attachToApplicationTargetGroup(trafficTG);

        // EKS PetSite Target Group
        const petSiteTG = new elbv2.ApplicationTargetGroup(this, 'PetSiteTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            targetGroupName: 'PetSite-TG'
        });

        new ssm.StringParameter(this, "putParamTargetGroupArn", {
            stringValue: petSiteTG.targetGroupArn,
            parameterName: '/eks/petsite/TargetGroupArn'
        });

        // PetAdoptionHistory Target Group
        const petHistoryTG = new elbv2.ApplicationTargetGroup(this, 'PetHistoryTG', {
            vpc: theVPC,
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/health/status',
            },
            targetGroupName: 'PetHistory-TG'
        });

        new ssm.StringParameter(this, "putPetHistoryParamTargetGroupArn", {
            stringValue: petHistoryTG.targetGroupArn,
            parameterName: '/eks/pethistory/TargetGroupArn'
        });

        // ====================================================================
        // 🔐 配置 Cognito 认证的 HTTPS Listener
        // ====================================================================
        // 注意：这里简化使用 HTTP，生产环境应该配置 HTTPS + ACM 证书
        
        const httpListener = unifiedAlb.addListener('HttpListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.authenticateCognito({
                userPool: userPool,
                userPoolClient: userPoolClient,
                userPoolDomain: userPoolDomain,
                next: elbv2.ListenerAction.fixedResponse(200, {
                    contentType: 'text/plain',
                    messageBody: 'Welcome to Pet Adoptions Platform'
                })
            })
        });

        // ====================================================================
        // 📍 添加路径路由规则（所有路径都需要 Cognito 认证）
        // ====================================================================

        // 1. PayForAdoption: /api/payforadoption/*
        httpListener.addTargetGroups('PayForAdoptionRule', {
            priority: 10,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/api/payforadoption/*', '/api/home/*'])
            ],
            targetGroups: [payForAdoptionTG]
        });

        // 2. ListAdoptions: /api/adoptionlist/*
        httpListener.addTargetGroups('ListAdoptionsRule', {
            priority: 20,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/api/adoptionlist/*'])
            ],
            targetGroups: [listAdoptionsTG]
        });

        // 3. Search: /api/search*
        httpListener.addTargetGroups('SearchRule', {
            priority: 30,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/api/search*'])
            ],
            targetGroups: [searchTG]
        });

        // 4. Traffic: /traffic/*
        httpListener.addTargetGroups('TrafficRule', {
            priority: 40,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/traffic/*'])
            ],
            targetGroups: [trafficTG]
        });

        // 5. PetAdoptionHistory: /petadoptionshistory/*
        httpListener.addTargetGroups('PetHistoryRule', {
            priority: 50,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/petadoptionshistory/*'])
            ],
            targetGroups: [petHistoryTG]
        });

        // 6. PetSite (default): /*
        httpListener.addTargetGroups('PetSiteRule', {
            priority: 100,
            conditions: [
                elbv2.ListenerCondition.pathPatterns(['/*'])
            ],
            targetGroups: [petSiteTG]
        });

        trafficGeneratorService.node.addDependency(unifiedAlb);

        // ====================================================================
        // 🎯 EKS 集群配置（保持原有逻辑）
        // ====================================================================
        const clusterAdmin = new iam.Role(this, 'AdminRole', {
            assumedBy: new iam.AccountRootPrincipal()
        });

        new ssm.StringParameter(this, "putParam", {
            stringValue: clusterAdmin.roleArn,
            parameterName: '/eks/petsite/EKSMasterRoleArn'
        })

        const secretsKey = new kms.Key(this, 'SecretsKey');
        const cluster = new eks.Cluster(this, 'petsite', {
            clusterName: 'PetSite',
            mastersRole: clusterAdmin,
            vpc: theVPC,
            defaultCapacity: 2,
            defaultCapacityInstance: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
            secretsEncryptionKey: secretsKey,
            version: eks.KubernetesVersion.V1_31,
            kubectlLayer: new KubectlV31Layer(this, 'kubectl'),
            authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
        });

        const clusterSG = ec2.SecurityGroup.fromSecurityGroupId(this, 'ClusterSG', cluster.clusterSecurityGroupId);
        clusterSG.addIngressRule(albSG, ec2.Port.allTraffic(), 'Allow traffic from the Unified ALB');
        clusterSG.addIngressRule(ec2.Peer.ipv4(theVPC.vpcCidrBlock), ec2.Port.tcp(443), 'Allow local access to k8s api');

        // Add SSM Permissions to the node role
        cluster.defaultNodegroup?.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"));

        // From https://github.com/aws-samples/ssm-agent-daemonset-installer
        var ssmAgentSetup = yaml.loadAll(readFileSync("./resources/setup-ssm-agent.yaml", "utf8")) as Record<string, any>[];

        const ssmAgentSetupManifest = new eks.KubernetesManifest(this, "ssmAgentdeployment", {
            cluster: cluster,
            manifest: ssmAgentSetup
        });

        // ClusterID is not available for creating the proper conditions https://github.com/aws/aws-cdk/issues/10347
        const clusterId = Fn.select(4, Fn.split('/', cluster.clusterOpenIdConnectIssuerUrl)) // Remove https:// from the URL as workaround to get ClusterID

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
        // Cloudwatch Agent SA
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

        // X-Ray Agent SA
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

        // NOTE: Amazon CloudWatch Observability Addon for CloudWatch Agent and Fluentbit
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

        // Amazon EKS Pod Identity Agent Addon for Network Flow Monitor
        const podIdentityAgentAddon = new eks.CfnAddon(this, 'PodIdentityAgentAddon', {
            addonName: 'eks-pod-identity-agent',
            addonVersion: 'v1.3.4-eksbuild.1',
            clusterName: cluster.clusterName,
            resolveConflicts: 'OVERWRITE',
            preserveOnDelete: false,
        });

        // Amazon EKS AWS Network Flow Monitor Agent add-on
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
                'ecs:ListClusters'
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
        petsiteApplicationResourceController.addEnvironment("ECS_CLUSTER_ARNS", sharedEcsCluster.clusterArn);

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
        customWidgetFunction.addEnvironment("ECS_CLUSTER_ARNS", sharedEcsCluster.clusterArn);

        var costControlDashboardBody = readFileSync("./resources/cw_dashboard_cost_control.json", "utf-8");
        costControlDashboardBody = costControlDashboardBody.replaceAll("{{YOUR_LAMBDA_ARN}}", customWidgetFunction.functionArn);

        const petSiteCostControlDashboard = new cloudwatch.CfnDashboard(this, "PetSiteCostControlDashboard", {
            dashboardName: `PetSite_Cost_Control_Dashboard_${region}`,
            dashboardBody: costControlDashboardBody
        });

        // Creating AWS Resource Group for all the resources of stack.
        const servicesCfnGroup = new resourcegroups.CfnGroup(this, 'ServicesCfnGroup', {
            name: stackName,
            description: 'Contains all the resources deployed by Cloudformation Stack ' + stackName,
            resourceQuery: {
                type: 'CLOUDFORMATION_STACK_1_0',
            }
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

        this.createOuputs(new Map(Object.entries({
            'UnifiedALBDnsName': unifiedAlb.loadBalancerDnsName,
            'UnifiedALBArn': unifiedAlb.loadBalancerArn,
            'CognitoUserPoolId': userPool.userPoolId,
            'CognitoUserPoolClientId': userPoolClient.userPoolClientId,
            'CognitoUserPoolDomain': userPoolDomain.domainName,
            'CognitoHostedUI': `https://${userPoolDomain.domainName}.auth.${region}.amazoncognito.com/login?client_id=${userPoolClient.userPoolClientId}&response_type=code&redirect_uri=http://${unifiedAlb.loadBalancerDnsName}/oauth2/idpresponse`,
            'CWServiceAccountArn': cwserviceaccount.roleArn,
            'NetworkFlowMonitorServiceAccountArn': networkFlowMonitorRole.attrArn,
            'XRayServiceAccountArn': xrayserviceaccount.roleArn,
            'OIDCProviderUrl': cluster.clusterOpenIdConnectIssuerUrl,
            'OIDCProviderArn': cluster.openIdConnectProvider.openIdConnectProviderArn,
            'PetSiteUrl': `http://${unifiedAlb.loadBalancerDnsName}`,
            'DynamoDBQueryFunction': dynamodbQueryFunction.functionName
        })));

        const petAdoptionsStepFn = new PetAdoptionsStepFn(this, 'StepFn');

        this.createSsmParameters(new Map(Object.entries({
            '/petstore/trafficdelaytime': "1",
            '/petstore/rumscript': " ",
            '/petstore/petadoptionsstepfnarn': petAdoptionsStepFn.stepFn.stateMachineArn,
            '/petstore/updateadoptionstatusurl': statusUpdaterService.api.url,
            '/petstore/queueurl': sqsQueue.queueUrl,
            '/petstore/snsarn': topic_petadoption.topicArn,
            '/petstore/dynamodbtablename': dynamodb_petadoption.tableName,
            '/petstore/s3bucketname': s3_observabilitypetadoptions.bucketName,
            '/petstore/searchapiurl': `http://${unifiedAlb.loadBalancerDnsName}/api/search?`,
            '/petstore/searchimage': searchService.container.imageName,
            '/petstore/petlistadoptionsurl': `http://${unifiedAlb.loadBalancerDnsName}/api/adoptionlist/`,
            '/petstore/petlistadoptionsmetricsurl': `http://${unifiedAlb.loadBalancerDnsName}/api/adoptionlist/metrics`,
            '/petstore/paymentapiurl': `http://${unifiedAlb.loadBalancerDnsName}/api/home/completeadoption`,
            '/petstore/payforadoptionmetricsurl': `http://${unifiedAlb.loadBalancerDnsName}/api/payforadoption/metrics`,
            '/petstore/cleanupadoptionsurl': `http://${unifiedAlb.loadBalancerDnsName}/api/home/cleanupadoptions`,
            '/petstore/petsearch-collector-manual-config': readFileSync("./resources/collector/ecs-xray-manual.yaml", "utf8"),
            '/petstore/rdssecretarn': `${auroraCluster.secret?.secretArn}`,
            '/petstore/rdsendpoint': auroraCluster.clusterEndpoint.hostname,
            '/petstore/rds-reader-endpoint': auroraCluster.clusterReadEndpoint.hostname,
            '/petstore/stackname': stackName,
            '/petstore/petsiteurl': `http://${unifiedAlb.loadBalancerDnsName}`,
            '/petstore/pethistoryurl': `http://${unifiedAlb.loadBalancerDnsName}/petadoptionshistory`,
            '/eks/petsite/OIDCProviderUrl': cluster.clusterOpenIdConnectIssuerUrl,
            '/eks/petsite/OIDCProviderArn': cluster.openIdConnectProvider.openIdConnectProviderArn,
            '/petstore/errormode1': "false",
            '/petstore/cognito/userpool_id': userPool.userPoolId,
            '/petstore/cognito/client_id': userPoolClient.userPoolClientId,
            '/petstore/cognito/domain': userPoolDomain.domainName
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
