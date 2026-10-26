# Codex 网关重复压缩：.80 修复与验证

## 原因与方案

2026-10-26 的两条真实 DeepSeek 对话多次成功压缩后再次触发。七牛一次压缩后的下一次调用仍有 237169 输入 tokens，工具定义约 643 KB，规则约 298 KB；硅基流动相应为 208331 tokens、612 KB 工具定义、189 KB 规则。不能把 Codex 压缩后暂估值当作上游实际输入，也不能将摘要计费 usage 当作续聊上下文。

[CC Switch / Codex 源码调研](cc-switch-compaction-research-2026-10-26.md)说明了设计依据。本次不接管原生后台、不修改官方目录，不伪造工具搜索能力、usage 或未知窗口。

实施两项修复：

1. 仅对 managed Codex、仅在客户端显式重建当前环境时，将认证检查点内可识别的旧原生环境快照纳入历史摘要。当前规则、system 消息及不能识别的自定义 developer 规则仍原样保留。普通推理不删规则，摘要失败不提交替换。新检查点不会无限保留每版旧环境；不直接删除历史文件。
2. 网关模型目录恢复 Codex 原生未知模型的 `truncation_policy={mode:bytes,limit:10000}`。由客户端保留日志首尾和可见截断提示，模型可按需重新读取。迁移仅替换 TokenFlow 原来的 `Number.MAX_SAFE_INTEGER` 哨兵；自定义预算及官方模型条目保持不变。

不启用开发中的全局 strict third-party tools 功能。约 600 KB 的工具定义仍是固定开销，因此不承诺与官方模型完全相同的压缩间隔。

## 红绿回归

`npx vitest run tests/codex-compaction-instructions.test.ts` 在修复前失败：旧快照根本没有进入摘要，仍作为固定规则重复保留。修复后通过，覆盖：旧检查点升级、当前规则、未知规则、system、缺失当前环境、普通 API、失败重试、跨模型、多次压缩、返回官方的上下文转换。

`tests/codex-catalog-refresh.test.ts` 先将预期改为原生 10000，旧实现返回 9007199254740991 而失败；目录生成和旧目录迁移修复后通过。

类型检查、相关压缩/usage/官方共存/本地历史恢复测试通过。生产构建、签名验证和 19 项打包运行检查通过。

## 真实检查点隔离回放

命令：`npx tsx scripts/codex-compaction-replay.mts <thread-id> [--live-summary]`。

脚本只读真实 rollout，把加密上下文密钥复制到私有临时目录，所有派生写入只发生在临时目录并在退出时删除。只输出大小、计数、时长，不输出提示词、账号或凭据。测试没有写入用户对话。

| 来源 | 旧回放 input 字节 | 新回放 input 字节 | developer 条数 | 摘要来源 |
|---|---:|---:|---:|---|
| 七牛 DeepSeek | 330678 | 63310 | 31 → 7 | 模拟摘要，真实检查点结构 |
| 硅基流动 DeepSeek | 209615 | 67428 | 29 → 5 | 真实选定 DeepSeek API |

硅基流动真实摘要：4 次请求，108009 ms，36668 输入 / 6843 输出 tokens（其中 3785 reasoning），成功完成。测试后校验当前任务标记、重启隔离上下文存储后的回放、返回官方格式转换。续聊 transport 为测试桩；以上不冒充完整真实 OpenAI 往返质量测试，也不把字节减少冒充 token 等比例减少。

## 已安装原生 Codex 集成实验

原生二进制：`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`，0.164.0-alpha.11.1；每个实验独立 `CODEX_HOME`，模型为本地合成服务。

`npx tsx scripts/codex-tool-output-budget-probe.mts`：同一真实 shell 工具输出，旧无限预算回传 264124 bytes；10000 预算回传 10217 bytes（含元数据和截断提示），首尾标记都保留。0 次付费模型请求。

`RESULT_PATH=/tmp/tf80-native-long-history.json npx tsx scripts/codex-first-long-history-smoke.mjs /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --large-history --remote-compaction --return-official --resume-after --total-scope --single-attempt`：约 12.7 MB 合成历史，网关压缩一次后续聊成功，重启隔离客户端续聊成功，切回原始 provider 成功，最早任务标记保留。该实验验证协议和缓存边界，上游是模拟服务；没有改动或重启真实 Codex。

## 生效范围

版本 10.15.26.80。服务更新后，旧检查点在下一次客户端触发的压缩中完成归档；不会后台篡改已有检查点。工具输出预算需要 Codex 重新加载模型目录，已加载会话可能需用户在回复结束后重启 Codex。

本次结束前发现仍有多个客户端持续通过 TokenFlow 请求，故安装重启时间单独交由用户选择，避免重现此前更新导致流式回复断开的情况。
