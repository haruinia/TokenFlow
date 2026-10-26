# 客户端与网关修复交付验证（2026-10-23）

本轮依据用户列出的 12 项问题和后续实施授权，按「续聊／历史 → 配置／导入 → 官方与网关共存 → 打包安装」完成。子代理使用 GPT-6.1 Sol、high。UI 遵守 [设计约定](../design.md)：复用既有组件，没有新增框线、背景色块或装饰效果。

## 实施范围

- Codex：修正回退历史的 immutable rollout ID／逻辑 ID 混淆；保留祖先投影，恢复旧版本已丢失的祖先派生索引；失败轮前分支、回退、分页、重启可继续。详情与真实原生 CLI 的隔离验证见 [Codex 修复](codex-continuation-repair-2026-10-23.md)。
- 压缩：完整原文最多四路并行提取、一次完整合并；无缩减时停止额外合并；提取和合并可跨重启复用。约 2.5 MB／七组夹具由七次提取加一次合并完成，不再多轮重复三段整理。这是调度验证，不是对原用户对话真实耗时的承诺。
- 流错误：不完整或无效终结有明确错误事件，不写为成功历史。外部 503／429 仍按真实错误报告，不伪造完成。
- Claude Code：未安装独立 CLI 也能应用 VS Code 扩展共享配置；安装／启动能力单独判断。Claude Desktop 入口保留，默认／快速模型在应用流程中选择。
- 安装更新：开放已有 npm 客户端配方；已安装的全局 npm 客户端沿原 prefix 更新。其他安装渠道继续其既有入口，不擅自跨渠道覆盖。
- Codex 配置：遇到第三方写坏的重复 TOML 表，保留原始私密备份，从可验证合法基线重建应用或恢复；并发修改保护继续保留。详情见 [客户端配置修复](client-configuration-repair-2026-10-23.md)。
- Antigravity Claude：工具声明、历史、工具选择和返回统一转换并反向还原名称；修正 Messages 缓存输入重复计数和 stream 输出 fallback。真实上游工具／签名续轮／Gemini 对照共六次请求成功；usage 用确定性夹具验证。详情及未能追溯的原请求边界见 [模型协议修复](model-protocol-repair-2026-10-23.md)。
- 导航：「使用」前置，「已保存」改为「供应商」。Thinking 沿用已有统一居中反馈和用户已要求的背景模糊；应用流程继续使用同一个固定窗口。

## 供应商导入

在 API 供应商页面复用 FlowDialog 提供预览、勾选、导入。支持本机 CC Switch 的只读 SQLite 数据库，以及用户选择的 SQLite、SQL 备份、旧版 JSON 和通用 API JSON。当前映射 Claude Code／Codex 的静态 API 供应商；官方 OAuth、动态密钥、额外请求头或不支持的协议明确跳过，不猜测配置。

预览仅返回名称、地址、协议、模型与原因；凭据留在服务端有时限的内存预览中。SQL 只解析字面量，不执行文件里的 SQL。导入统一写入现有加密存储，批量配置失败可回滚；预览及提交时都按地址、协议、密钥、模型和模型路由去重。同一密钥增加新模型不会被当作完全重复。九项回归通过，覆盖 SQLite/SQL/JSON、协议映射、重复、事务回滚、选择校验与秘密不出预览。

## Codex 官方与网关同菜单

启用前实时读取当前 ChatGPT 账号的完整官方 catalog，保留全部模型元数据；与所选网关模型合并，ID 冲突拒绝应用。受管 provider 使用官方认证模式和单独的本机连接 Key；不重写 auth.json。

`/codex/v1/responses` 及 `/responses/compact` 按精确 ID 分流：官方目录模型只发固定官方地址，所选网关模型走原来源，未知 ID 拒绝。ChatGPT Authorization 只进官方请求，网关客户端 Key 不出本机。两个入口都解码原生 zstd。网关私有 tfctx／resp_tf 引用在切回官方前按认证范围恢复；原生官方内容、密文、ID 不普遍改写。

已用当前账号只读拉取官方模型目录，HTTP 200、九个模型，没有发送真实官方推理。安装的 Codex 0.163.0-alpha.11.2 在隔离 HOME＋合成官方／网关服务下通过实际 model/list、切换、强制压缩后切官方、失败轮分支及重启；授权文件逐字不变，认证分流断言通过。该结果不能替代真实账号长对话的最终体验验证。

## 验收记录

- 最终 `npm test`：154 个测试文件、1,489 项全部通过，241.59 秒；`npm run typecheck`、`npm run build`、运行时依赖检查与 `git diff --check` 通过。原生 Codex 隔离流程及维护的 sidecar translator 测试另行通过。
- Electron UI 模拟七张截图通过：导航顺序、共存选择、npm 失败沿用结果窗、无 CLI 应用、单一 Thinking、进度／结果窗位置尺寸相同、无边框透明导入列表、760×680 浅色窗口。截图位于 ignored `release/client-capabilities-ui/`。
- 最终 `.57` arm64 与 x64（Rosetta）均通过 `scripts/check-packaged-runtime.mjs`：SDK 加载、网关、压缩、LAN 权限、Claude Desktop 路由、Claude 原生用量归属等。两包包含后补的祖先索引恢复与两架构生产 sidecar。
- 两个应用均通过 ad-hoc 签名与 `codesign --verify --deep --strict`；没有 Developer ID 公证。M／Intel ZIP 位于 `release/v10.15.26.57/`，全文件 CRC 检查通过，ZIP 内 app.asar／sidecar 哈希与已验证 bundle 一致。已安装 app.asar 也与 M bundle 一致。

| 导出包 | SHA-256 |
| --- | --- |
| TokenFlow-10.15.26.57-mac-M.zip | `706998a8601b8bbca3312fc6cb82675b18f9fe19bc0f863b698ade5b7cb0050d` |
| TokenFlow-10.15.26.57-mac-Intel.zip | `1b07723b0d8f349795893ba3d2282cf016ff46bca18a6a97d82dc85fa0e8df3d` |

- `/Applications/TokenFlow.app` 已安装 `.57`，旧 `.55` 与中间 `.56` 应用保存在各版本 release 目录；没有删除资料或用户凭据。用于诊断的 loopback inspector 已关闭，最终启动未开启调试端口。

## .57 交付时尚需系统交互的验证

后续用户已完成授权，实际计数、Grok A/B 和生产修复结果已补记在 [2026-10-24 授权后复验](credential-grok-follow-up-2026-10-24.md)。以下保留当时状态。

本机安装启动遇到 macOS 钥匙串受保护读取，主进程采样位于 SecItemCopyMatching／SecKeychainItemCopyContent，等待系统授权；已请用户在系统窗口完成验证，不读取或保存系统密码，也不改钥匙串权限。

因此此时尚未完成当前已保存 SDK key 的 Grok 4.7 默认参数／256k 对照。已有原生 OAuth 经正确系统代理访问 SDK catalog 得到 401，这不等同于 SDK key 失败，也不能据此判定 Grok 模型不可用。生产模型参数没有凭猜测修改。

凭据修复包含并发读取合并、按客户端复用加密子进程和内存结果复用；源码七项回归已经通过。不同客户端属于不同受保护条目，不能承诺所有平台总共只弹一次密码框；实际安装后的系统提示次数须如实记录。
