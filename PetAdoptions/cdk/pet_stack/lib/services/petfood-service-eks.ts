import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { EksService, EksServiceProps } from './eks-service';
import { Construct } from 'constructs';

export interface PetFoodServiceEksProps extends EksServiceProps {
  /** 食品目录表。petfood 通过 PETFOOD_FOODS_TABLE_NAME 读到它 */
  foodsTable: dynamodb.Table;
  /** 购物车表。通过 PETFOOD_CARTS_TABLE_NAME */
  cartsTable: dynamodb.Table;
  /** 领域事件总线。通过 PETFOOD_EVENT_BUS_NAME */
  eventBus: events.EventBus;
}

/**
 * petfood-rs —— 上游 2026-08 新增的 Rust 服务，本地从零编写 EKS 部署。
 *
 * 为什么不移植上游的部署层：上游 `src/cdk/lib/microservices/petfood.ts` 走的是 **ECS**
 * （ECS 命中 15 处、EKS 命中 0），而本项目硬约束是「所有容器跑现有 arm64 EKS，不得用 ECS」。
 * 所以只移植应用代码（46 文件），部署层用本地成熟的 `EksService` 基类重写。
 *
 * 端口：Service 80 → 容器 8080。
 *   容器端口保持上游的 8080（`config/mod.rs` 的 `PETFOOD_PORT` 默认值），
 *   **刻意不像 payforadoption 那样用 flag 把端口拉回 80** —— payforadoption 那么做是因为
 *   它的 Service 早已存在且挂在 internal ALB 目标组上，改端口要三处协同；
 *   petfood 是新服务、Service 由我们定义，直接做 80→8080 映射即可（与 petsite 同形），
 *   少一处与上游的分叉。
 *
 * ⚠️ 不暴露公网：`serviceType: 'ClusterIP'`。硬约束是「ALB 上不得新增公网入口」，
 *    petsite 需要访问它时走集群内 DNS，AgentCore 需要时走 internal ALB。
 */
export class PetFoodServiceEks extends EksService {
  constructor(scope: Construct, id: string, props: PetFoodServiceEksProps) {
    super(scope, id, props);

    // 两张表都需要读写：foods 是目录（读多写少，admin 端点会写），carts 是购物车（读写均衡）
    //
    // 授权对象是 `serviceAccount`（IRSA）而非 ECS 的 taskRole —— 本项目走 EKS，
    // Pod 的 AWS 身份来自 IAM Roles for Service Accounts，基类只暴露 serviceAccount。
    props.foodsTable.grantReadWriteData(this.serviceAccount);
    props.cartsTable.grantReadWriteData(this.serviceAccount);
    // 领域事件（库存变更、购物车结算）投递到 EventBridge，由三个配套 Lambda 消费
    props.eventBus.grantPutEventsTo(this.serviceAccount);
    // OTEL collector 经 IRSA 直发 X-Ray，与其余四个服务一致
    this.addManagedPolicy('arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess');
  }

  createContainerImage(): DockerImageAsset {
    return new DockerImageAsset(this, 'petfood-image', {
      // 符号链接 resources/microservices/petfood-rs -> ../../../../petfood-rs/
      // 需要在 resources/microservices/ 下建好，与其余五个服务同样的做法。
      directory: './resources/microservices/petfood-rs',
      // ⚠️ 必须显式 arm64。Rust 的 Dockerfile 里我已把 AWS CLI 的下载地址
      //    从上游硬编码的 x86_64 改成按 `uname -m` 选择，但镜像本身的架构
      //    仍由这里决定 —— 漏了它会产出 amd64 镜像，到 EKS 上才 CrashLoopBackOff。
      platform: Platform.LINUX_ARM64,
    });
  }
}
