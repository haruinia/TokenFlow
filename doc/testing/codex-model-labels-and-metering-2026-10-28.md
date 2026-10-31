# Codex 模型名称与官方请求计量（.87）

基于工作区 .86（包括用户的 Antigravity 修复），仅调整模型展示和官方响应计量。未改上下文转换、压缩、子代理派发协议、provider 或权限。

## 展示

- 官方模型保留官方目录的 display_name 与排序，不增加“OpenAI 官方”字样。
- 网关模型按所选顺序排在官方目录之后，展示为 `来源/模型`，去除 `TF ·` 前缀。
- 展示名称与派发 ID 分离；子代理完整目录仍有独立 source 字段，实际传入 slug。
- 安装的官方 Codex 引擎在隔离 HOME 中执行 model/list 验证通过；未发起推理，官方名称与排序一致，新增项是 Example/Gemini、Example/DeepSeek。

## 子代理用量核查

只读扫描 sessions、archived_sessions 的元数据及 token_usage_record，要求记录的 thread_id 等于子会话 ID，并按 response_id 去重；没有输出消息、工具参数、原始响应 ID 或凭据。

命令：`node scripts/codex-subagent-usage-audit.mjs --check --since 2026-10-27`。

结果见 results/codex-subagent-usage-2026-10-28.json。以 America/Los_Angeles 日历日为准。最近轨迹只保留 1000 条，过期轨迹有持久响应证据，但不能据此恢复逐请求账本详情；未将无法关联的响应一概判作漏计。

- 10 月 28 日七牛 DeepSeek 子代理的 2 个成功响应：输入 334,363、输出 865，总计 335,228 tokens；与网关轨迹逐响应一致，账本包含对应分组。缓存 172,288 已包含在输入中。
- 子代理没有独立的统计维度；用量归入 Codex、来源、模型等现有维度。
- 官方模型确有漏计：近期 773 条官方轨迹均缺少响应标识，账本成功请求显示未测得；部分子会话原始用量同时被本机索引按 token_flow provider 排除。这也影响官方主对话，不是子代理专属问题。

## 根因与验证

真实最小请求返回 HTTP 200、Content-Type application/json，实际正文却是 SSE（包含 response.completed、response.id、usage）。旧观察器按 MIME 选择整段 JSON 解析，因而丢失响应标识与用量。

先在真实 service 边界构建失败测试：7 次官方请求中，一次 SSE 使用 application/json 头，计量得到输入 60、输出 6、未测得 1，而正确值为 70、7、0。

修复为官方转发显式启用观察器自动识别正文格式。识别只用于计量，传给 Codex 的每个字节及响应头不变。其他调用方保留原来的显式格式；JSON 和 SSE 共用既有计量与去重逻辑。

真实响应的旧/新观察器对照：旧版 input/output=null、无响应标识；新版输入 19、输出 5、缓存 0、有响应标识，精确匹配官方完成事件。测试请求仅使用合成短文本。未修改用户生产用量记录；真实诊断请求由现有网关自然记录。

历史未测得条目未自动回填：旧轨迹没有响应标识，不能凭模型与时间猜测匹配。该修复从新版进程运行后计量新请求，不能宣称已经补齐旧账。

## 检查与安装

- 8 个相关测试文件共 144 项通过，typecheck 通过。
- 自动识别测试覆盖 JSON、SSE、字节切分、BOM、事件前缀、心跳、缺失完成事件，验证输出字节不变。
- 生产构建通过，Apple Silicon 包的 19 项隔离运行检查通过，ad-hoc 签名校验通过。
- 反重力 sidecar 与已安装 .86 的 SHA-256 一致：4390f754fbd44b279d431d9c7bec531e04dac48ce55b0fb92dbc038b550b243d。
- .87 使用 macOS 原子目录交换安装，保留 .86，不终止 TokenFlow/Codex，不改 Codex 配置或登录。安装回执在 release/model-usage-87/install-receipt.json。
- 磁盘更新不等于运行中升级：用户需重启 TokenFlow 后启用新计量，并重新应用所选模型、按客户端提示重新加载 Codex 以更新名称。
