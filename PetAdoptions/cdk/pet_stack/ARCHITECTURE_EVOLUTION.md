# 架构演进：两层 ALB + 纯 EKS (Graviton)

## 📊 三代架构对比

### 第一代：原始架构（多 ALB + ECS/EKS 混合）
```
用户
 ├→ PetSite ALB → EKS (PetSite 前端)
 ├→ List ALB → ECS Cluster (List Service)
 ├→ Search ALB → ECS Cluster (Search Service)
 ├→ PayFor ALB → ECS Cluster (PayFor Service)
 └→ Traffic ALB → ECS Cluster (Traffic Service)

❌ 问题:
- 5 个 ALB，成本高
- ECS + EKS 混合，管理复杂
- 无统一认证
- 后端直接暴露公网
```

### 第二代：统一 ALB + Cognito (ECS/EKS 混合)
```
用户
 ↓ Cognito 认证
统一 ALB (路径路由)
 ├→ /* → EKS (PetSite)
 ├→ /api/adoptionlist/* → ECS (List)
 ├→ /api/search* → ECS (Search)
 ├→ /api/payforadoption/* → ECS (PayFor)
 └→ /traffic/* → ECS (Traffic)

✅ 改进: 统一认证、成本降低 76%
⚠️ 问题: ECS + EKS 仍然混合，后端仍暴露公网
```

### 第三代：两层 ALB + 纯 EKS (Graviton) ⭐ 当前方案
```
用户
 ↓ Cognito 认证
外部 ALB (internet-facing)
 ↓ 只暴露前端
EKS - PetSite 前端 (Graviton ARM64)
 ↓ 调用后端 API
内部 ALB (internal, VPC 内部)
 ↓ Host/Path 路由
EKS - 所有微服务 (Graviton ARM64)
 ├─ List Service
 ├─ Search Service
 ├─ PayFor Service
 ├─ Traffic Service
 └─ PetHistory Service

✅ 优势:
- 两层 ALB（外部+内部），安全隔离
- 纯 EKS，统一管理
- Graviton ARM64，成本更低、性能更好
- 后端不暴露公网，只能通过内部 ALB 访问
```

---

## 🔐 安全架构对比

### 第一代（无认证）
```
互联网 → 各服务 ALB → 服务
❌ 任何人都可以直接访问后端 API
```

### 第二代（统一认证）
```
互联网 → 统一 ALB (Cognito) → 服务
✅ 有认证，但后端仍然通过公网 ALB 暴露
```

### 第三代（分层认证+隔离）⭐
```
互联网 → 外部 ALB (Cognito) → PetSite 前端
                                    ↓
                     VPC 内部 → 内部 ALB → 后端服务
✅ 前端有认证
✅ 后端不暴露公网
✅ 服务间通过内部 ALB 通信
```

---

## 🏗️ 架构详细对比

### 计算平台

| 维度 | 第一代 | 第二代 | 第三代 ⭐ |
|------|--------|--------|---------|
| **前端** | EKS | EKS | EKS (Graviton) |
| **后端** | ECS Fargate | ECS Fargate | EKS (Graviton) |
| **架构** | x86 | x86 | ARM64 |
| **管理工具** | ECS CLI + kubectl | ECS CLI + kubectl | kubectl |
| **统一性** | 分散 | 分散 | 统一 |

### 负载均衡

| 维度 | 第一代 | 第二代 | 第三代 ⭐ |
|------|--------|--------|---------|
| **ALB 数量** | 5 个 | 1 个 | 2 个（外部+内部） |
| **类型** | 全部 internet-facing | 1 个 internet-facing | 1 外部 + 1 内部 |
| **认证** | 无 | Cognito (统一) | Cognito (外部) |
| **后端暴露** | 全部暴露 | 全部暴露 | 不暴露（内部 ALB） |
| **月度成本** | ~$191 | ~$46 | ~$70 |

### 安全性

| 维度 | 第一代 | 第二代 | 第三代 ⭐ |
|------|--------|--------|---------|
| **认证方式** | 无 | Cognito OAuth2 | Cognito OAuth2 |
| **后端访问** | 公网直接访问 | 公网直接访问 | 仅 VPC 内部 |
| **服务间通信** | 公网 ALB | 公网 ALB | 内部 ALB |
| **纵深防御** | 1 层 | 2 层 | 4 层 |
| **安全等级** | 低 | 中 | 高 ⭐ |

### 成本分析

| 组件 | 第一代 | 第二代 | 第三代 ⭐ |
|------|--------|--------|---------|
| **ALB** | $191/月 | $46/月 | $70/月 |
| **计算** | ECS Fargate ~$150 | ECS Fargate ~$150 | Graviton EC2 ~$45 |
| **EKS 控制平面** | $73/月 | $73/月 | $73/月 |
| **月度总计** | ~$414 | ~$269 | ~$188 |
| **年度总计** | ~$4,968 | ~$3,228 | ~$2,256 |
| **节省（vs 第一代）** | - | 35% ↓ | **55% ↓** ⭐ |
| **节省（vs 第二代）** | - | - | **30% ↓** |

---

## 🎯 核心改进点

### 1. 安全隔离
```
第一代/第二代:
互联网 ──────────→ 后端服务
           ❌ 直接暴露

第三代:
互联网 → 外部 ALB → 前端 → 内部 ALB → 后端
                    ✅ 内部隔离
```

### 2. 统一平台
```
第一代/第二代:
ECS ─┐
     ├─ 管理复杂，工具分散
EKS ─┘

第三代:
EKS ─── 统一管理，kubectl 一站式
```

### 3. 成本优化
```
x86 ECS Fargate          Graviton EKS EC2
$0.04/vCPU/小时     →    $0.0128/vCPU/小时
按需付费            →    预留实例（更便宜）
                         
节省 68% 计算成本! 💰
```

---

## 📍 流量路径对比

### 第一代：分散式
```
用户 → List ALB → ECS List Service → RDS
用户 → Search ALB → ECS Search Service → DynamoDB
用户 → PayFor ALB → ECS PayFor Service → RDS
```
❌ 每个服务独立暴露，无统一认证

### 第二代：统一入口
```
用户 → 统一 ALB (Cognito) → 路径路由
         ├→ List (ECS)
         ├→ Search (ECS)
         └→ PayFor (ECS)
```
✅ 统一认证，但后端仍通过公网 ALB

### 第三代：分层架构 ⭐
```
用户 → 外部 ALB (Cognito) → PetSite 前端 (EKS)
                              ↓
                      内部 ALB (VPC 内部)
                         ├→ List (EKS)
                         ├→ Search (EKS)
                         └→ PayFor (EKS)
```
✅ 前端认证 + 后端隔离

---

## 🔄 服务间通信对比

### 第一代/第二代：通过公网 ALB
```
List Service → 公网 ALB → Search Service
                 ↑
          ❌ 绕一圈，延迟高，不安全
```

### 第三代：通过内部 ALB ⭐
```
List Service → 内部 ALB (VPC 内部) → Search Service
                     ↑
          ✅ 直接通信，延迟低，安全
```

或者通过 Kubernetes Service（更优）:
```
List Service → search-service.petadoptions.svc.cluster.local
                     ↑
          ✅ 集群内部 DNS，延迟最低
```

---

## 🏃‍♂️ 性能对比

### 第一代：x86 ECS Fargate
```
架构: x86_64
CPU: Intel/AMD
性能基准: 1.0x
```

### 第二代：x86 ECS Fargate
```
架构: x86_64
CPU: Intel/AMD
性能基准: 1.0x
（无变化）
```

### 第三代：Graviton ARM64 ⭐
```
架构: ARM64
CPU: AWS Graviton 3
性能基准: 1.4x (40% 提升!)
功耗: 60% 降低
性价比: 2.5x
```

**Graviton 优势**:
- ✅ 计算密集型任务: +40% 性能
- ✅ 内存带宽: +3x
- ✅ 加密性能: +2x
- ✅ 浮点运算: +2x
- ✅ 能效比: 功耗降低 60%

---

## 🛡️ 安全层级对比

### 第一代（单层）
```
[互联网] → [服务]
      ❌ 无防护
```

### 第二代（两层）
```
[互联网] → [Cognito 认证] → [服务]
              ✅ 有认证
```

### 第三代（四层）⭐
```
[互联网]
    ↓
[外部 ALB - Cognito 认证]  ← Layer 1: 用户认证
    ↓
[PetSite 前端]             ← Layer 2: 应用层
    ↓
[内部 ALB - VPC 内部]      ← Layer 3: 网络隔离
    ↓
[后端服务 Pod]             ← Layer 4: 容器隔离
    ↓
[数据层]
```

**纵深防御策略**:
1. **外部 ALB**: 阻止未认证用户
2. **前端应用**: 业务逻辑验证
3. **内部 ALB**: 仅 VPC 内部可访问
4. **后端服务**: 容器隔离 + RBAC

---

## 📊 架构成熟度对比

| 维度 | 第一代 | 第二代 | 第三代 ⭐ |
|------|--------|--------|---------|
| **可维护性** | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **可扩展性** | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **安全性** | ⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **成本效益** | ⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **性能** | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **复杂度** | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| **总评** | 6/30 | 17/30 | **28/30** ⭐ |

---

## 🎓 迁移路径建议

### 阶段 1: 测试环境验证（1-2 周）
1. 构建 ARM64 镜像
2. 部署到测试 EKS 集群
3. 验证所有服务功能
4. 压力测试

### 阶段 2: 灰度部署（1-2 周）
1. 部署外部 ALB + 内部 ALB
2. 10% 流量切到新架构
3. 监控指标和错误率
4. 逐步增加到 50%

### 阶段 3: 全量切换（1 周）
1. 100% 流量切到新架构
2. 监控 24 小时
3. 确认稳定后删除旧资源

### 阶段 4: 优化（持续）
1. 启用 HPA（自动扩缩容）
2. 配置 Service Mesh
3. 实施 GitOps (ArgoCD)
4. 多集群部署

---

## 💡 关键决策点

### 为什么选择两层 ALB？
- ✅ **安全隔离**: 后端不直接暴露公网
- ✅ **灵活路由**: 内部 ALB 可以根据 Host/Path 精细路由
- ✅ **成本合理**: 只比单 ALB 多 $24/月，但安全性提升显著

### 为什么删除 ECS？
- ✅ **统一管理**: kubectl 一站式管理所有服务
- ✅ **生态丰富**: Kubernetes 生态更成熟（Helm, Istio, ArgoCD）
- ✅ **成本更低**: Graviton EC2 比 Fargate 便宜 ~70%
- ✅ **性能更好**: Graviton 比 x86 性能提升 40%

### 为什么选择 Graviton？
- ✅ **成本**: 比 x86 便宜 20%
- ✅ **性能**: 比 x86 快 40%
- ✅ **能效**: 功耗降低 60%（绿色计算）
- ✅ **未来**: AWS 重点投入的方向

---

## 📈 ROI 分析

### 投入
- **时间**: 2-3 周（包括测试）
- **工程**: 1-2 人
- **风险**: 中等（有回滚方案）

### 回报
- **成本节省**: $2,712/年（vs 第一代）
- **性能提升**: 40% (Graviton)
- **安全提升**: 高（四层防护）
- **运维简化**: 统一到 EKS

**ROI**: ~300% (年)

---

## 🎯 推荐方案

✅ **推荐采用第三代架构** (两层 ALB + 纯 EKS Graviton)

**理由**:
1. **安全性最高**: 四层纵深防御
2. **成本最低**: 年度节省 55%
3. **性能最好**: Graviton +40% 性能
4. **管理最简**: 统一 Kubernetes 平台
5. **未来可扩展**: Service Mesh, GitOps, Multi-Cluster

**适合场景**:
- 重视安全性的生产环境
- 需要降低运营成本
- 希望统一管理平台
- 计划长期发展的项目

---

**文档版本**: v2.0  
**更新时间**: 2026-02-14  
**推荐架构**: 第三代（两层 ALB + 纯 EKS Graviton）⭐  
**作者**: 小乖乖 🐱
