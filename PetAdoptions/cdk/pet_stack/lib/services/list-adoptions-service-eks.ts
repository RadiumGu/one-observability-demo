import * as rds from 'aws-cdk-lib/aws-rds';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { EksService, EksServiceProps } from './eks-service';
import { Construct } from 'constructs';

export interface ListAdoptionsServiceEksProps extends EksServiceProps {
  database: rds.DatabaseCluster;
}

export class ListAdoptionsServiceEks extends EksService {
  constructor(scope: Construct, id: string, props: ListAdoptionsServiceEksProps) {
    super(scope, id, props);

    // Grant access to RDS secret
    this.grantDatabaseAccess(props.database);
    // OTEL collector sends traces to X-Ray directly via IRSA
    this.addManagedPolicy('arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess');
  }

  createContainerImage(): DockerImageAsset {
    return new DockerImageAsset(this, 'list-adoptions-image', {
      directory: './resources/microservices/petlistadoptions-go',
      platform: Platform.LINUX_ARM64,
    });
  }
}
