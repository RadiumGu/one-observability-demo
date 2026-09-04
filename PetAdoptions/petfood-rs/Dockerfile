# Build stage
#
# ⚠️ 本项目硬约束：所有容器必须跑在 arm64 EKS。
#    构建走 `docker buildx build --platform linux/arm64`（见 PetAdoptions/build-arm64-images.sh），
#    Rust 在 arm64 builder 里天然产出 aarch64 二进制，无需显式指定 target。
FROM public.ecr.aws/docker/library/rust:bookworm AS builder
WORKDIR /build
COPY . .
RUN cargo build --release

# Runtime stage
#
# ⚠️⚠️ 这一段与上游差异很大，原因是**构建环境封了出站 80 端口，只有 443 通**
#      （2026-09-04 实测：`deb.debian.org` HTTPS 返回 200，而
#        `Could not connect to deb.debian.org:80 (146.75.114.132), connection timed out`）。
#
#      上游的 runtime 阶段做 `apt-get update && apt-get install -y ca-certificates openssl
#      curl unzip` 再下载 AWS CLI。在本环境里它**必然失败**，而且失败方式互锁：
#        · Debian 默认源用 http:// → 80 不通 → apt-get update 取不到索引
#          （但 update 仍返回 0，于是四个包全报 "Unable to locate package"，
#            报错指向包名而非网络，极易误判成镜像问题）
#        · 把源改成 https:// → `Certificate verification failed: certificate issuer
#          is unknown`，因为 bookworm-slim **不自带 ca-certificates**（实测 dpkg -l 是 `un`）
#        · 于是「要 HTTPS 得先有证书，要证书得先能 apt」死锁
#
#      解法：**从 builder 阶段拷 CA 证书**，runtime 阶段完全不联网。
#      `rust:bookworm` 是完整 Debian 镜像，自带 224KB / 3697 行的 CA 包，
#      且两边 `/etc/debian_version` 都是 **12.15**（同系，证书格式与路径一致）。
#
#      同时**删掉 AWS CLI、curl、unzip 与 HEALTHCHECK**：
#        · petfood-rs 用 Rust AWS SDK，运行时不需要 CLI（CLI 只是上游的调试便利）
#        · **Kubernetes 不使用 Docker HEALTHCHECK** —— 它用自己的 liveness/readiness 探针，
#          我们已在 CDK 里通过 `healthCheck: '/health'` 配好。所以 HEALTHCHECK
#          在 K8s 里是死代码，为它拖一个 curl 依赖不值得。
FROM public.ecr.aws/docker/library/debian:bookworm-slim

# CA 证书 —— Rust SDK 对 AWS API 发 HTTPS 必需。没有它所有 AWS 调用都会
# TLS 握手失败，而症状是运行时报证书错误，不是构建失败。
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

COPY --from=builder /build/target/release/petfood-rs /app/petfood-rs

# Create a non-root user for security（保留上游这一点，slim 自带 useradd）
RUN useradd -r -s /bin/false petfood && \
    chown petfood:petfood /app/petfood-rs

USER petfood

# 容器内监听 8080（config/mod.rs 的 PETFOOD_PORT 默认值）。
# **不像 payforadoption 那样用 flag 拉回 80** —— petfood 是新服务，
# 我们自己定义它的 K8s Service，照 petsite 的既有模式做 Service 80 → 容器 8080 映射即可。
EXPOSE 8080
CMD ["/app/petfood-rs"]
