# 用量总览与计量改进调研

日期：2026-10-28（America/Los_Angeles）。本次只调研、运行隔离样本、保存文档；未改产品代码或生产用量记录。

## 核查范围

- TokenFlow：当前工作区 .87，包含此前 .86 的 Antigravity 修改。
- CLIProxyAPI：远端 HEAD / v8.0.46，`9717e325ba6ab2c7483ea93ccb5f2047eb2e7dd5`。
- Management Center：远端 HEAD `64b4f5aed19b8f791eb21eb9e785ea379ea05b44`；另核对最新 tag v1.26.7 `714de0760a3ce86094b178fb46f834d34bc4a2a5` 的目录结构。
- CC Switch：latest release v4.0.21；源码 HEAD `6d6b7162f122ac0ce1356a14688c8c4f712db3c8`，不能把 HEAD 全部能力当作已发布安装包能力。另见 [独立源码调研](cc-switch-usage-research-2026-10-28.md)。

## CC Switch 的可借鉴实现

- SQLite 保存逐请求事实，包含来源、session、请求/返回/计价模型、输入 token 语义；独立持久去重身份和文件游标。日汇总与明细删除在事务中完成，保留模型映射。适合借鉴其可重算和可追溯能力，而不只是把 JSON 换成数据库。
  [表结构](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/database/schema.rs#L207)、[归档](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/database/dao/usage_rollup.rs#L11)。
- Codex 导入考虑 fork 继承历史、父子线程、累计高水位和仅有 token_usage_record 的压缩记录；父关系矛盾时延后导入。适合借鉴这些边界样本，并不证明其已经有完整任务成本树。
  [Codex 导入](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/session_usage_codex.rs#L693)。
- 代理速度实测与日志估算分开，实测速率要求输出至少 100 tokens、生成窗口至少 100 ms；支持全局筛选、小时趋势、来源/同步状态。费用用 Decimal 和单独计价模型估算，不等于订阅实付。
  [速度口径](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/usage_stats.rs#L147)、[费用计算](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/proxy/usage/calculator.rs#L32)。
- 不直接采用其全部跨源去重：其中包含应用/模型/token 计数加前后 10 分钟匹配，不能证明并行请求身份相同。也不照搬会话导入 status_code=200；用量存在不能证明请求成功。
  [匹配窗口与条件](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/usage_stats.rs#L397)、[会话落库](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/session_usage_codex.rs#L2293)。

## CLIProxyAPI 的可借鉴实现

1. **显式 token 口径与质量。** accounting v2 把输入分成未缓存、缓存读、缓存写，把输出分成非推理和推理；区分包含关系、独立计量与独立推理计量。支持 `complete / inconsistent / unclassified` 和无法分类的已知总量；守恒检查失败时不会用截断后的分项伪装完整数据。
   [accounting.go](https://github.com/router-for-me/CLIProxyAPI/blob/9717e325ba6ab2c7483ea93ccb5f2047eb2e7dd5/sdk/cliproxy/usage/accounting.go#L5)、[对应测试](https://github.com/router-for-me/CLIProxyAPI/blob/9717e325ba6ab2c7483ea93ccb5f2047eb2e7dd5/sdk/cliproxy/usage/accounting_test.go#L8)。这不意味着可以删除我们原有的 null/未知语义；零结构仍不等于已测得零。
2. **一次客户端请求与上游执行分开。** Record 含 RequestID、TraceID、SelectionID、SessionID、ParentSessionID、请求模型与响应模型、请求/生效/响应 service tier。它记录的是 provider execution，不宜把每次执行直接当成用户的一条消息。
   [Record](https://github.com/router-for-me/CLIProxyAPI/blob/9717e325ba6ab2c7483ea93ccb5f2047eb2e7dd5/sdk/cliproxy/usage/manager.go#L26)、[持久化消费者的事件字段](https://github.com/router-for-me/CLIProxyAPI/blob/9717e325ba6ab2c7483ea93ccb5f2047eb2e7dd5/internal/redisqueue/plugin.go#L180)。事件还携带 node_kind、is_fork、is_compaction；字段可用不代表所有客户端都一定传来完整关系。
3. **失败与计量独立处理。** UsageReporter 以 sync.Once 结算一次执行；PublishFailureWithDetail 保留已观测用量。StreamDelivery 把向客户端交付的结果与上游读取/取消分开。
   [结算逻辑](https://github.com/router-for-me/CLIProxyAPI/blob/9717e325ba6ab2c7483ea93ccb5f2047eb2e7dd5/internal/runtime/executor/helps/usage_helpers.go#L545)、[流交付边界](https://github.com/router-for-me/CLIProxyAPI/blob/9717e325ba6ab2c7483ea93ccb5f2047eb2e7dd5/sdk/cliproxy/usage/stream_delivery.go#L20)。
4. **事件出口不是长期账本。** 包名虽叫 redisqueue，当前 queue.go 是进程内队列：默认保留 60 秒、最多 3600 秒；GetUsageQueue 会 PopOldest。不能用轮询这条队列替换 TokenFlow 持久账本，再把取不到历史当零消费。
   [队列](https://github.com/router-for-me/CLIProxyAPI/blob/9717e325ba6ab2c7483ea93ccb5f2047eb2e7dd5/internal/redisqueue/queue.go#L9)、[消费接口](https://github.com/router-for-me/CLIProxyAPI/blob/9717e325ba6ab2c7483ea93ccb5f2047eb2e7dd5/internal/api/handlers/management/usage.go#L23)。如接入，需可靠消费、先落本地事务，再确认；不能依赖短期队列完成历史对账。
5. **当前管理 UI 首页主要展示请求健康度。** 按来源聚合成功/失败请求、近期分桶和成功率；对 API Key 凭证与 auth-file 统计进行防重复处理。路由里没有内建独立 token 历史页，支持插件页面。不要将旧截图或第三方插件的费用/总览功能归给当前原仓库。
   [Dashboard 汇总](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/64b4f5aed19b8f791eb21eb9e785ea379ea05b44/src/features/dashboard/hooks/useDashboardOverview.ts#L106)、[路由](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/64b4f5aed19b8f791eb21eb9e785ea379ea05b44/src/router/MainRoutes.tsx#L19)。

## TokenFlow 已有的正确基础

- OpenAI 输入包含缓存；总量是输入加输出，不把缓存或 reasoning 再加一次。Anthropic 缓存分离字段先归一化到包含缓存的输入。
- 未知缓存不会进入命中率分母；Credits 保留自己的单位；官方额度百分比不换算 token。
- 原生记录用响应标识去重，网关响应指纹独立于近期轨迹持久保存，避免轨迹过期后再次导入。
- 账号归属已有请求级 OTel 证据；未确认/冲突不强行分配给当前登录账号。
- 网关按日账本保留 180 天，本机索引按文件戳增量扫描。

依据：[归一化](../../packages/core/src/gateway-observation.ts)、[账本](../../packages/core/src/usage-ledger.ts)、[本机样本](../../packages/core/src/local-usage.ts)、[响应证据](../../packages/core/src/gateway-response-evidence.ts)、[账号证据](../../packages/core/src/usage-attribution.ts)、[前端汇总](../../apps/console/src/usage-model.ts)。

## 确认的不足及隔离样本

| 输入/场景 | 当前结果 | 意义 |
|---|---|---|
| `{total_tokens:42}` | input/output 均为 null，没有地方保存已知总量 42 | 应保留“已知总量、分项未知” |
| input=10, output=3, total=20 | 保留 10 和 3，忽略 total=20，视图显示 13 | 无法发现字段冲突；不能未经协议判断直接采用其中任一口径 |
| HTTP 502，input/output=null | requests=1, failed=1, unmeasured=0，tokens=0 | “失败”和“用量未知”应是独立维度 |
| 官方共存请求 | sourceId 固定为 codex-official | 多个 ChatGPT 登录的消费不能依靠此字段拆分 |
| token_flow 原生记录 | 本机解析器直接排除；已观测的响应指纹也排除 | 见过请求不等于网关已经测到用量，无法以完整本机记录补全未知计量 |
| 日聚合长期保存，明细最多 1000 条/30 天/16 MiB | 总量还在，逐请求证据可能已淘汰 | 难以重算、追溯或安全补计；调试轨迹不适合作账本明细 |

前三项通过现有 providerUsage / UsageLedger 在临时目录执行，目录随后删除，无付费推理。其余是源码确认，未声称所有历史记录均可补回。官方 MIME 错标导致的计量遗漏已由 .87 修复；本表讨论更通用的数据模型不足。

## 建议的实施顺序

### 第一阶段：把每个数字的覆盖范围讲清楚

- 计量状态：完整、部分、未知、字段冲突。分项缺失保留 null；实际为 0 的字段仍是 0。
- 保留上游报告总量、规范化分项、口径版本及来源协议；总览根据质量汇总，不默默截断矛盾字段。
- 状态分为完成、失败、取消、流截断；已确认消耗始终保留。请求状态与用量状态正交。
- 把“未返回 Token”改成可解释的原因：上游缺字段、响应未完成、解析失败、只返回总量等；未知原因就写未测得，不推断供应商没有返回。
- 将“本机直连”与采集来源分离：本机日志是证据来源，不能证明网络直连。

### 第二阶段：建立可对账的逐请求明细

- 用 SQLite 事务保存纯计量元数据，逐请求事实为基础，当前日汇总是可重建视图；调试工具结果继续用独立的短期轨迹。
- 区分客户端请求、上游执行尝试、提供证据的观察记录。相同响应的 SSE、本机日志、OTel 是同一次执行的不同证据，不是三笔消费；两次真实重试执行也不能简单合成一笔。
- 去重必须证明“同一执行已经结算/计量”，不能只靠 provider 名称或见过的响应 hash 排除。迟到的完整证据更新同一笔，聚合在同一事务里重算或修正差额。
- 缺少强关联时进入待核对，不凭模型和相近时间强行匹配。无请求级标识的旧日汇总作为 legacy 汇总保存，不能假造明细。
- 官方共存入口从当次已认证账号 ID 生成账号指纹，和 API 来源、客户端、请求模型/实际模型分别保存；不把完整 token/API Key/提示词放入账本。

### 第三阶段：任务树与总览

- 有可靠关系时保存 thread/parent/root 的脱敏标识，区分主代理、子代理、压缩、内部重试；关系未知就保留未知。
- 总览显示“任务合计”和主代理/子代理/压缩拆分；父任务合计是视图，不再作为新消费加进全局。
- 保存 UTC 时间戳，按用户选择的 IANA 时区查询日期，展示覆盖截止时间；旧日汇总无法精确重分时区，需明确标注。
- 首页优先给总量、计量覆盖、缓存命中、失败/取消、近期走势；再按账号/来源/模型/客户端/任务下钻。价格估算作为可选层，标记价格来源/版本，不和订阅实付、Credits 混为一谈。

验收必须覆盖：同一响应多处出现只计一次、未知转完整只补差额、失败但有用量仍计入、父子合计守恒、压缩不重复加总、多账号切换准确归属、缓存/推理无重复、时区边界、重启后总量一致、历史迁移可回滚。

## 验证限制

已阅读上游实现与对应测试；尝试运行 CLIProxyAPI accounting tests 时，Go 1.26.10 工具链下载超时，未将这些测试列为本机通过。本次结论基于固定 commit 源码和 TokenFlow 隔离样本，不等同于完整上游部署验收。
