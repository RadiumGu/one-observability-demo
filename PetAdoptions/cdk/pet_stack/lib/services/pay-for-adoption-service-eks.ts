import * as rds from 'aws-cdk-lib/aws-rds';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { EksService, EksServiceProps } from './eks-service';
import { Construct } from 'constructs';

export interface PayForAdoptionServiceEksProps extends EksServiceProps {
  database: rds.DatabaseCluster;
}

export class PayForAdoptionServiceEks extends EksService {
  constructor(scope: Construct, id: string, props: PayForAdoptionServiceEksProps) {
    super(scope, id, props);

    // Grant access to RDS secret
    this.grantDatabaseAccess(props.database);
  }

  createContainerImage(): DockerImageAsset {
    return new DockerImageAsset(this, 'pay-for-adoption-image', {
      directory: './resources/microservices/payforadoption-go',
    });
  }
}
