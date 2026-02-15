import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { EksService, EksServiceProps } from './eks-service';
import { Construct } from 'constructs';

export interface TrafficGeneratorServiceEksProps extends EksServiceProps {}

export class TrafficGeneratorServiceEks extends EksService {
  constructor(scope: Construct, id: string, props: TrafficGeneratorServiceEksProps) {
    // Traffic generator doesn't need LoadBalancer service
    super(scope, id, {
      ...props,
      serviceType: 'ClusterIP',
    });
  }

  createContainerImage(): DockerImageAsset {
    return new DockerImageAsset(this, 'traffic-generator-image', {
      directory: './resources/microservices/trafficgenerator/trafficgenerator',
    });
  }
}
