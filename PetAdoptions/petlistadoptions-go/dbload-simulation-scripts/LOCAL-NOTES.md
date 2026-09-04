# 本地采纳说明 —— 这批脚本从哪来、为什么能用、跑之前必须知道什么

（2026-09-04 移植时写。上游对应目录：`src/applications/microservices/petlistadoptions-py/dbload-simulation-scripts/`）

## 为什么这批脚本能在「保 Go」的前提下直接采纳

上游把 `petlistadoptions` **整个换成了 Python**（`petlistadoptions-py/app.py`，367 行；
上游已 **0 个 Go 文件**）。本项目的决定是**保留本地 Go 实现**，理由见 GOAL.md。

在这个前提下逐项核对上游到底新增了什么，结论是**只有这批脚本值得拿**：

| 上游新增 | 是否移植 | 依据 |
|---|---|---|
| 对外 HTTP 接口 | **无需移植** | 两边**完全一致**，都只有 `/health/status`、`/api/adoptionlist/`、`/metrics`。上游是等价重写，不是功能扩展。 |
| 配置热加载（`_fetch_from_parameter_store` / `_refresh_parameters_if_needed`） | **无需移植** | 本地 Go 的 `config.go` 把参数名**硬编码**成 `/petstore/rdssecretarn`、`/petstore/searchapiurl`、`/petstore/rds-reader-endpoint`。上游那套「用 `PETSTORE_PARAM_PREFIX` 做前缀间接」反而多一个 fail-fast 失败点（抄错变量名会静默失效），保 Go 少一个风险面。 |
| 凭据轮换刷新（`_fetch_secret` / `_refresh_secret_if_needed`） | **无需移植** | **实测该密钥没有启用轮换**：`RotationEnabled=null`、`RotationLambdaARN=null`、`LastRotated=null`、`NextRotation=null`，最后变更是 2026-02-18。上游这段解决的是**本环境不存在的场景**，移植属于投机性工作。线上两个 Pod **0 重启**。<br>⚠️ 如果将来给这个密钥开了轮换，这条结论立即失效 —— 本地 Go 只在启动时取一次凭据，届时必须补刷新逻辑。 |
| `dbload-simulation-scripts/`（本目录） | **✅ 已采纳** | 纯 shell + SQL，**与服务用什么语言无关**。是真实的可观测性演练内容（死锁、锁阻塞、慢查询、唯一约束冲突、执行计划优化前后对比）。 |
| `_search_pet_info(pet_id)` | 未移植 | 是 Python 版内部私有方法，不对外暴露；本地 Go 通过 `PetSearchURL` 走 HTTP 调 search 服务，路径不同但效果等价。 |

## ⚠️ 跑之前必须知道：这些脚本会对 Aurora 执行 DDL

**本项目硬约束：Aurora 不动。所以这批脚本已落盘但刻意没有执行 —— 要跑必须先经确认。**

已逐个脚本核对过它们的真实作用范围：

- **只碰三张自己建的表**：`CustomerOrders`、`CustomerContacts`、`InventoryItems`。
- **不碰任何业务表**（`transactions` / `pets` / `adoptions` 均无命中）。
- `DROP INDEX` 的目标全部是**脚本自己创建的**索引（`idx_customerorders_*`、`customer_id_order_date_idx`），不会删掉既有索引。
- `cleanup-performance-demo.sh` 用 `DROP TABLE ... CASCADE` 收尾，能自清理。

**但仍有两点真实影响**：

1. `setup-performance-demo.sh` 会**批量插入 `NUM_RECORDS` 条记录**（分批，带进度输出）。
   这会占用生产 Aurora 的存储与 IO，量取决于该变量。
2. 脚本靠 `psql` 的标准 `PG*` 环境变量决定连哪个库 —— **它不自带保护，指到哪就打到哪**。
   上游 README 里 `Log group: /aws/rds/cluster/your-cluster-name/postgresql` 是个占位符，
   说明上游本来就假设由操作者自己接好连接参数。

**建议**：真要演练就指向一个独立的库或 schema，不要直接对 `adoptions` 库跑。
