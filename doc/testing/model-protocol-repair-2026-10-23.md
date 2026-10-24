# 模型协议修复与验证（2026-10-23）

## 已修复：Antigravity Claude 的工具名称

原调研已用相同简单 schema 真实复现 `mcp__fixture.read` → 400、`mcp__fixture_read` → 200，供应商路径为 `tools.0.custom.name`。维护 overlay 现在只对 **Antigravity Messages 入口且目标为 Claude** 使用 `[a-zA-Z0-9_-]{1,128}`；Gemini 目标继续使用上游原规则，未整体升级 v8。

声明、`tool_choice`、历史 `tool_use`、由 ID 关联的 `tool_result`、流式/非流式响应反向映射使用同一张按请求构建的名称表。表包含已经从当前声明移除的历史工具；碰撞用确定的 SHA-256 后缀处理，保持 128 字节上限和声明顺序无关。没有修改客户端原工具名，客户端收到的工具调用仍用原名。

持久化源为 `patches/cliproxy/antigravity_claude_tool_names.go`、`scripts/antigravity-claude-overlay.mjs` 与 `scripts/sidecar-overlay.mjs`。没有只修改 ignored upstream。直接 Responses/Chat 入口使用另一套 translator，本次工具名修复没有扩大到它们。

## 已修复：缓存 token 重复计算

检查同一协议链发现独立、可复现的使用量问题：Antigravity 的 `promptTokenCount` 包含缓存 token，但 Messages 的 `input_tokens` 必须只含未缓存输入。当前非流式转换先写完整 prompt，又附加 `cache_read_input_tokens`；一个遵守 Anthropic 语义的下游加总时会重复计算。

红 fixture：`promptTokenCount=123000`、`cachedContentTokenCount=122000`、输出 `28`，旧转换得到 Messages `input_tokens=123000/cache_read_input_tokens=122000`，桥接 Responses 后输入 `245000`，可错误越过 `244800` 压缩阈值。修复后 Messages 是 `1000+122000`，Responses 输入是 `123000`。同时修复 stream 早期 `cpaUsageMetadata` 的字段含义，以及缺少 candidates count 时把缓存量算入输出的 fallback（旧值 `122028`，正确值 `28`）。

直接 Antigravity→Responses 走 Gemini converter，fixture 验证其输入一直是 `123000`，未改动此路径。此证据**不能单独证明**外部来源 `anti_claude-opus-5` 的真实压缩循环必然经过上述有问题的 Messages 链；仍需结合该来源的白名单 usage 与路由诊断。没有通过删除缓存计数、修改上下文阈值或伪造 usage 规避问题。

依据：[Google UsageMetadata](https://ai.google.dev/api/generate-content#UsageMetadata) 定义 prompt 为包含缓存的有效输入；[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#how-do-i-calculate-total-input-tokens-from-the-usage-fields) 定义总输入为普通输入、缓存读和缓存写之和。最新官方 main `8289ec4c71ad914d0612c2776352b76ba3d355a6` 也有流式 fallback 修正，但非流式仍输出完整 prompt；本次只移植/实现所需边界，不整体升级。

## 已修复：安全参数路径诊断

`packages/core/src/upstream-errors.ts` 可从嵌套 JSON 错误的 message 起始位置提取结构路径，包括 `tools.0.custom.name` 与 `messages.1.content.0`。只有固定字段、数字索引、最多 256 字符的路径能返回；原始供应商 message、签名、工具参数名、schema properties 名和正文不会返回。保留原通用 `upstream_invalid_request` 分类，避免把字段校验误报成账号或 DNS 问题。

## 验证记录

- `node scripts/test-sidecar-model-protocol.mjs`：完整 Antigravity Claude translator package 通过。测试覆盖名称碰撞、截断、历史调用/结果、tool_choice、流/非流逆映射、已移除历史工具和 Gemini 名称对照；使用量 fixture 同时覆盖流、非流、Messages→Responses 桥与直接 Responses 对照。禁用新名称 overlay 时名称回归失败；添加 usage fix 前 fixture 真实得到 `245000`，修复后变绿。
- `npx vitest run tests/upstream-errors.test.ts tests/cursor-model-probe.test.ts`：与 `tests/cursor.test.ts` 共 92 个 mock/unit 测试通过。错误路径三个新增 fixture 已先运行红，再修复变绿；任意参数名和私有文本拒绝测试通过。
- 本机 Claude Code `2.1.309` 在隔离 cwd/config、禁用外部 MCP 配置、无会话持久化的条件下向本地 mock server 发出一次真实 CLI 请求，进程退出 0。仅保留字段名和结构：adaptive thinking、context_management、output_config、stream=true、12 个工具（含 ToolSearch、defer_loading 占位工具）。这是**真实 CLI/模拟模型服务**，没有推理，也不能代表用户原会话或 Desktop 请求。
- 临时 Go overlay test 直接用当前有效账号的内存 Auth 进入 patched executor（不启动/重启生产 sidecar、不读 refresh_token、不执行刷新、不改真实配置）。三种真实请求：句点工具名 → 200、原生 thinking 签名与 tool_result 续轮 → 200、Gemini 句点工具名对照 → 200；响应工具名均恢复原名。harness 被意外重复启动一次，因此实际为 **2 轮共 6 个串行推理请求**，不是 3 个；每次约 3–5 秒，单次 60 秒上限。没有执行模型生成的工具，凭据/签名/原始响应仅在进程内存，未输出/落盘。此轮真实请求验证了名称修复；usage 修复发生在其后，usage 使用合成 fixture 验证，没有追加真实推理。

临时 harness 位于 ignored `.tmp/research-antigravity/`，不在默认测试链中；真实 harness 另加 `TOKENFLOW_RUN_REAL_PROTOCOL_PROBE=1` 显式开关，再次运行会消耗额度。维护测试均不接触真实凭据/上游。六次真实进程已结束，未保存原始 usage，不能事后从日志恢复这些 raw counters。

## Cursor Grok 4.7 状态与后续有界验证

生产模型目录与默认变体选择尚未改动，也未静态隐藏模型。已有历史 `model_not_found` 和官方论坛 500k/local runtime 案例仅是候选；本轮没有解密 `cursor-account.bin`、触发 Keychain、刷新凭据或进行真实 Cursor 推理。当前进程内 Secrets 不可由独立进程直接复用。只读检查也确认 `~/.cursor/sdk/auth.json` 不存在，`~/.cursor/cli-config.json` 无 API key，原生 `~/.cursor/auth.json` 与 IDE `state.vscdb` 有 OAuth access token；未把 OAuth 当成已验证的 SDK API key、未调用 CreateUserApiKey。

准备了明确调用才运行的 `scripts/probe-cursor-local-model.ts`。由已授权且已有缓存的应用进程传入内存 Secrets facade：

```ts
const catalog = await probeCursorLocalModel(memoryOnlySecrets, { model: 'grok-4.7' });
const comparison = await probeCursorLocalModel(memoryOnlySecrets, {
  model: 'grok-4.7', accountId: alreadySelectedAccountId, runInference: true, timeoutMs: 60000,
});
```

默认只读取官方 catalog；显式 `runInference:true` 最多执行两个同账号/同模型请求：目录默认参数，以及目录明确广告 256k 且默认不是 256k 时只改 context 的对照，effort/speed 不变。禁用内建工具/MCP/本地设置，目录和模型状态为白名单输出，不输出账号、密钥、提示词、响应正文或原始错误；临时 SDK store 清理。每个探测共享 60 秒预算，结束或超时取消并关闭 agent。调用者必须提供已在内存中的授权值，不能将该函数误当成绕过安全存储授权的能力。

`tests/cursor-model-probe.test.ts` 的 5 项测试均为 mock，只证明参数对照设计、只读默认行为、同账号路由、工具禁用和秘密不外泄；不能声称已验证 Grok 4.7 的 500k/256k 实际差异。主任务随后授权使用原生 OAuth 进行一次 SDK 官方 models 只读请求；目录失败（白名单类别 `unclassified`），没有触发任何推理（`probes=[]`）。该结果未能区分 OAuth token 类型不兼容与通信失败，不能作为授权拒绝证据，也不能替代当前 SDK key 的对照；等待 installed 进程内有界 A/B 结果后再决定生产参数适配。

## 尚未证明的事项

- 原用户 Claude Code 与 Desktop 失败的完整 payload 没有保存，原 400 是否来自本次工具名问题仍无法追溯。未捕获 Desktop 当前真实请求，不把 CLI 的采样当成 Desktop 实测。
- 原生签名工具往返已两次真实成功；之前的人为单字符损坏签名只证明供应商会拒绝坏签名，不能作为原用户失败根因。因此没有伪造签名、清空全部 thinking 或把坏签名当成默认重试条件。
- 没有打包或替换正在运行的应用。两架构 sidecar 构建由主任务授权后执行，应用打包/安装由主任务统一处理。

构建核验：两个 production sidecar（不 clean、不构建前端、不替换运行进程）均成功：`darwin-arm64` SHA-256 `d87aaff51dd9f2491beafd9cae79317b8fba80a2082a1e385532ce6add10d8a9`；`darwin-x64` SHA-256 `caaf7a102d2d7dccc8c81f066ec67dfd6b88d214daebe729641b874590f60d44`。`file` 确认 Mach-O arm64/x86_64。

## Cursor system-proxy follow-up

A separately authorized read-only retry used the configured system proxy at 127.0.0.1:7897 via createNetworkProxy/installFetch and temporary SDK proxy environment variables. Route metadata confirmed both api2.cursor.sh and api.cursor.com used system_proxy. The official SDK model catalog returned HTTP 401 / unauthenticated for the existing native OAuth access token; probes remained empty. No Cursor inference, key creation, credential refresh or production configuration mutation occurred. The earlier unclassified direct-network failure alone did not establish this credential result. Production Grok parameter selection still awaits the installed application SDK-key comparison.
