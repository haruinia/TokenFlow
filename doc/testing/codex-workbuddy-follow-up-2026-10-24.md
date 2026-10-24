# Codex 共存与 WorkBuddy 后续复查（2026-10-24）

接续已安装的 `.60`。用户要求先修复并直接替换本机 M 应用验证，暂停 M / Intel 压缩包导出。保留此前 Antigravity 工具结果顺序修复；本轮不新增界面框线、背景色块或特效。

## Codex 共存入口

安装版只读确认：本机 ChatGPT 登录仍有效，当前配置为官方路由；共存能力读取完成后，网关列表中的原 checkbox 默认勾选。但模型选择弹窗没有对应入口，用户从选择直接应用时无法看到该选项。

在现有 `AgentModelPicker` 增加通用 `applicationOptions` 插槽，Codex 在列表和弹窗复用同一个 checkbox、状态及处理函数，标签明确为「同时使用 ChatGPT 官方账号和网关模型」。沿用 `toggle` 和 `tfAgentPicked` 的布局，不新增 CSS。其余客户端不传入选项，保留现有效果。

构建后 Electron 隔离渲染回归修前失败于「Codex coexist choice is available before applying models」，修后通过。检查弹窗默认状态、取消后列表状态同步、新接入默认共存及应用请求 `codexCoexist: true`。原 Desktop 固定应用窗口、失败重试、单组 Thinking、供应商导入等检查继续通过，截图已人工核对。

## 旧对话恢复

旧错误在祖先索引修复阶段发生，尚未开始修改 rollout 或应用配置。持久化的中止轮次 `turn_context` 不一定属于 Codex 可见历史，使用它作为分支边界可导致 `thread/fork` 返回 `turn not found`。安装的 Codex 引擎在脱敏隔离历史上复现，生产修复函数验证通过。

现在仅在该明确 RPC 错误下查询同一线程的真实终结轮次，有界分页并重试一次；仍校验祖先索引完整性和字节边界，不跳过失败对话，也不直接改写 Codex 数据库。旧实现丢弃了原始 RPC 错误，不能声称重建了历史错误原文。[详细证据](codex-projection-boundary-repair-2026-10-24.md)。

## 共存模式切换官方账号

共存模式不再走「断开网关再切官方」的互斥流程。切换前使用候选账号读取官方目录，然后在共享锁下更新登录、目录和路由允许列表，保留网关连接 ID、Key 和选择的模型。读取失败不动现有登录，写入失败分别回滚已写入的内容；外部并发修改保留。恢复原登录同样保留共存。

8 文件 137 项定向回归通过。实际安装的 Codex 在隔离 HOME、合成账号和上游中完成切换与恢复后的官方／网关对话、目录刷新、重启及失败轮分支检查。prepared 恢复仅验证锁已释放的中断状态，不声称强杀或断电残留锁可自动恢复。[详细证据](codex-coexist-account-switch-2026-10-24.md)。

## WorkBuddy 原始工具声明

针对用户 01:58:40 的 `invalid_args`，复现并修复了 JSON Schema 转 Zod 的语义变化：required-only `oneOf`、元组、带偏移的日期时间、相对 URI 被误拒，以及默认值擅自写入参数。改为共用原始 JSON Schema 校验，MCP 公开工具列表和回调、流式提议采用同一份声明；不自动转换值、补默认值或删除额外字段。显式支持对应方言和本地根引用，不获取远程引用；不支持或不合法的声明单独报告。

6 文件 151 项定向测试通过，包含合法／非法参数对照、实际内存 MCP 列举和调用以及流式提议。真实 WorkBuddy DeepSeek 上游以合成 required-only `oneOf` 工具分别发送 Messages、Responses 一次，两次 HTTP 200，均正确提议一个合法工具；不执行工具，不发送用户历史。

上述证据确认共用转换缺陷及修复效果，**不确认 01:58 原始私人请求唯一由该 oneOf 引起**，因为未保留原始参数和声明。原对话须安装后由用户复测。

## 本机交付结果

- `npm run typecheck`、`npm run build`、运行时依赖及 `git diff --check` 通过；最终 `npm test` 为 **165 文件、1,643 项通过**，耗时 276.54 秒。
- M `.app` 使用 Electron 40.10.6 / arm64 构建，ad-hoc 深度签名及严格验证通过。实际 `.app` 运行时 **19 项检查**通过，包含 WorkBuddy 原始声明校验、非法参数拒绝和 draft6 元数据加载，以及既有网关、压缩、客户端和账号检查。没有生成新的 M 或 Intel ZIP。
- `/Applications/TokenFlow.app` 已替换为 **10.15.26.61**。`.60` 保留于 `release/v10.15.26.60/installed-before-61.app`。安装后的 app.asar 和 sidecar 均与验收构建一致；app.asar SHA-256：`21d4dd63eddb065415c1de90f5ebce2554ae895fc800883241c7b3a1871439d5`。
- 安装后工作台 `127.0.0.1:9527` 返回 HTTP 200，网关 8317 监听正常，临时 inspector 9231 未开启。实际窗口可操作；Codex 页面及「管理所选模型」弹窗均显示已启用、已勾选的「同时使用 ChatGPT 官方账号和网关模型」。检查后取消弹窗，原选择保留，网关仍待用户应用。
- 本轮没有停止 Codex、切换真实登录或迁移真实对话。真实旧对话恢复与用户原始 WorkBuddy 长对话仍需用户在 `.61` 主动应用／重试后确认。共享机制及安装引擎的隔离验证通过，不等于这两个原始场景已经确认恢复。
- 先前系统授权仍实际出现六次「允许」；本轮未得到新的逐窗计数，不将系统提示次数标记为已减少。更早原 12 项的实现与验证边界见[逐项复核](robustness-delivery-2026-10-24.md)，Antigravity 和 WorkBuddy 后续更新分别见[Claude 后续](claude-client-follow-up-2026-10-24.md)与[工具协议复核](workbuddy-tool-protocol-diagnostic-2026-10-24.md)。

官方资料区分目录与实际权限：`model/list` 可用于选择器，但目录存在不代表一次推理必然成功。TokenFlow 共存由本地受控路由按官方目录与网关模型 ID 分流，不把它描述为 Codex 原生已经提供任意多提供商菜单。[官方 app-server 认证说明](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。
