# 授权后复验与 Grok 兼容修复（2026-10-24）

接续 [.57 交付验证](client-gateway-delivery-2026-10-23.md)。用户已完成系统验证，并明确反馈该次启动共出现 **2 次密码提示**。这是真实计数，不记为一次，也不在缺少证据时归因到某个客户端。

## 实际凭据读取

在已安装 .57 应用进程内，通过原有 safeStorage 和加密存储读取同一 Cursor 凭据，四个并发调用只执行一次 `decryptString`，四个结果一致，安全存储警告数为零。只输出计数和布尔状态，凭据留在进程内存。

同一进程内对 Claude、Qoder、Qoder IDE 的本机账号状态各发起四次并发读取：全部 HTTP 200。Qoder 和 Qoder IDE 均为 signed-in，新增加密 helper 数为零，复用已经建立的独立会话。Claude 当前为 signed-out；四次不受保护的元数据查询、零次受保护内容读取，**不能据此声称实测通过 Claude 已登录凭据的并发合并**。该边界仍由已有确定性回归覆盖。

用户完成验证后，工作台曾停留在启动提示；随后正常打开。对已安装 .57 进行一次正常 SIGTERM 退出和重启后约两秒可访问工作台，未再次遇到系统授权阻塞。没有证据证明该次启动等待由 helper 退出问题引起。

额外的退出回归模拟 helper 忽略 SIGTERM 和不触发 `close`：旧实现会无限等待。修复后只结束本应用创建的隔离 helper；SIGTERM 后一秒升级结束，再一秒兜底释放自身管道和等待，迟到的旧事件不会清除新会话。该结论来自模拟退出测试，不能替代某台机器上的系统故障诊断。

## Grok 4.7 的真实对照

使用应用中已保存、已授权的 SDK Key，只读取得该账号官方模型目录。目录包含 `grok-4.7`，提供 256k／500k、四种 effort 和 fast 开关的 16 个变体，默认是 500k／high／fast=true。

| 同账号、同模型、同提示词 | 结果 | 耗时 |
| --- | --- | --- |
| 目录默认 500k／high／fast=true | `model_not_found` | 11,758 ms |
| 只将 context 改为目录提供的 256k | finished | 10,439 ms |

两次有界请求均禁用工具、MCP 与本地设置，不执行模型输出；提示词、回答、账号和凭据不记录。由此确认本机当前 SDK／上游拒绝默认变体，而非目录缺少 Grok 4.7。不能据此推断所有账号或未来版本都拒绝 500k。

生产处理保留官方目录与默认选择。只有精确 `grok-4.7` 的 500k 变体明确报 model_not_found、无生成内容或工具活动、且目录提供其余参数完全相同的 256k 变体时，才关闭失败 agent 并尝试一次。成功选择只在当前账号授权、目录和参数范围内短暂复用。其他模型、权限错误、区域拒绝和普通网络错误不触发该兼容重试。

## 生产路径复验

在已安装应用进程内载入修复后的 `CursorProvider`，仅将同一已有授权交给隔离临时 profile，调用实际 `response` 入口两次；未改变用户真实 profile。SDK 边界只观察参数、阶段和状态，没有替换推理实现。结果如下：

- 第一次：500k 在 `wait` 阶段返回 error，生产兼容门允许一次 256k 尝试，后者 finished；最终 HTTP 200／completed，24,020 ms。
- 第二次：仅创建一个 256k agent，直接 finished；最终 HTTP 200／completed，14,777 ms。
- 两次均保持 high／fast=true。共三个实际 SDK send 尝试，其中两个生成成功；不把一次实测耗时当作性能保证。

此前两次验证脚本使用 macOS `/var` 符号链接临时路径，被 `rememberCursorGatewayConversation` 的既有 safePath 保护拦住，均未执行 send。独立检查确认原路径 409、realpath 后通过；只修正诊断路径，没有绕过或修改生产路径保护。SDK agent 与临时 store 已关闭清理。

## 交付复验

- `npm test`：154 个文件、1,518 项通过，247.64 秒；新增 26 项 Grok 和 3 项 helper 退出边界回归。typecheck、构建、运行时依赖检查和 diff 检查通过。
- `.58` 的 arm64 和 x64（Rosetta）均通过 `scripts/check-packaged-runtime.mjs` 的 18 项检查，覆盖 SDK、网关、压缩、原生用量归属和 Claude Desktop 路由。
- 两应用均通过 ad-hoc 签名及 `codesign --verify --deep --strict`；没有 Developer ID 公证。两个 ZIP 全文件 CRC 通过，压缩包内 app.asar／sidecar 与已验证 bundle 哈希一致；各架构自动生成的别名 ZIP 也已替换为同一签名包。
- `/Applications/TokenFlow.app` 已替换为 `.58`，已安装 app.asar 与 M 包一致。旧 `.57` 保留于 `release/v10.15.26.57/installed-before-58.app`，用户资料与凭据未删除。
- 正常启动后的工作台 HTTP 200，原生窗口实际显示「使用／供应商」与 Claude Desktop 页。首次读取窗口曾超时，随后打开；主进程采样为事件循环等待，未见受保护钥匙串调用。没有把“未观察到新阻塞”写成零次密码提示；准确的系统提示计数仍是用户反馈的上一轮 2 次。
- 临时 loopback inspector 9231 已关闭；最终应用通过普通启动运行。

| 导出包 | SHA-256 |
| --- | --- |
| TokenFlow-10.15.26.58-mac-M.zip | `ca151eda6b4c29dd9e2c50ab2ebd374cb91d23dd9eaa3d028d65ec2f6697eab7` |
| TokenFlow-10.15.26.58-mac-Intel.zip | `98086872b86d7117b42bf69315061d57f1c8360b3bc3f15da8b812a0da2ff358` |

本轮只改 Grok 请求兼容与隔离 helper 生命周期，未新增产品 UI、框线、背景色块或特效。
