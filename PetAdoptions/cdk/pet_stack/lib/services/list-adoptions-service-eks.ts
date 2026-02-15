import * as rds from 'aws-cdk-lib/aws-rds';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
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
  }

  createContainerImage(): DockerImageAsset {
    return new DockerImageAsset(this, 'list-adoptions-image', {
      directory: './resources/microservices/petlistadoptions-go',
    });
  }
}
