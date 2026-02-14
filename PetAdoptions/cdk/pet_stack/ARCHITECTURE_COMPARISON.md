# 架构改动对比

## 📊 架构对比图

### 之前 (5 个 ALB)
```
┌─────────────────────────────────────────────────────────────────┐
│                         互联网                                   │
└─────────────────────────────────────────────────────────────────┘
           │              │            │           │          │
           ▼              ▼            ▼           ▼          ▼
    ┌──────────┐   ┌──────────┐  ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ PetSite  │   │   List   │  │  Search  │ │ PayFor   │ │ Traffic  │
    │   ALB    │   │   ALB    │  │   ALB    │ │   ALB    │ │   ALB    │
    └──────────┘   └──────────┘  └──────────┘ └──────────┘ └──────────┘
        │ (EKS)          │            │            │            │
        │               │            │            │            │
        ▼               ▼            ▼            ▼            ▼
    ┌──────┐      ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
    │PetSite│     │ECS List │  │ECS Search│ │ECS PayFor│ │ECS Traffic│
    │ Pod  │      │Cluster  │  │ Cluster  │ │ Cluster  │ │ Cluster  │
    └──────┘      └─────────┘  └─────────┘  └─────────┘  └─────────┘

❌ 问题：
- 5 个 ALB = 高成本
- 无统一认证
- 管理复杂
- 安全组分散
```

### 之后 (1 个 ALB + Cognito)
```
┌─────────────────────────────────────────────────────────────────┐
│                         互联网                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   Unified ALB    │
                    │  (Cognito Auth)  │
                    └──────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
        [路径路由规则]
              │               │               │
    ┌─────────┴─────┐   ┌────┴─────┐   ┌────┴─────┐
    │  /api/search* │   │ /*       │   │ /api/... │
    │  → Search     │   │ → PetSite│   │ → Others │
    └───────────────┘   └──────────┘   └──────────┘
              │               │               │
              ▼               ▼               ▼
    ┌───────────────────────────────────────────┐
    │      共享 ECS 集群 (所有微服务)            │
    │  ├─ PayForAdoption Service                │
    │  ├─ ListAdoptions Service                 │
    │  ├─ Search Service                        │
    │  └─ Traffic Generator Service             │
    └───────────────────────────────────────────┘
              │
              ▼
        ┌──────────┐
        │   EKS    │
        │ (PetSite)│
        └──────────┘

✅ 优势：
- 1 个 ALB = 节省 76% 成本
- Cognito 统一认证
- 简化管理
- 统一安全策略
```

## 🔐 认证流程

### 之前
```
用户请求 → ALB → 服务 (无认证)
```

### 之后
```
用户请求 
  ↓
ALB (检查认证 Cookie)
  ↓
未认证? → 重定向到 Cognito Hosted UI
  ↓
用户登录 (邮箱/用户名 + 密码)
  ↓
Cognito 验证 → 返回授权码
  ↓
ALB 交换 Token → 设置 Cookie
  ↓
已认证! → 转发到后端服务
```

## 📝 代码改动细节

### 1. 删除的独立 ALB 创建代码

**之前** (services.ts):
```typescript
// PayForAdoption 独立集群和 ALB
const ecsPayForAdoptionCluster = new ecs.Cluster(this, "PayForAdoption", {
    vpc: theVPC,
    containerInsightsV2: ecs.ContainerInsights.ENHANCED
});

const payForAdoptionService = new PayForAdoptionService(...);
// 自动创建内部 ALB ❌
```

**之后** (services-unified-alb.ts):
```typescript
// 共享集群
const sharedEcsCluster = new ecs.Cluster(this, "SharedECSCluster", {
    vpc: theVPC,
    containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    clusterName: 'PetAdoptions-Shared-Cluster'
});

const payForAdoptionService = new PayForAdoptionService(this, 'pay-for-adoption-service', {
    cluster: sharedEcsCluster, // 使用共享集群 ✅
    ...
});
```

### 2. 新增 Cognito 配置

**新增**:
```typescript
// 创建 Cognito 用户池
const userPool = new cognito.UserPool(this, 'PetAdoptionsUserPool', {
    userPoolName: 'PetAdoptionsUserPool',
    selfSignUpEnabled: true,
    signInAliases: {
        email: true,
        username: true
    },
    autoVerify: { email: true },
    passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
    }
});

// 创建域名（Hosted UI）
const userPoolDomain = userPool.addDomain('PetAdoptionsDomain', {
    cognitoDomain: {
        domainPrefix: `petadoptions-${stack.account}-${region}`.toLowerCase()
    }
});

// 创建客户端
const userPoolClient = new cognito.UserPoolClient(this, 'PetAdoptionsUserPoolClient', {
    userPool: userPool,
    generateSecret: true,
    oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
            cognito.OAuthScope.EMAIL,
            cognito.OAuthScope.OPENID,
            cognito.OAuthScope.PROFILE
        ]
    }
});
```

### 3. 统一 ALB 配置

**之前**:
```typescript
// PetSite 的 ALB
const alb = new elbv2.ApplicationLoadBalancer(this, 'PetSiteLoadBalancer', {
    vpc: theVPC,
    internetFacing: true,
    securityGroup: albSG
});

const listener = alb.addListener('Listener', {
    port: 80,
    open: true,
    defaultTargetGroups: [targetGroup], // 直接路由 ❌
});
```

**之后**:
```typescript
// 统一 ALB
const unifiedAlb = new elbv2.ApplicationLoadBalancer(this, 'UnifiedALB', {
    vpc: theVPC,
    internetFacing: true,
    securityGroup: albSG,
    loadBalancerName: 'PetAdoptions-Unified-ALB'
});

// 配置 Cognito 认证 ✅
const httpListener = unifiedAlb.addListener('HttpListener', {
    port: 80,
    protocol: elbv2.ApplicationProtocol.HTTP,
    defaultAction: elbv2.ListenerAction.authenticateCognito({
        userPool: userPool,
        userPoolClient: userPoolClient,
        userPoolDomain: userPoolDomain,
        next: elbv2.ListenerAction.fixedResponse(200, {
            contentType: 'text/plain',
            messageBody: 'Welcome to Pet Adoptions Platform'
        })
    })
});
```

### 4. 路径路由规则

**新增**:
```typescript
// PayForAdoption: /api/payforadoption/*, /api/home/*
httpListener.addTargetGroups('PayForAdoptionRule', {
    priority: 10,
    conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/payforadoption/*', '/api/home/*'])
    ],
    targetGroups: [payForAdoptionTG]
});

// ListAdoptions: /api/adoptionlist/*
httpListener.addTargetGroups('ListAdoptionsRule', {
    priority: 20,
    conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/adoptionlist/*'])
    ],
    targetGroups: [listAdoptionsTG]
});

// Search: /api/search*
httpListener.addTargetGroups('SearchRule', {
    priority: 30,
    conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/search*'])
    ],
    targetGroups: [searchTG]
});

// ... 其他规则
```

## 🔄 资源变更清单

| 资源类型 | 之前 | 之后 | 变更 |
|---------|------|------|------|
| **Application Load Balancer** | 5 个 | 1 个 | 删除 4 个 ✅ |
| **ECS Cluster** | 3 个 | 1 个 | 合并 ✅ |
| **Cognito User Pool** | 0 | 1 | 新增 ✅ |
| **Target Groups** | 5 个 | 6 个 | 新增 1 个 |
| **Listener Rules** | ~2 个 | 6 个 | 新增路径路由 |
| **Security Groups** | 多个 | 2 个 | 简化 ✅ |

## 💾 SSM 参数变更

### 新增参数
```
/petstore/cognito/userpool_id      - User Pool ID
/petstore/cognito/client_id        - Client ID
/petstore/cognito/domain           - Cognito Domain
```

### 更新参数（URL 变更）
所有服务 URL 从各自的 ALB DNS 改为统一 ALB DNS：

```typescript
// 之前
'/petstore/searchapiurl': `http://${searchService.service.loadBalancer.loadBalancerDnsName}/api/search?`

// 之后
'/petstore/searchapiurl': `http://${unifiedAlb.loadBalancerDnsName}/api/search?`
```

## 🎯 服务路径映射

| 服务 | 之前的 URL | 之后的 URL (路径) |
|------|-----------|------------------|
| **PayForAdoption** | `http://payfor-alb-xxx.elb.amazonaws.com/api/home/*` | `http://unified-alb-xxx.elb.amazonaws.com/api/home/*` |
| **ListAdoptions** | `http://list-alb-xxx.elb.amazonaws.com/api/adoptionlist/*` | `http://unified-alb-xxx.elb.amazonaws.com/api/adoptionlist/*` |
| **Search** | `http://search-alb-xxx.elb.amazonaws.com/api/search*` | `http://unified-alb-xxx.elb.amazonaws.com/api/search*` |
| **Traffic** | `http://traffic-alb-xxx.elb.amazonaws.com/traffic/*` | `http://unified-alb-xxx.elb.amazonaws.com/traffic/*` |
| **PetSite** | `http://petsite-alb-xxx.elb.amazonaws.com/*` | `http://unified-alb-xxx.elb.amazonaws.com/*` |

## 🔍 迁移注意事项

### 1. 数据库连接不受影响
- RDS 集群保持不变
- 连接字符串不变
- 服务内部逻辑无需修改

### 2. ECS 任务定义保持不变
- 容器镜像不变
- 环境变量通过 SSM 自动更新
- 健康检查路径不变

### 3. EKS PetSite 需要注意
- Target Group ARN 会变化
- 需要更新 Ingress 配置（如果有）
- 通过 SSM Parameter 自动获取新的 TG ARN

### 4. DNS/域名（如果有）
- 需要将域名 CNAME 指向新的 ALB DNS
- 或使用 Route53 Alias 记录

### 5. 监控告警
- CloudWatch 告警需要更新 ALB 维度
- Dashboard 需要更新到新 ALB
- 日志组路径保持不变

## ⚙️ 环境变量/配置变更

应用无需代码修改，所有配置通过 SSM Parameter Store 自动更新：

```bash
# 服务启动时自动从 SSM 读取
aws ssm get-parameter --name /petstore/searchapiurl
# 返回新的统一 ALB URL
```

## 🧪 测试验证清单

- [ ] **认证流程**: 未登录访问 → 跳转 Cognito → 登录成功 → 返回应用
- [ ] **路径路由**: 各服务路径正确路由到对应 Target Group
- [ ] **健康检查**: 所有 Target Group 显示 Healthy
- [ ] **ECS 任务**: 所有服务的 Running Count = Desired Count
- [ ] **EKS Pod**: PetSite 和 PetHistory Pod 正常运行
- [ ] **数据库**: RDS 连接正常，数据完整
- [ ] **S3**: 图片资源访问正常
- [ ] **SSM 参数**: 所有参数更新正确
- [ ] **监控**: CloudWatch 指标正常上报
- [ ] **日志**: 所有服务日志正常输出

## 📈 性能影响

### 延迟变化
- 单一 ALB 可能略微增加延迟 (~1-2ms)
- Cognito 认证首次登录增加 ~200-500ms
- 后续请求使用 Cookie，无额外延迟

### 吞吐量
- ALB LCU 可能略微增加（合并流量）
- 整体吞吐能力不受影响
- ECS 集群资源池更灵活

## 🔐 安全性提升

### 之前
- ❌ 无统一认证
- ❌ 服务直接暴露
- ❌ 多个安全组管理
- ❌ 无会话管理

### 之后
- ✅ Cognito 统一认证
- ✅ ALB 层面访问控制
- ✅ 简化安全组规则
- ✅ OAuth2 标准流程
- ✅ 会话自动管理
- ✅ 支持 MFA（可选）

## 💡 未来扩展

### 可选改进
1. **HTTPS + ACM**
   ```typescript
   const certificate = acm.Certificate.fromCertificateArn(...);
   const httpsListener = alb.addListener('HttpsListener', {
       port: 443,
       certificates: [certificate],
       ...
   });
   ```

2. **WAF 防护**
   ```typescript
   const webAcl = new wafv2.CfnWebACL(...);
   new wafv2.CfnWebACLAssociation(this, 'ALBWAFAssociation', {
       resourceArn: unifiedAlb.loadBalancerArn,
       webAclArn: webAcl.attrArn
   });
   ```

3. **社交登录**
   ```typescript
   const googleProvider = new cognito.UserPoolIdentityProviderGoogle(...);
   userPool.registerIdentityProvider(googleProvider);
   ```

4. **自定义域名**
   ```typescript
   const customDomain = userPool.addDomain('CustomDomain', {
       customDomain: {
           domainName: 'auth.yourdomain.com',
           certificate: certificate
       }
   });
   ```

---

**总结**: 这次改动将分散的 5 个 ALB 合并为 1 个，并添加了 Cognito 统一认证，大幅提升了安全性和可维护性，同时降低了约 76% 的负载均衡成本。
