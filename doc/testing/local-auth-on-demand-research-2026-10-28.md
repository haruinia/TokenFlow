# 本机授权按需读取与凭据引用调研

日期：2026-10-28（America/Los_Angeles）。只读源码、合成测试；没有打开用户真实凭据、读取提示词或调用真实账号接口。

## 结论与本轮最小边界

进入程序时不批量读取其他应用认证，可以独立实施。应把「TokenFlow 已经保存且用于已配置服务的凭据」与「首次发现/导入其他应用的本机认证」拆开。删除自动 discoverLocal 调用不够：用量身份观察、状态 GET、Cursor 状态检查和 Codex 官方对账快照也是读取入口。

建议本轮只完成按需读取，保持已导入账号服务工作。凭据仅保存外部引用应作为独立功能，不宜用路径字段替换现有 auth-file 内容后声称完成。

## 已确认的读取入口

| 入口 | 实际行为 | 按需改造 |
|---|---|---|
| `apps/desktop/src/main.ts` 启动 | `service.discoverLocal()` 批量导入 Codex、Claude、Qoder、Qoder IDE、Antigravity、两种 WorkBuddy、Trae | 启动改为只加载已保存来源/启动网关；不再发现外部认证 |
| `service.ts` 的 `observeNativeLogins()` | 创建服务时、onListen、每 5 秒、每次 nativeUsageSnapshot 都调用七种原生账户 usageLogin | 本次会话尚未明确读取的 provider 不调用；未知身份保持未知，不假装登出，也不能将旧观察时间延长 |
| `AgentsPage.tsx` | 页面挂载同时启用五种 `useNativeLogin` | 默认可取无凭据状态；不因挂载隐式读取认证 |
| `AccountsPage.tsx` | 挂载同时启用七种原生登录，Cursor/Trae 在当前 tab 启用 | 切换 tab 不等于导入许可；改为同样无凭据状态 |
| `native-login.ts` → GET `/api/codex-accounts`、`/api/native-accounts/*` | status 实际读取 auth.json、钥匙串、认证数据库；refresh=1 可重试系统读取 | 后端默认返回「未读取」状态，不只依赖前端隐藏；显式 import/inspect 后返回真实 revision |
| Cursor GET 状态 | `CursorLocalLogin.status` 读取 state.vscdb accessToken，并调用 GetMe 校验 | 未明确读取时不能调用；当前缓存只是减少请求，不等于没有读取 |
| Codex reconciliation worker | main 以全局 allowCredentials 设置 allowOfficial；worker 最初及每 15 分钟调用 officialSnapshot | 官方快照需独立、明确的本机 Codex 授权；仅扫描已存在用量记录可保持启用 |
| `/api/a2a/codex-coexist` GET | `codexCoexistStatus` 会检查本机 auth.json | 默认状态也需受按需读取边界约束；实际启用官方共存是显式用户操作，可读取所需 Codex 认证 |
| 明确 switch/restore/connect | 为并发校验、备份和恢复读取当前本机认证 | 保留显式动作所需读取；不能用统一未检测 GET 破坏 revision 检查 |

来源：[桌面启动](../../apps/desktop/src/main.ts)、[服务](../../packages/core/src/service.ts)、[登录 hook](../../apps/console/src/native-login.ts)、[Cursor 本机读取](../../packages/core/src/cursor-local.ts)、[官方对账 worker](../../packages/core/src/codex-reconciliation-worker.ts)、[共存](../../packages/core/src/codex-coexist.ts)。

`CLIProxyManager.startProcess()` 中 `cursor.load()` 读取的是 TokenFlow 自己保存的 `cursor-account`，不是 Cursor 本机数据库。`proxy.nativeUsageAccounts()` 读取的是 TokenFlow 已导入 auth 目录，用于身份映射，不能与外部原生账户扫描混为一谈。`ApiSources.list()` 解密已有来源的 `credentialRef` 以确认 hasKey，也属于现存已配置服务，但后续可独立改为不解密的存在性元数据检查。

## 最小操作模型

后端维护本次进程内的按 provider 读取状态，默认未读取。前端「从本机导入」POST 先允许该 provider 的一次读取，完成导入并返回当前状态；失败可由同一按钮明确重试。状态 GET、页面挂载、定时任务均不能授予读取。

对已有切换/恢复流程，可增加显式 POST inspect，只有用户点击切换或恢复时才取得当前身份和 revision，随后沿用现有乐观并发校验。无凭据 GET 返回独立的未读取状态、空 revision 和可用的池账号元数据，不应使用 signed-out 或伪造 revision。服务端同样限制直接 GET，前端 enabled=false 只能减少调用，不能构成完整边界。

`guardCredentialAccess(allowCredentials, ...)` 目前把启动选择固化为布尔值，同时包住 Claude keychain、Qoder crypto 等。因此即使用户后来明确点击导入，也会提示必须重启。应将本机客户端读取权限收窄到操作/provider 上下文；不要继续用 TokenFlow 自己 vault 的启动开关控制所有外部客户端。若用户启动时跳过自己的 vault，但导入流程需要保存 CredentialHistory，可在这次明确导入动作中激活 vault 的按需访问，随后由系统原生授权窗口决定是否允许；失败保留原值，不要求重启，也不能绕过系统权限。全局记忆选择不应被当成所有客户端的永久导入许可。

## 只存路径或钥匙串引用的真实条件

运行时请求最终必须得到密钥并放到供应商认证字段中。路径引用能减少 TokenFlow 的长期凭据副本，但不能让 TokenFlow「完全不接触 key」。对于钥匙串，引用通常是 service/account 标识，不是文件路径。对数据库是路径加固定记录选择器，对配置文件是路径加受控字段；都需要校验文件类型、大小、符号链接、变化与当前身份。

当前 `importNative` 读出完整 credential，`CLIProxyManager.importCredential` 会先 `CredentialHistory.remember`，再 POST `/auth-files` 写入 TokenFlow 的 sidecar auth 目录。CredentialHistory 在桌面端通过自身加密存储保留授权备份；sidecar 的 auth 文件则含有效 token。故当前实现确实复制保存凭据，不是 path-only。

| 来源 | path-only 可行性/障碍 |
|---|---|
| 普通 API Key 文件/环境/系统钥匙串 | 可用独立 resolver 在请求前读取并仅在内存短暂持有；仍会读取明文；当前 ApiSources 接口是自有 credentialRef，需要新引用类型 |
| Codex/Claude OAuth | 读取 access token 可引用原文件/钥匙串，但 CLIProxyAPI 自行刷新并保存新 token；需要决定刷新归属、避免与原客户端同时旋转 refresh token、明确是否允许写回原存储 |
| Qoder / Qoder IDE | 文件/数据库还需客户端 crypto；`verifyNativeQoder` 可能刷新过期凭据但不修改客户端，因此新凭据可能没有原路径可引用，不能只保留旧路径 |
| Antigravity | 本机数据库字段需解析，网关刷新与原客户端生命周期需独立协调；当前导入是完整 token 对象 |
| Cursor | 导入读取本机 session 验证身份后调用 CreateUserApiKey 创建独立 SDK Key，原本机认证文件并不包含这个新 key，无法仅记录原路径替代 |
| WorkBuddy | 受保护凭据可能无法被第三方解密；现有逻辑复用匹配身份的已授权 grant，并非所有客户端凭据都能通过路径读取 |

来源：[导入与持久化](../../packages/core/src/cliproxy.ts)、[CredentialHistory](../../packages/core/src/credential-history.ts)、[本机 OAuth](../../packages/core/src/local-credentials.ts)、[Qoder 验证](../../packages/core/src/qoder-credentials.ts)、[Cursor 导入](../../packages/core/src/cursor-local.ts)、[sidecar FileStore](../../upstream/CLIProxyAPI/sdk/auth/filestore.go)、[Codex token 保存](../../upstream/CLIProxyAPI/internal/auth/codex/token.go)、[Codex refresh](../../upstream/CLIProxyAPI/internal/auth/codex/openai_auth.go)。

不要用临时明文 auth-file 或指向原文件的符号链接宣称零副本：临时文件仍落盘，符号链接可能被 sidecar 刷新/删除操作影响原认证；不同文件格式也不兼容。

## 必需验证

1. mock 所有本机读/crypto/GetMe，创建服务、listen、访问主页所需 GET、推进 5 秒定时器，未显式导入的读取次数均为零。
2. 显式导入 Qoder 只触发 Qoder，Codex/Claude/其他来源仍零次；系统拒绝不自动循环重试，按钮重试能恢复。
3. GET Codex/原生状态、Cursor tab、用量快照不触发隐式读取；显示未读取而不是未登录。
4. 已保存 pool 与 API Key 服务仍能启动；未导入原生身份保持未知，不扩大归属覆盖时间。
5. switch/restore 显式 inspect 获取真实 revision，并保留原来的变化冲突和备份保护。
6. 启动跳过自身 vault 后显式导入不再被固定布尔值永远阻断；系统拒绝时仍不覆盖原凭据。

本次运行合成测试：`npx vitest run tests/credential-access-service.test.ts tests/credential-access-audit.test.ts tests/local-credentials.test.ts`，3 文件 17 项全部通过。这些测试反映改造前行为，包含「服务创建已发生 Qoder 读取」的明确断言，可作为要翻转的回归点；没有依赖真实本机认证。

补充核查：`CodexReconciliationRecorder.scan()` 本身只读取会话日志及 TokenFlow 已有归属证据，不打开 auth.json；真正让官方引擎加载认证的是 `officialSnapshot()` → `readOfficialUsage()` 启动 app-server，再执行 account/read 与 account/usage/read。因此启动关闭 allowOfficial 可以保留普通日志扫描。`AgentConnections.status()` 仍会读取各客户端配置用于显示路由；一些配置允许内嵌 API Key，应避免把「不自动扫描原生认证」描述成「启动绝不读取任何可能包含 key 的文件」。
