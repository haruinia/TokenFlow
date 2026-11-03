# Claude Desktop API 直连与备份开销复核（.104）

基于 `dcfa535`（.103）。本轮不切换生产客户端、不读取生产会话正文、不发供应商测试请求。菜单栏当前桌面 panel 的 .103 修复保留。

## Desktop 接入

- 「直连」分别显示官方账号与 API 来源，复用现有 API 来源选择器和应用进度窗口。应用读取已经保存的 Messages 路由，不重新探针，不要求再选具体模型。
- Desktop 使用自身 `Claude-3p/configLibrary` 的第三方推理 profile；`inferenceGatewayBaseUrl` 是来源地址，`inferenceGatewayAuthScheme=x-api-key`，模型菜单保留真实 ID。这里的原生 `gateway` 是 Desktop 对第三方 HTTP 服务的命名，不代表流量经过 TokenFlow。
- 只支持 Desktop 原生认可的 Claude 模型，且同一菜单共享同一个已保存的 Messages 地址。非 Claude 或需要协议转换的模型仍使用现有 TokenFlow 网关。保留 tenant / anthropic 路径，只去掉 Messages SDK 自动补充的末尾 `/v1`。
- 官方账号 cookie / 钥匙串不读写；Claude CLI 的配置独立。API A/B、网关与 API 之间共用配置事务和原始恢复点；恢复账号直连明确回到 `1p`，不隐式恢复旧网关。
- 网关的别名生成和直连 profile 生成分开，API 不生成 TokenFlow 客户端 Key。网关转直连时撤销旧网关 Key；删除 API 来源时级联恢复官方入口。API Key 仍按客户端要求写入本机私有配置，并存入现有加密恢复记录；这不属于“不接触 Key”的实现。
- 原生能力依据：本机 Claude Desktop app.asar 中 auth scheme 接受 `bearer` / `x-api-key`；原生模型检查过滤非 Anthropic 路由；支持 `anthropicFamilyTier` / `isFamilyDefault`。未修改 Desktop 或其引擎。

## 备份优化

问题一：原来只有等长改写能保存稀疏片段；分散的模型名变长会复制中间几乎全部正文。新增 JSONL 记录复用格式：未变化的记录引用不可变父版本字节范围，只保存新记录。选择增量格式时计入元数据开销，不划算则保留旧策略。限制记录数与重建范围，重建后仍验证完整长度和 SHA-256。

- 同一合成历史 4,001,880 字节，20 处模型名变长：原增量 3,801,816 字节，新增量 1,300 字节（约 0.0325%）；两个版本逐字节还原一致。
- 保持原有基线、旧前后缀增量、等长稀疏增量可读。保留修订 ID、父链和所有恢复引用，回访旧修订不写出循环。
- 新的记录增量需要 .104 或更新版本读取；旧程序遇到它会校验失败而停止，不应使用旧程序处理新恢复点。没有重写生产历史备份格式。

问题二：路由切换同步执行全库内容去重，会读取大量历史 SQLite / JSONL。现在切换仍执行引用存在性、路径边界、父链环检查和未发布载荷清理，但不读取所有历史文件来比较内容或权限。实际捕获／恢复的历史仍执行内容校验。全库内容去重保留在独立维护器中，本轮未对生产目录运行它。

- 隔离 192 MiB 历史数据库基准：完整整理 227 ms、读取哈希 12 份；切换所需检查 21 ms、哈希 0 份，12 条引用一致。这不是全流程切换时间或生产加速倍数承诺。
- 新增对话才创建基线；原有对话按文件身份与修订复用，现有数据库基线继续共享。没有改回“每次复制全部对话”。
- 2026-11-01 仅读目录元数据：thread backups 14,580 MiB / 1,608 文件；context backups 14,792 MiB / 228 文件；history backups 16,618 MiB / 14,389 文件。合计约 44.9 GiB 逻辑大小，与上次审计一致，不等于独占物理占用或可释放空间。API direct 只有 13 个小配置文件。
- 尚未按时间清除历史恢复点；仍被清单、父链或基线引用的文件不是无依赖垃圾。没有为减少体积删除它们，也没有自动缩写现有会话。

## 验证

- 101 项相关回归覆盖：Desktop 配置／API／网关服务、Claude CLI API、Codex API、迁移、历史增量、维护器与账号 UI。新增失败复现先于修复；验证变长改写、插入／删除、Unicode、旧修订复用、损坏片段拒绝、网关 Key 撤销、删除来源、重开失败与重试。
- 本机 Desktop 内置 Claude Code 2.1.309 对合成 Messages 上游验证通过：准确 URL、真实模型 ID、x-api-key，TokenFlow 中转和生产供应商请求均为 0。此项验证内置引擎传输，未自动操作真实 Desktop 聊天界面；实际供应商是否接受请求由来源服务决定。
- Electron 隔离界面检查：来源选择、不可用协议、官方/API 状态、恢复入口、原有网关与 CLI 切换通过。界面截图位于 `.tmp/claude-desktop-api-ui/direct.png`。
- 结果：`results/claude-desktop-api-native-2026-11-01.json`、`results/codex-variable-length-backup-2026-11-01.json`、`results/codex-backup-switch-benchmark-2026-11-01.json`。

## 安装

typecheck、构建、20 项打包运行时检查与签名核验通过。已替换 `/Applications/TokenFlow.app`；9527 网关 PID 未变、HTTP 200，Codex 配置／认证、Claude CLI 设置及 Desktop 模式文件哈希均未变。手动重启 TokenFlow 后加载 .104。

安装回执：`release/v10.15.26.104/install-receipt.json`；原程序保留在 `/Applications/.tokenflow-before-104-x51XI0/TokenFlow.app`，当前运行进程仍依赖它，不能当作垃圾删除。本次隔离测试的 Electron 临时副本完成检查后清理。
