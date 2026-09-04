# `appsettings.json` 的合并决策

**这些说明必须放在这里，绝不能写回 `appsettings.json`。**

## 为什么单独一个文件 —— 一次线上 502 换来的教训

2026-09-04 17:56 部署后 petsite 全站 **502**。日志：

```
Unhandled exception. System.InvalidOperationException: Configuration value
'以下两项采纳上游新增 —— AWS SDK 的日志对排查 SSM/Bedrock 调用失败很有用' is not supported.
```

原因：我在 `appsettings.json` 里用 `"//": "..."` 和 `"//AWS": "..."` 当注释。
JSON 没有注释语法，这个「伪注释键」的技巧在很多配置里无害，
但**在 .NET 的 `Logging:LogLevel` 段里是致命的** ——
该段会把**每一个键**都当成一个日志类别、把**每一个值**都当成 `LogLevel` 枚举去解析。
中文说明文字不是合法枚举值，于是启动即抛未处理异常。

**顺带暴露一个更值得记的问题**：Pod 当时显示 `Running` / `ready=true` / `RESTARTS=0`，
而应用其实已经崩了、全站 502。**「Pod Ready」不等于「应用可用」** ——
所以部署验证判据里必须包含**实际 HTTP 请求**，不能只看 Pod 状态。
这条已写进 GOAL.md 的阶段 A 判据。

## 逐项决策

| 键 | 取值 | 理由 |
|---|---|---|
| `Logging:LogLevel:Default` | `Information` | 两边一致 |
| `Logging:LogLevel:Microsoft` | **`Warning`**（保本地） | 上游改成 `Information`，会把框架层日志全打出来，在压测下显著放大 CloudWatch Logs 体量而信息价值很低 |
| `Logging:LogLevel:Microsoft.Hosting.Lifetime` | `Information` | 两边一致 |
| `Logging:LogLevel:Amazon` | `Information`（**采纳上游新增**） | AWS SDK 日志对排查 SSM / Bedrock 调用失败很有用 |
| `Logging:LogLevel:AWSSDK` | `Information`（**采纳上游新增**） | 同上 |
| `AllowedHosts` | `*` | 两边一致 |
| **`XRay` 整段** | **保留本地，上游已删除** | `Startup.cs` 的 `app.UseXRay("PetSite", Configuration)` 直接读它，删掉会让 X-Ray 中间件拿不到配置。`ContextMissingStrategy=LOG_ERROR` 尤其重要：它让缺少 trace 上下文时记日志而不是抛异常，`PaymentController` 里那句 `catch (EntityNotAvailableException)` 依赖的正是这个宽容行为 |

上游的 4 空格缩进纯属格式差异，本地保持 2 空格。
