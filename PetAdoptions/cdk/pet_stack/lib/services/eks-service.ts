import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

export interface EksServiceProps {
  cluster: eks.Cluster;
  cpu: string;
  memory: string;
  replicas: number;
  port?: number;
  containerPort?: number;  // If different from service port (e.g., petsite: service=80, container=8080)
  healthCheck?: string;
  serviceType?: 'ClusterIP' | 'LoadBalancer';
  region: string;
  instrumentation?: string;
  database?: rds.DatabaseCluster;
  // Additional environment variables
  additionalEnv?: { [key: string]: string };
}

export abstract class EksService extends Construct {
  public readonly deployment: eks.KubernetesManifest;
  public readonly service: eks.KubernetesManifest;
  public readonly serviceAccount: eks.ServiceAccount;
  public readonly serviceName: string;
  public readonly serviceUrl: string;

  constructor(scope: Construct, id: string, props: EksServiceProps) {
    super(scope, id);

    const serviceName = id.toLowerCase();
    this.serviceName = serviceName;
    const port = props.port || 80;
    const containerPort = props.containerPort || port;
    const namespace = 'petadoptions';

    // Create Service Account with IRSA
    this.serviceAccount = new eks.ServiceAccount(this, 'ServiceAccount', {
      cluster: props.cluster,
      name: `${serviceName}-sa`,
      namespace: namespace,
    });

    // Build container image using DockerImageAsset
    const imageAsset = this.createContainerImage();
    const imageUri = imageAsset.imageUri;

    // Prepare environment variables
    const envVars: { name: string; value: string }[] = [
      { name: 'AWS_REGION', value: props.region },
    ];

    // Add additional environment variables
    if (props.additionalEnv) {
      for (const [key, value] of Object.entries(props.additionalEnv)) {
        envVars.push({ name: key, value: value });
      }
    }

    // Prepare containers array
    const containers: any[] = [{
      name: serviceName,
      image: imageUri,
      ports: [{ containerPort: containerPort }],
      env: envVars,
      resources: {
        requests: {
          cpu: props.cpu,
          memory: props.memory,
        },
        limits: {
          cpu: props.cpu,
          memory: props.memory,
        },
      },
      ...(props.healthCheck && {
        livenessProbe: {
          httpGet: {
            path: props.healthCheck,
            port: containerPort,
          },
          initialDelaySeconds: 30,
          periodSeconds: 10,
        },
        readinessProbe: {
          httpGet: {
            path: props.healthCheck,
            port: containerPort,
          },
          initialDelaySeconds: 5,
          periodSeconds: 5,
        },
      }),
    }];

    // Add sidecar containers based on instrumentation
    if (props.instrumentation === 'otel') {
      // Use AOT_CONFIG_CONTENT env var to pass config inline - no ConfigMap needed
      containers.push({
        name: 'aws-otel-collector',
        image: 'public.ecr.aws/aws-observability/aws-otel-collector:v0.47.0',
        env: [{
          name: 'AOT_CONFIG_CONTENT',
          value: [
            'receivers:',
            '  otlp:',
            '    protocols:',
            '      grpc:',
            '        endpoint: 0.0.0.0:4317',
            '      http:',
            '        endpoint: 0.0.0.0:4318',
            'processors:',
            '  batch/traces:',
            '    timeout: 1s',
            '    send_batch_size: 50',
            'exporters:',
            '  awsxray:',
            '    region: ' + props.region,
            'service:',
            '  pipelines:',
            '    traces:',
            '      receivers: [otlp]',
            '      processors: [batch/traces]',
            '      exporters: [awsxray]',
          ].join('\n'),
        }],
        resources: {
          requests: { cpu: '32m', memory: '256Mi' },
          limits: { cpu: '256m', memory: '256Mi' },
        },
      });
    } else if (props.instrumentation === 'xray') {
      containers.push({
        name: 'xray-daemon',
        image: 'public.ecr.aws/xray/aws-xray-daemon:3.3.4',
        ports: [{ containerPort: 2000, protocol: 'UDP' }],
        resources: {
          requests: { cpu: '32m', memory: '256Mi' },
          limits: { cpu: '256m', memory: '256Mi' },
        },
      });
    }

    // Create Deployment manifest
    this.deployment = new eks.KubernetesManifest(this, 'Deployment', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: serviceName,
          namespace: namespace,
          labels: { app: serviceName },
        },
        spec: {
          replicas: props.replicas,
          selector: {
            matchLabels: { app: serviceName },
          },
          // maxSurge:0 + maxUnavailable:1 prevents rolling update CPU deadlock on 2-node clusters:
          // instead of adding a new pod before removing old (which requires extra CPU headroom),
          // it removes 1 old pod first, then adds 1 new pod, keeping total pods constant.
          strategy: {
            type: 'RollingUpdate',
            rollingUpdate: { maxSurge: 0, maxUnavailable: 1 },
          },
          template: {
            metadata: {
              labels: { app: serviceName },
            },
            spec: {
              serviceAccountName: this.serviceAccount.serviceAccountName,
              // 多副本时优先跨 AZ + 跨 Node 打散，允许同 AZ 双 replica（t4g.large CPU 紧张时兼容）
              // ScheduleAnyway: scheduler 尽力均衡但不会阻止调度
              ...(props.replicas >= 2 && {
                topologySpreadConstraints: [
                  {
                    maxSkew: 1,
                    topologyKey: 'topology.kubernetes.io/zone',
                    whenUnsatisfiable: 'ScheduleAnyway',
                    labelSelector: { matchLabels: { app: serviceName } },
                  },
                  {
                    maxSkew: 1,
                    topologyKey: 'kubernetes.io/hostname',
                    whenUnsatisfiable: 'ScheduleAnyway',
                    labelSelector: { matchLabels: { app: serviceName } },
                  },
                ],
              }),
              containers: containers,
            },
          },
        },
      }],
    });

    // Create Service manifest
    const serviceAnnotations: { [key: string]: string } = {
      // Topology Aware Routing: kube-proxy prefers in-zone endpoints to reduce cross-AZ traffic.
      // Falls back to cross-AZ automatically when no healthy in-zone pod exists.
      'service.kubernetes.io/topology-mode': 'auto',
    };
    if (props.serviceType === 'LoadBalancer') {
      serviceAnnotations['service.beta.kubernetes.io/aws-load-balancer-type'] = 'nlb';
      serviceAnnotations['service.beta.kubernetes.io/aws-load-balancer-scheme'] = 'internal';
    }

    this.service = new eks.KubernetesManifest(this, 'Service', {
      cluster: props.cluster,
      manifest: [{
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: serviceName,
          namespace: namespace,
          annotations: serviceAnnotations,
        },
        spec: {
          type: props.serviceType || 'LoadBalancer',
          selector: { app: serviceName },
          ports: [{
            port: port,
            targetPort: containerPort,
            protocol: 'TCP',
          }],
        },
      }],
    });

    // Service depends on deployment
    this.service.node.addDependency(this.deployment);
    this.deployment.node.addDependency(this.serviceAccount);

    // Generate service URL (will be internal NLB DNS)
    // Note: Actual DNS will be available after deployment
    this.serviceUrl = `http://${serviceName}.${namespace}.svc.cluster.local:${port}`;
  }

  // Abstract method - each service must implement this
  abstract createContainerImage(): DockerImageAsset;

  // Grant read access to RDS secret
  protected grantDatabaseAccess(database: rds.DatabaseCluster) {
    database.secret?.grantRead(this.serviceAccount);
  }

  // Add IAM policies to the service account
  protected addManagedPolicy(policyArn: string) {
    this.serviceAccount.role.addManagedPolicy(
      iam.ManagedPolicy.fromManagedPolicyArn(this, policyArn.split('/').pop() || policyArn, policyArn)
    );
  }

  public addToPrincipalPolicy(statement: iam.PolicyStatement) {
    this.serviceAccount.role.addToPrincipalPolicy(statement);
  }
}
