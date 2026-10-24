# 认证读取与原需求总复核（2026-10-24）

接续 `.58`，本轮基线为 `cccc283`。用户澄清「允许」有 6 次系统提示，「始终允许」有 2 次，项目涉及 TokenFlow、Qoder、Qoder IDE。子代理继续使用 GPT-6.1 Sol high。只修复可复现的问题及原需求遗漏；不新增框线、色块或装饰效果。

## 钥匙串次数：应用重复读取与系统授权分别验证

本轮先用合成凭据复现：Qoder 状态/用量读取之后自动导入再次解密；拒绝后导入绕过已有失败缓存；Claude 后台观察重复读取同一拒绝版本；TokenFlow 加密文件失败后再次解密，成功读取后写入又解密旧值。修复共用的 `RevisionCredentialAccess`，按凭据作用域及源版本合并在途、成功、失败结果。主动刷新只重试失败；写入校验可以要求新读取。源文件的异步读取也处于变更版本检查内，旧读取不会覆盖刚写入的新值。Secrets 同名写入/删除串行、临时文件唯一，不同凭据独立。

这些回归证明减少了应用重复访问，**不证明新版本的系统提示次数已经减少到某个数字**。本轮没有修改钥匙串 ACL、保存系统密码或复制其他客户端的主加密密钥。

实际 runtime 是 Electron 40.10.6 / Chromium 144.0.7559.236。对应 [Chromium OSCrypt 源码](https://raw.githubusercontent.com/chromium/chromium/144.0.7559.236/components/os_crypt/sync/os_crypt_mac.mm) 已在每个进程内缓存解密密钥；[Keychain 实现](https://raw.githubusercontent.com/chromium/chromium/144.0.7559.236/crypto/apple/keychain_secitem.mm) 通过一次 `SecItemCopyMatching` 查询指定项目。不能把每次 `decryptString` 都当作一次新的系统取钥。

[Mozilla 的原生导入问题记录](https://bugzilla.mozilla.org/show_bug.cgi?id=1582486#c4) 还实测过一次 `SecItemCopyMatching` 出现两次确认。因此“三套项目各两次”与本次观察相符，但只是候选解释，未在这台机器上逐窗追踪，不能认定六次全部由此产生。不同项目仍由 macOS 分别授权，不能承诺首次总共一次。

当前导出包为 ad-hoc 签名。按 [Electron 官方说明](https://www.electronjs.org/docs/latest/api/safe-storage#synchronous-api)，缺少持续有效的签名会使更新后系统无法确认同一应用，从而再次询问。正式发行使用稳定 Developer ID 签名是更新授权稳定性的另一项工作；本轮未伪造证书或改权限绕过。

没有加入跨启动的原生凭据副本。若以后进一步减少启动读取，应在统一自动发现流程中，以精确源密文版本和仍可用的已导入授权共同确认是否可复用；单独持久化一个“已登录”标记会掩盖外部账号切换或失效，不能作为本次快捷修补。

## 原 12 项问题逐项复核

| 原问题 | 当前实现与本轮补充 | 验证边界 |
| --- | --- | --- |
| 1. 失败后换模型断流、503 后分支/编辑 | 原历史索引/祖先修复继续保留；本轮统一处理底层断流、坏 SSE、失败终结和取消，失败不写为成功历史 | 合成流故障及原生 Codex 隔离流程；外部 503 本身仍如实报告 |
| 2. 只有 VS Code 插件也能应用 Claude Code | 配置能力与 CLI 安装/启动能力分开，应用共享设置不再要求 CLI | 配置/服务回归；未在真实 VS Code 插件发送聊天 |
| 3. 本地 Agent 直接安装/更新 | 支持已有固定 npm recipe；已安装 npm 客户端沿确认过的全局 prefix 更新；其他渠道沿原入口 | 模拟安装、更新及渠道测试；未实际升级用户客户端 |
| 4. 第三方写坏 Codex TOML 后可覆盖/恢复 | 备份原始坏字节，基于合法基底重建，保留 revision 并发检查 | 隔离配置/账号/HTTP 回归，未修改用户当前 Codex 配置 |
| 5. 从 CC Switch 导入 | 复用 API 来源及现有导入窗口；本轮修复显式环境/命令凭据被错误替换为全局密钥的缺口 | 合成 SQLite/SQL/JSON，去重/事务/认证来源测试；不执行导入文件中的命令 |
| 6. 官方与网关同菜单分流 | 完整官方目录加所选网关目录，精确模型 ID 分流，登录文件不改写，凭据各去对应目的地 | 已有真实官方目录只读证据；真实 Codex 配合隔离合成上游；未做真实账号长对话端到端 |
| 7. 使用前置、供应商命名 | 已保留；同时复查 Desktop 入口、固定应用窗口及统一 Thinking | 构建后渲染器隔离检查及安装窗口检查 |
| 8. 一直压缩 | 原并行提取/有界合并保留；本轮补目录容量透传、摘要覆盖窗口统一回放，以及在途压缩按来源/模型/授权隔离 | 合成大历史与并发失败回归；不把原 20 分钟归因于单一缺陷或承诺固定压缩耗时 |
| 9. Grok 4.7 不可用 | `.58` 已用同账号真实 A/B 确认 500k 变体拒绝、256k 可用；保持目录与默认值，只对确证情形有界兼容 | 已有生产入口两次真实成功；本轮离线回归，不新增推理 |
| 10. 重启后网关对话消失 | 原 provider/索引/祖先迁移保留；本轮修复压缩摘要持久化恢复时旧 user 复活及当前 user 重复 | 原生 Codex 隔离重启/分页/失败轮分支；未对真实用户历史做迁移操作 |
| 11. Antigravity Claude CLI/Desktop 400 | 工具名协议转换、逆映射和缓存 usage 语义统一处理；不按客户端品牌各打一套补丁 | 先前真实工具/签名续轮/Gemini 对照成功；CLI 请求结构使用模拟上游；未捕获原始 Desktop 失败请求，无法追溯其唯一根因 |
| 12. 合并认证读取并安装验证 | 本轮共用读取版本管理，覆盖拒绝、重试、源变化和写入竞争；保留已有 helper 会话复用 | 应用层计数与系统窗次数分别记录；各系统授权不作一次承诺 |

## 共用机制与尚未覆盖的边界

凭据合并放在通用读取模块；SSE 终结放在共享 reader pump；压缩摘要的认证、覆盖范围与消息等价规则由请求和持久化恢复共用；已完成摘要可跨来源复用，在途调用则必须按真实传输来源隔离。目录容量沿原 registry → 管理接口 → Core 传递，未知仍为未知。以上均有先失败、修复后通过的用例，不通过降低全部模型窗口或伪造完成掩盖错误。

详细证据分别见本轮[凭据复查](credential-read-robustness-2026-10-24.md)、[Codex 复查](codex-robustness-review-2026-10-24.md)与[协议复查](protocol-robustness-review-2026-10-24.md)，以及[前次配置交付](client-configuration-repair-2026-10-23.md)和[前次协议实测](model-protocol-repair-2026-10-23.md)。客户端真实长对话体验、原 Desktop 请求和新安装系统提示计数仍须与模拟测试区分。

复查另保留两个既有边界：Claude 被动读取依赖系统条目 metadata，完全相同 metadata 下外部替换内容须 fresh 校验；`security -i` 写超时仍依赖子进程 close，尚未证明无 close 的异常路径可恢复。这些没有被本次读取缓存修复掩盖，也不记为已解决。没有为理论上所有 OS 故障增加自动重写授权的机制。

## 最终构建、安装和导出

- Typecheck、完整构建、运行时依赖检查和 diff 检查通过。最终后端构建包含最后补充的 SSE DONE 和嵌套错误状态码修复。
- 新 UI 构建的维护 harness 七组检查通过。Desktop confirm/working/error/saved/restart 都保持 440×360 的同一矩形；失败/重试与重启结果留在原窗；一组 Thinking；列表无默认/快速角色标记、说明或高亮，角色仅在应用对话中选择。截图位于 ignored `release/client-capabilities-ui/`，已打开核对。
- 两组真实安装 Codex 程序的隔离 smoke 通过：普通来回切换，以及网关强制压缩后切官方；包含重启续聊、分页、失败轮之前 fork，合成 auth.json 字节不变、认证头分流正确。没有访问真实账号上游或修改用户 Codex profile。
- 两个 production sidecar 已重新构建。`.59` arm64 和 x64（Rosetta）实际打包 runtime 均通过 18 项检查；两包 ad-hoc 深度签名和严格校验通过，没有 Developer ID 公证。
- 最终空闲运行 `npm test`：**162 文件、1,570 项通过**，255.85 秒。前一轮并发打包/检查时，一个 API 来源目录用例等待 10 秒超时；该文件单独 54 项、该场景连续复查和最后全量均通过。现有日志不足以确定超时根因，没有放宽超时或修改生产重试策略。更早一轮在代理仍补 SSE 用例时读到了旧源码，结果没有作为最终验收。
- `/Applications/TokenFlow.app` 已正常替换为 `.59`，已安装 app.asar 与 M bundle 一致。旧 `.58` 保留在 `release/v10.15.26.58/installed-before-59.app`。没有删除用户资料或凭据，也没有终止 Codex。
- 两个 ZIP 全文件 CRC 通过，包内 app.asar 和 sidecar 与已验收 bundle 一致；自动生成的别名 ZIP 已替换为相同签名导出包。临时 inspector 9231 未打开。
- 安装后主进程采样包含 `SecItemCopyMatching` / `SecKeychainItemCopyContent`，工作台尚未监听，正等待用户完成系统授权。已请求用户本机验证并记录项目、次数和按钮选择。**此时不记为安装后认证读取验收完成，不声称新版本为零次、一次或两次提示。**

| 导出包 | SHA-256 |
| --- | --- |
| TokenFlow-10.15.26.59-mac-M.zip | `cce7369c0b12a1eebcbe5b47561b180db713f3947ad550bad847e9780afcbc68` |
| TokenFlow-10.15.26.59-mac-Intel.zip | `71546eaa19f76821cc6265c821d5762b004bd6596777b24aa49c3e60638f567e` |
