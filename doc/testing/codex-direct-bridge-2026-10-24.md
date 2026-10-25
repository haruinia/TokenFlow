# Codex 官方直连＋网关会话桥（10.15.26.68 实验版）

用户选择：继续接通官方直连＋网关的会话重载，再安装测试。旧版 .64/.66/.67 与本次源码、安装包分别保留。

## 链路与启动

官方使用内置 `openai` provider，推理与原生 compaction 由 Codex 直连官方；TokenFlow 不转发这两类请求。网关 provider 使用 `/v1`，明确 `remote_compaction=unsupported`，由 Codex 请求当前网关模型生成可读摘要。

使用当前桌面客户端支持的 `CODEX_CLI_PATH` 加载一个 stdio JSON-RPC 桥。它不处理 HTTP 推理。桥接代码和只含路径、模型 ID 的配置复制到用户数据目录 `codex-direct-bridge`，由 Codex 自带 Node 启动原版 Codex 引擎。退出 TokenFlow 不终止已加载的会话桥和原生引擎。

首次启用需要退出并重新打开 Codex 一次。后续通过本页「重启」入口启动混合模式；尚未安装系统级持久启动配置，普通应用图标启动不保证加载桥。界面区分配置已保存与桥已连接。此次安装本身不切换用户 provider，不退出当前 Codex；用户将在安装后选模式。

模型选择对应 `thread/settings/update` 或 `turn/start`，桥在必要时通过自身连接退订，按目标 provider 重载相同 thread ID，再恢复权限及模型设置。网关产生新内容后返回官方，先等待 Codex 的可读摘要完成。临时会话、活动回复/审批、后台终端、无法复原的权限、其他订阅者阻止重载时拒绝发送待发请求。失败尝试恢复原 provider；不会误将官方请求发往第三方。

官方加密压缩项不能被第三方直接解读。官方→网关的可读恢复沿用 TokenFlow 本地历史恢复；网关→官方使用可读摘要。并非无损状态共享。缺失本地历史应失败而非猜测。

## 验证证据

- `scripts/codex-provider-bridge-smoke.mts --live --long`：隔离 CODEX_HOME，实际安装 Codex 引擎、实际 OpenAI 与 Antigravity Gemini。经产品 `/api/a2a/connect` 配置新模式，生成约 50 万字符上下文。官方原生压缩、关闭测试 TokenFlow 服务续聊/压缩、重开服务、仅发送普通模型选择请求转网关、摘要后返回官方、再次关闭服务并压缩/续聊全部通过。两端标记保留，同线程，桥 PID 94060、引擎 PID 94061 未重启，官方转发尝试 0，测试登录文件内容不变。结果：`results/codex-provider-bridge-long-2026-10-24.json`。
- 短往返结果：`results/codex-provider-bridge-smoke-2026-10-24.json`。
- `scripts/codex-provider-bridge-tools.mts`：实际 Codex 引擎＋隔离本地 Responses 夹具（非真实供应商推理）。动态工具注册在官方→网关→官方重载后均能收到客户端调用和返回结果。三个阶段 reasoning=high；官方两端保留 service_tier=priority。自定义网关的原生请求没有 priority 字段：传递选项不代表第三方具备官方 Fast 能力。结果：`results/codex-provider-bridge-tools-2026-10-24.json`。
- 协议回归覆盖繁忙、临时会话、后台终端、其他订阅者、权限不一致、摘要失败、不泄露原始内部错误、工具和流消息转发、官方请求参数不变。
- 配置回归覆盖官方内置 provider、原官方目录 metadata、独立网关 Key、菜单改模型仍识别配置、恢复官方不触碰登录。
- 账号切换回归覆盖混合模式保持官方直连、原网关 Key、账号目录与桥路由同步，原账号可恢复。

## 验证边界

引擎与会话协议测试已完成；用户真实桌面窗口的首次加载、模型菜单交互和视觉无痕程度仍需本次安装后验收。不要将这些测试描述为所有 Codex 原生特性完全等价。

尚未验证官方父代理调用不同 provider 子代理、运行中子代理跨 provider 迁移、所有第三方模型、远程主机、外部沙箱和所有客户端版本。该实验入口仅支持当前可识别的 macOS Codex 安装。

## 发布前检查

- 9 个相关测试文件，175 项测试通过；TypeScript 检查、生产构建通过。
- 19 项 Electron 生产包运行检查通过，macOS ad-hoc 签名及 strict 校验通过。
- 工具往返夹具另外使用 Codex 自带 `cua_node/bin/node` 运行最终生产 bundle，三阶段工具调用与官方参数检查通过。
- 安装前只读确认当前用户配置 provider=openai，无官方 base URL 覆盖；记录配置及 auth 文件哈希用于安装后核对。没有在当前会话启用新模式。

## .68 用户试用反馈排查（2026-10-24 上午）

用户已在真实项目中验证切换；报告某 Responses API 断流、重复应用混合模式时目录读取失败，以及随后头像/账号加载缓慢。本轮没有重启 Codex、替换安装包或修改用户登录与配置。

- 切换记录：09:25 应用成功；09:34 目录读取失败；09:35 应用成功；09:36–09:37 多次目录读取失败；09:40 恢复官方配置成功（America/Los_Angeles）。目录读取在停止客户端和写配置之前。
- 新增隔离回归：已经应用混合模式后，连续两次目录请求抛超时。原 config、auth、模型目录、桥设置、网关 Key、接入记录与备份均不变，Codex 生命周期方法从未调用。不能把这类错误描述成半完成迁移。
- 桌面日志：首次混合启动引擎初始化约 2.12 秒；第二次约 1.82 秒；恢复原生后约 1.74 秒。第二次启动的 account/read 等待 29633ms 后返回 `workspace routing discovery failed`；getAuthStatus/desktop-auth 同时超时，之后账号读取恢复到 2–5ms。恢复原生后仍有云 WebSocket 失败和远程主机连接错误。支持账号发现/网络问题的方向，但没有足够证据证明具体网络根因或头像请求路径。
- 出错来源配置为本地 127.0.0.1:17450 的 Responses 接口，对应模型 `volcengine_deepseek-v4.1-flash-261017`。历史网关记录有多次 502；本轮通过其私有来源 relay 发送三条不含项目内容的短探测（普通、reasoning/high、工具声明），均返回 HTTP 200 和 `response.completed`，分别约 1.33、1.90、0.81 秒。未重放用户长历史，也未复现先前断流；这些探测不证明复杂请求全部兼容，不应据此宣称上游或 TokenFlow 已无问题。
- 使用当前官方授权经本机代理只读请求官方模型目录：HTTP 200、9 个模型、约 2.46 秒。未刷新或替换登录。

本轮源码改动：配置匹配且模型列表无改动时，混合模式按钮显示「已配置」并禁止重复应用；有改动或配置漂移仍可应用。会话桥未加载时保留「重启」提示。目录获取分别提示超时、网络连接失败和 JSON 格式异常，不把这些错误混称为登录失效，不输出底层敏感响应，也不使用跨账号缓存掩盖失败。

验证：错误分类用例修复前 3 项失败、修复后通过；5 个相关文件共 89 项测试通过，TypeScript、生产构建、diff whitespace 检查通过。本轮改动仅在源码/构建产物中，当前安装版仍为 .68；不声称已修复无法复现的断流或账号网络故障。

## 后续复现：API 日限额和共享代理节点超时

用户澄清第二次应用是为了加载新增模型，并非无改动重复点击。前述按钮修正仅针对配置匹配且模型草稿无改动的情况，不解决新增模型时目录发现失败。

09:59:19 再次应用混合模式成功，10:01:05 恢复官方配置成功。读取该次配置备份并做语义比较，变化仅为 `model_providers`、`model`、`model_catalog_json`；共享 CLIProxy 配置修改时间仍是 09:20:55。切换路径写入 Codex 配置、目录与桥文件，可能转换本地历史；启动设置 CODEX_CLI_PATH/CODEX_APP_RUNTIME_CLI_PATH，没有发现修改系统代理、DNS、证书的路径。

Clash 服务日志提供了独立网络证据：09:59:25 起，到 chatgpt.com/ab.chatgpt.com 的连接因无法连接所选代理节点而报 `dial tcp ... i/o timeout` / `context deadline exceeded`。09:59 至 10:03 每分钟分别出现 20、9、17、16、18 条相关警告；其他域名在应用之前的 09:58 也有连接警告。A2A 同账号 TLS 错误在恢复官方配置后的 10:02 仍发生。第二次桌面 account/read 约 24.85 秒后返回 workspace routing discovery failed。证据支持共同代理连接故障；尚未证明启动负载是否加重故障，不能仅凭时间关联断言会话桥修改了网络，也不应将 TLS 分类等同于证书损坏。所有时间为 America/Los_Angeles，Clash 原日志的 +08:00 时间已换算。

API 使用隔离 CODEX_HOME、实际已安装 Codex 引擎和不含项目内容的最小提示复现断流。诊断 relay 只收集字段名、事件类型和安全错误，不落盘请求/凭据。实际 API 返回 HTTP 200、application/json：`{"code":1008,"error":true,"message":"超过每天令牌使用限制","data":null}`。简化输入、去掉工具、思考或元数据均返回相同错误。故本次复现明确是 API 日 token 限额，不是 Codex 客户端被禁止，也不是工具字段兼容性证据。没有获取额度余额/重置时间；不能断言余额为零。早先短探测成功与后续限额不矛盾；不能确认所有历史失败都相同。

修复 HTTP 200 错误信封：Responses JSON 解析在验证输出/持久化上下文前识别 error=true 或结构化 error，保留已知安全错误分类。对实际观测的日限额消息返回 429 / upstream_daily_token_limit，提示去 API 服务检查额度；不泄露原始消息、调试字段或伪造 response.completed。新增集成回归覆盖 stream=true/false 和调用记录，修复前得到 502 invalid_terminal_response、修复后明确 429。未更换用户的代理节点、登录或安装包。

验证：TypeScript、生产构建和 diff 检查通过。4 个相关测试文件首次 165/167 通过，2 项在 sidecar 模型目录就绪等待阶段超时（尚未执行响应处理）；单独复跑这两项和新增日限额回归，3 项均通过。当前安装版仍为 .68，错误识别改动尚未安装。

## 2026-10-25：无迁移日志的混合模式旧历史首次整理

用户报告硅基流动 `deepseek-ai/DeepSeek-V4.1-Flash` 在旧对话切换后失败，新对话可用。01:00:05 的记录为 HTTP 400，耗时约 102 秒；01:02:57 的较短对话返回 200，约 5.35 秒。旧版只保存通用 provider_error，没有原始上游 400 明细，不能断言其唯一原因。普通短消息、工具结果回放、附带空 reasoning_content 的短回放均经同一 Chat API relay 返回 200。

只读分析发现失败分支通过多层 history_base 引用既有历史，其中一个历史 replacement_history 含 2231 项、约 14.96 MB。将 7 份必要 rollout 复制到私有临时 CODEX_HOME，使用实际安装的 Codex 引擎向本地诊断端点恢复，捕获了约 16.30 MB、2400 项的客户端压缩请求。再使用隔离副本中的 TokenFlow 上下文状态跑实际转换：bootstrapHistory 不存在，发送边界仍为约 16.02 MB、2362 项。没有向外部发送该诊断中的真实历史，也没有修改用户原 rollout。

确认的代码缺口：首次整理原先仅认迁移日志 revision。混合模式的会话重载和 fork 不一定有该日志，因而跳过整理。为受管混合模式增加显式 prepareHybridHistory 标志，并在线程范围记录 hybridPrepared；首次收到该线程或出现未处理的官方 opaque checkpoint 时，按现有阈值/分片策略整理旧历史。新对话的单条大用户消息不触发此整理；Key、模型或服务重启不会清空标记。失败不标记已完成、不覆盖原历史；后续普通网关轮次仍等待客户端压缩触发。标志仅由已保存的混合模式接入记录启用，并在服务重启与账号切换更新路由时保留。

修复后，同一真实历史的隔离副本经过 23 次本地假摘要，最大片段请求约 482 KB，最终请求约 321 KB、88 项。这只验证分片/缓存/数据流，不证明摘要语义保真。另用不含用户内容的约 180 KB 合成历史、小测试窗口通过实际硅基流动 API 完成 19 次分片/合并摘要及续聊，所有请求 HTTP 200，最终约 15.3 KB，两个精确标记 CEDAR-731 / 4186 均保留。未重放原用户会话到上游，具体原始 400 的全部成因仍未完全确认。

回归：新增首次继承、旧状态升级、跨模型/Key/重启复用、新对话不摘要、后续普通轮次不自动摘要、失败重试不改历史、新官方 checkpoint 再次准备，以及服务路由重启保留标志的检查。修复前新测试 2 项失败；修复后 6 文件 105 项通过，随后补充的 checkpoint 用例所在 4 项文件全部通过。TypeScript、生产构建通过。源码修复未覆盖安装；当前仍为 .68。

## .69 本地安装（2026-10-25）

已按用户要求安装 `/Applications/TokenFlow.app`，CFBundleVersion 为 10.15.26.69。生产构建、19 项打包运行检查、ad-hoc 签名及 strict 校验通过；安装文件哈希与已验收产物一致。旧版 .68 保存在 `release/v10.15.26.69/installed-before-69.app`，新版归档在同目录的 `TokenFlow.app`。退出菜单未完成后台关闭，安装仅向旧 TokenFlow bundle 内进程发送 SIGTERM，未停止 Codex。

新应用已启动，9527 首页返回 HTTP 200，Codex 页面、账号与所选网关模型正常显示。安装前后 `~/.codex/config.toml` 与 `auth.json` 哈希均一致；当前保存模式仍为官方直连，没有代用户启用混合模式。用户可在当前任务结束后应用“官方账号＋网关模型”并验收旧对话切换。首次旧历史整理可能需多次模型请求；真实原会话的上游 400 是否全部消除仍待用户复测，不能以安装成功代替该项验收。安装回执位于发布目录 `install-receipt.json`。

## 2026-10-25：硅基流动长历史压缩后返回官方直连

复用隔离会话 smoke，增加 --gateway-model 与 --gateway-long，使用当前生产 bridge bundle、实际安装 Codex 引擎、实际 OpenAI gpt-6-astra 和硅基流动 deepseek-ai/DeepSeek-V4.1-Flash。网关阶段输入约 463 KB 合成历史；显式执行 Codex 客户端压缩后续聊，再选择官方模型触发桥的摘要与同线程重载。网关压缩约 6.215 秒，压缩后续聊 1.895 秒；返回官方（包括桥追加的网关摘要）10.211 秒。官方阶段与网关阶段两个精确标记均保留。关闭隔离 TokenFlow 服务后，官方续聊 1.981 秒、官方原生压缩 9.748 秒、再次续聊 3.127 秒，全部成功；官方推理转发次数为零，桥与引擎 PID 保持不变，隔离登录文件未改变。结果保存于 results/codex-deepseek-roundtrip-2026-10-25.json。

命令：node --import tsx scripts/codex-provider-bridge-smoke.mts --live --proxy http://127.0.0.1:7897 --gateway-long --gateway-model api-f254d61008aa5e1648614c7e/deepseek-ai/DeepSeek-V4.1-Flash --out doc/testing/results/codex-deepseek-roundtrip-2026-10-25.json。首次未传系统代理的隔离尝试停在官方阶段，无验证结论，终止该测试进程后使用现有本机代理重跑成功；没有修改系统代理。测试服务与桌面 TokenFlow 独立，未关闭用户应用或改写真实 Codex 配置。

边界：这是合成长文本加两个标记的连续性检查，压缩由显式 compact/start 触发，不证明自动阈值触发或真实 16 MB 历史全部细节保真。桥在网关产生新内容后返回官方还会请求一次客户端摘要，因此切回并非零等待。

子代理核查：官方文档 https://learn.chatgpt.com/docs/agent-configuration/subagents 明确自定义子代理继承父 provider，model_provider 不能在自定义代理文件中覆盖。现有桥只处理客户端 thread/start、fork、resume、settings/update、turn/start，未处理引擎内部 spawn 路由；旧聚合方案同 provider 的子代理测试不能证明当前分离 provider 可用。本轮本地端点探针未暴露 spawn 工具，未形成有效子代理请求，不能声称实际跨 provider 派发或子代理压缩已通过。

## 2026-10-25：当前桌面真实跨 provider 子代理测试

用户明确要求测试后，从当前官方主代理通过原生 collaboration.spawn_agent 派发 fresh-context 子代理，显式选择硅基流动 DeepSeek、medium；只要求返回固定标记，禁止工具、文件操作和继续派发。子线程 01a1728a-930c-70a2-883f-14060274516b 的 turn_context 模型正确，但 session_meta.model_provider 仍为 openai。03:10:46 至 03:12:40（America/Los_Angeles）未出现对应硅基流动网关请求，也没有完成回复。桌面尝试读取/重载该子线程时，桥返回 -32001「请等待当前回复、工具操作或审批结束，再切换模型。」本次是运行中的内部子代理，不能通过客户端的空闲会话重载补救其首次路由。已 interrupt 该测试子代理，未修改主会话配置或用户文件。

结论：当前官方直连父代理直接派发网关模型子代理未成功；子代理创建成功不等于推理路由正确。此测试尚未进入网关推理，因此也未进入子代理压缩，不能宣称其压缩可用。应在首次推理前解决子代理 provider 选择，而不是放松忙碌会话重载保护。记录：results/codex-hybrid-subagent-live-2026-10-25.json。

## 2026-10-25：官方直连通过专用工具派发网关工作代理原型

在不改动当前应用、真实 Codex 配置或原生 spawn_agent 的前提下，新增 scripts/codex-direct-delegation-prototype.mts。它在隔离官方父会话注册动态工具 delegate_deepseek，由实际 OpenAI gpt-6-astra 选择调用；工具处理器通过同一个 app-server 创建独立 thread/start(modelProvider=token_flow) 工作会话，初始权限与父会话相同（read-only、never）。这是真实 Codex 网关工作会话，但不是引擎原生父子代理关系，不会自动获得原生 collaboration 管理与 UI。

使用实际硅基流动 deepseek-ai/DeepSeek-V4.1-Flash、当前生产 bridge bundle 和实际安装的 Codex 引擎通过测试。工作会话收到约 450235 字节合成长文本及两个精确标记；首次回复、显式 thread/compact/start、压缩后续聊三次网关推理均成功。子会话压缩 30.906 秒，整个子任务 38.884 秒；官方主代理调用工具并复述结果的总耗时 58.939 秒。工具结果中的两个标记均被主代理正确接收。主会话读取仍为 provider=openai，官方推理转发计数为零。

随后关闭隔离 TokenFlow 服务并确认端口关闭：官方父会话续聊 9.943 秒，原生压缩 13.720 秒，压缩后续聊 10.624 秒，两个标记仍保留且网关请求均为零。桥与引擎 PID 不变，隔离登录文件不变，临时会话/凭据副本在结束时清理。用户正在运行的 TokenFlow 和 Codex 均未关闭。

复现命令：node --import tsx scripts/codex-direct-delegation-prototype.mts --live --proxy http://127.0.0.1:7897 --gateway-model api-f254d61008aa5e1648614c7e/deepseek-ai/DeepSeek-V4.1-Flash --out doc/testing/results/codex-direct-delegation-prototype-2026-10-25.json。

推荐产品接入方向：给官方会话提供显式网关派发工具，服务在创建工作会话时选定 provider，主代理只接收任务结果；各会话分别由 Codex 调度压缩，DeepSeek 生成可读摘要、官方继续原生压缩。初期传递明确任务/必要摘要，不能将官方 opaque checkpoint 直接交给第三方。需要补齐任务生命周期（状态、取消、超时、失败）、并发限制、权限/工作目录/工具授权继承和恢复、结果长度控制，避免工具替调用方扩大权限。不能把它称为原生 spawn_agent 已修好，也不能据此承诺原生子代理 UI 或所有工具已验证。

测试边界：合成历史、单工作会话、无文件读写/外部工具调用；使用显式压缩而非等待自动阈值。当前为可重复执行的原型，没有注入用户现有会话，没有修改安装版。

## 2026-10-25：原生子代理管理可复用，派发消息另有协议限制

进一步源码和真实测试纠正上面的独立工作会话建议：不同 provider 不要求重写状态、取消、失败回传或权限继承。临时引擎在原生创建阶段选 provider，沿用 AgentControl，可以保留这些能力。但新版原生 v2 的任务消息是加密参数，且官方服务端固定 collaboration schema；只换 provider 或直接去掉加密标记都未通过真实测试。使用另一工具 namespace 调用相同原生实现的兼容原型，通过了真实 OpenAI→DeepSeek 派发、追加任务、自动压缩后续聊，以及关闭测试网关后官方原生压缩和续聊。不是给当前安装版直接修好了原始 spawn_agent，也不是另建不相关的 thread/start 会话。完整证据和产品边界：[原生 provider 路由调研](codex-native-provider-routing-2026-10-25.md)。
