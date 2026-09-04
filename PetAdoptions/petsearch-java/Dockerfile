# 采纳上游：改用 public.ecr.aws 而非 Docker Hub 的 gradle 镜像。
# Docker Hub 对匿名拉取有速率限制，构建高峰期会随机失败（429），
# ECR Public 没有这个问题。保留 --platform=linux/arm64 的显式声明 ——
# 上游写的是 $BUILDPLATFORM，那会跟随构建机架构；本项目**所有容器必须是 arm64**，
# 显式钉死比跟随环境更安全（构建机现在是 m8g arm64，但不该依赖这一点）。
FROM --platform=linux/arm64 public.ecr.aws/docker/library/gradle:7.3-jdk17 as build

WORKDIR /app
COPY ./build.gradle ./build.gradle
COPY ./src ./src
COPY ./settings.gradle ./settings.gradle

ENV GRADLE_OPTS "-Dorg.gradle.daemon=false"
# 采纳上游：加 --no-daemon 与 --stacktrace。
# --no-daemon 与上面的 GRADLE_OPTS 重复但无害；--stacktrace 让构建失败时能看到根因，
# 这在远程构建机上尤其值得 —— 日志是唯一的诊断入口。
RUN gradle build -DexcludeTags='integration' --no-daemon --stacktrace

# 采纳上游：runtime 基础镜像也走 ECR Public。
# 但**不采纳上游的 amazoncorretto:17-al2-generic-jdk** —— 那是 Amazon Linux 2 全量 JDK，
# 比本地的 alpine3.17 大很多。保留 alpine 变体，同样从 ECR Public 拉。
FROM --platform=linux/arm64 public.ecr.aws/docker/library/amazoncorretto:17-alpine3.17
WORKDIR /app

# ⚠️ 保留本地这两行 —— 上游把它们**整段删掉了**，那会让 petsearch 停止产出 trace。
#    这是 ADOT Java 自动埋点 agent：靠 JAVA_TOOL_OPTIONS 挂 -javaagent，
#    在字节码层面自动为 Spring MVC / AWS SDK / HTTP 客户端织入 span，
#    再由下面的 OTEL_EXPORTER_OTLP_ENDPOINT 送到同 Pod 的 aws-otel-collector sidecar。
#    删掉它 = petsearch 从 X-Ray 服务图消失 = etl_xray 丢掉它的出边 = 图谱静默残缺。
#    （petsite 是相反的情况：它没有 sidecar，只能靠 X-Ray SDK 发给 xray-daemon。
#      两个服务的遥测出口不同，所以移植结论也不同 —— 不能一概而论。）
ADD https://github.com/aws-observability/aws-otel-java-instrumentation/releases/download/v1.21.1/aws-opentelemetry-agent.jar /app/aws-opentelemetry-agent.jar
ENV JAVA_TOOL_OPTIONS "-javaagent:/app/aws-opentelemetry-agent.jar"

ARG JAR_FILE=build/libs/\*.jar
COPY --from=build /app/${JAR_FILE} ./app.jar

# ⚠️ 保留本地：OpenTelemetry agent 配置。上游同样整段删掉。
#    OTEL_EXPORTER_OTLP_ENDPOINT 指向 localhost:4317 —— 那是同 Pod 内
#    aws-otel-collector sidecar 的 OTLP gRPC 端口，是这个服务遥测的唯一出口。
#    OTEL_PROPAGATORS 含 xray：保证与其余服务（用 X-Ray header 传播）能串成同一条 trace。
ENV OTEL_TRACES_SAMPLER "always_on"
ENV OTEL_PROPAGATORS "tracecontext,baggage,xray"
ENV OTEL_RESOURCE_ATTRIBUTES "service.name=PetSearch"
ENV OTEL_IMR_EXPORT_INTERVAL "10000"
ENV OTEL_EXPORTER_OTLP_ENDPOINT "http://localhost:4317"

# ⚠️ 刻意不采纳上游新增的两段：
#
#  ① AWS CLI 安装：
#       RUN yum install -y curl unzip && \
#           curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" ...
#     又一次**硬编码 x86_64** —— 与 petfood-rs、petsite 的 Dockerfile 同一个 bug，
#     这是上游第三处。装进 arm64 镜像后运行时报 exec format error，且它只是调试便利，
#     服务本身用 AWS SDK for Java，运行时不需要 CLI。
#     （顺带：yum 在 alpine 上根本不存在，上游那段是为 al2 基础镜像写的。）
#
#  ② HEALTHCHECK --interval=30s ... CMD curl -f http://localhost:8080/actuator/health
#     两个问题：**Kubernetes 不使用 Docker HEALTHCHECK**（它用自己的探针）；
#     而且端口写的是 8080，而本服务在本环境监听 **80**（见 application.yml），
#     即使 Docker 会执行它也永远失败。

ENTRYPOINT ["java","-jar","/app/app.jar"]
