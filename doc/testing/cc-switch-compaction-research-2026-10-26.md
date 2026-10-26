# CC Switch / Codex 压缩机制核查（2026-10-26）

## 核查范围

- CC Switch：2026-10-26 `git ls-remote origin HEAD` 得到 `42ef63471f0ed879913f8de0d0c7e3e580293193`；从该 commit archive 到隔离目录审阅。原参考 checkout `d8983bb` 已不是最新。
- OpenAI Codex：同日远端 HEAD 与本地源码均为 `970111f6cb62cc02fe36a82ea7d71b37a2889c97`。源码是公开仓库版本，不据此声称所有桌面私有实现完全一致。
- 本机原生二进制 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --version`：`0.164.0-alpha.11.1`。只运行版本与 feature 列表查询，没有启动新推理、修改登录/配置、停掉 Codex 或修改对话。

## CC Switch 实际做法

1. **第三方聚合模式已经有自己的 remote compaction V2 适配。** 它识别 `/responses` 的末尾 `compaction_trigger`，换成 Codex 本地压缩使用的交接摘要提示，让当前第三方模型生成摘要，再以 `ccswitch-compaction-v1:` + base64 放进 `encrypted_content`。这只是编码，不能称为 OpenAI 加密压缩。后续发送第三方或官方时把自有 envelope 展开为一条摘要消息。它不会把整个旧 developer 配置列表再次塞进这个 envelope。
   - [适配、摘要提示、编解码、回放与请求改写](https://github.com/farion1231/cc-switch/blob/42ef63471f0ed879913f8de0d0c7e3e580293193/src-tauri/src/proxy/providers/codex_compaction.rs#L1)
2. **压缩请求仍保留工具定义，禁止新工具调用。** `shape_summary_turn_request` 设置 `tool_choice: none`，没有清空 `tools`；源码说明部分上游拒绝“存在工具调用历史但没有相应定义”（#7976）。这不解决大型工具 schema 的固定占用。
   - [摘要请求整形](https://github.com/farion1231/cc-switch/blob/42ef63471f0ed879913f8de0d0c7e3e580293193/src-tauri/src/proxy/providers/codex_compaction.rs#L227)
3. **官方路由保留官方压缩。** 官方分支清理自身产生的第三方 envelope 等不兼容状态，第三方原生 Responses 分支才改写 trigger。旧式 `/responses/compact` handler 按选中模型解析 stack、送到 forwarder；不能把源码中“透传”注释理解成所有来源均不适配。
   - [官方与第三方分支](https://github.com/farion1231/cc-switch/blob/42ef63471f0ed879913f8de0d0c7e3e580293193/src-tauri/src/proxy/forwarder.rs#L1955)
   - [旧 compact endpoint](https://github.com/farion1231/cc-switch/blob/42ef63471f0ed879913f8de0d0c7e3e580293193/src-tauri/src/proxy/handlers.rs#L1364)
4. **按模型窗口派生压缩点，不是通用防循环算法。** CC Switch 的 `sink_row_windows` 为第三方行写窗口的 90%（或用户指定值），官方行除明确配置外保持原样；普通 catalog fallback 可为 128000，不是统一的 272000。没有在上述路径发现根据摘要收益自动消除大工具定义开销的实现。
   - [逐行窗口与阈值](https://github.com/farion1231/cc-switch/blob/42ef63471f0ed879913f8de0d0c7e3e580293193/src-tauri/src/codex_config.rs#L2692)
   - [目录默认窗口](https://github.com/farion1231/cc-switch/blob/42ef63471f0ed879913f8de0d0c7e3e580293193/src-tauri/src/codex_config.rs#L2384)
5. **跨官方加密历史的处理弱于 TokenFlow 本地恢复。** 遇到不可读的他方 compaction，部分转换路径只给出“旧上下文已压缩，当前模型不能读取”占位语；不宜照搬，以免丢失当前任务背景。
   - [不可读 checkpoint 占位](https://github.com/farion1231/cc-switch/blob/42ef63471f0ed879913f8de0d0c7e3e580293193/src-tauri/src/proxy/providers/codex_compaction.rs#L46)

## Codex 原生如何避免历史配置一直累积

- `build_v2_compacted_history` 默认只保留特定用户消息、受 feature 管理的 client-authored developer 消息/工具输出及 compaction；不是保留所有 developer 消息。
- `build_compaction_replacement_history` 从当前 step 与 world state 重新渲染 initial context，再装入压缩后历史。这使当前规则与权限仍然存在，而旧的引擎配置快照不无限累积。
- 重要边界：原生识别 client-authored developer 依赖内部 `CodexHarnessMetadata.client_authored`。普通网关 wire input 不一定有这个 sidecar，不能简单复制“删掉全部 developer”的逻辑；未知或用户注入规则必须保守保留。工具调用/结果也不能剪成不配对的历史。

来源：

- [原生重建当前上下文](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/compact.rs#L83)
- [V2 保留逻辑与 developer 元数据](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/compact_remote_v2.rs#L480)

## 工具占用与窗口：可改项和不能伪装的能力

原生未知模型 fallback：`context_window=max_context_window=272000`，有效窗口百分比 95，`supports_search_tool=false`，`truncation_policy={mode:bytes,limit:10000}`。TokenFlow 当时 gateway catalog 的工具输出 limit 是 `Number.MAX_SAFE_INTEGER`，等于取消正常工具结果截断；它使大型日志/文件工具结果迅速填满历史。恢复原生上限应通过 Codex 原生 truncation 流程执行，保留其截断提示与按需重新读取能力，而不是在网关悄悄裁掉任意消息。

- [Codex fallback metadata](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/models-manager/src/model_info.rs#L115)

工具定义自身另需按需加载，但不能只把 DeepSeek 的 `supports_search_tool` 改为 true：CC Switch 有明确回归测试指出 DeepSeek 不支持该 tool_search 路径，错误声明会使 MCP 工具不可调用。

- [CC Switch DeepSeek 能力回归](https://github.com/farion1231/cc-switch/blob/42ef63471f0ed879913f8de0d0c7e3e580293193/src-tauri/src/codex_config.rs#L4566)

一个值得隔离验证的原生候选是 **CodeModeOnly + code_mode_only_strict_3p_tools**：它把第三方工具改为 Deferred，但保留 exec 调用路由；没有 tool_search 时使用 Catalog discovery，因此理论上不依赖服务端 tool_search。上游测试覆盖 `supports_search_tool=false/true`。本机原生 `features list` 确认该 feature 存在，但 `code_mode`、`code_mode_only`、`code_mode_only_strict_3p_tools` 均为 under development / false；用户当前 config 未显式设置这三个字段。它是全局 feature，直接启用会扩大到官方路径，不能在本次修复中未经验证全局打开。目录 `tool_mode` 选择、桌面覆盖、实际 discovery 和执行都需要原生二进制集成测试。

- [strict 条件](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/spec_plan.rs#L190)
- [第三方 deferred 暴露](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/spec_plan.rs#L603)
- [无 tool_search 时 Catalog discovery](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/spec_plan.rs#L1054)
- [原生工具暴露测试](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/spec_plan_strict_third_party_tests.rs#L9)

## 建议本次落地的边界

1. managed Codex checkpoint 区分当前规则与历史引擎快照；当前规则原样保留，已被当前快照替代的旧引擎配置进入历史摘要，不再作为每轮高优先级消息重复回放。没有足够来源证据的 developer 消息保留；不按长度或简单关键词删规则。
2. 恢复 gateway catalog 原生工具输出预算，独立验证大输出被原生客户端可见截断、后续仍能通过工具按需读取。官方目录保持原样。
3. 保留 TokenFlow 的完整性检查、本地官方 checkpoint 恢复、完整工具交换边界、已成功摘要缓存与失败不提交机制；不照搬 CC Switch 的不可读历史占位。
4. 不伪造 usage、自动提高未知上游容量或关闭压缩来掩盖循环。对真实 checkpoint 的隔离回放同时量测固定指令字节、工具 schema 字节、普通历史字节与总请求量；固定 schema 很大时，修复旧快照也不能承诺与官方完全同样的 token 成本。
5. 本文是研究证据；实际通过的回归/真实 checkpoint 回放/安装结果应由主任务补在修复验证记录中。尚未声称进行了付费上游长会话等价测试。
