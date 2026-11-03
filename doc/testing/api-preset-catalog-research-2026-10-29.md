# API 预设与 Codex 模型能力缓存调研

日期：2026-10-29（America/Los_Angeles）。范围：只读公开源码与文档；未读取凭据或会话，未修改产品代码、模型配置或安装包。

## 核对版本

- CC Switch 当前主分支：`b76426741ef93069e2f374ac01ca7ef5760e1d0e`，提交时间 `2026-10-30T03:31:34Z`，提交说明 `docs(release): add v4.0.22 release notes`。通过 GitHub 连接器读取主分支提交及下列文件。
- 本地旧快照 `/tmp/tokenflow-usage-ccswitch-20261028` 用于搜索定位；关键结论已重新读取以上固定提交的源码。预设表通过当前 main 读取，返回的文件修改时间为 `2026-10-30T02:20:58Z`，早于上述 HEAD。

## 预设不是只有 URL

CC Switch 的 `codexProviderPresets.ts` 同时维护地址候选、协议、精确模型 ID、上下文、模态、推理档位、部分工具能力。以下是它当前的预设，不代表我们已经实测这些供应商，也不代表同名模型在其他聚合平台拥有相同能力。

| 来源 | Base URL | 代表模型 | 预设协议 | 预设上下文 |
|---|---|---|---|---:|
| DeepSeek 官方 | `https://api.deepseek.com` | `deepseek-flash` | Responses 原生 | 1,048,576 |
| Kimi 开放平台国内 | `https://api.moonshot.cn/v1` | `kimi-k3` | Responses 原生 | 1,048,576 |
| 智谱 | `https://open.bigmodel.cn/api/v1` | `glm-5.3` | Responses 原生 | 1,048,576 |
| MiniMax 国内 | `https://api.minimax.cn/v1` | `MiniMax-M3.1-Flash` | Responses 原生 | 1,000,000 |
| SiliconFlow 国内 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V4-Flash` | Chat Completions，需要转换 | 1,048,576 |

来源：[预设源码](https://github.com/farion1231/cc-switch/blob/b76426741ef93069e2f374ac01ca7ef5760e1d0e/src/config/codexProviderPresets.ts)。其中 SiliconFlow 的推理档位为 `high/max`，不能照搬 DeepSeek 官方的 `low/high/max`。地区、套餐端点也各自维护，不能把补 `/v1` 当作普遍正确的端点发现规则。

## 目录生成与压缩阈值

1. CC Switch 将界面的简化模型记录转换成完整 Codex 目录。上游实际为 Responses、Chat 或 Anthropic 时采用不同工具能力模板；`wire_api = responses` 仅说明 Codex 端协议，不能单凭它认定上游原生支持 Responses。
2. DeepSeek 原生 Responses 特例使用内置的官方 `models.json` 副本，包含官方工具说明与能力。该副本有 `deepseek-flash`、`deepseek-v4-pro` 两行，均为 `context_window/max_context_window = 1048576`、`effective_context_window_percent = 95`、`auto_compact_token_limit = null`。当前新建预设只列 Flash；“预设列表”和“完整供应商目录”不是同一回事。
3. Stack 合并目录时，`sink_row_windows` 把各供应商的全局窗口配置归到对应模型行；第三方未指定压缩点时取窗口的 90%。官方原生行只写明确覆盖的值，其余保持原样。这个合并策略不能误称为供应商公布的固定压缩点。
4. `model_catalog_json` 是输出目录文件的路径，不是模型本身的能力字段。应缓存目录内容及来源，按设备路径生成引用。

来源：[目录生成源码](https://github.com/farion1231/cc-switch/blob/b76426741ef93069e2f374ac01ca7ef5760e1d0e/src-tauri/src/codex_config.rs)、[DeepSeek 目录副本](https://github.com/farion1231/cc-switch/blob/b76426741ef93069e2f374ac01ca7ef5760e1d0e/src-tauri/src/resources/codex_deepseek_catalog_template.json)、[DeepSeek 官方 Codex 文档](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)。

## 官方账号目录缓存

CC Switch 的 `codex_official_models.rs` 已把官方目录和第三方静态预设分开：

- 从 `https://chatgpt.com/backend-api/codex/models` 获取，携带目标账号及本机 Codex 的 `client_version`。
- 按工作区 ID 与用户身份隔离缓存，并核对客户端版本；不能只以工作区或模型名称作为键。
- 持久文件为 `~/.cc-switch/codex-official-models.json`；新鲜期 6 小时，后台每 15 分钟检查，支持 ETag/304。可用但过期的数据先用于切换，后台刷新，不把网络等待放在切换锁内。
- 不盲用 `~/.codex/models_cache.json`，因为无法证明它属于哪个身份和客户端版本。拉取失败可降级到本机 `codex debug models --bundled`，但该列表与账号无关，不能据此声称账号获准使用某模型。
- 缓存已更新和客户端输出文件已更新分别记录。后者写入失败不会因前者已新鲜而永远漏掉重试。
- 目录为启动加载；刷新文件不等于已运行客户端立即采用新目录。它另外记录目录代数并识别可能仍使用旧目录的客户端。

来源：[官方缓存源码](https://github.com/farion1231/cc-switch/blob/b76426741ef93069e2f374ac01ca7ef5760e1d0e/src-tauri/src/services/provider/codex_official_models.rs)、[客户端目录代数源码](https://github.com/farion1231/cc-switch/blob/b76426741ef93069e2f374ac01ca7ef5760e1d0e/src-tauri/src/services/provider/codex_client_catalog.rs)。官方缓存关键代码已读取当前固定提交；客户端代数实现已读取本地 2026-10-28 快照。

## 对 TokenFlow 的建议

以下为设计建议，不是已实现行为。

把流程拆成 `供应商端点预设（URL/协议/精确主机） → 账号或来源实际可用模型 → 带来源的能力快照 → 按实际路由及 Codex 版本生成目录 → model_catalog_json 引用`。

### 第一层：来源能力缓存

按来源 ID、归一化实际端点、模型 ID、协议及必要的账号身份/套餐隔离。保留原始上下文、最大输入、最大输出、模态、推理档位、工具/压缩能力，以及来源 URL、获取时间、修订/ETag、客户端版本、是否预设或实测。上下文总窗、最大输入和最大输出分开；此处不存密钥值或对话。

官方账号目录原样保留其有效元数据；有官方供应商目录时优先使用目录。仅返回模型 ID 的 `/models` 不能证明窗口容量。经过检查的预设是缺省来源，不覆盖新鲜、同一实际路由的权威数据或用户明确覆盖；未知能力保持未知。

### 第二层：客户端适配产物

按 Codex 版本、当前模式、实际路由及转换器能力生成目录。直连只声明上游可兑现的能力，推理不经过 TokenFlow；统一网关只声明上游与转换器共同可兑现的能力。现有统一网关的 v1 子代理协议覆盖留在适配层，不污染供应商原始能力缓存。容量上限和我们采用的调度预算要分开，`auto_compact_token_limit` 可为空，也应记录是上游默认、用户覆盖还是 TokenFlow 策略。

输入快照、模型选择或转换器版本变化时重建目录；只有内容变化才原子写入。记录产物 hash、应用状态和客户端是否已加载，避免把“缓存更新”显示成“运行中的 Codex 已生效”。

### 刷新与边界

- 导入账号/API、用户刷新模型、应用配置时复用或获取相应来源，不因打开程序而主动访问所有未导入的本机凭据。
- 短暂网络失败保留可归属的旧快照并标记过期；更换账号/端点/协议不能复用不匹配快照。认证失效不应被无限 stale 缓存遮蔽。
- 探针证明的是协议、工具、流式和摘要路径，不足以证明 1M 容量；不发大请求“测量”容量。
- 不照搬 CC Switch 的 `base_url.contains("deepseek.com")` 匹配，应解析 URL 并精确匹配允许主机/子域边界。
- 不照搬未知模型克隆供应商旗舰能力的做法；同名和别名不是充分证据。也不机械采用“所有未知模型 128K”或统一压缩百分比。

OpenAI 官方模型目录文档要求按调用身份、`client_version` 与缓存控制刷新；本地 `model_catalog_json` 会阻止远程目录读取，需要管理刷新与实际生效，而不能承诺只写文件即可热更新。来源：[OpenAI 模型目录说明](https://learn.chatgpt.com/docs/model-catalogs)（由主任务核对）。

## 本仓库现状（主任务本地核查）

- `codex-coexist.ts` 的官方目录读取保留完整元数据，但这条路径还没有独立持久缓存。
- `patches/cliproxy/official_catalog.go` 有按凭据/供应商/端点/客户端身份隔离的内存缓存，30 秒刷新、15 分钟 stale 窗口，静态表不授予模型权限。
- `cliproxy.ts` 当前只归一上下文和部分模态；`codex-model-catalog.ts` 已有窗口来源记录；API 来源已有 `modelRoutes(baseURL/protocol/checkedAt)`，尚未形成完整统一能力快照。
- 因此应在现有发现与目录生成之间补足统一的数据契约和持久快照，而非新建第二套独立模型清单。

## 追加：推理档位与协议转换（2026-10-29）

范围：读取当前本地 `upstream/CLIProxyAPI`、TokenFlow overlay 和官方文档；仅离线运行已安装 Codex 的 schema 生成器，未发模型请求、未读取或修改真实 Codex 配置。

### 当前 Codex 不需要把 max 伪装成 xhigh

- DeepSeek 官方目录确实声明 `low/high/max`，默认 `high`。桌面配置示例还包含 `enabled-reasoning-efforts` 中的 `max`。[官方目录](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
- OpenAI 配置文档将 `model_reasoning_effort` 定义为模型声明的字符串，示例含 `max/ultra`，同时注明可用性受模型和客户端影响。[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
- 本机原版 `codex-cli 0.166.0-alpha.5.1` 离线执行 `app-server generate-json-schema --experimental`，`ReasoningEffort` 实际 schema 为 `{type:"string",minLength:1}`，描述为模型公布的非空档位值。因此至少当前协议层可原样表达 `max`；这不是桌面全部入口已完成 UI 实测的证明。

### CLIProxyAPI 已有转换层

`internal/thinking/apply.go` 从 Responses 的 `reasoning.effort`、Chat 的 `reasoning_effort` 读取成 `ThinkingConfig`，结合精确模型的 `ThinkingSupport` 验证，再交给 provider applier。

| 目标协议 | 现有写入形态 |
|---|---|
| Codex / Responses | `reasoning.effort` |
| OpenAI Chat | `reasoning_effort` |
| Gemini 离散档位 | `generationConfig.thinkingConfig.thinkingLevel` |
| Gemini 预算 | `generationConfig.thinkingConfig.thinkingBudget` |
| Antigravity | 同 Gemini，但前面有 `request.` |
| Claude adaptive | `thinking.type=adaptive` + `output_config.effort` |
| Claude manual | `thinking.type=enabled` + `thinking.budget_tokens`，并约束预算小于 `max_tokens` |

来源：`upstream/CLIProxyAPI/internal/thinking/{apply,validate,convert}.go` 与 `provider/{codex,openai,gemini,antigravity,claude}/apply.go`。

当前 `convert.go` 的档位转预算是 CLIProxyAPI 自己的策略：minimal=512、low=1024、medium=8192、high=24576、xhigh=32768、max=128000，然后按模型上限裁剪。不能把这些数值保存成供应商官方承诺的档位语义。`apply.go` 对跨协议/家族还存在 xhigh→max→high、max→xhigh→high 候选降级；已有测试覆盖。这是历史兼容策略，不能据此宣称 max 与 xhigh 等价，也无需在 TokenFlow 再做一遍相同转换。

### auth-files/models 当前缺什么

- 原 handler `internal/api/handlers/management/auth_files.go:GetAuthFileModels` 只输出 id/display_name/type/owned_by。
- **实际补充位置为 `scripts/official-catalog-overlay.mjs` 的 handler patch（当前约第34行）**：增加 `supportedInputModalities` 和 `context_length`，另增加 `catalog.status/verifiedAt/...`。目前没有输出 `thinking`、最大输出或 supported_parameters。
- Registry 的 `ModelInfo.Thinking` 已有 `min/max/zero_allowed/dynamic_allowed/levels`，其字段可用于有限白名单序列化；不能直接导出整个 `ModelInfo`，其中 `Config.OverrideHeader` 可能是请求配置且与能力缓存无关。
- `patches/cliproxy/official_catalog.go` 会把已注册同 ID 模型拷贝作初值，再覆盖 live 的模态和输入/输出容量；**目前不会从 live 官方目录解析 supported_reasoning_levels**。所以 registry 中现有 thinking 往往来自内置表，并不能因 catalog.status=live 就标为“实时官方档位”。

### 可安全实现的数据契约

1. 保存原生能力：`reasoning` 的类型为离散档位、预算、混合、明确不支持或未知；保留原生 levels、default、预算 min/max、是否能关闭/自动，以及每项来源与时间。不要把未知空值当成明确不支持。
2. 客户端目录优先原样展示供应商支持、当前实际路由可兑现的档位。DeepSeek 直连给 `low/high/max`，只做 JSON 字段形态转换，不改档位语义。未设置档位时保留供应商默认，不自动填 high。
3. 网关复用已有 CLIProxyAPI 思考转换；如要对旧客户端提供替代档位，必须另存明确的 route/client 适配映射与 provenance，记录用户选择和实际发送值，不覆盖原始能力，也不在直连配置伪造 max=xhigh。
4. 预算模型若需要 Codex 离散菜单，应把“菜单档位→预算”定义为适配策略，针对模型预算范围裁剪并去掉重复档；无法证明有效的档位不显示。摘要可见性（reasoning.summary/includeThoughts）与思考量独立，不能混为一项。
5. 映射应由唯一执行层负责。能力缓存和目录编译器提供声明；实际请求的转换在已有协议适配层完成，避免 TS 层与 Go 层重复转换产生二次降级。
