# Claude 客户端新故障跟进（2026-10-24）

基线为已安装的 `10.15.26.59` / `857ec97`。用户新报 Antigravity Claude 的 `messages.2` HTTP 400，以及 WorkBuddy DeepSeek 经 Claude Desktop 的 `workbuddy_tool_protocol` HTTP 502。本次没有修改前端样式。

## Antigravity：已定位并修复结果顺序

01:26 的原始失败日志含完整客户端输入。只在本地内存读取和转换，未重发私人请求。三条工具调用与紧随的三条工具结果 ID 完全匹配；输入末尾还有一条 system 提醒。

生产转换函数原来调用 Gemini 共用消息合并，得到 `user[text,result×3]`。Claude 要求下一条 user 消息以工具结果开头。新的 Claude 协议合并函数稳定排列为 `user[result×3,text]`，保留所有提醒、结果、ID 和模型 thinking/signature。Gemini 保留既有排列。

回归覆盖 Opus 4.6、Opus 4.6 thinking、Sonnet 4.6 和明确标为合成的未来 Claude ID；12 个 Claude 结果顺序场景修前失败、修后通过，3 个 Gemini 对照通过，4 个签名字节保留场景通过，原工具名转换和 usage 回归继续通过。该实现按既有 Claude 目标协议生效；未来模型若改变协议或能力仍需验证。

额外三次真实上游请求全部 HTTP 200：

1. 合成请求取得有效 thinking 签名及恰好三条工具调用。
2. 在内存中原样续用返回内容，回传三条合成结果，并添加尾部 system 提醒，续轮成功返回 thinking/text。
3. Gemini 对照成功返回三条工具调用。

凭据和签名只在内存中使用；未执行工具、未发送用户原始请求。整个 live 流程 12.30 秒。原日志未保留出网 JSON，根因证据是原输入经同一生产转换函数的本地结构重现，不能称为抓取到了出网 body。详细回归见[协议复查](protocol-robustness-review-2026-10-24.md)。

## WorkBuddy：原 502 尚未复现

持久调用记录确认 01:26:20 的请求在回传一个工具结果后出现 `workbuddy_tool_protocol`，后续同类失败和成功均存在。`.59` 把未知工具名、未完成工具块等不同失败归入同一错误，现有记录不足以确定具体原因。

使用相同来源账号、独立临时 SDK 工作目录，共进行了 8 次有界真实请求：Messages 与 Responses 各含续轮，分别覆盖 12 个工具，以及 115 个合成工具和 100 轮合成历史。8 次全部成功；观测到的工具均能匹配注册定义、块完整、JSON 合法，未出现孤立增量。这些结果不能证明用户原 502 已修复。

已补齐固定枚举诊断，让用户原场景再次发生时能区分具体校验阶段；不放宽未知工具、参数、完整性或并行约束。保留稳定的 `workbuddy_tool_protocol` code，用固定 message 标签在现有调用记录中呈现子类；仅接受安全类别与非负整数计数，不记录工具参数、正文或凭据。126 项定向测试及 typecheck 通过，包含 Messages/Responses、流式/非流式及最终调用记录。见[WorkBuddy 诊断报告](workbuddy-tool-protocol-diagnostic-2026-10-24.md)。

## 既有任务与安装状态

此前 Codex 续聊、压缩、历史恢复、官方登录与网关同菜单、无 CLI 的 VS Code 配置、npm 安装更新、CC Switch 导入及导航调整仍包含在本次基线中，逐项边界见[总复核](robustness-delivery-2026-10-24.md)。

本机只读检查确认 Codex 当前仍为合法的 `openai` 配置，ChatGPT 登录存在，尚未启用 TokenFlow 共存设置。共存入口为“使用 → Codex → 同时保留官方模型”，选择网关模型后应用。当前会话未改写真实 Codex 配置或登录文件。

`.59` 用户实际授权仍为 6 次“允许”；不记为系统提示次数已降低。按用户优先级，跨启动缓存设计暂停。

`.60` 全量 162 文件 / 1,594 项测试通过，typecheck 与构建通过；M 与 Intel（Rosetta）实际 bundle 各 18 项 runtime 检查通过。两份导出包 CRC、包内 app.asar 与 sidecar 一致性、ad-hoc 签名严格检查通过。已安装 `/Applications/TokenFlow.app`，旧 `.59` 保留在 `release/v10.15.26.59/installed-before-60.app`。启动后工作台 HTTP 200、网关 8317 正常，inspector 9231 未打开。本次未统计系统授权窗口次数。

随后用户报告 `.60` 的真实 WorkBuddy 失败子类为 `invalid_args`（本地显示 01:58:40），进入参数结构转换复查；不再将其仅描述为未发生。用户又报告 Codex 旧对话恢复失败及共存选项不易找到，继续处理。用户明确暂停后续 M / Intel 压缩包导出，之后先直接替换本机应用验证，再最终打包。

最新 `.61` 已修复并安装的后续结果、未确认边界及暂停导出要求见 [Codex / WorkBuddy 后续复查](codex-workbuddy-follow-up-2026-10-24.md)。
