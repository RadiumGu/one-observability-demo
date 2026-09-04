# 采纳上游：.NET 8（与 csproj 的 <TargetFramework>net8.0</TargetFramework> 必须一致；
# 本地原为 net7.0 + 7.0-bullseye-slim）。
#
# 也采纳上游更好的分层缓存：先只 COPY *.csproj 再 restore，然后才 COPY 全量源码 ——
# 这样改代码不改依赖时 restore 层能命中缓存。本地原来是先 COPY . . 再 restore，
# 任何源码改动都会让 restore 重跑（.NET restore 是这个构建里最慢的一步）。
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY *.csproj .
# ⚠️ 刻意去掉上游的 `--no-cache`（本地原来没有）。
#    实测：带 `--no-cache` 时 restore 要 **26.16 分钟**（201 个包全部强制重下，
#    且 System.Text.Json 同时解析出 7.0.3 / 9.0.0-rc / 9.0.10 三个版本，依赖图很大）。
#    第一次实验就是因为它超出了我给的 25 分钟上限而被砍，报 "context canceled"，
#    看起来像网络挂住，其实 restore 本身 0 warning / 0 error 完全正常。
#    版本在 csproj 里已全部钉死，`--no-cache` 想防的「拿到过期包」在这里不成立。
RUN dotnet restore "PetSite.csproj"
COPY . .
RUN dotnet publish "PetSite.csproj" -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
WORKDIR /app
EXPOSE 8080

# ⚠️ 刻意**删掉**上游这一段：
#      RUN apt-get update && apt-get install -y curl unzip && \
#          curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" ...
#    两个原因：
#    ① 它把架构**硬编码成 x86_64** —— 与 petfood-rs 的 Dockerfile 同一个 bug。
#       本项目所有容器跑 arm64 EKS，装进去的 CLI 根本执行不了，而且失败在**运行时**
#       （exec format error）而非构建时，排查成本很高。
#    ② 它只是「for troubleshooting」的调试便利：petsite 用 AWS SDK for .NET，
#       运行时不需要 CLI。为一个调试工具多拉 apt 依赖、放大镜像、并引入架构风险不值得。
#
# 同样删掉上游的 Docker `HEALTHCHECK`（它依赖上面那个 curl）：
#    **Kubernetes 不使用 Docker HEALTHCHECK**，它用自己的 liveness/readiness 探针，
#    我们在 CDK 的 EksService 里已配好。那段在 K8s 里是死代码。

# 采纳上游：非 root 运行（本地原来以 root 跑，是不必要的权限）
RUN groupadd -r appuser && useradd -r -g appuser appuser
COPY --from=build --chown=appuser:appuser /app/publish .
USER appuser

# 采纳上游的 .NET 8 惯用写法。注意线上 Deployment 显式设了
# `ASPNETCORE_URLS=http://+:8080`，它的优先级高于本行 —— 两者指向同一个端口，
# 所以无论哪个生效结果都一致（Service 是 80 → 容器 8080）。
ENV ASPNETCORE_HTTP_PORTS=8080

ENTRYPOINT ["dotnet", "PetSite.dll"]
