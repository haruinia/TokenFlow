# Codex 官方直连 / 网关模式实现与验证

## 回退点和交付

- 实现前 Git 快照：`a2f6494`，包含先前聚合共存、压缩与直连实验的源码、测试和文档。
- 本次构建版本：10.15.26.67；单独保存到 `release/v10.15.26.67/`，包含应用、源码归档和校验清单。
- 旧 .64/.65/.66 归档保留。本轮没有替换 `/Applications/TokenFlow.app`，没有退出用户正在使用的 Codex 或 TokenFlow。

## 实际行为

本地 Agent → Codex 新增连接方式入口：

- **官方直连**：清除 TokenFlow 和 OpenAI 自定义地址覆盖，选回内建 `openai` provider。保留现有官方登录，恢复官方模型菜单与原生压缩。TokenFlow 读取本机使用记录，推理请求不经过 TokenFlow。
- **网关模型**：显式使用 `token_flow` provider 的 `/v1`，`requires_openai_auth=false`，不改 `auth.json`。不声明远程压缩；本次安装的 Codex 按本地压缩流程请求当前模型生成可读摘要。
- **旧聚合共存**：已有 `/codex/v1` 配置明确标为“聚合共存（旧模式）”，不因官方账号仍登录而标成直连。新应用网关模型不再自动启用聚合。

复用现有带修订校验、备份与历史迁移的 connect/restore 接口。切换前明确确认会退出本机 Codex 进程；确认后依次退出、备份/处理历史、写入配置、重新打开。进入原对话继续，不承诺热切换已加载会话，也不承诺只影响当前一条对话。

官方加密压缩项不能直接交给其他厂商。转网关时从本机历史恢复；过长时会调用网关模型摘要。转回官方时物化 TokenFlow 私有检查点，恢复官方可读历史。官方直连运行期间不由 TokenFlow 代做压缩。

状态来自已保存配置，检查当前 legacy profile、provider 和地址覆盖；不将文件状态冒充正在运行的客户端状态。自定义来源与无法解析的配置单独显示。

## 自动检查

- `npm run typecheck` 通过。
- `tests/codex-routing-mode.test.ts`、`codex-routing-ui.test.ts`、`agent-connections.test.ts`、`a2a-service.test.ts`、`codex-context.test.ts`、`codex-switch-lifecycle.test.ts`、`usage-attribution-service.test.ts`：157 项通过。
- 生命周期测试模拟进程退出/打开，验证确认之前修订冲突不退出客户端；切换后地址、provider、登录字节及备份状态正确。
- `scripts/codex-direct-roundtrip.mts` 单独 strict TypeScript 检查通过。
- 生产构建、19 项打包运行时检查、macOS ad-hoc 签名及 strict 校验通过。

## 真实模型与真实产品接口

在隔离 HOME / CODEX_HOME 中，使用实际安装的 Codex 引擎、临时官方凭据副本和生产 TokenFlow 服务实现。官方模型 `gpt-6-astra` 原生连接，网关模型 `antigravity/gemini-3.8-flash-low`。普通网络代理用于 OpenAI 网络可达性，不是 TokenFlow 推理代理。未修改原始登录或历史。

新增 `--product-switch`，实际调用产品 `/api/a2a/connect` 与 `/api/a2a/restore` 接口。真实客户端进程只在隔离环境停止/启动；生产桌面全局退出/重启由模拟生命周期测试覆盖。

复现命令：

```sh
node --import tsx scripts/codex-direct-roundtrip.mts --live --product-switch --proxy http://127.0.0.1:7897 --out doc/testing/results/codex-direct-product-switch-2026-10-24.json
node --import tsx scripts/codex-direct-roundtrip.mts --live --product-switch --long --proxy http://127.0.0.1:7897 --out doc/testing/results/codex-direct-product-long-2026-10-24.json
```

两次均完成：官方种子对话 → 官方原生加密压缩 → 产品接口切网关 → 网关续聊和新增要求 → Codex 本地摘要 → 网关摘要后续聊 → 产品接口恢复官方 → 关闭隔离 TokenFlow 和网关适配器 → 官方续聊 → 官方再次压缩 → 官方继续回复。

- 短上下文保留 2 个要求标记。
- 长上下文使用 **482,337 字节的合成审计历史作为一次真实用户输入**，随后多轮续聊；并非真实用户历史的完整副本，也不冒充数百轮人工对话。早、中、晚标记及往返新增要求共 5 项均保留。
- 长样本首次网关续聊约 21.8 秒，恢复较长历史时产生 3 次额外网关摘要调用。显式 Codex 本地摘要约 6.4 秒。
- 停止 TokenFlow 后，长样本官方续聊约 10.7 秒、官方压缩约 12.8 秒、压缩后续聊约 5.0 秒。
- 两次 TokenFlow 官方推理转发计数均为 0，临时登录字节未变。
- 恢复官方后保留产品 OTel 统计配置；即使采集服务已经停止，官方推理与压缩仍完成。本机记录分别解析到 5 个官方用量样本。

原始报告：[短上下文](results/codex-direct-product-switch-2026-10-24.json)、[长上下文](results/codex-direct-product-long-2026-10-24.json)。数字为单次观测，不能作为速度对比基准。标记召回证明本次样本的连续性，不能证明任意语义和历史完全无损。

## 界面验收

`node scripts/codex-routing-ui-fixture.mjs` 只提供内存中的假配置与假生命周期，不操作真实客户端。使用 CUA 点击完整生产控制台：

- 官方直连 → 网关确认 → 取消，服务调用为 0。
- 确认网关切换：只发出一次 connect，明确 `codexCoexist=false` 与 `restartCodex=true`。
- 处理中关闭按钮禁用，显示同一个操作窗口内的进度，没有 Thinking 遮住阶段文字。
- 切回官方使用 restore，明确 `restoreHistory=true` 与 `restartCodex=true`。
- 模型选择页应用先进入切换确认，不立即退出客户端。
- 注入历史备份失败后停在错误窗口，展示原因和检查旧对话入口，仍显示原直连配置。
- 旧聚合状态单独显示，提供迁移入口。

截图：[官方直连确认](results/codex-direct-mode-ui-2026-10-24.png)。这是隔离界面验收，不是对用户当前配置已切换的证明。
