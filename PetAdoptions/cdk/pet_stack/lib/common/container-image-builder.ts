/**
 * Create a container image from Dockerfile and make it available
 * on a dedicated ECR repository (by default, CDK places all of the
 * container images in the same "CDK Assets" ECR repository)
 *
 * Behind the scenes, this is what happens:
 * 1. The container image is built locally and pushed into the "CDK Assets" ECR repository
 * 2. A dedicated ECR repository is created
 * 3. The container image is copied from "CDK Assets" to the dedicated repository
 */

import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrassets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecrdeploy from 'cdk-ecr-deployment';

import { Construct } from 'constructs';

export interface ContainerImageBuilderProps {
    repositoryName: string,
    dockerImageAssetDirectory: string
}

export class ContainerImageBuilder extends Construct {
    public repositoryUri: string;
    public imageUri: string;

    constructor(scope: Construct, id: string, props: ContainerImageBuilderProps) {
        super(scope, id);

        const repository = new ecr.Repository(this, props.repositoryName + 'Repository', {
            repositoryName: props.repositoryName,
            imageScanOnPush: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
        });
        const image = new ecrassets.DockerImageAsset(this, props.repositoryName + 'DockerImageAsset', {
          directory: props.dockerImageAssetDirectory
        });
        // 构造 id 从 'DeployDockerImage' 改为 'DeployDockerImageV2'：
        // cdk-ecr-deployment 3.x -> 4.x 改变了它发出的 CFN 自定义资源**类型字符串**，
        // 而 CloudFormation 不允许原地改变资源 type（ValidationError:
        // "Update of resource type is not permitted"）。换逻辑 id 让 CFN 走
        // create-new + delete-old，绕开这个限制。
        //
        // 这样做是安全的：ECRDeployment 只做「把镜像从 CDK 资产仓库复制到目标 ECR 仓库」，
        // 重建会重跑一次复制（幂等），删除旧的自定义资源不会删掉已复制的镜像。
        new ecrdeploy.ECRDeployment(this, props.repositoryName + 'DeployDockerImageV2', {
          src: new ecrdeploy.DockerImageName(image.imageUri),
          dest: new ecrdeploy.DockerImageName(repository.repositoryUri),
        });

        this.repositoryUri = repository.repositoryUri;
        this.imageUri = `${repository.repositoryUri}:latest`;
    }
}
