# 账号授权：真实可用性核查与待实测清单

核查日期：2026-10-17。范围是「账号授权」页的 10 个平台：Codex、Claude、Antigravity、Kimi、xAI Grok、Qoder、WorkBuddy／WorkBuddyAI、ZCode、Trae、Cursor。

本轮**没有用任何真实账号登录、切换或发推理**。做法是三方对照：

- **代码**：TokenFlow 和 `upstream/CLIProxyAPI` 里实际使用的地址、参数、字段。
- **本机官方客户端**：从已安装的官方客户端里只读提取常量（只取 URL、字段名、版本号，不读凭据值）。
- **官方文档**：优先官方页面；只有官方没写时才引用社区资料，并单独标注。

标注：【官方】官方文档／官方源码；【本机】本机已安装官方客户端中的字符串；【代码】TokenFlow 现有代码事实；【推断】根据代码推理、需实测确认；【社区】第三方实现或论坛报告。

各平台服务条款的核查结论和处理决定另存本地，不随仓库发布；本文只记录技术可用性。

## 修复进度（2026-10-17）

以下代码修复均已完成并有自动化测试覆盖，**仍未用真实账号验证**；实测时以各平台「实测清单」为准。

| 平台 | 已修复 | 状态 |
| --- | --- | --- |
| Kimi | 额度读服务端下划线字段 `limit_5h`／`used_ratio`／`reset_time`，兼容驼峰；夹具改为服务端格式 | 已完成 |
| Qoder | 额度兼容 `user_quota`／`add_on_quota`／`shared_quota` 等下划线字段；`machine_id` 登录时写入授权文件，刷新时复用 | 已完成 |
| ZCode | 新增「添加 BigModel 账号」（CLI 轮询 `provider=bigmodel`，在 `bigmodel.cn/login` 登录，不做 Z.ai 业务令牌交换）；BigModel 推理与模型目录改走 `open.bigmodel.cn/api/coding/paas/v4`；额度按账号查 `bigmodel.cn` 或 `api.z.ai`；本机导入优先读官方共享文件 `~/.zcode/v2/credentials.json`，值不像明文令牌时拒绝导入；`glm-5.3` 不再改成 Flash；额度窗口按 `unit`／`number` 标为「5 小时」「每周」，`CREDIT_LIMIT` 归入模型用量，`number` 不再当作额度上限 | 已完成 |
| Trae | 本机导入时刷新令牌已过期（或无刷新令牌且访问令牌已过期）直接拒绝；刷新接口返回 200 但没有令牌按失败处理；1455 端口被占用时提示与 Codex 登录、`codex login` 冲突 | 已完成 |
| WorkBuddy | WorkBuddyAI 国际版可「从本机导入」，读 `workbuddy-desktop-ai.info`，保存为海外域名账号；不加入启动自动导入 | 已完成 |
| Claude | 新增「授权码登录」：`redirect_uri` 用官方 `https://platform.claude.com/oauth/code/callback`，粘贴页面显示的 `code#state`，校验 state 后提交，不占本机端口；授权地址放行 `claude.com/cai/oauth/authorize`，并校验 `redirect_uri`；钥匙串服务名按 CLI 规则用 `CLAUDE_CONFIG_DIR` 原值计算 hash；按模型的周限额标签带上 `scope.model.display_name` | 已完成 |
| Codex | 读取 `/etc/codex/managed_config.toml`、`/etc/codex/requirements.toml` 和 macOS MDM（`com.openai.codex` 的 `config_toml_base64`／`requirements_toml_base64`），`cli_auth_credentials_store` 被强制为非 `file` 时拒绝切换并在状态里提示；切换后用 `CODEX_HOME` 指向本机目录跑 `codex login status`，没读到 “Logged in using ChatGPT” 或找不到 Codex 程序时在切换结果里提示。云端 requirements 读不到，只能靠切换后核验兜底；`login status` 不显示账号，只能确认 Codex 读到了 ChatGPT 登录 | 已完成 |
| Codex／Claude | 刷新令牌共享（见第二节第 1 条） | 按用户决定暂不处理 |
| 全部 | 重新生成 `upstream.patch`；类型检查、全量 vitest、sidecar Go 测试、sidecar 编译 | 已完成，见下方说明 |

验证结果（2026-10-17）：类型检查只剩已有的 `tests/agent-connections.test.ts` 第 322 行错误；vitest 991 项通过，1 项失败（`tests/native-accounts-service.test.ts`，修复前的 HEAD 上同样失败）；sidecar Go 测试中 `TestAntigravityConcurrentRequestsDefaultPoolLimitsToTwo` 失败，相关文件与修复前补丁完全一致，属原有问题；`TestCodexClientModelsResponseAppliesMaxContextLengthOverride`（deepseek-v4-pro 上下文长度）在版本号改回旧值时同样失败，也属原有问题；其余 Go 测试、`test:sidecar-pin`、`test:sidecar-qoder`、`test-provider-login` 通过；overlay 编译 `./cmd/server` 通过。

| Codex／xAI／WorkBuddy | 伪装的客户端版本号对齐官方（第二节第 2 条）；Claude 暂不改 | 已完成 |

仍未处理：Antigravity 切换写入的 `userStatus`；Claude 版本指纹（第二节第 2 条）。Kimi 国际区与网关 403、Trae 非美国区、Cursor 密钥续期不影响当前使用，按用户决定暂缓，记录在本地私密文档。

## 一、总览

「本机授权」指 `~/Library/Application Support/desktop-browser-agent/cliproxy/auth` 下当前有没有该平台的授权文件（只看了文件名）。「代码已知问题」是核查时发现的问题，修复情况见上表。

| 平台 | 本机授权 | 已真实验证过 | 从未真实验证 | 代码已知问题 |
| --- | --- | --- | --- | --- |
| Claude | **无** | 无。历次报告均写明“无可用测试授权，未声称完成实时验收” | 登录、额度、网关推理、本机切换／还原、令牌刷新**全部** | 刷新令牌共享；回调端口固定；伪装版本落后 |
| Codex | 有 2 个＋本机导入 1 个 | macOS 推理与逐请求账号证据（6 次）、切换（含内存溢出修复）、额度 | Windows；长时间共用后的令牌刷新 | **刷新令牌共享**；凭据存钥匙串时无法切换 |
| Antigravity | 有 3 个 | 目录、推理（含并发压测）、本机 SQLite 用量只读核对 | 本机切换写入后 IDE 是否正常；额度与 IDE 对账 | 切换写入的 `userStatus` 不完整 |
| Kimi | 有 2 个，**均已过期**（2026-09-26） | 无有效账号实测 | 全部 | **额度字段名读错**；网关可能被 403；不支持 kimi.ai 国际区 |
| xAI Grok | 有 1 个 | 模型目录（返回 `grok-4.7`） | 额度、推理、刷新 | 伪装版本前后不一致且过旧 |
| ZCode | 有 1 个 | 模型目录（Coding Plan 2 个模型） | 额度（界面仍提示未确认 Coding Plan 余额）、推理、本机导入 | **BigModel 端点错**；**本机导入路径错**；`glm-5.3` 被改成 Flash；额度窗口标签混淆 |
| Qoder | 有 5 个 | 目录、推理；共存规则回归 | Windows；刷新时设备 ID 是否一致 | 额度只读驼峰字段；每次生成新 `machine_id` |
| WorkBuddy | 国内 2＋海外 1 | 国内／海外目录与推理（海外 12/12、96/96 压测） | Windows 菜单；免费账号；海外本机导入 | 伪装版本旧；海外本机导入漏文件 |
| Trae | 有 6 个 | **美国区**额度、推理、工具调用（安装版 80/80） | 新加坡／欧洲区、国内版 | 只支持美国区；导入不检查过期；回调端口与 Codex 冲突 |
| Cursor | 存于 TokenFlow 密钥库 | 官方 SDK 推理、本机会话＋官方逐事件账单（14,052 Token） | Windows；90 天后密钥过期 | 密钥不自动续期；额度走私有接口 |

**结论**：Claude 是唯一一个从未真实走通任何一步的平台；Kimi 授权已过期，等同于未测；xAI 和 ZCode 只验证过模型目录。

## 二、跨平台的共性问题

### 1. 刷新令牌被网关和本机客户端同时持有（Codex、Claude）

- 【代码】服务启动时 `discoverLocal`（`packages/core/src/service.ts` 第 264 行起）会把本机 Codex、Claude 登录自动导入网关账号池；本机切换时又把账号池里的凭据原样写回 `~/.codex/auth.json` 或 Claude 钥匙串。两条路径都让网关和本机客户端拿着**同一个刷新令牌**。
- 【官方】Codex：[CI/CD 认证文档](https://developers.openai.com/codex/auth/ci-cd-auth/) 写明 “Do not share the same file across concurrent jobs or multiple machines”，并把 “another machine or concurrent job rotated the token first” 列为刷新失败原因。
- 【本机】Claude Code 2.1.302 刷新时会拿到新的刷新令牌；遇到 `invalid_grant` 会把本机令牌清空，提示重新登录。
- 后果：哪一方先刷新，另一方就失效。短时测试看不出来，通常在第一次过期刷新后出现。本机已有 `~/.codex/auth.json.bak.revoked-20260917T233858`，可能就是此前遇到过一次（仅凭文件名推断）。
- 修复方向：同一时刻只让一方持有可刷新的令牌。切换到本机后，账号池里对应凭据停止刷新并标记“由本机持有”；还原时从本机读回最新令牌。启动导入改为只识别身份、不进入可刷新的账号池，或让用户单独为网关授权一次。（sidecar 已停用的授权不参与自动刷新调度，可直接用停用实现“停止刷新”。）
- **决定（2026-10-17）：暂不处理，保持共用。** 目前没有发现失效，预计只有很长时间不切换登录才会出现。若出现本机或网关提示登录过期，先按此条排查，再按上面的修复方向改。

### 2. 伪装的官方客户端版本落后

版本过旧可能被服务端拒绝或限流。2026-10-17 已按本机官方客户端或官方 npm 包对齐：

| 平台 | 原来 | 现在 | 依据 |
| --- | --- | --- | --- |
| Codex | 额度 `codex-tui/0.149.1`，推理与模型目录 `0.153.3` | 全部 `0.154.0` | 本机 `codex-cli 0.154.0` |
| xAI | 额度 `0.2.91`，执行器 `0.2.120` | `x-grok-client-version` 与 UA 版本号均为 `1.0.62` | 官方 npm `@xai-official/grok-darwin-arm64@1.0.62` 二进制中的 `x-grok-client-version1.0.62`；1.x 的 UA 是运行时拼接，静态看不出完整格式，UA 沿用原格式只换版本号 |
| WorkBuddy | UA `CLI/2.63.2 CodeBuddy/2.63.2`，刷新来源 `workbuddy` | `CLI/2.161.0 CodeBuddy/2.161.0`，刷新来源 `plugin` | 本机 WorkBuddy 5.8.3 内置 CLI 2.161.0，刷新与登出请求均发 `"X-Auth-Refresh-Source":"plugin"` |
| Claude | `claude-cli/2.1.258`，SDK `0.112.1` | **不变** | 见下 |

Claude 没改的原因：版本号与 SDK 版本、beta 头是一套指纹。本机 2.1.302 的计费头算法与盐值未变、运行时仍是 `v26.3.0`，但 SDK 已是 `0.128.0`，且比上游多出约 30 个 beta 名（如 `cache-keepalive-2026-09-03`、`timing-2026-09-09`、`inline-tools-2026-09-15`），哪些请求带哪些 beta 需要真实账号抓包才能确定。只改版本号会让 UA、SDK 版本、beta 头互相矛盾。上游 CLIProxyAPI 最新提交（2026-10-17，领先本地 4330 个提交）也只对齐到 `2.1.280`、SDK `0.112.1`。等有 Claude 账号实测或同步上游时一并对齐。

### 3. 回调端口

Codex 与 Trae 都固定使用 1455（官方注册的回调地址），同时登录会冲突；现在端口被占用时会提示是哪些客户端在用。Claude 固定 54545，被占用时可改用「授权码登录」。

## 三、各平台详情

实测建议使用测试账号，不要用主力账号。

### Claude（Claude Code 订阅登录）

**现状**：本机没有 Claude 授权文件；[模型目录跟进报告](../archive/reports/model-catalog-followup-2026-10-16.md)与 [Antigravity 修复报告](../archive/reports/antigravity-500-repair-2026-10-15.md)均写明没有可用 Claude 账号、未做实时验收。登录、额度、推理、切换、刷新全部未测。

**与本机 Claude Code 2.1.302 对照**

| 项目 | TokenFlow | 本机 CLI 2.1.302 | 结论 |
| --- | --- | --- | --- |
| client_id | `9d1c250a-…2f5e` | 相同 | 一致 |
| 授权地址 | `https://claude.ai/oauth/authorize` | `https://claude.com/cai/oauth/authorize`，实测 307 跳转到 claude.ai 并保留参数 | 等价；两者现在都放行 |
| 令牌／刷新地址 | `https://platform.claude.com/v1/oauth/token` | 相同 | 一致 |
| 回调 | 固定 `http://localhost:54545/callback`；另有授权码登录 `https://platform.claude.com/oauth/code/callback` | 随机端口；另有同一个手动授权码地址 | 端口被占用时可用授权码登录 |
| scope | 5 项 | 7 项，多 `org:create_api_key`、`user:plugins` | 子集，能用，但特征不同 |
| OAuth beta | `oauth-2025-04-20` | 相同 | 一致 |
| 额度接口 | `GET /api/oauth/usage` | 相同；`limits[]` 每项多了 `scope.model.display_name`，另有 `extra_usage` | 已按模型名标注 |
| system 首两段 | billing header＋“You are Claude Code…” | 相同 | 一致 |
| User-Agent | `claude-cli/2.1.258` | `claude-cli/2.1.302` | 落后 |
| 钥匙串服务名 | `Claude Code-credentials[-hash]` | 设置 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 时按它（空值不加 hash）；否则只有设置 `CLAUDE_CONFIG_DIR` 时才加 hash，hash 输入是变量原值 | 已对齐；未设置变量但目录不是 `~/.claude` 时仍加 hash，对应从 Finder 启动读不到终端变量的情况 |
| 凭据字段 | `claudeAiOauth.{accessToken,refreshToken,expiresAt,scopes,subscriptionType,rateLimitTier}`，毫秒 | 相同 | 一致 |

**会导致实测失败的点**

1. 刷新令牌共享，见第二节第 1 条（待修）。
2. ~~回调端口固定 54545、没有手动粘贴授权码的备用流程~~：已增加「授权码登录」。
3. ~~授权地址白名单只放行 `claude.ai`~~：已放行 `claude.com/cai`。
4. ~~钥匙串 hash 规则与 CLI 不一致~~：已按 CLI 源码对齐。
5. 切换后写入的 `subscriptionType`、`rateLimitTier` 为空，CLI 补拉资料前套餐显示可能不准。

**官方依据**：[认证与凭据存储](https://code.claude.com/docs/en/authentication)（macOS 钥匙串、Linux／Windows `~/.claude/.credentials.json`、`CLAUDE_CONFIG_DIR`、`claude setup-token`、认证优先级）；[状态栏 rate_limits](https://code.claude.com/docs/en/statusline)（`five_hour`／`seven_day` 的 `used_percentage`、`resets_at` 为 Unix 秒）；[Pro/Max 使用 Claude Code](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)。`/api/oauth/usage` 没有官方文档。

**实测清单**

1. 基线：`claude --version`；在 Claude Code 里 `/status` 记下登录方式和邮箱；`security find-generic-password -s "Claude Code-credentials" -a "$USER"`（不加 `-w`，只确认条目存在）。
2. 登录：先 `lsof -iTCP:54545 -sTCP:LISTEN` 确认端口空闲；授权地址里核对 client_id、`redirect_uri`、`S256`；完成后账号列表显示正确邮箱。失败信号：`redirect_uri` 不匹配、令牌端点 403、`invalid_grant`。
3. 授权码登录：点「授权码登录」，官方页面显示授权码后粘贴提交；粘贴旧会话的授权码应被拒绝。
4. 额度：与 Claude Code `/usage` 和状态栏对比，百分比相差不超过 1，重置时间一致；按模型的周限额显示模型名。
5. 网关推理：Claude Code 经 TokenFlow 发一条小模型请求，上游 200；再用 `/usage` 确认扣的是该账号。失败信号：401（OAuth beta 丢失）、400 “只能用于 Claude Code”。
6. 切换：完全退出 Claude Code 后切换，`/status` 显示新账号并能对话。**专门测刷新令牌共享**：让网关和 Claude Code 各刷新一次，看是否有一方提示 “Login expired”。
7. 还原：退出后还原，原账号可用；再用网关调用被切换过的账号，看是否已失效。
8. 过期刷新：等 `expired` 过后再发网关请求，刷新成功且本机 Claude Code 不掉线。

### Codex（ChatGPT 登录）

**现状**：有真实账号。macOS 已完成推理与逐请求账号证据（6 次、858,911 Token）、切换（见 [切换内存溢出报告](../archive/reports/codex-switch-oom-2026-10-17.md)）、额度展示；Windows 未测；个人主页日桶对账见 USAGE-005。

**与本机 Codex CLI 0.154.0 对照**：授权／令牌地址、client_id `app_EMoamEEZ73f0CkXaXp7hrann`、回调 `localhost:1455/auth/callback`（官方文档写明默认 1455）、额度接口 `chatgpt.com/backend-api/wham/usage` 及其字段全部一致。scope 少了 `api.connectors.read`、`api.connectors.invoke`，只影响连接器。

**问题**

1. 刷新令牌共享，见第二节第 1 条（暂不处理）；需要“同时使用 24 小时以上、跨过一次刷新”才能实测出来。
2. 【官方】[config-reference](https://developers.openai.com/codex/config-reference)：`cli_auth_credentials_store` 有 `file`／`keyring`／`auto`／`ephemeral`，管理员还能用 requirements 文件或 macOS MDM 强制指定。TokenFlow 只支持 `file`；被强制为钥匙串时，写回 `file` 后 Codex 仍读钥匙串里的旧账号，切换会**静默无效**。~~建议切换后跑 `codex login status` 核验~~（已修复：本机托管配置强制非 `file` 时拒绝切换；切换后跑 `codex login status`，未读到 ChatGPT 登录时提示）。本机当前是 `file`，不受影响。
3. 【官方】[定价页](https://developers.openai.com/codex/pricing)：GPT-5.5 已于 2026-10-14 从 ChatGPT 登录的 Codex 下线；需确认模型目录已更新。
4. 【官方】Pro 套餐没有 5 小时窗口、Enterprise/Edu 弹性计费没有固定窗口；后者可能显示“未返回额度窗口”。
5. 1455 端口同时被 `codex login` 或 Trae 登录占用时会冲突；现在会给出明确提示。

**实测清单**：备份 `~/.codex` 目录（不打开文件）→ 登录 → 额度与 `/status` 对比 → 网关推理（避开已下线模型）→ 切换后 `codex login status` → 网关与 Codex 同时使用 24 小时以上 → 还原后 `config.toml` 其他设置保留 → 过期后两边都未掉线。

### Antigravity（Google 登录，提供 Gemini 和 Claude 模型）

**现状**：有 3 个真实账号；目录、推理（含 96 次并发压测和 EOF 重连）已实测；本机 SQLite 用量只读核对 45 次。本机切换写入后 IDE 的表现、额度与 IDE 对账未测。

**对照**：与本机 Antigravity IDE 2.5.5 的 client_id、scope、后端地址（cloudcode-pa、daily）、状态库键名一致；IDE 用动态端口，TokenFlow 固定 51121，Google 桌面客户端一般接受任意本机端口【推断】。新版 Antigravity App 2.23.1 里没有找到 state-sync 键，本机切换可能只对 IDE 生效【推断】。

**问题**

1. 【代码】`antigravity-accounts.ts` 切换时写入的 `userStatus` 只有邮箱（本机真实值约 9KB），并把 `project_id` 写进 `enterpriseGcpProjectId`；个人账号可能被 IDE 误判为企业模式，需实测。
2. 【官方】[模型说明](https://antigravity.google/docs/models)：部分模型 2026-11-02 下线；额度按组（Gemini 一组，“Claude and GPT models”一组），各有 5 小时和周窗口，与现有解析结构吻合。
3. 【官方】[FAQ](https://antigravity.google/docs/faq)：只对已批准地区的个人账号开放，出口 IP 或账号地区不在列表内会登录失败。

**实测清单**：备份两个 `state.vscdb` → 登录后账号带 `project_id` → 额度分组与 IDE 设置页一致 → 分别调用 Gemini 和 Claude 模型 → 切换后启动 IDE，核对账号、套餐没被误判为企业、模型列表正常 → 还原 → 一小时后两边仍可用。

### Kimi（Kimi Code）

**现状**：本机 2 个授权在 2026-09-26 已过期，从未用有效账号实测。

**与官方源码 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)（2.2.0）对照**：client_id、设备码地址、`api.kimi.com/coding/v1` 一致。

**问题**

1. ~~额度字段读错~~（已修复）。官方 `packages/oauth/src/managed-usage.ts` 读取的服务端原始字段是 `usages.limit_5h`／`limit_7d`／`limit_month_total`／`limit_month_code`，每项 `used_ratio`、`reset_time`，再在客户端内部转成驼峰；TokenFlow 原来直接读驼峰。现在先读下划线、再兼容驼峰，夹具已改为服务端格式。
2. 【社区】[kimi-code#636](https://github.com/MoonshotAI/kimi-code/issues/636)：服务端按 `X-Msh-Platform` 白名单放行，非白名单返回 403 `access_terminated_error`（“only available for Coding Agents such as Kimi CLI, Claude Code, Roo Code…”）。CLIProxyAPI 申报的是 `CLIProxyAPI`，网关推理大概率被拒。不要通过改请求头冒充其他客户端来绕过。
3. 官方另有国际区（`auth.kimi.ai`、`api.kimi.ai`），TokenFlow 写死 `.com`，kimi.ai 账号无法使用。

**实测清单**：重新授权 → 额度与 Kimi Code Console 对比 → 网关推理（若 403 即证实问题 2，记录后再定方案）→ 过期刷新。

### xAI Grok

**现状**：1 个真实账号，只验证过 OAuth 对话目录（`grok-4.7`）。额度、推理、刷新未测。本机 Grok Bot 是 Cursor 出品（`com.anysphere.sand`），登录走 cursor.com，无法用来对照；Grok CLI 未安装。

**对照**：【官方】[CLI 参考](https://docs.x.ai/build/cli/reference) 中的设备码登录、`auth.x.ai`、`cli-chat-proxy.grok.com` 与代码一致；计费接口 `/v1/billing?format=credits` 无官方文档。

**问题**：~~伪装版本前后不一致且过旧~~（已对齐 1.0.62，见第二节）；【社区】团队账号查额度返回 412 “No personal team”，额度耗尽返回 403 `personal-team-blocked:spending-limit`，应显示为额度提示而不是授权失败；【官方】X 订阅用户的 Grok 与 Cursor 共用每周额度池，两张额度卡可能重复显示同一个池。

**实测清单**：设备码登录 → 额度显示每周额度和重置时间（另用团队账号验证 412）→ 网关调用 `grok-4.7` 流式与非流式 → 到期前刷新令牌轮换且请求不中断 → 额度耗尽时显示为额度提示。

### ZCode（Z.ai／BigModel GLM Coding Plan）

**现状**：1 个真实账号（本机官方客户端登录的是 BigModel 账号），只验证过模型目录；界面仍提示未确认 Coding Plan 余额。

**与本机 ZCode 3.15.3 对照**：CLI 轮询登录（`zcode.z.ai/api/v1/oauth/cli/init`、`/poll/{flowId}`）、`chat.z.ai` 授权、client_id、`/api/monitor/usage/quota/limit` 一致。【本机】官方客户端的 BigModel 账号在 `https://bigmodel.cn/login` 登录、没有业务令牌交换一步，额度地址在 `bigmodel.cn` 下；CLI 与桌面端共享的凭据文件是 `~/.zcode/v2/credentials.json`，键为 `oauth:active_provider`、`oauth:<zai|bigmodel>:access_token`／`refresh_token`／`user_info`、`zcodejwttoken`；桌面端可能对值加密【推断】。

**问题**

1. ~~BigModel 推理端点错误~~（已修复）：原来用 `open.bigmodel.cn/api/paas/v4`；【官方】Coding Plan 必须走 `https://open.bigmodel.cn/api/coding/paas/v4`，“错误配置端点将导致无法使用 GLM Coding Plan 套餐额度”。
2. ~~登录写死 Z.ai~~（已修复）：新增 BigModel 登录，额度按账号查对应主机。BigModel 额度接口的请求头格式未公开，先发裸令牌，被拒再用 `Bearer` 重试一次【推断】。
3. ~~本机导入路径错~~（已修复）：现在优先读 `~/.zcode/v2/credentials.json`；Z.ai 账号导入时同样做业务令牌交换；值像密文时拒绝导入并提示改用应用内登录。
4. ~~模型被静默降级~~（已修复）：`glm-5.3` 不再改成 `glm-5.3-flash`。
5. ~~额度窗口标签混淆~~（已修复）：【官方】有 5 小时和每周两个窗口，【社区】靠 `unit`／`number` 区分（`unit` 3 为小时、6 为周）；`number` 是窗口长度，不再当作额度上限。
6. 【本机／推断】官方客户端推理前会先解析一个 Coding Plan 项目令牌，TokenFlow 直接用业务令牌，需实测确认。

**实测清单**：Z.ai 与 BigModel 账号各登录一次 → 额度分别显示「5 小时模型用量」「每周模型用量」和工具用量，未开通套餐显示“未开通” → 网关分别调用 `glm-5.3` 与 `glm-5.3-flash`，核对返回模型名并确认扣的是套餐额度 → 本机导入（若提示已加密，记录桌面端版本）→ 过期刷新。

### Qoder

**现状**：5 个真实账号；目录与推理已实测，官方登录与自定义模型共存规则回归通过；Windows 未测。

**对照**：与本机 qodercli 1.1.29 完全一致（`selectAccounts`、S256、`deviceToken/poll`、`refresh`、`/v2/quota/usage`、client_id），Qoder IDE 状态库键名一致；【官方】[CLI 认证](https://docs.qoder.com/cli/authentication)、[Credits](https://docs.qoder.com/Credits) 对得上。

**问题**：~~额度只读驼峰~~（已修复，别名与 qodercli 相同）；~~每次刷新随机生成 `machine_id`~~（已修复：登录时写入授权文件，刷新时复用；旧授权文件在第一次刷新后写入）；原生切换未覆盖新的 Qoder App（0.3.4，独立数据目录）。

**实测清单**：浏览器登录与 PAT 登录各一次 → 额度显示套餐、加购、组织三类 Credits → 网关推理 → 切换到 Qoder IDE 后显示新账号、还原后回到原账号 → 过期刷新成功且授权文件里的 `machine_id` 不变。

### WorkBuddy／WorkBuddyAI

**现状**：国内 2 个、海外 1 个真实账号；国内／海外目录与 SDK 推理已实测（海外长对话工具 12/12，并发 96/96）；Windows 菜单未测。

**对照**：与本机 WorkBuddy 5.8.3（内置 CLI 2.161.0）的认证路径、刷新头、额度接口与字段一致；国内用 `copilot.tencent.com`，【官方】[CodeBuddy CLI 文档](https://www.codebuddy.cn/docs/cli/quickstart) 也列为国内站。

**问题**：~~伪装版本与刷新来源~~（已对齐 2.161.0 与 `plugin`，见第二节）；~~本机导入漏了海外的 `workbuddy-desktop-ai.info`~~（已修复：在 WorkBuddyAI 客户端下点「从本机导入」）；【官方】免费体验版没有 CLI 访问，免费账号走 `platform=CLI` 可能被拒；【推断】额度请求不带 `X-User-Id`／`X-Enterprise-Id`，企业账号可能拿到错误的额度池。

**实测清单**：国内、海外、免费账号各登录一次 → 额度显示套餐 Credits 与套餐名 → 两个区域分别 SDK 推理，确认无错误码 11128 → 原生切换与还原 → 刷新后仍在原区域域名 → 国内与海外本机导入，海外导入后账号文件名带 `overseas`、域名为 `www.workbuddy.ai`。

### Trae

**现状**：6 个真实账号；**美国区**额度、推理、工具调用已实测（见 [Trae 修复报告](../archive/reports/trae-repair-2026-10-16.md)），其他地区未验证。本机已卸载 Trae，只剩旧 `storage.json`，其刷新令牌已于 2026-05-07 过期。

**问题**：额度和推理主机只支持美国区（`api-us-east.trae.ai`、`trae-api-us.mchost.guru`），新加坡／欧洲区与国内版不支持；~~本机导入不检查刷新令牌是否过期~~（已修复）；~~刷新接口既无令牌也无错误时被当成成功~~（已修复）；回调端口 1455 与 Codex 登录冲突（已加提示）；IDE 版本头写死，可能过时。【官方】2026-02-24 起改为按美元用量计费（[套餐与计费](https://docs.trae.ai/ide/new-plans-and-billing)），代码判断方式与之一致。

**实测清单**：重装 Trae 对照客户端常量 → 1455 回调登录（确保 Codex 登录未同时进行）→ 美国区显示额度，非美国区明确提示不支持 → 网关推理与工具调用 → 刷新时令牌轮换 → 导入本机现存的过期 `storage.json` 应被拒绝。

### Cursor

**现状**：官方 SDK 推理、本机会话＋官方逐事件账单在 macOS Cursor 3.25.6 实测通过（14,052 Token），见 [客户端直连用量](native-direct-usage.md)。Windows 未测。

**对照**：与 `@cursor/sdk` 1.0.31、Cursor.app 3.25.6 一致；【官方】[SDK 文档](https://cursor.com/docs/sdk/typescript)：`Cursor.auth.login()` 签发 90 天有效密钥，存储的登录不读取本机 Cursor 应用凭据，不支持 Team Admin 密钥。

**问题**：密钥 90 天到期不自动续期；团队可禁止用户 API 密钥，此时登录或导入返回 403；额度走私有 `DashboardService`，字段一变严格校验就报错；每账号同一时间一个请求，并发返回 429。

**实测清单**：SDK 登录后控制台出现 `token-flow` 密钥 → 模型列表与套餐一致 → 网关推理与工具调用，并发请求返回 429 → 额度显示每周额度池 → 撤销密钥后界面提示重新登录。

## 四、修复顺序与剩余事项

按下列顺序修复，不需要真实账号：

1. **Kimi 额度字段**：已完成。
2. **ZCode**：已完成。
3. **Trae**：已完成。
4. **WorkBuddy 海外本机导入**：已完成。
5. **Qoder**：已完成。
6. **Claude**：授权码登录、`claude.com/cai` 放行、钥匙串 hash、按模型周限额标签已完成。
7. **Codex**：切换后用 `codex login status` 核验；检测 requirements／MDM 强制的凭据存储。已完成。
8. **Codex／Claude 刷新令牌共享**：按用户决定暂不处理，保持共用；方案留在第二节第 1 条。
9. **伪装版本号**：Codex、xAI、WorkBuddy 已对齐；Claude 需抓包或同步上游后再改。
10. **Kimi 国际区与网关 403、Trae 非美国区、Cursor 密钥续期**：不影响当前使用，暂缓，详情在本地私密文档。

需要真实账号才能关闭的事项：Claude 全流程（含授权码登录）；Kimi 重新授权后的额度与推理；xAI 与 ZCode（Z.ai、BigModel 各一）的额度和推理；ZCode 本机导入；Codex／Claude 跨刷新的长时间共用；Antigravity 切换后的 IDE 表现；Trae 非美国区。
