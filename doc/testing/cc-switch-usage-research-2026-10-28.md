# CC Switch 用量统计实现调研（2026-10-28）

## 范围与版本

仅审阅上游源码，没有运行 CC Switch、迁移数据库或读取用户凭据/提示词。GitHub latest release API 返回 **v4.0.21**（2026-10-26 发布）；本次远端 HEAD 和实际隔离 checkout 为 **6d6b7162f122ac0ce1356a14688c8c4f712db3c8**。以下描述针对该 HEAD，不能宣称该提交所有功能都已进入 v4.0.21 安装包。源码位于 `/tmp/tokenflow-usage-ccswitch-20261028`。

- [最新发行版](https://github.com/farion1231/cc-switch/releases/tag/v4.0.21)
- [上游使用说明](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/docs/user-manual/zh/4-proxy/4.4-usage.md)

## 已证实的设计

### 1. 先保存逐请求事实，再做汇总

`proxy_request_logs` 以 request_id 为主键，持久化客户端、provider_id、返回模型、请求模型、计价模型、token 分项及输入语义、费用、耗时/首字、状态、session_id、data_source。查询和归档使用相同有效记录过滤条件。这使修复、重新计价、按来源排查有可重放基础。

- [表结构与索引](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/database/schema.rs#L207)
- [记录器：同 request_id、相同计量语义幂等；不同语义用带 SHA-256 的碰撞键保留](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/proxy/usage/logger.rs#L102)

`session_usage_dedup` 独立保存去重身份，避免明细归档删除后，重扫或 fork 导致旧用量再次计入。`session_log_sync` 保存文件扫描游标；Claude 支持字节偏移与边界指纹检测外部重写。Codex 导入按 1000 条事务分批释放锁，避免导入长历史时长时间阻塞 UI 查询。

- [持久去重与游标表](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/database/schema.rs#L310)
- [Codex 批次与游标](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/session_usage_codex.rs#L1957)

### 2. 明细短期保留、日汇总长期保留，操作原子化

`rollup_and_prune(retain_days)` 在 SAVEPOINT 内先按本地完整日聚合，再删除旧明细。日表保留 app/provider/model/request_model/pricing_model，避免归档后丢失别名与计价映射。边界对齐本地午夜，并处理 DST。查询只有在范围覆盖完整本地日时纳入该日 rollup：归档后无法重建任意小时精度，不应把历史日汇总当逐秒明细。

- [事务归档、完整日边界、字段保留](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/database/dao/usage_rollup.rs#L11)
- [总览组合明细与日汇总](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/usage_stats.rs#L940)

### 3. 本机日志与网关合并，但跨源去重并非都基于精确响应 ID

本机记录导入与代理记录进入同一表，保留 data_source。写入先检查 request_id；跨源还使用 **应用 + 模型 + 输入/输出/缓存计数 + 前后 10 分钟**匹配已成功的代理记录。查询层也使用这一过滤，以处理后到的代理记录。缺失 cache_creation 的部分协议放宽匹配；unknown 模型也有匹配分支。

这比仅看 provider 后排除整份会话更能恢复数据，但并不是严格的一对一身份关联。并行子代理可能在同窗口内产生相同模型、相同 token 数，因此存在不同请求被当成重复的理论风险；本次没有实测该误判。TokenFlow 已有响应 hash 的强证据，不应退回采用该宽松匹配作为正式记账依据；最多作为“疑似重复”提示。

- [去重窗口定义](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/usage_stats.rs#L397)
- [查询层跨源去重条件](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/usage_stats.rs#L479)
- [写入层 DedupKey 和匹配](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/usage_stats.rs#L681)

### 4. Codex 子代理、分叉与压缩单独处理

Codex 导入器识别 `forked_from_id` 和 `source.subagent.thread_spawn.parent_thread_id`；二者冲突会延后导入，父文件缺失/不稳定也有 deferred 状态。父时间线用于消除 fork 继承历史，处理同线程分页与累计高水位。`token_usage_record` 可补充不伴随有效 token_count 的远程压缩用量；中断时清除下一请求计时起点，避免把上次中断时间算到下一轮。

但数据库的请求事实仍主要是 session_id，不等于已经提供完整“父任务—子任务—压缩—重试”成本树。也不应从“日志有 token”直接断言任务成功：Codex 会话导入行在此写入 status_code=200，这是导入器的约定，不是 HTTP 成功的独立证据。

- [父关系验证](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/session_usage_codex.rs#L693)
- [逐响应补记](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/session_usage_codex.rs#L1604)
- [来源、计价与状态落库](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/session_usage_codex.rs#L2293)

### 5. 缓存语义显式保存，费用是估算

CC Switch 保存 `input_token_semantics`，区分含缓存输入与新增输入。汇总统一为非重叠的新增输入、缓存写入、缓存读、输出，因此 real_total=input_fresh+cache_write+cache_read+output。TokenFlow 的 input 已含缓存，当前 input+output 与该公式等价，不能照抄四项直接相加。

成本用 Decimal 分项计算，计价基准单独保存；可按 provider 倍率调整总估价，并识别 Anthropic 5 分钟/1 小时缓存写入价格差异。未知价格在 UI 显示未定价；费用不能替代订阅余额、Credits 或供应商最终账单。计算器按 app_type 推断缓存语义，TokenFlow 的多来源跨协议模型更适合在协议适配边界明确语义，而非仅靠客户端名称。

- [显式 token 语义](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/database/schema.rs#L207)
- [总量与命中率](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/usage_stats.rs#L48)
- [Decimal 成本与缓存 TTL](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/proxy/usage/calculator.rs#L32)

### 6. 展示层比较成熟的部分

全局时间/应用/provider/模型筛选联动总卡、日志、趋势、分组；今天及 24 小时按小时，长周期按日。提供数据来源、同步状态和手动同步。速度将代理实测与会话日志估算分开，实测只纳入输出≥100、生成窗口≥100ms 的请求，避免短工具调用、缓冲突发算出离谱速度；首字用中位数，估算首字另列。

- [页面行为说明](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/docs/user-manual/zh/4-proxy/4.4-usage.md#L40)
- [实测/估算速度口径](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/services/usage_stats.rs#L147)

## 对 TokenFlow 的建议顺序

1. **优先持久化可对账的请求事实**：响应 hash、请求/执行/父子线程身份、来源账号快照、实测/部分/缺失用量状态、输入语义、时间戳；由此派生日汇总，不再只依赖每日计数加近期 1000 条轨迹。SQLite 是适合选项，关键是幂等事务和可重算语义，不是换存储名称本身。
2. **将计量状态独立于请求成败**：失败/取消也可能有已计费 token，成功也可能未知。缺失字段不能都归零；本机记录没有 HTTP 证据时，不硬判成功。这是比加成本图更优先的完整性改进。
3. **保留精确响应去重，不照抄时间窗口猜测**；缺少身份的历史回填先列未关联/疑似重复，不直接并入最终账本。持久身份的寿命应长于明细保留期。
4. **父子任务维度与导入覆盖率**：子代理 token 已计入来源合计，并不等于可展示子代理占比。只有父子关系证据完整时再做任务汇总，并防止把父日志镜像、fork 继承历史重复加进去。
5. **再扩展总览**：一致的时间/来源筛选、小时趋势、数据覆盖与更新时间、来源标签从“本机直连”改为准确的数据来源说明；再提供独立的 API 估价视图，订阅额度和 Credits 不换算成美元实付。

本次没有运行上游自动化测试或使用其桌面程序，因此上述“已证实”指代码路径与表结构事实，不代表所有运行时边界均已验收。
