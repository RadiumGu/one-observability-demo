# 采纳上游：走 ECR Public 镜像而非 Docker Hub —— 避开 Docker Hub 的匿名拉取限流，
# 那是构建机上偶发 toomanyrequests 的根因。同时把 golang 1.23 升到 1.25。
FROM public.ecr.aws/docker/library/golang:1.25 as builder
WORKDIR /go/src/app
COPY . .
# 保留本地值：上游改成了 GOPROXY=direct，但本环境到 proxy.golang.org 不稳定，
# goproxy.io 镜像是本地实测可用的那条路。direct 作为 fallback 仍在。
ENV GOPROXY=https://goproxy.io,direct
RUN go get .
# ⚠️ 保留本地的 GOARCH=arm64（上游删掉了它，改为完全依赖 buildx --platform）。
#    保留的理由：本项目的硬约束是「所有容器必须跑在 arm64 EKS」，显式钉死能让
#    误用 `docker build`（不带 --platform）时**当场产出错架构而被发现**，
#    而不是静默产出 amd64 镜像、到 EKS 上才 CrashLoopBackOff。
#    build-arm64-images.sh 确实用的是 `docker buildx build --platform linux/arm64`，
#    所以这一行在正常路径上是冗余的 —— 它防的是有人绕过那个脚本。
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -a -installsuffix cgo -o app .

# 采纳上游：alpine 从 latest 钉到 3.22.1。`latest` 会让「同一份 Dockerfile 两次构建
# 产出不同基础镜像」，那是无法复现的构建。
FROM public.ecr.aws/docker/library/alpine:3.22.1
WORKDIR /app
# 采纳上游：加 curl（HEALTHCHECK 需要）与 aws-cli。
RUN apk --no-cache add ca-certificates curl aws-cli
# 采纳上游：非 root 运行。原实现以 root 跑，是不必要的权限。
RUN addgroup -g 1000 appuser && adduser -D -u 1000 -G appuser appuser
COPY --from=builder /go/src/app/app .
COPY --from=builder /go/src/app/seed.json .
RUN chown -R appuser:appuser /app
USER appuser

# ⚠️ 保留 80，不采纳上游的 8080。
#    上游把 main.go 的 flag 默认值从 `:80` 改成了 `:8080`
#    （main.go: flag.String("http.addr", ":8080", "HTTP Port binding")）。
#    但线上实测 Deployment 的 containerPort=80、Service 是 80 -> 80，
#    而且这个 Service 挂在 internal ALB 的目标组上。
#    改端口需要 Deployment + Service + 目标组健康检查三处协同改动，
#    收益为零而断服风险实在 —— 所以在 CMD 里用 flag 把端口显式拉回 80，
#    **不改 main.go**（它是上游单方面改动，整体采纳）。
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:80/health || exit 1
CMD ["./app", "-http.addr=:80"]
