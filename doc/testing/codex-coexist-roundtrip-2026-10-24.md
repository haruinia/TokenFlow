# 官方原生压缩与网关摘要：两次往返续聊验证

## 结果

2026-10-24，已安装 Codex `0.164.0-alpha.11.1`、源码中的生产 TokenFlow service、真实 OpenAI `gpt-6-astra` 和现有反重力 `antigravity/gemini-3.8-flash-low` 完成两次同线程往返。13 个阶段全部成功；最终官方回复包含全部三个逐步加入的随机要求标识。

仅使用临时 HOME/CODEX_HOME、临时服务和合成任务。官方凭据只在临时文件中使用，刷新令牌替换为不可用测试值，临时目录在退出后删除；没有改动用户的真实配置、登录、会话或运行中的应用。反重力请求使用现有本地网关，发生了少量真实模型用量。

## 实现

`AgentConnections` 在共存连接中声明 `capabilities.remote_compaction = "v2"`。Codex 管理压缩触发和会话历史替换；官方分支转发原生请求，网关分支复用现有摘要兼容层。独立网关模式保持 Codex 本地摘要路径。官方登录及模型元数据保持不变。

网关不能解密官方压缩项。当前实现从本机准确匹配的 rollout 恢复可读历史，发送给网关；网关摘要以 TokenFlow 本地加密检查点保存。切回官方前展开该检查点为可读内容，不将 TokenFlow 密文发送给 OpenAI。

## 实测过程

| 阶段 | 结果 |
|---|---|
| 官方记住要求 A，原生压缩 | 完成 |
| 网关读回 A，加入 B，再生成摘要 | A、B 保留；1 次摘要调用 |
| 官方读回 A、B，再原生压缩 | 完成 |
| 网关读回 A、B，加入 C，再生成摘要 | A、B、C 保留；1 次摘要调用 |
| 最终切回官方 | A、B、C 全部保留 |

网关收到的请求不含官方或 TokenFlow 的 compaction 密文；官方请求不含 TokenFlow 检查点。切换没有重启 Codex、改 provider 或修改 rollout，使用同一线程的模型选择完成。

## 验证

先将配置测试改成期待远程压缩能力，旧实现失败，声明能力后通过。

```sh
npx vitest run tests/agent-connections.test.ts tests/codex-coexist.test.ts tests/codex-context.test.ts --reporter=dot
npx vitest run tests/gateway-context.test.ts --reporter=dot
npm run typecheck
node --import tsx scripts/codex-coexist-roundtrip.mts --out doc/testing/results/codex-coexist-roundtrip-fixture-2026-10-24.json
node --import tsx scripts/codex-coexist-roundtrip.mts --live --proxy http://127.0.0.1:7897 --out doc/testing/results/codex-coexist-roundtrip-live-2026-10-24.json
```

152 项回归测试、项目类型检查、模拟上游及真实上游往返验证通过。新脚本也使用 strict TypeScript 参数单独检查通过；最初单独检查未启用项目 strict 选项，出现依赖源码的类型诊断，按项目选项检查后通过。

## 边界和发布状态

本次验证是显式压缩后的短任务续聊，不是自动阈值压力测试，也不证明所有工具、隐藏推理、超长会话或所有供应商之间完全无损。缺少对应本地历史时，官方密文仍无法恢复，现有逻辑会报错而非静默清空上下文。

源码已修改；未构建或安装包含此变更的新应用，未把它写入用户正在使用的连接。此前暂存的 10.15.26.65 安装包不含此次变更。后续安装新版后需要通过连接流程重新应用共存配置，现有旧连接不会因源码变化自动获得能力声明。
