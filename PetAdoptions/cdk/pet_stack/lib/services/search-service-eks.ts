import * as iam from 'aws-cdk-lib/aws-iam';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { EksService, EksServiceProps } from './eks-service';
import { Construct } from 'constructs';

export interface SearchServiceEksProps extends EksServiceProps {}

export class SearchServiceEks extends EksService {
  constructor(scope: Construct, id: string, props: SearchServiceEksProps) {
    super(scope, id, props);

    // Add required IAM policies
    this.addManagedPolicy('arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess');
    this.addManagedPolicy('arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess');
    // OTEL collector sends traces to X-Ray directly via IRSA
    this.addManagedPolicy('arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess');
  }

  createContainerImage(): DockerImageAsset {
    return new DockerImageAsset(this, 'search-service-image', {
      directory: './resources/microservices/petsearch-java',
      platform: Platform.LINUX_ARM64,
    });
  }
}
