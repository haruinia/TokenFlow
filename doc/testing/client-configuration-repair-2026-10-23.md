# 客户端配置与安装修复验证（2026-10-23）

范围：Claude Code 仅 VS Code 扩展时应用共享配置、已有 npm 客户端安装与更新、Codex 重复 TOML 的应用/官方恢复/账号恢复，以及“使用”导航前置和“供应商”命名。修改前已阅读 `doc/design.md`、`.impeccable.md` 和客户端兼容调研。复用现有 FlowDialog、进度和结果窗口，没有新增样式、框线或效果。

## 实现与保护

- `AgentInstallation.configurationSupported` 将配置应用能力与独立可执行程序的 `installed` 分开；Claude Code 没有独立 CLI 仍可应用本机共享配置。保留 Claude CLI / Claude Desktop 切换，安装入口继续可用。
- 固定 npm 包名、官方 registry 与无 shell 的执行方式保持不变。根据经过包名核对的安装元数据推导当前 prefix；已有 npm 客户端在原 prefix 更新。非 npm 桌面渠道继续打开原官方下载页面。更新探测只把 npm 安装与 npm 版本比较。未执行真实安装或更新。
- Codex 无法完整解析时，先选择最近合法日志映像并移除旧路由，只保留非路由设置；没有合法映像则重建最小配置。没有用正则删除重复 TOML 表。
- 覆盖前在 `agent-backups/codex-repair-<uuid>.json` 私有备份中保存完整坏文本、原始字节的 Base64、revision 与时间，文件权限为 0600。应用 journal 另存坏文件 `previousConfig`。公开状态和预览仅返回脱敏 recovery 策略及说明。
- A2A 应用、恢复预览、native 恢复、官方模型预检及 CodexAccounts 原登录恢复共用合法基底策略。原始坏文件备份可以逐字节取回；常规恢复写合法目标，不重新播放坏 TOML 或旧网关。
- 覆盖仍检查最初 revision、落盘前当前 revision，并用临时文件原子替换。账号恢复还核对登录凭据；不同外部账号不会被坏 TOML 修复覆盖。账号文件写入失败时只回滚本次写入且未被更新的字节。

## 合成 red → fix

先新增并运行合成用例，确认原实现失败：5 条 A2A 配置路径因重复表抛 TOML 错误/阻止恢复；3 条安装能力用例表明自定义 npm prefix 无自动更新、Claude 配置能力未区分、native 渠道被错误比较 npm 版本；2 条账号恢复用例因 status 先解析坏 TOML 无法取得恢复 revision。修复后通过。

验证命令与结果：

- `npx vitest run tests/agent-connections.test.ts tests/agent-installation.test.ts tests/agent-updates.test.ts tests/agent-model-switching.test.ts tests/agent-lifecycle.test.ts`：131 条通过（含 78 条 Connections）。
- `npx vitest run tests/client-configuration-repair-service.test.ts`：2 条 HTTP 端到端通过，覆盖重复 TOML 的 connect → restore-preview → native restore，以及原登录 status → restore；确认错误文件密钥不泄露到响应。
- `tests/codex-accounts.test.ts`：16 条通过，含重复 TOML 原登录恢复、外部登录拒绝、较新并发配置保留。
- `npm run typecheck`：通过。
- `git diff --check`：通过。

配置修复阶段合并定向集（上述 7 个测试文件）149 条通过。补充 `tests/codex-accounts-service.test.ts` 2 条 HTTP 回归通过，共 151 条。补充回归曾发现并行开发中的 `CodexContext.rewrite` 对不存在临时 Codex 目录执行 readdir 导致 ENOENT，主代理修复后复验通过。该错误未触及真实用户目录。

覆盖的关键断言：最小配置修复、合法备份非路由设置保留、活跃记录 drift 修复、完整坏文本和原始字节保留、prepared 日志重试、普通恢复/native 恢复、落盘前较新并发写入保留、状态和审核一致、固定 npm recipe / prefix / 运行进程门禁、native 与桌面渠道回退。

## 实机边界

所有写入仅发生在隔离临时目录；安装测试完全 mock 文件与子进程。没有更改用户配置、退出或终止客户端、安装/更新程序、打包或提交。尚未执行 VS Code 插件聊天实机验收或 Windows 安装实机验收。导航与弹窗修改维持原组件与样式；隔离 built-renderer 界面检查见下文。

## 追加：Codex 官方与网关模型共存

主代理确认 Codex 核心原生分页/分支/续聊验证后，追加共存接线。`AgentConnections.apply` 接收由服务验证过的 `officialCatalog`；记录仅保存共存模式和官方模型 slug，完整官方元数据原样写入私有合并 catalog。官方目录排前、所选网关目录排后，遇到 slug 冲突拒绝落盘。`tokenflow_gateway_models` 标记允许启动时只刷新网关模型容量，不改动官方目录元数据。

共存 provider 仍为 `token_flow`，基址为 `/codex/v1`，`requires_openai_auth=true`；客户端 key 写入 `http_headers.x-tokenflow-client-key`，不写 `experimental_bearer_token`，原 ChatGPT 登录文件不变。官方与网关模型的请求分流、凭据隔离和完整官方目录加载由主代理的服务实现负责。

现有网关模型区复用 `toggle` 样式的原生 checkbox“同时保留官方模型”。已有接入沿用当前模式，新接入在状态接口可用时默认开启；提交仍走现有应用窗口。官方身份显式读取 `codexCoexist`，共存时匹配的本机账号仍显示已登录，`gatewayConnected` 保留实际连接含义。关闭共存后可回到原仅网关配置，恢复仍能回到原合法配置。

新增 red → fix 覆盖：完整官方元数据保留、合并目录与客户端 header、切到官方 slug 后无误报 drift、header 真被改写仍能发现、容量刷新仅访问网关模型、停用共存与回退、官方 slug 冲突拒绝、原登录文件不变，以及官方身份只在显式共存时选中。`tests/agent-connections.test.ts` 80 条、`tests/codex-catalog-refresh.test.ts` 7 条、`tests/native-login-identity.test.ts` 8 条通过。原生 Codex 与混合 catalog 的隔离验证由主代理安排其他代理补验；此处不将单测当作实机验证。


## 隔离 built-renderer UI 检查

运行 `scripts/client-capabilities-ui-check.cjs`，沿用已有 Electron 40 runtime（`/tmp/tokenflow-account-electron40/Electron.app/Contents/MacOS/Electron`），没有安装 runtime。临时 Electron userData 目录在结束时清理，全部 API 请求由本地 fixture server 处理，静态资源读取主代理构建的 `dist/console`。没有加载真实用户 profile 或访问真实客户端配置。

六个场景通过：导航组顺序与“供应商”名称；共存 checkbox 与匹配官方账号“已登录”；npm 更新进入现有 FlowDialog、失败留在弹窗且没有重复 toast；缺少独立 Claude CLI 仍直接应用并保留 Claude Desktop 入口；供应商选择预览默认选中 ready 项、禁用 unsupported 项并提交所选 ID；新 Codex 接入状态可用时默认共存。深色和浅色截图均已检查，Claude 应用过程中只显示一组共享 Thinking。

Final built-renderer rerun passed all assertions. Screenshots in `release/client-capabilities-ui/`: `01-navigation-codex-coexist.png`, `02-npm-update-error.png`, `03-claude-apply-progress.png`, `04-claude-applied.png`, `05-supplier-import-preview.png`, `06-new-codex-default-coexist-light.png`, `07-supplier-preview-small-light.png`. Images were opened and inspected: the import list has border=0 and transparent background; all controls remain visible at 760x680 in the light theme. One shared Thinking layer is present, and the Claude progress/result dialog coordinates and size match exactly. The final bundle is newer than the npm detection change.


安装渠道追加边界检查：POSIX 本地项目的 `node_modules` 不能被当成全局 npm prefix，否则 `npm --global` 会安装到另一目录。自动 recipe 只接受确认过的 POSIX `prefix/lib/node_modules` 或 Windows `prefix/node_modules`；本地依赖回到原官方页面，不改项目 manifest。追加后 `tests/agent-installation.test.ts` 13 条通过，typecheck 通过。
