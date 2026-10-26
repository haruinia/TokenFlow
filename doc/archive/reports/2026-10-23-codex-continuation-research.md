# Codex 续聊、压缩与客户端兼容调研（2026-10-23）

本轮按用户要求先调查、后决定实现。未修改产品运行代码、真实 Codex 会话/配置、登录状态或安装应用。新增研究文档和隔离诊断夹具；Antigravity 的小量真实协议对照由用户明确要求，详见单独报告。子代理按用户追加要求使用 GPT-6.1 Sol / high。

基线：仓库 `4149f08`；安装应用 `10.15.26.55`。安装包并未包含该提交的凭证读取改动。下文时间同时说明 UTC 与本机 PDT（UTC−7），不把轮次总耗时当成压缩耗时，不把 immutable rollout ID 当成逻辑对话 ID。

## 结论及后续顺序

优先修 Codex 续聊的历史投影一致性，再处理摘要反复归并、压缩后立即再次触发、失败流结束事件。坏 TOML 的可恢复覆盖、Claude 插件误拦和 Antigravity 参数兼容可独立处理。官方/第三方同菜单共存先保留研究结论，遵照用户要求等续聊稳定后再实现。

| 用户问题 | 本轮结论 | 证据边界 |
| --- | --- | --- |
| 1. 503 后切模型断流、不能编辑/分支、首次整理约 20 分钟 | 实际错误和长整理均找到；另复现历史改写后未清理 rollout-ID 投影的缺陷。首次整理为 7 个分块、最多 4 路并发，随后 4 轮归并，共 19 次摘要调用。 | 未重放原始失败 SSE；不能断言所有断流、编辑故障都是同一原因。 |
| 2. 仅 Claude Code VS Code 插件也能应用 | 可以；扩展自带运行时，独立 CLI 安装检测误挡共享配置应用。 | 远端 VS Code / 自定义目录须单独识别。 |
| 3. 应用内下载/更新 | 部分 npm 客户端已支持；桌面安装渠道目前只跳官网，可按渠道逐项增加。 | 检测新版本不等于已有可靠安装/更新实现。 |
| 4. 外部工具导致坏 TOML 后覆盖 | 当前 apply 与恢复都先 parse 坏文本，确实无法恢复；应备份坏文件后从合法基底重建。 | 未把用户当前配置直接覆盖来测试；不能认定重复表必然由 CC Switch 写出。 |
| 5. 导入 CC Switch 等供应商 | 可做选择性导入；当前 CC Switch 主格式为 SQLite，导出为 SQL，认证能力不能仅靠复制供应商行。 | 先支持 URL、协议、Key、模型，不盲导入 OAuth、脚本和整库配置。 |
| 6. 官方账号与第三方模型共存 | Codex 提供目录和网关机制；当前 CC Switch 上游通过目录合并及逐模型分流实现。TokenFlow 当前尚未完整实现。 | 保留 auth.json、多个 provider、同菜单聚合是三件事；源码能力不等于用户桌面实机通过。 |
| 7. 使用前置、已保存改供应商 | 调整现有两组渲染顺序及标题即可，不需新增界面效果。 | 本轮未改 UI；Claude Desktop 入口继续保留。 |
| 8. 持续压缩 | 找到 11 次压缩循环：压缩后普通调用仍超过客户端 244800 Token 触发线。 | 已确认触发链；固定工具定义与上游 Token 口径各占多少尚缺原始请求结构统计。 |
| 9. Grok 4.7 | 08:09 两次真实 model-not-found；4.6 随后成功。首要候选为目录默认 500k 与 local SDK 运行能力不一致。 | 官方论坛有同版本一手复现；本机未记录原始 params，不能定案。 |
| 10. 重启后网关对话不展示 | 已找到真实历史投影错误；官方 thread/list 也有 provider 默认过滤机制。当前核查的逻辑会话及原始历史仍在。 | 未证明桌面实际使用默认 provider 过滤，也未复现 UI 列表隐藏，不能称对话已被删除。 |
| 11. Antigravity Claude 400 | 长历史+工具可成功；单变量复现工具名含句点，以及格式合法但签名无效的 thinking 两类 400，均被现有错误映射抹成同一泛化提示。 | 原用户 6 条 400 未保留具体参数路径，不能指定其中一类就是原始根因。 |
| 12. 重复密码读取 | 源码已合并 Claude 并发读取、复用 Qoder helper；7 个 mock 测试通过。当前安装包仍是旧实现。 | 未做真实 Keychain 弹窗计数；跨安全存储、跨签名不能承诺只授权一次。 |

问题 2–7 及 10 的官方源码依据见[客户端能力报告](2026-10-23-client-capabilities-research.md)；问题 9/12 见[Cursor 与凭证报告](2026-10-23-cursor-credentials-research.md)；问题 11 见[Antigravity 报告](2026-10-23-antigravity-claude-research.md)。

## 1. 那次接近 20 分钟的首次整理

定位到逻辑对话 `01a166db-53df-7262-97db-8fe8af8125a8`（界面标题“对比 GAN KINT view 进度”），原始历史文件位于 `~/.codex/sessions/2026/10/22/`。它从官方模型进入 `qoder/gmodel` 后：

- 01:52:43.178 PDT（08:52:43.178 UTC）：任务开始。
- 01:52:48.480：持久分组计划建立，旧历史共 **2,525,803 UTF-8 字节**，7 组。
- 02:10:28.846：首次检查点进入 Codex，共 **17 分 45.668 秒**；02:10:33.397 已有普通工具调用。
- 02:12:25.025：又完成一次 Codex 自己发起的压缩。因此从首次任务到第二次压缩完成约 **19 分 42 秒**，符合用户“约二十分钟”的感受；但末段包含普通调用，不能全部算成首次摘要。

通过本机持久计划与逐块摘要缓存，在内存解码后只输出分组字节数、时间及长度，未输出旧对话正文。缓存键逐一匹配当前摘要请求格式，得到下表：

| 阶段 | 摘要调用数 | 摘要合计字节 | 最后一块完成时间 UTC |
| --- | ---: | ---: | --- |
| 原始历史 7 组 | 7 | 55,774 | 08:57:54.118 |
| 归并第 1 轮 | 3 | 30,944 | 09:00:23.755 |
| 归并第 2 轮 | 3 | 27,881 | 09:04:14.892 |
| 归并第 3 轮 | 3 | 27,132 | 09:06:55.179 |
| 归并第 4 轮 | 3 | 27,695 | 09:09:45.874 |

**确认：不是所有分块串行。** 初始 `initialParallel` 最多 4 个 worker；Cursor 特例为 1。第 2/3 组早于第 1 组完成，也符合并行。轮与轮之间有数据依赖，必须等上一轮输出；该样本 19 次调用中，后 12 次都在摘要归并。最后一轮变长，代码按“不再缩小”退出，保留上一轮较短结果，并未无限循环。

依据：[initial-compaction.ts](../../../packages/core/src/initial-compaction.ts#L35)、[gateway-context.ts](../../../packages/core/src/gateway-context.ts#L545)。当前首次整理会把合并后的短文本再次按 50%/30%/20%分成三组，分别继续要求保留细节；未给最终合并单独的压缩任务或输出目标。这解释了本次越到后面收益越小、每轮仍耗时数分钟。常规远程压缩另有 48 KiB 串行分块路径，但此案例的首次整理走的是 initial 路径，不应混称“串行压缩”。

**建议后续验证：** 保留完整旧历史分块和已完成缓存；把“完整历史提取”与“最终合并”分开，用单次有明确目标的最终合并对照当前多轮三段归并，记录缩减率、延迟、事实保留和失败可恢复性。不建议简单增加并发、截断旧历史或仅把等待提示改得更热闹。

## 8. 一直上下文压缩的另一条对话

对话 `01a16924-9170-7b83-87f4-e6e8d0fd8af2`（“运行两道截图编程题并检查体验”）使用 API 来源的 `anti_claude-opus-5`。07:54:34.896–08:09:42.995 PDT 的同一轮约 15 分钟内有 **11 次 compacted**，每次之间又有普通模型/工具步骤。

Codex 本机 `logs_2.sqlite` 的 `codex_core::session::turn` 记录：

- `auto_compact_scope_limit=244800`；`full_context_window_limit=258400`。
- 每次普通调用后的 `auto_compact_scope_tokens` 为 246189–248587，全部 `token_limit_reached=true`。
- 下一次再压缩；随后普通调用又越线，形成反馈循环。

网关保留的轨迹进一步区分：摘要请求约 18k–21k 输入 Token，而普通工具调用约 244k–245k 输入 Token；不是把所有调用都视为普通回答。压缩后的 replacement_history 只有 4–5 条，JSON 约 43–47 KiB，且没有持续累积旧摘要。当前配置明确使用 Codex 自己的 custom-provider compaction（`agent-connections.ts:368`），这批也没有网关 CompactionReport，因此不能套用先前已修复的“159 条旧摘要叠加”原因。

**确认到触发链，不越界归因：** 普通调用的固定开销/工具定义或者上游 Token 统计使回到 244800 以下的余量太小。原始工具定义和上游原始 usage 未完整保存，尚不能准确拆分贡献，也不能断言供应商虚报 Token。缓存命中仍属于上下文占用，不能通过扣掉 cached_tokens 假装压缩成功。

后续应先记录脱敏的 instructions/history/tools 各自字节数、当前模型真实 context 能力、上游 usage 原始字段；重放“压缩→一次工具→再次触发”闭环。验证有效余量及压缩收益，再决定按真实能力调整目录或工具传递方式。不能仅抬高阈值隐藏循环。OpenAI 官方也要求压缩请求的输入仍在模型窗口内：[Compaction 文档](https://developers.openai.com/api/docs/guides/compaction)。

## 1/10. 失败、编辑/分支与历史显示

### 实际失败时间线

在“对比 GAN KINT view 进度”的当前回退记录中找到：

| 时间 PDT | 模型 | 结果 |
| --- | --- | --- |
| 06:57:51、07:08:41、07:10:58 | Qoder | 503，来源暂不可接收；保留的后续轨迹含 `source_cooldown`。 |
| 07:17:58、07:18:32 | 切换后的 API DeepSeek 路由 | `stream closed before response.completed`。 |
| 07:24:03（另一新对话） | API DeepSeek 路由 | `Source returned an invalid terminal response`，此前 Codex 做了 5 次重试。 |

另有 Qoder `gfmodel/gmodel/kmodel_latest` 的真实 429 `qoder_capacity_wait_exhausted`。503、429、缺少流结束事件和结构无效的结束响应应分开统计；某次新会话成功不能证明旧会话的问题只是网络。`upstream-errors.ts:91` 的 `source_cooldown` 是对 `auth_unavailable`/cooling-down 的分类，不能由它反推出原始失败必然是密码失效。

网关 `gateway-context.ts:369` 会验证终结对象必须有 output 数组和 completed/incomplete 状态；流 EOF 无终结事件会发 incomplete_stream。上述原始失败响应未留存，故目前不能指出是哪一个字段缺失、哪个适配器先关闭。应在后续重现中只保存事件类型、状态、output 类型和错误路径，不落提示词/密钥；不要补一个假 completed 冒充成功。

### 已复现的历史投影失效缺陷

Codex 的逻辑对话 ID 与回退后的 immutable rollout ID 不同。例如逻辑对话 `01a166db-…` 当前文件名为 `rollout-…-01a166db-…_01a1682d-….jsonl`。`state_5.sqlite.threads` 按前者记录会话；`thread_history_1.sqlite` 的四张历史投影表按后者保存索引与字节偏移。

TokenFlow 改写历史时正确保留了记录序号，但 `codex-context.ts:250` 从 `session_meta.payload.id` 收集待失效 ID，随后 `:278-281` 按这个逻辑 ID 删除投影。回退记录的 rollout-ID 投影因而没有清掉。

隔离诊断夹具（仅合成历史与临时 SQLite，无模型请求、无用户数据修改）运行结果：

```text
rewritten=1; beforeBytes=406; afterBytes=252; staleOffsetBeyondEOF=true
remainingStaleProjections=thread_turns,thread_items,thread_history_projection_state,thread_realtime_items
FAIL: rollout-ID projections survive logical-ID invalidation
```

实际数据只读核对也吻合：

| rollout ID 前缀 | 当前文件字节数 | 缓存 next_rollout_byte_offset | JSON 行/ordinal |
| --- | ---: | ---: | --- |
| 01a1682d | 10,755,688 | 10,756,417 | 全部合法、连续 |
| 01a167fe | 954,610 | 955,469 | 全部合法、连续 |

Codex 同时记有 `durable rollout shrank before projection`、`skipping malformed rollout line during projection`、缺失 ordinal 范围。当前文件没有坏 JSON 行，这里“malformed”是从旧偏移进入新文件中间造成的强证据。报告保留为“已复现缓存失效缺陷 + 与实际错误吻合”；未实际点击原故障编辑/分支，缺少该 RPC 的失败日志，尚不能宣称这个单点解释全部 UI 症状。

复跑：`npx tsx scripts/research-codex-rollout-projection.mts`。在当前基线上应退出 1；它是诊断的红灯，不是测试设施故障。修复验收应同时覆盖逻辑 ID 与回退/分支 rollout ID、分页读取、重启、编辑、从失败前分支，并确保只使相关派生缓存失效、原始历史和新消息保留。

### 重启后看不到的边界

核查的逻辑会话仍存在于当前 state 数据库，原始历史也仍在。此前“回退记录 ID 不在 threads 中”的现象本身正常，不能当成数据删除。

另有独立的官方列表机制：普通 `thread/list` 不传 modelProviders 时默认筛当前 provider；显式 `[]` 才跨 provider（仍受归档、项目等过滤）。因此官方/网关切换可能让未迁移路由的会话暂不显示，但本轮没有取得桌面实际列表请求，不能定案为过滤问题。[官方源码 thread_processor.rs:5995](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/request_processors/thread_processor.rs#L5995)。

后续验收应分别核对 state 逻辑会话、rollout 历史、派生投影、thread/list 参数和 UI；不能通过恢复旧数据库或删除对话来让列表“看起来正常”。

## 本轮验证与保留限制

- 只读检查 Codex 本机 SQLite、相关会话事件、TokenFlow 轨迹及持久摘要缓存，输出结构/时间/计数，报告不包含密钥和聊天正文。
- 历史投影隔离夹具稳定失败，确认当前代码缺口；未实施修复。
- 凭证 2 个测试文件、7 项通过，属于 mock 验证。
- Antigravity 真实对照见分报告；不把成功的合成历史当成用户原始失败已修复。
- gateway-traces 只保留最近 1000 条，早上首次整理请求已被滚动淘汰。19 次摘要结论来自逐条缓存键匹配与文件时间、会话事件，而非假定仍有完整网络日志。
- 未重装、未导出新包、未提交 Git；本轮研究资料留在工作区供决定修复时使用。
