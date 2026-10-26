# Cursor 模型与凭证读取调研

日期：2026-10-23（America/Los_Angeles，PDT）。范围：用户问题 9（Cursor / Grok 4.7）和 12（凭证读取、加密会话复用）。本轮仅调研：没有实现修复、修改用户选择或配置、打包、触发真实 Keychain 读取，也没有发送可能收费的模型探测请求。

## 结论与证据等级

| 问题 | 已确认 | 推断与未验证 |
| --- | --- | --- |
| 9：08:09 Grok 4.7 返回 400，4.6 可用 | 本机轨迹有两次 `cursor_model_not_found`，随后 Grok 4.6 有真实 200。Cursor 路径采用账号官方动态目录，并原样复制目录默认变体参数。 | 首要候选是 Grok 4.7 默认 500k 变体与 local SDK runtime 不兼容；官方论坛已有同版本 SDK 用户复现和支持人员回复。轨迹没有保存 params，不能证明本次一定发送 500k；当前账号新鲜目录和 256k 实际可用性尚未验证。 |
| 12：4149f08 是否减少重复密码提示 | 代码确实合并同一 Claude store 的并发读取，并按 metadata revision 缓存成功值；Qoder CLI/IDE 各复用独立 helper。7 个针对性 mock 测试通过。 | 它减少保护值读取/OSCrypt 初始化次数，不能保证整个应用只弹一次、跨启动不再弹或多个来源共用一次授权。没有真实系统弹窗计数实测。 |
| 安装版是否已包含修复 | `/Applications/TokenFlow.app` 的 `CFBundleVersion=10.15.26.55`；直接读取 asar 后确认仍是旧的 Claude 每次 `security -w`、Qoder 每次启动 helper 实现。 | 仓库有提交不等于安装应用已包含；本轮没有重新打包或覆盖应用。 |

## 9：Grok 4.7 的实际失败路径

### 本机历史记录（已确认）

只读检查运行 profile 的 `~/Library/Application Support/desktop-browser-agent/gateway-traces.json`。检查时保留 1000 条记录，起始时间 `2026-10-23T14:27:24.307Z`；因此覆盖用户提到的 08:09 PDT，即 15:09 UTC。仅提取时间、白名单模型名、状态、耗时与错误码/脱敏错误，不读取输出提示词、title、工具结果或密钥字段。

| 开始时间 UTC | 当地 PDT | 模型 | 状态 / 错误码 | 耗时 |
| --- | --- | --- | --- | --- |
| 2026-10-23 15:09:14.002 | 08:09:14.002 | cursor/grok-4.7 | 400 / cursor_model_not_found | 23,845 ms |
| 2026-10-23 15:09:37.954 | 08:09:37.954 | cursor/grok-4.7 | 400 / cursor_model_not_found | 10,698 ms |
| 2026-10-23 15:10:31.677 | 08:10:31.677 | cursor/grok-4.6 | 200 | 26,738 ms |
| 2026-10-23 15:11:00.274 | 08:11:00.274 | cursor/grok-4.6 | 200 | 33,082 ms |

同一保留窗口汇总：Grok 4.7 共 6 条，其中 2 条为上述 `cursor_model_not_found`，另 4 条是约 4–6 ms 的 `upstream_invalid_request`；Grok 4.6 共 16 条，其中 11 条 200、4 条 `upstream_invalid_request`、1 条客户端取消。不能把前置参数拒绝与真实上游模型拒绝混为同一种失败，也不能因为 Grok 4.6 有个别 400 就否定其随后成功。

`cursorFailure()` 会将上游 `model_not_found` 或消息中匹配 “model not found” 的错误统一转成 400 / `cursor_model_not_found`，并返回通用描述。该描述不保留上游完整错误；如果上游实际是 “AI Model Not Found / Invalid parameters”，这份轨迹也可能只表现为“找不到模型”。因此它不能单独证明模型 ID 错了或模型被下架。来源：[cursor.ts:263](../../../packages/core/src/cursor.ts#L263)、[gateway-traces.ts:69](../../../packages/core/src/gateway-traces.ts#L69)。

### 模型目录、映射与缓存（已确认）

- `load()` 读取现存授权后刷新；首先使用 `Cursor.models.list({apiKey})`，失败时按重试策略回退至 `https://api.cursor.com/v1/models`。模型不是在 TokenFlow 中静态写死；这里没有 `grok-4.7 → 其他名字` 的别名翻译。来源：[cursor.ts:55](../../../packages/core/src/cursor.ts#L55)。
- 目录按账号维护内存状态；请求路径在距上次检查至少 5 分钟时调用 `refreshIfStale()`。刷新失败时最多保留距上次成功小于 15 分钟的目录；认证/权限阻断会清空。成功时间超过 15 分钟时 snapshot 不再暴露模型。来源：[cursor.ts:56](../../../packages/core/src/cursor.ts#L56)、[cursor.ts:74](../../../packages/core/src/cursor.ts#L74)、[cursor.ts:84](../../../packages/core/src/cursor.ts#L84)、[service.ts:1144](../../../packages/core/src/service.ts#L1144)。
- 发请求前要求模型出现在账号当前 snapshot 中；模型名加 `cursor/` 命名空间暴露给客户端，再以目录原始 `model.id` 发送给 SDK。来源：[cursor.ts:90](../../../packages/core/src/cursor.ts#L90)、[cursor.ts:136](../../../packages/core/src/cursor.ts#L136)。
- 关键实现：直接复制 `model.variants.find(v => v.isDefault).params`，最多覆盖已有目录支持的 effort 参数，然后使用 `Agent.create({model:{id,params}, local:{cwd,...}})`。没有基于 local runtime 对 `context=500k` 的额外兼容过滤。安装 asar 的 `dist/chunk-YBCLEC34.js` 中也具有同一行为。来源：[cursor.ts:137](../../../packages/core/src/cursor.ts#L137)、[cursor.ts:154](../../../packages/core/src/cursor.ts#L154)。
- 因此，目录里有名字只能说明目录广告了模型；还必须检查变体参数、执行路径和实际运行结果。Cursor 官方 SDK 文档也将目录定义为当前账号/团队可见模型和参数，并要求动态发现后显式选择参数。来源：[Cursor TypeScript SDK，Cursor.models.list](https://cursor.com/docs/sdk/typescript#cursormodelslist)。

### 一手外部证据与首要候选（推断）

Cursor 官方的[可用模型说明](https://prod.cursor.com/help/models-and-usage/available-models)列出 Grok 4.7 与 Grok 4.6；这证明产品层面存在它们，不能证明当前账号、此 SDK 路径或某一变体运行成功。

官方论坛 [Grok-4.7 run rejects advertised context 500k](https://forum.cursor.com/t/grok-4-7-run-rejects-advertised-context-500k/172554) 的 2026-09-21 用户原始复现使用 `@cursor/sdk 1.0.31`，与本仓库 [package.json:33](../../../package.json#L33) 一致：目录广告 256k/500k，默认变体为 500k + high + fast；local SDK 对 500k 返回 model-not-found / invalid-parameters，而相同条件切换 256k 成功。

该帖 2026-09-22 的 deanrie 支持回复明确说明目录与 local runtime 不同步，local SDK 当时无法启用该 500k 模式，并建议使用 256k；2026-10-07 另一用户提供 1.0.35/1.0.36 的进一步复现。**这是官方论坛中的用户原始复现与支持回复，不是本机已经重现、不是正式发布说明，也不能据此断言 10 月 23 日上游仍未修复。** 报告所见的错误、SDK 版本、默认变体复制逻辑和 local 路径均与此案例吻合，所以它比“Grok 4.7 静态名称不存在”更值得优先核查。

另一个官方论坛[Cloud Agent Grok 4.7 不可用](https://forum.cursor.com/t/grok-4-7-not-found-in-cloud-agent/172633)记载过云端自身故障及支持回复；这只说明相同错误可能有其他上游原因，不能拿云端案例替代本机 local SDK 诊断，也不建议贸然改成云端来规避。

### 当前目录与真实可用性的边界

已定位只读 `GET /api/local-agent`（返回 snapshot）及 `POST /api/local-agent/providers/cursor/refresh`（已有刷新接口），来源：[service.ts:1010](../../../packages/core/src/service.ts#L1010)、[service.ts:1022](../../../packages/core/src/service.ts#L1022)。后者虽为 POST，其设计是官方只读同步，不更改用户模型选择；但本轮没有调用。

运行进程的本机 API 需要管理员会话认证；profile 内已有 DevToolsActivePort 对应端口不可达，其他当前监听端口也没有现成可用 CDP 会话。本轮没有为了获取目录而读真实 Keychain、解密会话 cookie 或提取真实 API Key。**尚未拿到调查时刻该账号的新鲜 catalog，也未验证 Grok 4.7 的 256k/high/fast 组合实际成功。** 历史 trace 未保存原始 model.params，因此尚不能定案为 500k 问题。

建议后续实现前按顺序核查：在已认证应用进程中只读刷新并仅输出 Grok 4.7 的参数定义/默认变体；核对 local runtime 可用 context；获得真实调用测试的任务授权后，以相同账号比较 256k 与默认变体。若证实不兼容，再设计 local runtime 参数适配，并用参数组合而非模型名建立回归。现有错误提示可补充“目录变体参数与当前运行方式不兼容”的分支，避免只让用户反复刷新。上述均为建议，本轮未实施。

## 12：4149f08 实际保证的内容

提交 `4149f08` 时间：2026-10-23 01:13:46 PDT。核查对象是源码中的会话复用和保护值缓存，不把它们等同于操作系统授权策略。

### Claude Keychain

[claude-accounts.ts:18](../../../packages/core/src/claude-accounts.ts#L18) 的同一个 `claudeKeychain(configDir)` 实例维护 `reading` 和 `cached`：

1. 同时进入的普通 read 共享一个 promise，避免状态轮询、用量读取等并发调用各执行一次受保护读取。
2. 普通 read 先运行无 `-w` 的 metadata 查询，以 stdout/stderr 哈希作为 revision。revision 未变时返回上次成功读到的值；变化后才执行带 `-w` 的受保护值读取。
3. `fresh:true` 等待当前读取后清缓存；写入也先等待并清缓存，写后强制读取校验，避免同一 metadata 时间粒度下漏掉冲突或写入失败。
4. 拒绝/错误清空缓存，不缓存“不可读”结果；不存在（security code 44）返回 null，明确的系统拒绝仍会报错。

[main.ts:82](../../../apps/desktop/src/main.ts#L82) 只建立一个 store 并通过带 guard 的接口传给 service；service 中原生账户状态和本地凭证导入复用这个注入实例。来源：[service.ts:269](../../../packages/core/src/service.ts#L269)、[service.ts:308](../../../packages/core/src/service.ts#L308)、[service.ts:704](../../../packages/core/src/service.ts#L704)。因此正常桌面进程这些路径共享缓存，**不是跨所有 store 实例、所有 configDir 或所有进程的全局锁**。

它保证的是同一实例并发合并、同 metadata 时复用成功值。metadata 查询仍有子进程开销；缓存没有独立 TTL，外部变更检测依赖 Keychain metadata 变化。它不能保证系统锁定、访问控制变更、首次授权或新进程启动后不再提示。

### Qoder CLI 与 Qoder IDE

[qoder-crypto.ts:14](../../../apps/desktop/src/qoder-crypto.ts#L14) 在每个导出的 client closure 中惰性创建一个 helper。多个请求复用 stdin/stdout 的逐行 JSON 协议，通过自增 id 对应 pending promise；helper 持续循环处理 safeStorage encrypt/decrypt。CLI 的 app 名为 `Qoder App`、IDE 为 `Qoder`，分别拥有独立 helper 和临时 profile，以保持原生加密身份隔离。来源：[qoder-crypto.ts:57](../../../apps/desktop/src/qoder-crypto.ts#L57)、[qoder-crypto.ts:63](../../../apps/desktop/src/qoder-crypto.ts#L63)。

helper 失败或请求超时会拒绝该会话全部 pending、关闭进程并清除会话引用；下一次显式请求可以新建 helper。应用退出时统一关闭。来源：[qoder-crypto.ts:30](../../../apps/desktop/src/qoder-crypto.ts#L30)、[qoder-crypto.ts:48](../../../apps/desktop/src/qoder-crypto.ts#L48)、[main.ts:145](../../../apps/desktop/src/main.ts#L145)。

这减少“每读一个凭证都启动一个 Electron/OSCrypt 会话”，没有把 CLI/IDE 两个安全存储合并。明文请求值经管道进入 helper，不进入 argv/env，也没有明文磁盘缓存；Windows 临时 profile 只复制 DPAPI 包裹的加密 key，来源：[qoder-crypto-profile.ts:6](../../../apps/desktop/src/qoder-crypto-profile.ts#L6)。

Electron 官方 [safeStorage 文档](https://www.electronjs.org/docs/latest/api/safe-storage#platform-specific-key-providers)说明 macOS 使用应用 Keychain，系统可能阻塞等待用户输入；应用签名不稳定也可能导致更新后再次提示。这里 helper 复用并不控制 Keychain ACL、用户是否只允许一次、系统锁定或代码签名身份，故不能承诺“TokenFlow 只问一次密码”。

### 测试结果与未覆盖内容

本轮执行：`npx vitest run tests/claude-keychain-read.test.ts tests/qoder-crypto-session.test.ts`，2 个文件、7 个测试全部通过。

- Claude 的 3 个测试覆盖：4 个并发读 + metadata 不变后续读只做 1 次保护值读取，revision 变化重新读取，拒绝后可重试，fresh 绕过 metadata 缓存。
- Qoder 的 4 个测试覆盖：同 client 4 个并发请求只启动 1 个 helper，CLI/IDE 独立，退出关闭，失败重建，pending 不挂起。

来源：[claude-keychain-read.test.ts](../../../tests/claude-keychain-read.test.ts)、[qoder-crypto-session.test.ts](../../../tests/qoder-crypto-session.test.ts)。所有测试都 mock child_process / Electron；**未覆盖真实 macOS 弹窗次数、Keychain ACL、跨版本签名授权，也没有真实安全存储读写实测**。

## 实际安装应用核验

- `/Applications/TokenFlow.app/Contents/Info.plist`：`CFBundleVersion=10.15.26.55`。
- `app.asar` 文件时间为 2026-10-23 00:23 PDT，早于 4149f08 的 01:13 PDT；文件时间只作旁证，结论依赖下一项源码核查。
- 只读提取 asar 到 `/tmp/tokenflow-credentials-research`：`dist/main.js:51` 的 Qoder 仍是每次调用创建 profile、spawn helper，然后 `stdin.end(JSON.stringify({operation,value}))` 的单次协议；`dist/chunk-YBCLEC34.js` 的 `claudeKeychain.read()` 仍每次直接执行 `security find-generic-password ... -w`，没有 `reading` 或 metadata cache。这两项直接证明安装包未包含对应 credential fix。
- asar SHA-256：`73f95abf0389607bad4195eb507ea5bfae5c8c898b33401a6d50bd72c05fc626`，用于定位本次核查包。
- `codesign -dv --verbose=2` 显示 `Signature=adhoc`、`TeamIdentifier=not set`。结合 Electron 官方文档，跨构建签名身份导致重新授权仍是需要验证的风险；不能据此直接断言本次每一个弹窗均由签名触发。

建议的验收分两部分：先在未来明确授权的构建/安装阶段确认 asar 具有复用实现，再在真实系统中分别记录首次读取、同进程多次刷新、CLI 与 IDE 两种来源、重启和更新后的弹窗次数。产品表述应为“复用读取/加密会话，减少重复授权请求”，不应写“全应用永久只授权一次”。本轮没有执行这些安装或真实授权操作。
