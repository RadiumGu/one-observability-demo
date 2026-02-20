# PetSite ALB 外部测试方案

> 背景：PetSite ALB (`Servic-PetSi-by0kpyBtxswj`) 配置了 Cognito 认证，外部 HTTP 请求需要通过认证才能访问。
> 以下方案适用于开发/测试场景绕过或配合 Cognito 认证。

---

## 方案 A：浏览器登录拿 Cookie（最简单，日常推荐）

1. 浏览器访问 PetSite，完成 Cognito 登录（用户名 `petsite-user`，密码 `PetSite@2026`）
2. 打开开发者工具 → Application → Cookies，复制 `AWSELBAuthSessionCookie-0` 的值
3. 测试时带上 Cookie：

```bash
curl -k \
  -H "Cookie: AWSELBAuthSessionCookie-0=<cookie值>" \
  "https://Servic-PetSi-by0kpyBtxswj-1910028459.ap-northeast-1.elb.amazonaws.com/your/path"
```

**有效期**：7 天，到期后重新登录获取即可。

---

## 方案 B：程序化获取 Token（自动化脚本）

ALB Cognito 认证基于 Cookie，不支持 Bearer token，但可以通过 Cognito API 获取 IdToken 用于其他目的（如直接调用后端服务 API）。

```bash
# 获取 token
aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id 3g9nsp906bmsugq7m4rqulta63 \
  --auth-parameters USERNAME=petsite-user,PASSWORD=PetSite@2026 \
  --region ap-northeast-1

# 注意：IdToken 可用于调用 Cognito 保护的 API Gateway，
# 但不能直接绕过 ALB 的 Cookie 认证流程。
```

> ⚠️ 限制：此方案对 ALB Cognito 认证不直接生效，需结合浏览器 Cookie 流程。
> 适合直接调用后端服务（绕过 ALB）时使用。

---

## 方案 C：ALB 添加豁免规则（自动化测试推荐）

在 ALB 443 Listener 添加高优先级规则，匹配特定 Header 直接转发，跳过 Cognito 认证：

```bash
# 1. 创建豁免规则（匹配特定测试 Header）
aws elbv2 create-rule \
  --listener-arn arn:aws:elasticloadbalancing:ap-northeast-1:926093770964:listener/app/Servic-PetSi-by0kpyBtxswj/bbe5082588a126fc/9aef62689ebe42c0 \
  --priority 1 \
  --conditions '[{"Field":"http-header","HttpHeaderConfig":{"HttpHeaderName":"X-Test-Key","Values":["<你的密钥>"]}}]' \
  --actions '[{"Type":"forward","TargetGroupArn":"arn:aws:elasticloadbalancing:ap-northeast-1:926093770964:targetgroup/Servic-PetSi-BGUX1XK3RN6D/8d4815db7d125b15"}]' \
  --region ap-northeast-1

# 2. 测试时带上 Header
curl -k \
  -H "X-Test-Key: <你的密钥>" \
  "https://Servic-PetSi-by0kpyBtxswj-1910028459.ap-northeast-1.elb.amazonaws.com/your/path"
```

**优点**：自动化脚本/CI 可直接使用，不需要 Cookie 或浏览器交互。
**注意**：密钥要保密，避免泄露到公共仓库。

---

## 资源信息

| 资源 | 值 |
|------|-----|
| PetSite ALB DNS | `Servic-PetSi-by0kpyBtxswj-1910028459.ap-northeast-1.elb.amazonaws.com` |
| Cognito User Pool | `ap-northeast-1_uEVoS9ocy` (openclaw-users) |
| App Client ID | `3g9nsp906bmsugq7m4rqulta63` (petsite-alb-client) |
| 测试用户名 | `petsite-user` |
| 测试密码 | `PetSite@2026` |
| Target Group ARN | `arn:aws:elasticloadbalancing:ap-northeast-1:926093770964:targetgroup/Servic-PetSi-BGUX1XK3RN6D/8d4815db7d125b15` |
| Listener ARN | `arn:aws:elasticloadbalancing:ap-northeast-1:926093770964:listener/app/Servic-PetSi-by0kpyBtxswj/bbe5082588a126fc/9aef62689ebe42c0` |
