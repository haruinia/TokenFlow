# Codex 历史投影、压缩与续聊修复验证（2026-10-23）

根据[调研报告](../archive/reports/2026-10-23-codex-continuation-research.md)实施，遵循 diagnosing-bugs：先运行红灯，再建立真实调用链回归，最后实现与复跑。所有模型请求均为本机 loopback 合成供应商；Codex 子进程的 HOME、CODEX_HOME、工作目录均为临时目录。不改真实 Codex 配置、授权或聊天，不结束已有客户端进程，不使用真实账号或付费推理。

## 历史失效与真实分页

`npx tsx scripts/research-codex-rollout-projection.mts` 修复前退出 1：406 字节缩至 252 字节，staleOffsetBeyondEOF=true，四张历史投影表均仍保留回退 rollout ID 的旧偏移。修复后退出 0：remainingStaleProjections=[]，staleOffsetBeyondEOF=false。

codex-context.ts 现在按文件名的 immutable rollout ID 使变更文件投影失效，覆盖分页源与发生边界变化的依赖文件。无法识别文件名的旧记录仍用逻辑 ID；逻辑 ID 若不代表独立祖先文件，也清理其旧索引。历史文件、消息、ordinal 和快照备份全部保留。

真实分页额外发现：回退文件逻辑 ID 同时可能就是未改写祖先的 immutable ID。盲删两类 ID 会误删祖先投影，让最早轮次不再展示。实现为精确识别祖先并保留其独立投影；新增回归，不能仅凭四张表清空宣称分页成功。

对旧版本已经改写过的历史，若投影字节位置超过 EOF，或与明确的 next ordinal 边界不符，也会备份并使相关派生记录失效。即使本轮无需再改写 JSONL，也可修复旧偏移；不猜测没有 ordinal 证据的位置。不存在的 Codex HOME 视为空历史。

`tests/fixtures/codex/thread-history-schema.sql` 来自已安装 Codex 的表定义，仅有 schema，没有用户数据。回归覆盖四表、immutable/逻辑 ID、已有坏偏移、保留祖先、分页依赖、非零 ordinal、多次回退、原始备份、重试与缺失 HOME。

## 压缩：完整提取一次，完整合并一次

旧实现会把提取出的短摘要再次按旧/中/近期三段拆分，多轮重复保留细节提示。现保留原始完整分块、最多四路提取、稳定分组与已完成缓存；最终合并一次看到全部提取结果，并给明确 UTF-8 字节目标、去重与任务关键事实保留要求。

约 2.5 MB、七组确定性回归：全部原文逐字符抵达提取调用，恰好七次提取加一次合并，共八次；合并输入含七块唯一事实。重启后提取和合并均复用持久缓存。保留真实容量错误后的无损细分；最终合并若遇容量拒绝，保留提取结果和缓存，不丢输入、不截断、不付费递归。无法继续缩小时保留较短的完整结果。

这证明调度减少，不代表真实供应商对原对话已测得八次或固定分钟数。未用 mock 评估真实历史事实保留质量；真实付费摘要质量和耗时仍需验证。

## 持续压缩的结构证据

新增 ContextOptions.onContextObservation，由 context-observation.ts 产生结构记录，服务层接入脱敏轨迹 context 数组：inference/summary 阶段、来源 context window；request/instructions/input/非指令 history/tools 的 JSON UTF-8 字节大小与数量；白名单原始数字 usage（含缓存和 reasoning）；终结 status、output 类型、已识别错误码。

各字段为各自编码大小，不能相加当精确 Token 数。不保存正文、工具定义/参数、任意 usage 扩展字段或认证信息。合成“压缩→普通工具→压缩”闭环中，tools 超过 230 KiB、压缩后 history 不到 16 KiB，来源仍报告 input_tokens=246189；客户端收到的 inclusive input 与缓存不变，记录能区分两种开销。

这为真实来源复现提供证据，不提高 244800 阈值，不扣 cached tokens，不截断工具。用户原外部 API 请求结构未保存，不能把合成工具例子认定为原故障原因。其他来源的 usage 归一化修复与证据由协议测试单独覆盖。

## 断流明确失败

新增红灯：response.completed 的 response 缺失/null、output 缺失/含 null、status 仍为 in_progress。旧实现抛错断开转发流，现发 invalid_terminal_response 错误事件并调用错误回调；缺终结的 EOF 发 incomplete_stream 并记录错误。失败不持久化为成功历史，终结后的帧不再写入成功记录。

用户当时原始失败 SSE 未保留，只能证明这些模式的错误传递已修复，不能声称上游 503、所有缺 completed 或所有 invalid terminal 已消除。

## 验证命令与结果

```sh
npx vitest run tests/codex-context.test.ts tests/initial-compaction.test.ts \
  tests/gateway-context.test.ts tests/gateway-summary-budget.test.ts \
  tests/context-summary.test.ts tests/gateway-context-replay.test.ts \
  tests/gateway-context-usage.test.ts tests/gateway-context-service.test.ts \
  tests/codex-accounts-service.test.ts
```

九文件、122 项通过。codex-accounts-service 覆盖 history compatibility 开/关，不存在目录不再导致 500。git diff --check 通过。早期全仓 typecheck 通过；最终复跑曾被并行新增 scripts/probe-cursor-local-model.ts 类型错误阻断，已反馈所有者，不把该次检查记为通过。

```sh
node --import tsx scripts/codex-context-migration-smoke.mjs \
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  --remote-compaction --rollback-history --long-recovery --repeat-gateway --projection-pages
```

真实已安装 Codex 0.163.0-alpha.11.2 通过，132 次 loopback 合成请求：

- 原始来源→网关→换网关模型→原始来源→再次网关→再次原始来源；多次停止/重启专属测试子进程。
- 长历史、三次原始压缩、网关重复压缩、工具和最近进展保留，回退内容不复活。
- 迁移前建立真实分页缓存；迁移后 thread/turns/list 与 thread/items/list 按两条一页遍历，显示七轮、104 条 item，最早请求与保留分支可见。
- 人为上游 400 产生真实 failed turn，thread/fork.beforeTurnId 从失败前分支并继续成功；失败轮不进新分支，失败前最近进展保留。

npm 安装 Codex 0.154.0 也通过跨来源、长历史、重复压缩、回退、重启验证（未启用新分页 API），130 次合成请求。尚未在用户原真实对话点击编辑/分支或调用真实官方账户，mock 成功不能代替这些验收。官方/第三方同菜单共存的追加验证完成后补充于本文。

## 共存模型与认证分流追加验证

codex-thread-migration.ts 新增回归先红后绿：首次 prepare 的 nextModel、execute、后续 provider repair、后来新增官方会话，均在 allowedModels 包含现模型时保留其模型；provider 仍统一为 token_flow。该文件 30 项测试通过。

```sh
npx tsx scripts/codex-coexist-smoke.mts \
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
```

真实 0.163.0-alpha.11.2 与实际 createDesktopService、合成 sidecar、隔离 HOME、合成 ChatGPT JWT/catalog 通过：

- model/list 同时展示官方与网关模型；token_flow 使用 requires_openai_auth=true、x-tokenflow-client-key，无 experimental_bearer_token。
- 实际服务分流顺序 gateway→official→gateway→重启后 official→合成官方 400 failed turn→失败前 fork 后 gateway。
- thread/turns/list 与 thread/items/list 两条一页完整读取五轮、九条 item；最早输入及模型切换进展保留，失败轮不进入新分支。
- 官方 fetch 收到合成 ChatGPT Authorization 与 account header，不含网关客户端 Key；第三方 sidecar 未收到 ChatGPT Authorization 或网关客户端 Key。原合成 auth.json 逐字不变。
- 所有非 loopback 的真实 fetch 均被测试保护拒绝，官方请求由注入 fetcher 验证固定 host 后本地合成返回，没有使用真实官方账号。

fixture 显式等待 UsageAttribution.enable 后再读取配置 revision，避免 listen 的异步 recorder 配置写入与预览版本竞态。最终 npm run typecheck 与 git diff --check 再次通过。

此初次共存验证使用短历史；网关 tfctx1 压缩后直接切官方的转换边界需单独验证，已向服务层所有者反馈，不能由短历史通过推断该场景通过。

## 原生官方请求的受限便携恢复

`CodexContext.forOfficial(body, scopes)` 仅处理 tfctx1 compaction 与 resp_tf previous_response_id。通过已认证 checkpoint 的 coveredUsers 排除被摘要覆盖、由客户端重新前置的旧用户消息；保留新规则、新用户请求及 checkpoint 后原生条目，检查点替换整个已覆盖窗口。存储的网关 previous response 若又包含私有 checkpoint，也会展开；无法恢复时失败并保留历史。正文没有私有引用时原样返回，原生官方 compaction、reasoning、item IDs 与 native previous_response_id 不会被普遍归一化。

三个回归先红后绿，覆盖真实网关 compact 产生的 authenticated coverage、fresh instructions、原生后缀、网关 previous response、存储 compaction response 的嵌套引用与损坏/缺失记录。服务层官方分流在发送前调用此接口；不会把 tfctx 私有密文伪装成官方密文。

最终扩大的相关检查共 11 文件、181 项通过，npm run typecheck 通过。额外保留旧回归语义：若第一轮摘要已比原文更长，不再付费做最终合并；有缩减且仍超目标时最多合并一次。

### 强制 remote 检查点后切官方：实机通过

```sh
npx tsx scripts/codex-coexist-smoke.mts \
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --compact-before-official
```

Codex 0.163 通过，gatewayCompactionBeforeOfficial=true、privateGatewayReferencesObserved=true：客户端确实在官方模型请求入口发送 tfctx 检查点，注入的官方端明确拒收 tfctx / resp_tf 引用，服务层恢复后通过。六次模型请求仍为 gateway→official→gateway→重启 official→失败 official→失败前分支 gateway，分页六轮、十条 item，原认证文件逐字保留。

此模式通过与既有 migration smoke 相同的 CLI provider.name=OpenAI override 强制 remote compaction，再用 thread/compact/start 显式压缩；用于覆盖 remote/旧版私有检查点，并不声称当前默认 custom-provider 文本压缩总会产生私有密文。等待 turn/completed 后才能发下一轮；item/completed 仍可能处于 active Compact 状态。

真实请求首次还揭示新 /codex/v1 入口遗漏 zstd 解压：Codex 返回 Content-Length 不匹配。服务所有者已扩展 gateway-decoding 匹配两个入口并补回归，修复后本轮实机通过。短历史 fixture 最终改为等待 onListen 的 recorder 配置已写入后再读 revision，避免并发调用 enable 本身竞争同一个临时文件。

上述祖先投影损伤边界随后由独立红灯复现，并按下一节通过 Codex 原生投影器修复；原始 JSONL 与备份未删除。


## 旧版本已删除祖先投影：原生全链重建

先运行独立红灯：warm 真实分页后，夹具仅删除逻辑祖先 ID 在四张派生表中的记录，保留原始 JSONL；原修复只能重建当前 delta，`TURN_ONE_MARKER` 不再可见，命令稳定失败。

读取官方固定源码后确认：[paginated_fork.rs](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/thread-store/src/local/paginated_fork.rs#L52) 的 ThroughTurn/BeforeTurn boundary 会逐个 materialize 祖先再投影 leaf，Latest 则不会；[thread_processor.rs](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/request_processors/thread_processor.rs#L5406) 支持 ephemeral+excludeTurns 的无持久分支。

新增 codex-projection-repair.ts：仅在已退出 Codex 的授权迁移生命周期内，检测到缺失或将失效的祖先投影，先保留数据库备份与历史快照，再启动专属官方 runtime，通过合法 lastTurnId 的 ephemeral fork 让官方投影器重建全链。随后 unsubscribe 并关闭该专属 runtime，验证各祖先投影覆盖准确的继承 cutoff，next byte offset 与明确的 ordinal 边界一致。无 turn/start，没有从旧备份拼凑不完整 projection；模型、工具与原对话内容不进入推理请求。其他 Codex 进程重新出现或校验失败时停止并保留备份。

```sh
node --import tsx scripts/codex-context-migration-smoke.mjs \
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  --remote-compaction --rollback-history --long-recovery --repeat-gateway \
  --projection-pages --prior-projection-damage
```

红灯转绿：7 turn、104 item、132 次合成请求；最早用户、回退后保留分支可见，被回退内容不复活，真实失败前 fork 后继续成功。额外断言：原始祖先文件 SHA-256 不变；修复前后 state 数据库线程数不变；修复区间没有增加上游模型请求。

再追加 `--already-rewritten-before-damage`，先完成历史改写与子投影失效，再删祖先派生表，形成历史无需再次改写、祖先与子投影都缺失的状态。相同实机流程通过，migrated=0 而历史展示与分支恢复，证明派生索引修复不依赖再改写原始历史或复制旧数据库。

新增 helper 的 4 项离线回归通过：只发送 ephemeral ThroughTurn fork/unsubscribe；活跃进程阻断；缺失、未覆盖 cutoff、字节/ordinal 不对齐都失败而非伪造恢复。连同此前 11 文件 181 项，相关回归累计 185 项通过。最终全仓测试和安装验收由主任务记录。
