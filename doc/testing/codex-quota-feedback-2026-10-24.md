# Codex 切换、Antigravity 额度与操作进度修复

初版修复安装为 `10.15.26.62`，随后额度展示精简交付为 `10.15.26.63`。本轮修复已归档会话阻断历史索引修复、Antigravity 缺少模型额度，以及全屏 Thinking 模糊操作进度的问题。

## Codex 历史索引

本机最近两次失败的 context 备份时间为 `2026-10-24T09:48:09.316Z` 和 `2026-10-24T09:48:52.982Z`，均没有 rollout 重写条目，也没有新的 thread migration manifest。检查时仍为官方路由，官方登录存在。

将 718 个本地 rollout 和一致性 SQLite 快照复制到临时目录，重定向所有线程路径，不复制登录凭据，以不可用的 loopback 模型端点运行安装的 Codex 引擎。生产 `CodexContext.repairLineage` 在副本上复现相同错误：`thread/fork` 返回 `-32600`，原因是目标 session 已归档。这个错误不同于此前已经处理的 `turn not found`。

修复仅对明确的 archived 错误临时解除归档，执行原有临时 fork 与祖先索引校验，然后恢复归档。解除归档前原子保存恢复意图；失败时保留记录，下次即使已经没有待修复索引，也会继续恢复归档。未知错误仍停止，原有进程检查及字节／ordinal 完整性校验继续执行。

同一副本修复后通过，`migrated: 0`（没有 rollout 重写），所有线程的归档状态和持久线程数量保持一致。原始 Codex 配置、登录和历史未在本轮切换或迁移；真实应用需用户结束当前工作后触发。

## Antigravity 额度

对用户所述账号只读查询确认：production 和 daily 的 `retrieveUserQuotaSummary` 都只返回 Claude/GPT 周及五小时窗口；Gemini 在 `fetchAvailableModels.models[*].quotaInfo` 中报告。

现在成功取得汇总后仍补充模型额度，动态读取模型 ID、显示名、剩余比例和重置时间，不硬编码 Gemini 模型列表。保留零剩余额度，排除明确标记为 internal 的模型。某一来源失败时保留另一来源的结果并说明覆盖不完整。相同百分比不被当作共享池的证明，也不累加模型额度。来源错误解释不再将某个 Antigravity 模型或已知第三方池的耗尽套用到无关模型。

生产解析器的只读实测得到 2 个汇总窗口、17 个模型窗口，其中 12 个 Gemini 窗口。安装版界面已确认原账号的 58%／1% 已用汇总和 Gemini 额度同时显示。

## 操作反馈

弹窗中的 Thinking 现在在弹窗内部显示；现有阶段文字和进度条保持可见。页面级反馈显示具体操作文字，打开弹窗时隐藏，移除其全屏背景模糊。进度、失败、重试和结果仍使用原固定弹窗。

构建后 Electron 界面回归修前失败于弹窗内反馈缺失，修后通过。已打开并检查 `release/client-capabilities-ui/03-claude-apply-progress.png`，操作阶段清晰可见。

## 共存和子代理

扩展 `scripts/codex-coexist-smoke.mts --subagents`，使用实际安装的 Codex、生产 TokenFlow 服务、合成 ChatGPT 登录及模拟上游。官方主会话显式创建网关模型子代理，实际路由为 `official → official → gateway`，子代理完成；凭据分流断言通过。测试关闭 Apps 功能以排除合成登录导致的远程 MCP 启动失败，没有修改真实用户的 Apps 设置。

官方文档说明未指定模型时子代理继承父模型，且自定义 agent 文件中的 `model_provider` 不覆盖父配置。TokenFlow 共存通过同一个受控 provider 按模型 ID 分流，不能把本结果解释成 Codex 原生允许任意 provider 混用。参见 [OpenAI 官方子代理文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)。

## 验证与交付

- 9 个定向测试文件、139 项通过，覆盖切换生命周期、账号切换／恢复、共存、历史、索引、额度与来源错误说明。
- 类型检查、生产构建、`git diff --check` 通过。
- Electron 界面检查通过，实际打包运行时 19 项检查通过。
- arm64 应用 ad-hoc 签名和严格验证通过；安装后工作台 HTTP 200，窗口可操作。
- `/Applications/TokenFlow.app` 为 `10.15.26.62`；旧版保存在 `release/v10.15.26.61/installed-before-62.app`。
- 安装版与验收构建 app.asar SHA-256 一致：`54261b6fad9a83bdbb9c08cbf0842e09e4ed78ecbc5af803ba411a352bdc9aeb`。

没有据此宣称所有真实上游长对话均已验证。真实模型权限、供应商响应及用户原始切换场景仍需安装后的实际使用确认。


## 10.15.26.63：额度展示精简

用户反馈 19 行全部展开容易误解为独立额度。采集保持完整，默认展示原 Claude/GPT 两个周期与一个 Gemini 概览，其余 17 个模型窗口折叠在“按模型查看”。这只改变显示，不累加、不修改上游百分比。Gemini 各模型数值不同则显示剩余范围，不编造统一重置时间；未来未知模型保留“其他模型”概览与明细。

- 新增 `tests/quota-presentation.test.ts` 三项回归，与额度解析测试共 21 项通过；类型检查和构建通过。
- 新增 `scripts/antigravity-quota-ui-check.cjs`，隔离夹具验证默认三行、原百分比不变、完整明细可展开、窄窗口容纳且没有账号变更；截图已检查。
- 新安装包的 19 项运行时检查及 ad-hoc 签名严格验证通过。
- `.62` 安装备份：`release/v10.15.26.62/installed-before-63.app`。

Codex 后端修复与 `.62` 相同。没有为此次显示调整重复触发真实 Codex 切换，前述真实历史副本和模拟上游测试的边界仍适用。

`.63` 安装后 app.asar 校验一致：`35ad27d3483f976bff85e0c4597716823b227c8cb7071fadb0c73e9d70dd7c7e`。首次启动进程采样显示主线程阻塞在 macOS `SecItemCopyMatching`，系统 SecurityAgent 正在运行；工作台尚未监听 9527。Computer Use 明确禁止操作 `com.apple.SecurityAgent`，已请用户在系统窗口完成钥匙串授权。安装版真实账号界面验收等待该操作；隔离界面验收已经通过。

用户完成钥匙串授权后，`.63` 已正常启动。安装版实际界面复核：原反馈账号默认只显示三项（Claude/GPT 周剩余 42%、五小时剩余 99%、Gemini 剩余 100%），17 个模型明细可以展开并重新收起；最后保留收起状态。Codex 页显示官方登录仍使用中，网关仍为待应用，未触发真实切换。安装版界面验收已完成。

## Hub 请求标识对照验证

同一已授权账号，经运行中的 CLIProxyAPI `/api-call` 只读查询，使用同一个 project，未输出任何凭据：旧 `antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)` 在 daily 返回 HTTP 200，但只有 `3p-weekly`、`3p-5h`。改为 Management Center 的 `antigravity/hub/2.23.0 darwin/arm64` 后，daily、sandbox 和 production 均返回四个周期窗口。daily 当次 Gemini 周剩余 0.97616976，五小时剩余 0.9409276；Claude/GPT 周 0.4201076、五小时 0.994592 不变。不同端点的 Gemini 数值有轻微差异，因此按上游顺序优先 daily，不混合各端点的读数。

源码已同步 Hub UA 与 daily → sandbox → production 顺序。新增身份相关回归在修改前失败、修改后通过，额度与展示测试共 21 项通过。原模型明细保留为补充数据，存在 Gemini 周／五小时汇总时直接展示这两个窗口。此项改动尚未重新打包安装；不重启正在承载当前会话的网关。

## 10.15.26.64 安装验收与共存依赖

用户要求切换后，安装 .64。生产构建、签名严格检查、打包运行时 19 项通过；旧版保存在 release/v10.15.26.63/installed-before-64.app。启动后工作台 HTTP 200，实际 Antigravity 页面确认 Gemini 周／五小时和 Claude/GPT 周／五小时四个窗口恢复。

更新停服期间官方模型会话也中断。当前共存配置 model_provider=token_flow，base_url=http://127.0.0.1:9527/codex/v1，requires_openai_auth=true。官方模型仍经 forwardOfficialCodex 转发到 OpenAI；官方登录保留不等于网络直连。origin=native 标签表示本机日志来源，不能证明绕过网关。此次安装只停止 TokenFlow 路径下的进程，未主动退出 Codex。转发服务独立生命周期、更新不中断在途请求及来源标签纠正仍待实现。
