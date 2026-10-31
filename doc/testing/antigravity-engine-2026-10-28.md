# Antigravity 引擎更新与模型目录验收（2026-10-28）

TokenFlow 构建号：10.15.26.85。保留现有 CLIProxyAPI 基础 pin `d198db54d4c4886c99b21488d54fc576933019a3` 和供应商补丁，移植 [上游 02e9e85204052dfed9bf73b7075c7b414111a4b3](https://github.com/router-for-me/CLIProxyAPI/commit/02e9e85204052dfed9bf73b7075c7b414111a4b3) 的 Hub 客户端及控制面修复。这是 Antigravity 专项更新，不是整体升级到 CLIProxyAPI v8。

## 实测结论

使用本机 3 份启用的 Antigravity 凭据，分别比较旧默认版本、新默认版本、旧格式在线版本、新格式在线版本。12 次 `fetchAvailableModels` 请求均为 HTTP 200，使用同一 daily 端点和各自项目。

| 请求身份 | 三份凭据返回的对话目录 |
| --- | --- |
| `antigravity/hub/2.9.1 darwin/arm64` | 原有六个可用型号 |
| Hub 2.24.0，完整 `aidev_client` 元数据及对应 CL | 六个可用型号 + `gemini-4-argon-disabled` |
| Hub 2.27.0，旧格式 | 同上 |
| Hub 2.27.0，完整 `aidev_client` 元数据 | 同上 |

在线版本清单返回 2.27.0。新出现的 Argon 项明确带有 `disabled: true`；没有返回 Claude 5.5。本次证实版本影响目录内容，但没有观察到 2.27.0 下仅改变 UA 格式就扩大账号权限。不能推断账号禁用的具体套餐或灰度原因。

`tieredModelIds` 中的 `gemini-3.8-flash-tiered` 没有 `displayName`，也不在 `agentModelSorts` 中；Hub 请求已经提供了 high/medium/low 三个正式选择项。因此保留按对话选择名单过滤的规则，不把 routing tier 或禁用占位项加入可调用列表。先前使用旧式 IDE UA 得出的“缺少 Gemini”结果不代表 TokenFlow 的 Hub 请求结果。

## 变更

- 使用上游 Hub 版本模块：默认版本从 2.9.1 提升到 2.24.0，保留动态更新；只有已验证的版本携带对应 changelist，未知版本不借用其他版本的 CL。
- 项目发现和额度 `loadCodeAssist` 与推理统一使用 daily 默认端点，保留显式自定义端点；同步上游相应请求头调整。
- TokenFlow 自有目录缓存使用与推理相同的客户端身份。客户端版本/UA 变化会使缓存失效，目录请求与缓存键使用同一份身份快照；旧身份在途结果不会被作为新身份的已验证目录返回。
- 保留已有 EOF 重连、Claude 工具名兼容、其他供应商适配，以及禁用/内部/非对话型号过滤。
- 新增 `scripts/test-antigravity-engine.mjs` 和显式 opt-in 的 `scripts/antigravity-engine-live.mjs`。

## 验证

修改前 `node scripts/test-official-catalog.mjs` 的两项新增回归失败：旧客户端仍注册旧目录；客户端改变后请求次数仍为 1，继续使用原缓存。修改后通过。

以下检查通过：

- `node scripts/test-antigravity-engine.mjs`：misc、Antigravity auth、executor、account catalog，含 `-race`；覆盖在线更新期间身份变化、目录失效、项目/额度端点、自定义客户端身份与禁用目录。
- `node scripts/test-sidecar-qoder.mjs`：Qoder、WorkBuddy、Agent contract、Antigravity EOF 重连。
- `node scripts/test-sidecar-model-protocol.mjs`：Antigravity Claude 翻译与原有协议补丁。
- `node scripts/build-sidecar.mjs darwin-arm64`。
- `node scripts/antigravity-engine-live.mjs --live --inference`：用新二进制启动隔离服务，三份凭据目录均为 HTTP 200 / `live`；账号目录与 `/v1/models` 注册结果一致；Gemini 3.8 Flash Low 真实推理 HTTP 200、有文本、`finish_reason=stop`。

真实测试只复制 access token 到权限受限的临时目录，不复制 refresh token；结束后终止隔离服务并删除临时目录。未输出令牌、邮箱、项目 ID、上游实验提示词或真实用户对话。

最终可用型号仍为 `gemini-3.8-flash-high`、`gemini-3.8-flash-medium`、`gemini-3.8-flash-low`、`claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`。升级客户端不会解除上游 `disabled` 标记；当账号目录返回新的启用型号时，会由现有实时发现逻辑自动注册。

## 本机安装

完整 macOS arm64 `.85` 应用构建成功。打包下载路径等待过久，改用已有的 Electron 40.10.6 缓存；缓存 SHA-256 与 SHASUMS 一致，ZIP 完整性检查通过。安装包使用本机 ad-hoc 签名并通过 `codesign --verify --deep --strict`。

用户确认当前对话经过 TokenFlow 统一网关后，采用 macOS `renamex_np(RENAME_SWAP)` 原子交换应用目录，仅替换磁盘版本，不终止或重启网关。安装位置 `/Applications/TokenFlow.app`，版本 `10.15.26.85`，sidecar SHA-256 `4390f754fbd44b279d431d9c7bec531e04dac48ce55b0fb92dbc038b550b243d`。旧应用保留在 `/Applications/.tokenflow-update-bnxf286n/TokenFlow.app`。

**运行中的进程仍为旧引擎；新引擎在用户下次重启 TokenFlow 后加载。** 不将磁盘安装完成表述为运行中升级完成。
