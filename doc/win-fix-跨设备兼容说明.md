# win-fix 分支：Windows 跨设备兼容说明

> 本文说明 `win-fix` 分支存在的目的、它相对产品主线做了哪些跨设备兼容改动，以及同步 `main` 时必须保留的部分。
> 产品功能、界面与使用逻辑以 `main` 为准；`win-fix` 只承担 **Windows 跨设备兼容与打包修复**，不引入独立的产品行为。

## 一、分支定位

| 项目 | 说明 |
| --- | --- |
| 分支 | `win-fix` |
| 基线 | `origin/main` |
| 职责 | Windows 实机兼容（进程身份、安装发现、窗口、打包链路）、Windows 端到端测试资产 |
| 不负责 | 产品功能、界面改版、模型路由策略、用量口径 —— 这些一律跟随 `main` |
| 合并方向 | `main` → `win-fix`（跟随主线），`win-fix` 不反向合并覆盖主线 |

维护约定：同步 `main` 时**保留本文第二、三节列出的 Windows 兼容行为**，其余一律采用 `main`。冲突优先按"产品逻辑取 main、跨平台适配取 win-fix"的原则逐段判断，不以整文件覆盖解决。

## 二、Windows 兼容改动清单

### 1. 进程身份识别（`packages/core/src/windows-agent-lifecycle.ts`）

Windows 上判断"某个同名进程属于哪个应用"不能只看 exe 名字，必须读应用自身的身份声明。

| 改动 | 原因 |
| --- | --- |
| `electronPackageMetadata()` 读取 ASAR 时临时开启 `process.noAsar` | TokenFlow 自身以 asar 打包运行时，Node 的 asar 透明解包会拦截对目标应用 `app.asar` 的原始字节读取，导致身份识别失败 |
| `qoderIdeWindowsIdentity()` 接受多种 package 名（`Qoder` / `Qoder IDE` / `qoder-ide`） | Qoder IDE 1.106 把 `package.json` 的 `name` 从 `Qoder` 改成了 `Qoder IDE`；身份判据实际由 `product.json` 的 `win32AppUserModelId`、`applicationName`、`dataFolderName` 承载 |
| `windowsAppIdentity()` 同时识别 `Qoder.exe` 与 `Qoder IDE.exe` | 1.106 起可执行文件改名为 `Qoder IDE.exe`，旧版本仍是 `Qoder.exe` |
| 识别 `qoder-ide-helper` | Qoder IDE 自带一份 `Qoder IDE\resources\app\resources\bin\x86_64_windows\Qoder.exe`，与独立版 Qoder 同名但属于不同应用。识别出来才能忽略它，而不是把它当成"未知进程"阻断独立版 Qoder 的重启 |
| 识别 `claude-desktop-helper` | Claude Desktop 会从 `%LOCALAPPDATA%\Claude-3p\claude-code` 拉起内置 Claude Code，不是独立安装 |
| `codexCliWindowsIdentity()` 按路径特征识别 Codex CLI | 覆盖 `OpenAI\Codex`、`WindowsApps\OpenAI.Codex_*`、`node_modules\@openai` 三类布局 |
| 忽略 `--type=crashpad-handler` 进程 | Electron 的崩溃报告子进程会**在主程序退出后继续存活**并共享同一 exe 路径。不排除它，重启会一直卡在"Qoder 尚未退出" |
| `--user-data-dir` / `--profile` 改为比对实际值 | 每个 Electron 子进程（GPU、network、renderer、node service）的命令行都带 `--user-data-dir`，它的存在不代表用户用了自定义配置目录。只有取值与该应用默认 user-data 目录**不同**才算自定义 |
| 商店安装改为按包清单解析 | 商店应用（Codex、Claude、WorkBuddy、Qoder）从 `Get-AppxPackageManifest` 读可执行文件名，不再靠开始菜单显示名匹配 |

### 2. 安装发现（`packages/core/src/agent-installation.ts`）

| 改动 | 原因 |
| --- | --- |
| 新增 `windowsRegistryApp()` 注册表发现 | 遍历 `HKLM` / `HKLM WOW6432Node` / `HKCU` 的 Uninstall 项，按显示名前缀匹配（长度降序防误匹配），从 `InstallLocation` / `DisplayIcon` 解析 exe。任意盘符、任意自定义目录都能发现，不再依赖固定路径。带 60s 缓存 |
| 新增 `AGENT_INSTALL_DIRS` 环境变量 | PATH 风格分隔的额外搜索根，支持 `根\应用名\应用.exe` 与 `根\应用.exe` 两种布局（macOS 为 `根/应用.app`）。便携版 / 免安装版可被发现 |
| `desktopCandidates` 同时探测 `Qoder IDE.exe` 与 `Qoder.exe` | 同上，1.106 改名 |
| 商店包名扩展 | 增加 `AnthropicPBC.Claude`、`WorkBuddy.WorkBuddy`、`com.qodercn.app`；MSIX 版不进传统 Uninstall 注册表，只能按包身份找 |
| Store 版 `codex.exe` 按文件体积降序选 | 安装目录里可能有多个同名小文件，按体积排序取主程序 |

### 3. 进程查询与生命周期（`packages/core/src/agent-connections.ts`）

| 改动 | 原因 |
| --- | --- |
| `tasklist` / PowerShell CIM 查询超时 5s → 15s | Windows 冷启动 PowerShell/CIM 可能超过 5 秒，导致误报"无法检查 Agent 进程"。均为只读查询，放宽不影响安全性 |
| Claude 进程单独识别 | Claude Desktop 自带 `Claude.exe` 进程树和内置 Claude Code helper；只有独立 CLI 才算一个 Claude Code 会话，否则会把桌面端误判成 CLI 正在运行 |
| `updateDeepseekEnv()` | 接入/修复 DeepSeek 时把网关 Key 写入 `$DSH_HOME/.env`（`DEEPSEEK_API_KEY=...`，0600、原子替换）；移除/还原时清除。Harness 的 `needsWelcome = !loggedIn && !hasApiKey` 据此在**每次启动（含用户手动启动）**都能跳过欢迎页 |
| `restoration()` / `restore()` 容错 | 配置被外部改动时回退到备份原文；`restore` 支持 `overwrite`，避免因换行符等差异直接报错卡死 |

### 4. 桌面应用（`apps/desktop/src/`）

| 改动 | 原因 |
| --- | --- |
| `uiRoot` 优先 `app.asar.unpacked` | **图标 404 长期 bug 的根因修复**：`@fastify/static`（send 1.x）在 Windows 上无法从 `app.asar` 内提供静态文件——磁盘路径返回 200，asar 路径返回 404。配合 `asarUnpack` 把 `dist/console/**` 解包到磁盘 |
| preload 同样优先 unpacked 副本 | 同一原因：沙盒 preload 在 Windows 上无法从 `app.asar` 加载（ENOENT），`window.desktop` 桥整体缺失，窗口按钮遮挡、复制按钮、主题切换全部静默失效 |
| 启动窗口与主窗口焦点修复 | `show` 后 `setAlwaysOnTop(true→false)` 抢焦点；`startup.focus()` 在最小化时先 restore；`second-instance` / `activate` 在无主窗口时聚焦启动窗口 |
| `qoder-crypto.ts` 清除 `ELECTRON_RUN_AS_NODE` | Node 会把 `undefined` 序列化成字符串 `"undefined"`，导致 Electron 以 Node 模式启动并丢失 `safeStorage` |
| `qoder-crypto.ts` 用 `readSync` 读 stdin | Electron 的 GUI 主进程在 Windows 上不通过 `process.stdin` 投递管道数据，`for await` 永远等不到输入 |

### 5. 网关与 sidecar（`packages/core/src/service.ts` / `cliproxy.ts`）

| 改动 | 原因 |
| --- | --- |
| 最小调用检查弃用 `app.inject` | 打包版（asar）运行时冷加载 `light-my-request` 失败；改为服务已监听时走真实 loopback `fetch`（45s 超时），测试未绑 socket 时保留 inject |
| restore API 增加 `overwrite` | 与 `agent-connections` 的还原容错配套 |
| `.js` / `.cjs` / `.mjs` sidecar 用 `node` 启动 | `spawn` 直接执行脚本文件在 Windows 上会走 ShellOpen 拦截或失败，改为 `process.execPath <脚本> -config ...` |

### 6. 打包链路

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `package.json` | `build.win.icon` → `app-icon.ico` | electron-builder 的 `win.icon` 用 PNG 会被静默忽略，导致 exe 无图标；新增含 256×256 共 7 尺寸的 ico |
| `package.json` | `asarUnpack` 增加 `dist/console/**`、`dist/preload.cjs` | 配合 `uiRoot` / preload 修复 |
| `apps/console/vite.config.ts` | `resolve.dedupe:['react','react-dom']` | node_modules 重排后 vite 产物打进两份 React，运行报 `Cannot read properties of null (reading 'useState')` 白屏 |
| `scripts/before-pack.cjs` | Windows 用 `System32\tar.exe`（bsdtar） | GNU tar 把 `d:\code\...` 解析成远程主机（"Cannot connect to d"） |
| `scripts/clean-package.mjs` | 改用 `cmd rmdir /s /q`，占用则跳过 | 宿主沙箱把 `fs.rm` 挂成失败回收站操作、杀软锁定句柄时不再中断构建 |
| `scripts/fetch-upstream.mjs` | `git apply` 加 `--ignore-whitespace` | Windows 换行符差异导致 cliproxy 补丁应用失败 |
| `scripts/*-overlay.mjs` | 读取源码统一 `\r\n → \n` | CRLF 与多补丁叠加问题 |
| `.gitignore` | `release*/`、`root /index-*.js`、`/index-*.css` | 统一忽略全部打包产物，以及误落在根目录的 Vite 产物 |

### 7. 启动脚本（仅本机便利，不参与产品构建）

- `启动TokenFlow.bat`：启动 release 打包版（UTF-8 代码页），优先 `release\win-unpacked`。
- `启动TokenFlow.vbs`：无控制台窗口静默启动。**内含本机绝对路径，换机器需改。**

### 8. Windows 端到端测试资产

| 文件 | 用途 |
| --- | --- |
| `scripts/run-all-windows-e2e.mjs` | 一键串跑 8 项真实环境测试（真实 Codex CLI 握手、真实 Desktop Service、无边框窗口、启动窗、账号加载、Agent 启动、网络诊断、原生垃圾清理），汇总通过率 |
| `scripts/test-real-codex.mjs` | 定位 Windows 上的 Codex CLI 二进制并启动 RPC 会话握手 |
| `scripts/test-real-desktop-service.mjs` | 创建 Desktop Service、监听端口、验证 settings / local-agent / providers probe 与优雅关闭 |
| 各 `*-ui-check.cjs` | Electron 真实渲染检查；渲染等待 120→250 轮，临时目录清理加 `maxRetries:3`（杀软句柄延迟释放） |

### 9. Qoder 相关兼容（随主线演进保持）

| 改动 | 原因 |
| --- | --- |
| Qoder IDE 1.106 身份识别 | 见第 1 节 |
| Qoder 本机登录导入账号池 | 导出原生 grant 给网关，**refresh token 不导出**——网关侧刷新会把 token 从官方客户端轮换走 |
| Qoder 单模型 Key 只接受自身的原生 id | 原先固定单模型 Key 会把任何模型名改写成固定模型，构成授权绕过 |

### 10. HTTP 接入放宽到局域网

`isLocalHttpHost()` 允许回环地址之外的私网地址（`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`.local`）使用 HTTP。这一项不是 Windows 专属，而是为了让局域网内其它设备接入本机网关。

## 三、同步 main 时的保留原则

1. **产品行为取 main**：界面、文案、模型路由、用量口径、登录流程一律采用 main。
2. **平台适配取 win-fix**：上表列出的进程身份、安装发现、打包链路、desktop 主进程改动必须保留。
3. **冲突逐段判断**：常见冲突点是同一函数被两侧同时修改（例如 `desktopCandidates` 的候选路径、`service.ts` 的 key 授权检查）。按"main 加功能 + win-fix 加平台分支"的方式合并，不要整文件二选一。
4. **测试同步**：`tests/windows-agent-lifecycle.test.ts`、`tests/agent-installation.test.ts` 里的 Windows 夹具与新增用例要保留；main 新增的用例照常引入。
5. **合并后必跑**：`npm run typecheck`、`npm run build`、`npx vitest run tests/windows-agent-lifecycle.test.ts tests/agent-installation.test.ts tests/agent-processes.test.ts`。

## 四、已知平台差异与限制

- `tests/agent-installation.test.ts`（5 项）与 `tests/agent-processes.test.ts`（4 项）在 Windows 实机上有预存在失败（含 `automatic` 在 win32 恒为 `false` 等），2026-10-23 经 worktree 在合并前的两个父提交上复测确认与合并无关；macOS 上这些用例全部通过。
- `tests/local-usage-index.test.ts` 在 Windows 上失败：索引 worker 以 `--import tsx/esm` 启动后无法把 `./local-usage.js` 解析到 `.ts`（`ERR_MODULE_NOT_FOUND`）。只影响 dev/test 下的 TS 运行，不影响 `dist` 打包产物。
- `package.json` 的 `build.mac.icon` 曾被误同步成 `.ico`；在 mac 上打包前应确认改回 `app-icon.png`。
- 真实 Windows 系统按钮、DPI、Snap、多显示器行为只能实机验收，渲染层模拟不能替代。

## 五、相关文档

- [Windows 兼容问题与实机接手说明](待修复的问题win兼容.md)：完整验收清单、测试执行规则、历史排查记录。
- [win-fix 与 main 差异对照](win-fix-与main差异-Windows兼容修改清单.md)：2026-10-17 的早期逐文件对照快照。
- [win-fix 同步与修复记录](win-fix-2026-10-17-同步与修复记录.md)：2026-10-17 实机验收发现的问题与打包坑。
- [Qoder IDE 1.106 与重启修复](fixes/README-qoder-ide-and-restart-2026-10-22.md)：最近的 Qoder 兼容修复与补丁。

## 六、同步记录

### 2026-10-23：合并 origin/main（65caf25），提交 7b4be1b

**纳入内容**：macOS 侧 41 个提交，集中在 Codex 压缩与检查点体系（并行初始压缩、远程压缩委托、分支检查点固化、容量默认值）、Qoder 账号直切与过期 grant 清理、控制台加载反馈与模型应用对话框统一、原生登录导入与 LAN HTTP 端点支持。

**冲突收敛要点**：

| 冲突点 | 处理方式 |
| --- | --- |
| 局域网 HTTP 放宽（win-fix 39b9110）vs macOS 2d99c98 的 LAN 端点支持 | 两侧行为一致，收敛为共享模块 `apps/shared/api-url-policy.ts`（回环 + 私网 + `.local` + ULA），渲染端与服务端共用，无分叉 |
| `packages/core/src/service.ts`（两侧同时修改） | 按"main 产品逻辑 + win-fix 平台分支"叠加：保留 main 的压缩/用量改动，叠加 win-fix 的 restore `overwrite` 容错与单模型 Key 只接受原生 id 的授权修复 |

**合并后验证（2026-10-23，Windows 实机）**：

- `tsc --noEmit` 类型检查通过。
- `tests/windows-agent-lifecycle.test.ts` **45/45 全部通过**（Windows 兼容核心用例）。
- `tests/agent-installation.test.ts` / `tests/agent-processes.test.ts` 共 9 项失败；经 git worktree 在合并前 win-fix（808d098）与 main（65caf25）两个父提交上复测，**失败集合完全一致**，确认为本机预存在的环境性失败（见第四节），与本次合并无关。
- Windows 兼容关键项逐一抽查在位：`process.noAsar`、Qoder IDE 1.106 身份识别（`Qoder IDE.exe`）、`qoder-ide-helper`、`--type=crashpad-handler` 忽略、`windowsRegistryApp` 注册表发现、`AGENT_INSTALL_DIRS`、`build.win.icon=app-icon.ico`、`asarUnpack`、`run-all-windows-e2e.mjs` 与启动脚本。
- 合并后 win-fix 相对 main 的净差异：54 个文件、约 +1466/-140 行，全部落在本文第二节清单范围内。

**实机端到端全量测试（2026-10-23 17:04，Windows，构建后 dist）**：8/8 通过——

| # | 测试 | 结果 |
| --- | --- | --- |
| 1 | 本机 Codex 真实 CLI 与 RPC 握手 | ✓ 7.5s |
| 2 | 本机 Desktop Service 与 Native Sidecar 服务 | ✓ 13.3s |
| 3 | Windows 无边框标题栏、Snap 与主题融合 | ✓ 3.8s |
| 4 | 启动窗口、授权卡片与焦点交互 | ✓ |
| 5 | 账号启动加载与初次轮询 | ✓ |
| 6 | Agent 启动与状态 | ✓ |
| 7 | 本地网络诊断 | ✓ |
| 8 | 本机原生垃圾清理 | ✓ 1.6s |

> 环境注意：在部分宿主环境（如 WorkBuddy 沙箱会话）下，Electron 的 GPU 进程会以 0xC0000005 崩溃、且环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化为纯 Node。跑 UI 检查需：
> `env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu --disable-gpu-sandbox --in-process-gpu scripts/<xxx-ui-check>.cjs`
> 这属于本机环境限制，与代码无关；真机直接 `node scripts/run-all-windows-e2e.mjs` 即可。

### 2026-10-26：合并 origin/main（77d93c9），提交 75a92ca

**纳入内容**：macOS 侧 37 个提交（272 文件、+20393/-567），集中在 Codex 双入口与原生 Agent 集成（官方/网关模型共存、混合启动器、跨提供方委派）、用量对账审计、控制台加载布局与 API 来源排序。

**冲突处理（6 个文件、11 个冲突块）**：

| 冲突点 | 处理方式 |
| --- | --- |
| `apps/desktop/src/qoder-crypto.ts`（两侧重写） | 采用 main 的**会话复用架构**（一个客户端一条长连接），但保留 win-fix 的 Windows 输入通道修复：子进程端不用 `readline/process.stdin`（Windows GUI 主进程收不到管道数据），改为 `readSync(0)` 分帧 NDJSON + `writeSync(1)` 回包；spawn 环境仍用 `delete ELECTRON_RUN_AS_NODE`（显式 `undefined` 会被序列化成字符串） |
| `agent-connections.ts`（3 处） | 采用 main 的 `codexRecovery` 恢复逻辑（已内含"Codex 就地改写后按字段还原"），保留 `updateDeepseekEnv()`（DeepSeek 欢迎页跳过）与 `approval?.revision` 可选容错 |
| `agent-installation.ts`（2 处） | 合并导入（`basename` + `posix/win32`），保留 `AGENT_INSTALL_DIRS` 与 `envRoots()` |
| `service.ts` | 恢复路由同时保留 win-fix 的 `overwrite` 容错与 main 的第三参数 `hybrid=false`（恢复时强制经典重启） |
| `scripts/clean-package.mjs` | 采用 main 的 `artifacts/` 保护（对账日志与审计证据不可删）与 `root` 参数，保留 Windows `cmd rmdir` 容错与被占用时跳过 |
| `tests/usage-ledger.test.ts`、`tests/usage-overview.test.ts` | 取 win-fix 的写法：账本夹具锚定"今天"（prune 读真实时钟）；连通用例保留更完整的 hint 断言（当前实现与之匹配） |

**验证（2026-10-26，Windows 实机）**：

- `tsc --noEmit` 通过；`npm run build` 通过。
- `tests/windows-agent-lifecycle.test.ts` **45/45 通过**。
- `agent-installation` + `agent-processes` 共 10 项失败；在 `origin/main`（77d93c9）上用 worktree 跑同样测试，**失败集合完全一致**，属 main 自带的本机预存在失败，合并零回归。
- Windows 兼容关键项抽查在位：`noAsar`、`AGENT_INSTALL_DIRS`/`windowsRegistryApp`、`updateDeepseekEnv`、`build.win.icon`、`asarUnpack`、`ELECTRON_RUN_AS_NODE` 删除写法。
