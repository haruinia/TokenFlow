# Antigravity Claude Code 400 调研（2026-10-23）

状态：完成首轮源码、官方仓库对照和 14 个低输出真实请求。没有修改产品代码、用户配置、上游 checkout 或打包。**已复现两种会被当前网关折叠成相同通用 400 的具体错误，但未确认哪一种导致原用户会话失败。**

## 结论与边界

1. **已确认：无状态长历史与工具本身可以工作。** 同一本机 sidecar 的 Claude 请求携带 80 轮合成工具历史、321 条 messages、179,778 字节请求、47,365 输入 token，streaming 正常结束并产生工具调用。60 轮约 31k 输入 token 也成功。因此不能将现象直接归结为“Antigravity Claude 不支持长对话/工具”。这也不证明所有长历史形状、账号或并行负载都正常。
2. **已复现：工具名字符集不匹配。** 只把 `mcp__fixture.read` 改成 `mcp__fixture_read`，相同简单 schema 从 400 变为 200。真实上游路径为 `tools.0.custom.name`。当前 Gemini 名称清理器保留 `.` 和 `:`，Claude 后端这次明确只接受字母、数字、下划线、连字符。原会话是否有这种名称，现存脱敏轨迹无法确认。
3. **已复现：结构仍可识别、但实际校验失败的 thinking 签名可以穿过本地检查后触发 400。** 从真实 Claude 工具响应取得签名，只改其中一个字符后回传，得到 `messages.1.content.0: Invalid \`signature\` in \`thinking\` block`。未修改的原生签名工具回传此前成功；明显无效的普通字符串签名会被清理后成功。这三类不能混为一谈。此次损坏是测试人为制造，**不是原会话签名损坏的证据**；也没有测试跨天/过期签名。
4. **已确认：现有网关丢失了区分上述原因的诊断信息。** 两类真实原始错误经过 `upstreamError()` 离线处理，都变成用户所见的 `upstream_invalid_request` 通用中文提示，不带参数路径。原始字段路径嵌在 message 内，未作为独立 `error.param` 返回。
5. **代码推断：最新官方上游还有 Claude 专用 schema 与工具结果 turn 修正，值得针对真实失败形状复核。** 本轮两种 nested union schema 均得到 200，未复现 schema 错误。不能据此直接整体升级或认定 schema 就是原根因。

## 证据与实测方式

- 原用户现象：`antigravity/claude-opus-4-6-thinking` 在 Claude Code 持续对话、工具后出现通用 400，简单问答可用；`antigravity/gemini-3.8-flash-high` 可用。
- 只读取 profile 的字段白名单。`gateway-traces.json` 当前 1,000 条记录中有 358 条 Antigravity：328×200、6×400、10×429、7×499、1×500、6×503。6 个 400 均为 Claude 的 `messages` 协议，时间为 2026-10-23 15:18:30/48/52Z 与 16:27:28/43/46Z；它们已只剩通用错误，不能恢复原始上游消息。对应工具结果计数为 1/4/0、1/5/0，不能从计数推出坏字段。`gateway-response-evidence.jsonl` 全是 64 位十六进制摘要，不是请求/错误原文。
- 使用现有本机 sidecar `127.0.0.1:8317/v1/messages` 直接测试，绕过 TokenFlow 的友好错误泛化层。认证值仅在进程内存中读取和使用，没有输出、写入临时文件或提交。没有复制 refresh token、主动刷新授权、执行模型输出工具，或给其他人发消息。
- 未启动最初设想的独立 sidecar：为满足秘密只留内存的约束，复用了现有 sidecar；未重启服务、改现有配置或启用原始请求日志。此方式无法保证其他并发请求不影响账号路由；没有固定账号，不能宣称所有账号均通过。
- 请求只有合成历史，无用户真实对话；未提供 session/header 会话标识，所有历史显式放进 messages。Anthropic 官方说明 Messages 支持这种无状态多轮方式：[Create a Message](https://platform.claude.com/docs/en/api/messages/create)。Antigravity executor 内部仍可能生成供应商 session 元数据，此处“无状态”指客户端没有依赖会话续接 API。
- 每次最长 60 秒，串行，总计 14 个推理请求；`max_tokens=2048`、`thinking.budget_tokens=1024`。没有负载压测、200k 上下文或完整 Claude Code 系统提示重放。
- 活跃进程来自 `/Applications/TokenFlow.app/Contents/Resources/sidecars/darwin-arm64/cliproxyapi`，与仓库 `sidecars/darwin-arm64/cliproxyapi` SHA-256 相同：`4e726ab6fd508cd604fdcd9b125c6646e42b7dd7617cfa8c5b55b96a56380fe5`。二进制自报 dev/Commit none，不能仅凭元信息证明它对应 checkout 的每一项现存改动。
- `/v1/models` 确认带/不带 `antigravity/` 的上述两个模型均 `owned_by=antigravity`。

| 测试 | 协议/输入规模 | 结果 |
|---|---|---|
| simple_qa | 非流式，1 message | 200，end_turn |
| short_tool | 非流式，1 工具 | 200，thinking + tool_use |
| native_thinking_tool_roundtrip | 原生 thinking/signature 与 tool_result，5 messages | 200，end_turn |
| long_history_60_tool | 241 messages，119,213 B，31,201 输入 token | 200，tool_use |
| invalid_old_thinking_tool | 普通无效签名字符串 + 工具历史 | 200，坏 thinking 被清理；不能用此证明真实坏签名会被清理 |
| gemini_long_history_60_tool | 同 60 轮历史，27,474 输入 token | 200，tool_use |
| complex_tool_name_schema | 句点工具名 + 较复杂 schema | 400，tools.0.custom.name |
| prefixed_streaming_80_tool_history | antigravity/ 前缀，321 messages，47,365 输入 token | 200，message_stop，thinking + tool_use |
| dot_name_simple_schema | `mcp__fixture.read`，简单 schema | 400，tools.0.custom.name |
| underscore_name_simple_schema | 只把上述句点换下划线 | 200，tool_use |
| nested_multi_branch_schema | object/object 的 nested anyOf | 200，tool_use |
| native_signature_seed | 取得真实 thinking + tool_use | 200，tool_use |
| tampered_structural_signature_tool | 真实签名中部仅改 1 字符，再回传工具结果 | 400，messages.1.content.0 |
| mixed_type_nested_union | string/object/object/null 的 nested anyOf | 200，tool_use |

实测时间约为 2026-10-24 01:47–01:54 UTC。仅保留元数据与脱敏错误，临时 harness 和结果在 `.tmp/research-antigravity/`，没有保留任何真实签名内容。临时脚本 `probe.mjs`、`followup.mjs`、`name-schema.mjs`、`signature.mjs` 若重新运行会消耗额度；不能将其自动纳入测试。

## 原始上游错误样本

直接 sidecar 返回外层 Anthropic error，其 `error.message` 又是 JSON 字符串；以下只展开内层，省略 request_id，参数路径与错误原文不改。

```json
{"type":"error","error":{"type":"invalid_request_error","message":"tools.0.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'"}}
```

```json
{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}
```

同样的原始响应经当前 `packages/core/src/upstream-errors.ts:83-88` 后，两者都得到：

```json
{"code":"upstream_invalid_request","type":"invalid_request_error","message":"上游拒绝了请求格式或参数。请保留此错误用于排查协议兼容性；切换账号或修改 DNS 不能修复参数错误。"}
```

这里不是根据友好文案猜测错误类别，而是实际保留了供应商字段路径。当前函数虽然在 `:59-65` 展开嵌套 JSON，但 `:84-88` 只保留白名单内的独立 `error.param`，不会解析 message 开头的路径；即使给出 `tools.0.custom.name`，白名单也暂未包含 `custom`。

## 本地转换与自定义补丁

本地 upstream HEAD 是 `d198db54d4c4886c99b21488d54fc576933019a3`，checkout 有任务开始前已经存在的维护改动，本调研未改动它们。

- Claude 入站转换：[antigravity_claude_request.go](../../../upstream/CLIProxyAPI/internal/translator/antigravity/claude/antigravity_claude_request.go) `:568-569` 将历史 tool_use 名称映射，`:627-648` 由 tool_use_id 找回 tool_result 对应名称，`:805-815` 将工具 `input_schema` 清理后改为 `parametersJsonSchema`，并走同一个名称映射。
- 名称规则：`upstream/CLIProxyAPI/internal/util/util.go:18-24` 的正则为 `[^a-zA-Z0-9_.:-]`，上限 64；这保留了本次 Claude 后端拒绝的句点。`internal/util/translator.go:290-333` 还处理清理后的名称碰撞，后续若改规则，必须连声明、tool_choice、历史调用/结果和响应反映射一起验证，不能只替换声明字符串。[固定 pin 源码](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/internal/util/util.go#L18-L54)。
- thinking：`internal/runtime/executor/antigravity_executor.go:782-806` 先清理非 Claude/空签名；Claude 与 Gemini 走不同路径。`antigravity_claude_request.go:61-92` 优先使用客户端携带的签名，显式提供坏签名时不退回 recovery cache。`internal/signature/provider_compatibility.go:364-381` 校验供应商类型和已知 protobuf 结构后归一化为 Antigravity 要求的 R 格式；该检查不能证明供应商的加密校验一定通过。[固定 pin 源码](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/internal/signature/provider_compatibility.go#L364-L381)。
- 响应签名：`antigravity_claude_response.go:28-56` 将 R 双层值解成客户端使用的 E 层，再由请求转换重建；本轮原生签名往返成功，不支持“这一往返总是损坏”的判断。
- 最终请求：`internal/runtime/executor/antigravity_executor_request.go:70-85` 在 Claude 路径再次清理 schema，使用 VALIDATED 工具模式。Claude 即使客户端非流式也走 `antigravity_executor_execute.go:261` 起的 Claude 特殊分支；上游错误在 `:390` 用 `newAntigravityStatusErr` 原文返回，定义在 `antigravity_executor_credits.go:336-342`。
- 当前维护补丁：`scripts/sidecar-overlay.mjs:37-45` 只把 inference 的 `httpClient.Do` 换为 `antigravityDoWithReconnect`；`patches/cliproxy/antigravity_reconnect.go:15-35` 仅在预响应 EOF、可重放且未取消时重连一次，**不重试 HTTP 400，不改请求参数**。现有 `patches/cliproxy/upstream.patch`/checkout 的传输池和 JSON 批量编辑维护不是已证实的本次 400 根因。
- 原始错误不可追溯原因：`packages/core/src/cliproxy.ts:179` 默认 `debug: false`、`logging-to-file: false`、`request-log: false`。本轮没有改变这些设置。

## 联网核实：最新官方仓库与本地 pin 的区别

2026-10-24 UTC，通过官方 GitHub 页面和临时 bare git fetch 交叉核实，官方 main HEAD 为 `8289ec4c71ad914d0612c2776352b76ba3d355a6`。使用独立 `.tmp/research-antigravity/remote.git`，未 fetch/reset 本地 upstream checkout。raw.githubusercontent.com 的本机 TLS 请求失败，改用 GitHub git transport 获得对应版本完整原文，未把网络失败当作源码不存在。

1. **新增 Claude 专用 union 清理（代码事实，当前样本未复现其对应错误）。** 最新 `internal/util/gemini_schema.go:64-80` 新增 `CleanJSONSchemaForAntigravityClaudeTool`；`internal/runtime/executor/antigravity_executor_request.go:176-181,229-237` 按模型只对 Claude 参数 schema 应用。上游注释认为其后端转换 custom.input_schema 时会拒绝某些 nested 多分支 union；本地仍共用普通清理器。见[固定版本 schema 源码](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/internal/util/gemini_schema.go#L64-L80)、[executor 源码](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/internal/runtime/executor/antigravity_executor_request.go#L229-L237)。官方仓库 [Issue 3662](https://github.com/router-for-me/CLIProxyAPI/issues/3662) 是变更背景，不是原用户错误证据。
2. **新增 Claude 工具结果 turn 分拆/排序。** 最新 `antigravity_claude_request.go:895-900` 只对 Claude 使用 `SplitGeminiFunctionResponseTurns` 与 `MergeAdjacentGeminiUserContents`；本地 `:873-874` 是统一 `MergeAdjacentGeminiContents`。新 helper 在 `internal/translator/common/gemini.go:162-225` 将 functionResponse 从同轮其他 user 部件分离，并考虑中间插入的提醒。[translator 源码](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/internal/translator/antigravity/claude/antigravity_claude_request.go#L895-L900)、[helper 源码](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/internal/translator/common/gemini.go#L162-L225)。本轮没有完整 Claude Code 提醒/并行工具形状重放，因此只列为候选差异。
3. **工具结果值清理与附件支持也有变化。** 最新 translator 改用 `SetGeminiFunctionResponseRaw/Result`（`:683-723`），并新增部分 document/container_upload 转换及空 turn 拒绝（`:740-767`）。这些可能改变特定工具返回/附件场景，未进行对应真实请求，不能纳入已确认根因。
4. **不能把“升级最新版”当作已验证修复。** 最新已是 v8 模块；`signature_validation.go` 与本地差异只有 v7→v8 import。最新 `internal/util/util.go:18` 仍保留 `.`、`:` 名称规则，工具名问题并未因 main 新版本自然消失。未构建/测试最新版本。

## 下一步建议（尚未实施）

先取下一次真实失败的**脱敏结构诊断**：保留错误类别、结构参数路径、签名有无/长度、块类型、工具名字符是否合法、tool_use/tool_result 配对及顺序；不记录正文、签名值或认证值。原请求无需写入普通日志，原始错误也不应直接全部回显给客户端。

再根据真实路径定向处理：若是 `tools.N.custom.name`，验证端到端名称映射及碰撞；若是 `messages.N.content.M` 的 signature 错误，排查该块在模型/供应商切换、历史压缩和流式合并前后的来源与完整性，不能一律伪造签名或删除所有 thinking；若是 input_schema/工具结果顺序，再用脱敏最小样本比较当前与上游专用转换。修复应只覆盖已确认路径，并回归 Gemini，避免改变其原本可用的签名/schema 语义。

当前最可靠的判断是：**原通用 400 隐藏了多个完全不同的参数错误；真实长历史工具调用已跑通，需要先让下一次真实失败留下安全的结构证据，才能决定修哪一层。**
