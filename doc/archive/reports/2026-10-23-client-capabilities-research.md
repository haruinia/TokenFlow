# 本地客户端与配置兼容调研（2026-10-23）

本轮仅更新调研报告；未修改运行代码、用户配置，未安装、更新或打包。本报告不展示任何真实密钥、账号 token 或完整用户配置。结论分为“已确认（当前源码/官方文档）”“建议/推断”“待实机验证”。问题 1 的实际日志由主代理另查。

调研基线：TokenFlow 当前工作区；CC Switch 官方上游 `farion1231/cc-switch` main，版本 4.0.19，提交 `d8983bb10b82a1ccc15ae5f44ab070902623e990`；OpenAI 官方 `openai/codex` main，提交 `970111f6cb62cc02fe36a82ea7d71b37a2889c97`。上游 main 的能力不代表用户已安装版具备同样行为。以下 GitHub 链接固定到调研提交。

## 2. 仅安装 Claude Code VS Code 插件时应用

**已确认：可以写共享配置，不必强制安装独立 CLI。** Anthropic 官方说明扩展自带用于聊天面板的 CLI；只有在终端直接执行 `claude` 才需另外安装。第三方 provider 使用 `~/.claude/settings.json`，扩展与独立 CLI 共享这份配置。[官方 VS Code 文档，Prerequisites / Use third-party providers](https://code.claude.com/docs/en/vs-code#prerequisites)

TokenFlow 当前只通过可执行程序判断 Claude Code 安装状态；找不到时 `installed=false`，前端 `applySelected` 即转入安装流程。因此这是前端安装 gate 误拦，而不是共享配置不能用。证据：`packages/core/src/agent-installation.ts:93-109`，`apps/console/src/AgentsPage.tsx:176`；共享配置路径及写入：`packages/core/src/agent-connections.ts:51`、`:358-363`。

**建议：** 将“配置可应用”与“可从本机启动 CLI”分开。配置存在/检测到扩展/用户明确选择仅配置时允许预览及应用；启动、重启与独立 CLI 安装保持各自条件。不要为应用共享配置而偷偷安装独立 CLI。

**边界：** VS Code Remote/WSL/container 的运行时读取远端用户目录，修改本机目录不能承诺影响远端；扩展 `environmentVariables` 可指定绝对 `CLAUDE_CONFIG_DIR`，项目级设置也可能覆盖用户设置。官方扩展文档的 Configure settings / Extension settings 已说明相关字段。待实机验证不同编辑器、远端环境及更高优先级设置覆盖后的生效提示。

## 3. 一键安装及更新

**已确认：现有实现已部分支持直接安装/更新。** Pi、Claude Code、Codex 有固定 npm recipe；macOS/非 Windows 缺失时可安装，已检测到特定全局 npm 路径时可更新。`automatic=false` 分支只打开官网下载页，所有检测为 application 的桌面渠道均在此分支。固定包名经 `execFile` 执行，未接受任意 shell 命令。证据：`packages/core/src/agent-installation.ts:9-18`、`:86`、`:106-136`。

更新探测已有 npm、DeepSeek 官方 feed、Qoder 官方 feed、WorkBuddy 官方接口；探测出版本不等于已有下载安装、验签及应用替换能力。证据：`packages/core/src/agent-updates.ts:21-49`。

**可行方案：按安装渠道管理。** npm 继续使用固定包名和安装前退出检查；Claude native 优先接官方 `claude update`，Homebrew/WinGet 按原渠道更新，扩展交编辑器更新。Codex 官方也提供独立安装器及 npm/Homebrew 渠道，应检测已有渠道而非一律转 npm。[Codex 官方安装说明 L14-L47](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/README.md#L14)。Anthropic 官方明确 native 自动更新，并提供手动 `claude update`，npm 也仍受支持但有 Node/optional dependency 条件。[官方安装及更新文档](https://code.claude.com/docs/en/setup#update-claude-code)

桌面应用可增设“下载官方安装器并启动”适配，但需逐厂商确认当前平台/架构、官方 feed 或稳定下载入口、签名、包格式、运行中替换和回滚方式；macOS 系统安装交互、Windows Store/UAC 不保证静默完成。不要把所有桌面应用统一当作可自动覆盖目录。DeepSeek Intel Mac 当前代码判定不支持，也不能绕过其官方包可用性。**待验证：** 每个桌面厂商/平台的安装器契约、渠道冲突和失败恢复；本轮未执行任何安装或更新。

## 4. Codex 重复 TOML 导致应用和恢复失败

**已确认：当前没有能绕过坏 TOML 的“覆盖修复”路径。** `decodeConfig` 直接 `parse(text)`；`repairConfigBase` 尝试恢复失败后仍解析当前文本；`nativeConfig` 同样先解析。apply 中 active 记录的 repair 还在 connectedConfig 的 catch 之外，因此重复表/键可直接透出 TOML 错误。证据：`packages/core/src/agent-connections.ts:126`、`:242-246`、`:279-282`、`:535-546`、`:609-612`、`:633-640`。

主代理随后只读核对本机 `switch-failures.json`：07:35:54.327、07:36:29.781、07:37:09.560 PDT 的 Codex `deepseek-flash` 操作均记录完全一致的 `Invalid TOML document: trying to redefine an already defined table or value`，其中 07:36:29 与用户给出的时刻吻合。没有读取/输出整份真实配置，也没有根据该记录归责某个外部工具。

**建议的可控覆盖：** 保存坏文件原始字节及 revision；最近合法备份仅作为重建基底，不能自动重放旧网关；从所选目的地重建路由，输出脱敏差异；落盘前完整 TOML parse、配置语义检查和 revision compare-and-swap，原子替换并保留回滚文件。没有合法基底时允许生成所选目的地的最小合法配置，并明确哪些非路由设置无法保留。不要用正则盲删重复表，避免误删多行字符串、数组和嵌套设置。用户已明确表达覆盖意愿，后续无需再次询问泛泛权限，但应保留可审阅结果和完整坏文件备份。

**与 CC Switch 兼容的含义：** 保留不归 TokenFlow 管理的合法表、更新其拥有的路由及 catalog 字段、检测另一个工具改写造成的 drift；不是让两个工具持续同时接管同一路由。CC Switch 自身也把 Codex 配置作为 TOML 解析，不能据此认定它会自动修好任意重复表。[CC Switch CodexProjection 解析入口 L144](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/live/project/codex.rs#L144)

**待验证：** 用户该次坏配置由哪个工具写出；本代理未读真实配置。应使用脱敏/合成重复表样本测覆盖、恢复、并发改写、完整备份回滚，而不是直接改用户配置来验证。

## 5. 从 CC Switch 导入模型供应商

**已确认数据格式。** 当前官方上游默认是 `~/.cc-switch/cc-switch.db` SQLite；数据目录可覆盖。`providers` 以 `(id, app_type)` 为联合主键，保存 `name`、JSON 文本 `settings_config`、JSON `meta`、分类等；另有 `provider_endpoints`。其 UI 文件导出/导入是 SQL 备份，不能假定是一个通用 providers.json。[schema L27-L59](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/database/schema.rs#L27)，[目录选择 L313](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/config.rs#L313)，[SQL 导出/导入 L30-L66](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/commands/import_export.rs#L30)。

**建议先做供应商选择性导入，不恢复整库。** 优先只读 SQLite 一致性快照并探测 `user_version`/列；支持官方 SQL 导出时，在隔离临时库、禁用 ATTACH/扩展/文件访问及触发器等越界行为后读取所需表，不能将文件任意 SQL 执行到用户库。上游也用临时库、authorizer 和 schema 检查约束 SQL 导入。[上游备份实现 L35-L83、L182-L220](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/database/backup.rs#L35)

| 来源内容 | 到 TokenFlow 的映射及限制 |
| --- | --- |
| Claude `settingsConfig.env` | `ANTHROPIC_BASE_URL` → `baseURL`；`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` → 安全存储；协议 `messages`；读模型及档位字段，去重但保留真实上游模型 ID。不能导入整个 env 覆盖 TokenFlow 进程。 |
| Codex `settingsConfig.auth` + TOML 字符串 `config` | key 取 `auth.OPENAI_API_KEY` 或有效 `experimental_bearer_token`；URL 取所选 `model_provider` 对应表；模型优先 `modelCatalog.models[].model`，再顶层 `model`；协议按显式 `apiFormat`/`wire_api` 归一化为 `responses`/`chat`/`messages`。 |
| 显示名/别名/多个 endpoint | 供应商 `name` 可导入；模型显示名应与真实 ID 分离。TokenFlow 当前 ApiSource 没有通用逐模型显示名字段，需明确补 schema 或报告未保留项。多个 endpoint 应让用户选入口或拆来源，不能静默把每个 URL 当等价备份。 |
| OAuth/托管帐号/官方卡 | 不作为 API key 来源盲导入；CC Switch 的 `codex_oauth`、Copilot 等由其托管账号系统和本地代理注入凭据，单独复制 provider 行并不具备认证能力。应跳过并说明需在 TokenFlow 独立授权。 |
| env_key/command auth/额外 headers/脚本 | 外部变量不存在不能视为空 Key 自动完成；TokenFlow 当前 ApiSource 只有三协议+单 Key，不支持的认证或 header 要列为待补配置，usage script 不执行。 |

映射依据：[Provider 及托管认证判定 L10-L101、取凭据 L156-L201](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/provider.rs#L10)，[Codex key/URL 提取 L955-L998](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/codex_config.rs#L955)，[catalog 模型字段 L1455](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/codex_config.rs#L1455)，[协议识别 L30-L55、L170-L198、L877-L893](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/proxy/providers/codex.rs#L30)。TokenFlow schema：`packages/core/src/api-sources.ts:14-28`；新来源必须有 key，安全存储和写入回滚位于 `:114-129`。

**去重与事务建议：** 以来源 app/id 做导入标记，以 URL+协议+密钥指纹辅助查重；密钥不进 UI/日志；导入前展示可导入、缺配置、已存在、跳过四类，确认后的写入调用已有安全存储并支持失败回滚。导入供应商不自动切换客户端配置，也不更改 CC Switch 数据。**待实机验证：** 用户安装版本、数据库路径/列、旧版 JSON、真实脱敏样本及所用插件的认证方式。

## 6. 登录 GPT 帐号时官方模型与第三方模型共存

**结论：当前 Codex 有构建聚合模型菜单的机制，CC Switch 当前上游已有具体实现；TokenFlow 当前接入方式尚未实现“保留原帐号身份、官方模型走原帐号、第三方模型走网关”的完整共存。** CLI profile、桌面菜单聚合、保留登录文件是三件独立能力。

### Codex 原生支持到哪里

- **多个 provider 声明 ≠ 自动聚合。** 配置可保存多家 provider，但选定一个 `model_provider`；上游配置构造亦只取一个 provider。CLI `--profile` 是配置层切换。官方当前明确从 0.134.0 起 profile 使用 `$CODEX_HOME/<name>.config.toml`，旧 `[profiles.name]`/顶层 `profile` 已不再被读取。TokenFlow `codexProfile()` 仍处理旧结构，应按实际客户端版本适配。[官方高级配置 Profiles / Custom model providers](https://learn.chatgpt.com/docs/config-file/config-advanced#profiles)，[单 provider 选择 L3994-L4016](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/config/mod.rs#L3994)。
- **官方确实支持桌面与 CLI 模型目录。** 新文档明确 gateway/cloud 可用 Codex Models catalog 驱动两个客户端的 picker；API-key provider 可显式 `model_catalog_url` 开启发现。`model_catalog_json` 是权威本地目录，优先于远端获取。普通 OpenAI `/v1/models` 列表不含 Codex 所需完整元数据。[官方 model catalogs 文档](https://learn.chatgpt.com/docs/model-catalogs)，[源码采用静态目录 L400-L416](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/model-provider/src/provider.rs#L400)。目录能列出多家模型，但每个 slug 的推理路由仍需要网关实现。
- **认证文件保留不等于帐号仍被当前 provider 使用。** `requires_openai_auth=false` 时上游 `account_state()` 返回无帐号；这可解释保留 auth.json 仍出现“帐号没登录/看不到原模型”的情况。TokenFlow `connectedConfig` 当前写 `token_flow`、`requires_openai_auth=false`、网关 bearer，并把目录替换为所选模型：`packages/core/src/agent-connections.ts:365-388`、`:518-524`。[官方源码 account_state L522-L563](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/model-provider/src/provider.rs#L522)。
- **官方也支持 ChatGPT 登录经网关。** 官方部署文档使用 `requires_openai_auth=true`，把 ChatGPT Authorization 与网关凭据分开，网关向 Codex 官方 backend 转发。该文档是 workspace managed 部署路径，并不保证任意第三方模型天然使用 ChatGPT 订阅；混合非 OpenAI 模型仍需独立鉴权/路由和协议兼容。[官方 Sign in with ChatGPT through a gateway](https://learn.chatgpt.com/docs/enterprise/sign-in-with-chatgpt-through-a-gateway)。

### CC Switch 到底怎么实现

已确认当前 main 的 Aggregation/Stack 模式是**统一本地代理 + 合并 Codex catalog + 按模型 ID 分流**：

1. 官方卡为默认路由时，保留官方模型的原生条目，再追加带供应商前缀的第三方 `ccs-<key>/<model>` 条目，避免同名模型碰撞。不是把几段 `model_providers` 简单叠加。[目录构造 L2568-L2654](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/codex_config.rs#L2568)，[官方+第三方同目录测试 L5671-L5724](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/codex_config.rs#L5671)。
2. 官方默认路由先读取登录态对应的完整官方列表；没有可用官方行时不写成“只有 Stack 模型”的目录，避免把官方模型遮没。已有自管 `model_catalog_json` 时也不强行合并。[codex_direct.rs L912-L956](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/services/provider/codex_direct.rs#L912)。
3. 客户端官方路由仍使用 OpenAI 登录；非统一历史时用顶层 `openai_base_url` 指向本地代理，统一历史时写 requires_openai_auth=true 的官方镜像 provider。[路由和镜像表 L451-L501](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/live/project/codex.rs#L451)。
4. 代理解码前缀，选择指定供应商并把 `body.model` 还原为上游 ID；官方请求透传客户端 ChatGPT Authorization，第三方请求换成其独立凭据，并剥离 ChatGPT 帐号/会话身份 header。[分流 L182-L215](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/proxy/handlers.rs#L182)，[凭据处理 L2472-L2492](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/proxy/forwarder.rs#L2472)，[第三方身份剥离 L3617-L3635](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/proxy/forwarder.rs#L3617)。
5. 另外有“切换第三方时保留官方登录”的独立开关；它与聚合目录不等价。第三方带自己 bearer/env_key 时还会按登录是否存在设置 requires_openai_auth，以兼容新版帐号 UI；不能无凭据地把该值盲改为 true，否则会把官方凭据回退发往第三方。[登录保留 L389-L407](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/services/provider/codex_direct.rs#L389)，[认证条件 L78-L89](https://github.com/farion1231/cc-switch/blob/d8983bb10b82a1ccc15ae5f44ab070902623e990/src-tauri/src/live/project/codex.rs#L78)。

**建议实现方向（尚未修改）：** 先做“官方为基础路由的共存模式”：用客户端当前真实登录读取官方完整 catalog，与 TokenFlow 所选第三方目录合并；保留官方模型 ID，第三方使用明确来源命名空间；网关对官方模型转发客户端登录，对第三方替换凭据并去掉官方身份；两类分别测试实际请求及帐号显示。TokenFlow 内另行 OAuth 登录并经 CLIProxy 调用官方模型是另一种能力，不能代替“沿用该 Codex 客户端现有帐号”。默认覆盖模式与共存模式应有明确差异及回滚。

**仍需实机验证：** 用户桌面内置 CLI 的具体版本/目录 schema、官方目录随帐号动态更新、原会话恢复与 provider ID 分桶、跨供应商切模型的压缩/加密 reasoning/工具协议差异、subagent v2、官方 OAuth 刷新、API key/官方 token 不串路由、客户端重载时机。上游源码/测试证明实现路径存在，本轮没有运行 CC Switch，也没有对用户帐号做推理请求，因此不承诺所有模型/客户端版本无缝兼容。

### 补核：重启后列表不显示不等于会话丢失

**已确认当前官方 app-server 行为：** 普通 `thread/list` 省略或传 null 的 `modelProviders` 会默认筛选 `self.config.model_provider_id`；显式传空数组 `modelProviders: []` 会关闭 provider 筛选；非空数组只列指定 provider。例外是 relation 查询（如带 parent/ancestor/attached relation）：省略 provider 时不加该筛选。请求字段由 `thread_list_response_inner` 原样交到公共列表函数。[参数传递 L2798-L2815](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/request_processors/thread_processor.rs#L2798)，[默认筛选及空数组分支 L5995-L6005](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/request_processors/thread_processor.rs#L5995)，[协议字段说明 L1433-L1436](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1433)。

**推断与验证边界：** 如果从 `token_flow` 切到 `openai`，而客户端发普通列表请求且不指定 `modelProviders`，原先记在 `token_flow` 的会话可仍在 state/rollout 中却暂不出现在这次结果；空数组仅表示跨 provider，不会绕过 archived/source/cwd/project 等其他过滤。该机制是“重启后看不到”的候选解释，不能据此断言用户桌面 UI 实际省略了该字段，也不能据此排除 history projection/offset 错误；需结合实际客户端请求、逻辑 thread ID、state 与 rollout 对照。此补核只读源码，未查询或修改用户会话。

## 7. 使用前置及供应商分组名称

**已确认：这是独立的小范围导航调整。** `apps/console/src/main.tsx:38-39` 的 saved 包含帐号授权/API 接口，used 包含本地 Agent/API 代理；`:131-132` 先“已保存”后“使用”。用户要求可实现为交换组渲染顺序，将“已保存”改为“供应商”，保留子入口与路由。帐号登录身份在语义上也属于模型来源，但最终文案按用户偏好，不另行扩大 UI 重构。已读 `doc/design.md`，本轮未改 UI。

## 建议后续顺序

优先完成用户要求的 Codex 续聊、压缩与历史恢复修复；坏配置可恢复覆盖、Claude 扩展独立使用误拦及导航调整可独立跟随。“官方登录+第三方模型”共存依用户要求在续聊稳定后再做。CC Switch 选择性导入、分渠道安装更新另作功能增量。每项实现前保留本报告的已确认边界；实现后再以隔离配置/脱敏样本验证，最后才考虑打包。本轮没有以调研结论授权修改用户现有配置。
