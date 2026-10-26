# Codex 官方共存与网关模型实机核验（2026-10-26）

在 Windows 实机上真实启动桌面应用（`electron .`，隔离数据根 + 端口 19528），再用同一数据根的 headless 服务（端口 19529）驱动 API，核验 `77d93c9` 引入的「官方模型共存 + 多网关模型」能力。测试结束后 `~/.codex` 已按快照字节级还原，隔离数据已删除，生产数据目录零修改。

## 一、启动

- 桌面应用正常启动：启动窗口 → 主窗口加载 → 服务监听 `127.0.0.1:19528`，渲染层建立连接。
- 首次运行写入 `credential-access.json`（`{version:1,allowed:true}`）后才加载密钥，符合「不把未回复当作授权」的设计。
- 宿主环境需 `env -u ELECTRON_RUN_AS_NODE` 与 `--no-sandbox --disable-gpu --disable-gpu-sandbox --in-process-gpu`，属本机环境限制（见 [Windows 跨设备兼容说明](../win-fix-跨设备兼容说明.md) 第六节）。
- 桌面版的会话 Cookie（`agent_session`）写在 Electron 会话内，外部脚本无法取得，因此 API 侧核验改用 headless。

## 二、共存接管（新增能力）

请求：`POST /api/a2a/connect`，`codexCoexist:true`，`selections` = 三个网关模型，`restartCodex:true`。

| 项目 | 结果 |
| --- | --- |
| 返回 | `codexCoexist:true`，`officialModelSlugs` 5 个，`selections` 3 个 |
| 校验项 | **7/7 通过**，含新增的「所选模型目录完整」 |
| `config.toml` | `model_provider="token_flow"`，`base_url=http://127.0.0.1:19529/codex/v1`，`http_headers.x-tokenflow-client-key` 已写入 |
| 模型目录 | `model_catalog_json` 共 **8 个**：官方 `gpt-reserve`、`gpt-6-luna`、`gpt-5.6-terra`、`gpt-5.6-luna`、`codex-auto-review` + 网关 `codex/gpt-6-luna`、`codex/gpt-5.6-luna`、`codex/gpt-5.6-terra` |
| 状态 | `configured`，`connection.codexCoexist=true`，Codex 已重启（15 进程） |

**真实调用**：用配置内的客户端 Key 请求 `/codex/v1/responses`，`codex/gpt-6-luna` 于 2.3s 返回 `OK`，网关路由正常。

**官方模型直连未在 headless 下验证**：同一端点请求官方 `gpt-6-luna` 返回 `官方模型需要 Codex 当前的 ChatGPT 登录`。这是桌面端凭据授权（`allowCredentials`）才具备的条件，headless 无该通道，属预期守卫而非缺陷；官方共存的实际走通需在桌面应用内验证。

## 三、还原残留：是还原语义不完备，不是 Codex 写回

`POST /api/a2a/restore`（`restartCodex:true`、`restoreHistory:false`）返回 `state=restored`，`auth.json` 与快照一致，但 `config.toml` 与快照不同：

| 残留 | 说明 |
| --- | --- |
| `model = "gpt-6-luna"` 行丢失 | 接管前的用户模型选择没有回来 |
| otel 端点仍指向 `127.0.0.1:19529` | 指向已停止的测试网关，真实端点为 `9528` |
| `x-tokenflow-recorder` 仍为测试实例的令牌 | 同上 |
| TOML 引号/转义被重新序列化 | TokenFlow 自己的写入器风格 |

**归因：还原函数只清路由，不恢复用户设置。** 三处证据：

1. 重启顺序是「`stop()` → 确认进程清空 → `work()` 写配置 → `open()`」（`codex-switch-lifecycle.ts` 的 `change()`），Codex 在写配置时已经退出，不存在"用内存旧配置写回"的窗口；新启动的 Codex 读到的就是刚写好的文件，也不会凭空产生 19529。
2. 还原后文件的 TOML 用转义双引号（`"C:\\Users\\..."`），这是 TokenFlow 写入器的风格；Codex 自己的写入器用单引号字面量（`'C:\Users\...'`，见快照原文）。即这份残留是 TokenFlow 写出来的。
3. `nativeCodexConfig()` 的实现明确 `delete config['model']` 并置 `model_provider='openai'`，且**完全不处理 `[otel]` 段**——与观测到的两处残留逐字对应。该函数自 2026-10-21 `c13ddff`（main 分支）起就是这样，早于两次实机测试，也早于本次合并。

**结论**：这是 main 主线「退回官方」还原语义的缺口，两个平台一致，并非合并引入的回归：

- `model` 被删除而不是恢复为接管前的值，用户还原后要重新选一次模型；
- `[otel]` 段（endpoint + recorder 令牌）不在还原范围，还原后遥测仍发往已断开的网关端口。

修复方向：`nativeCodexConfig()` 在清理路由的同时，把 `record.before` 中的 `model`／`[otel]` 还原（或至少移除本次接入注入的 otel 段），并在写入后校验这些字段是否回位。本次已按快照回填 `config.toml`，最终 `config.toml`/`auth.json` 与测试前字节级一致（`45ed27ab…` / `77acbc83…`）。

## 四、结论

- 官方共存 + 多网关模型目录在实机上工作正常，7 项校验全通过，网关模型真实调用可用。
- 还原语义不完备（main 既有设计）：`nativeCodexConfig` 会删掉 `model` 且不清理 `[otel]` 段，还原后用户需重选模型、遥测仍指向旧网关；与本次合并无关。
