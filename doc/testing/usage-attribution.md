# 用量渠道、来源与本地验证

整理日期：2026-10-16。关联 [USAGE-001 / USAGE-002 / USAGE-003](../TODO.md)。

## 先区分四个维度

| 维度 | 示例 | 不能据此推断什么 |
| --- | --- | --- |
| 目标客户端 `target` | Claude Code、Codex，或独立导出 Key 的 `key` | 使用 Messages 协议、Key 允许 Claude，不代表请求必定来自 Claude Code |
| 模型来源 `provider / sourceId` | 反重力来源与账号 A | 模型名字包含 Claude，不代表消耗 Claude 官方登录账号 |
| 来源渠道 `channel` | 官方账号 `official`、独立 API `api`、未知 `unknown` | `official` 表示来源类型，不代表请求绕过了 TokenFlow |
| 采集位置 `origin` | 网关 `gateway`、本机日志 `native` | 当前登录账号不必然是历史请求的账号 |

例如 Claude Code 通过 TokenFlow 使用反重力的 Claude 模型，正确归属是：目标 Claude Code、来源反重力账号、来源渠道官方账号、采集位置网关。它不应计入 Claude 官方账号直连用量。

界面按同一口径汇总：“使用方式”按 `target` 分为各本地 Agent（Claude CLI 与 Claude Desktop 分开）、API 代理（导出的 Key）和 TokenFlow 内部调用；“来源”按账号授权或 API 接口；账号授权页的今日用量只包含该平台账号服务的网关请求，以及本机日志中已确认走官方登录的请求，渠道未确认或 API Key 直连不计入。

## 当前实现范围

| 路径 | 当前依据 | 状态 |
| --- | --- | --- |
| Claude Code → TokenFlow → 反重力／其他来源 | 受管连接 Key 与来源绑定，上游 usage | 已有实现；本轮增加反重力双账号、Gemini／Claude、流式／非流式和重启测试 |
| 独立 Key → TokenFlow → 反重力 | 独立 Key 的 `sourceId` 与模型权限 | 来源可确定；目标记为 `key`，不能仅因授权 `agents=['claude']` 就认定客户端身份 |
| Claude Desktop → TokenFlow → 反重力／其他来源 | 网关记为 `target=claude-desktop`，来源按所选账号；本机 JSONL 的 `entrypoint=claude-desktop-3p` 在其当前配置指向本网关时不再重复累计 | 2026-10-17 起生效；第三方模式不计入 Claude 账号，指向其他网关时记为 API 渠道。旧索引按 v14 重建，不迁移历史账本 |
| Claude Code 本机官方直连 | 本机 JSONL、请求证据或有效登录观察时间段 | 夹具回归通过；复杂真实环境及包内历史失败仍待验收 |
| Claude Code 本机 API／第三方直连 | 日志中的认证证据，证据不足时未知 | 不能拿当前 TokenFlow 来源、当前登录或模型名倒填历史归属 |
| 反重力客户端自身的官方直连 | 2026-10-17 已接入原生 SQLite v1 的生成 Token 记录 | 生产 Worker 已在本机数据验证；旧 `.pb`、其他版本和无身份历史有边界，见 [直连采集](native-direct-usage.md) |
| 反重力周／5 小时额度 | `quota/antigravity.ts` 独立查询两个模型组、四个窗口 | 属于额度信息，不能从百分比反推 Token 或逐请求账号归属 |

## 本轮可复跑测试

```bash
npx vitest run tests/usage-attribution.test.ts tests/usage-attribution-service.test.ts tests/native-usage-logins.test.ts tests/local-usage.test.ts tests/local-usage-index.test.ts tests/usage-ledger.test.ts tests/usage-overview.test.ts
```

本轮在 macOS 开发机运行。原 37 项回归通过，新增反重力集成场景后共 38 项；测试使用隔离临时目录和模拟来源，不修改真实客户端配置、不读取钥匙串，不表示厂商真实调用或 Windows 实机已通过。

新增场景覆盖：

1. 两个反重力账号提供同名 Gemini 与 Claude 模型，来源分别计数，不按模型厂商错误合并。
2. Messages 非流式和流式各自将上游 7 输入／3 输出计入正确账号与模型。
3. 停用所选账号后返回 503，失败仍归该账号，不转到另一个有同名模型的账号，不增加虚构 Token。
4. 独立 Key 的请求记为 `target=key`；通过受管 Claude Code 配置取得的 Key 记为 `target=claude`，来源仍是反重力。
5. 关闭并重新创建本机服务后，各来源用量账本保持一致。

这些数字仅为固定测试输入，不是实际厂商 Token 值。

## 本机历史数据只读核对

读取现有应用资料中的 `usage-ledger.json`，仅输出汇总，不复制账号、Key 或请求正文。现有反重力记录覆盖 2026-10-13 至 2026-10-15：7 个汇总行、2 个非空来源标识，目标包含 Claude、DeepSeek、Pi，共 721 请求，其中 588 失败；记录输入 6,056,703、输出 27,407 Token。

该核对说明历史网关账本实际保存过反重力来源维度。它不能证明所有历史归属正确，也不能解释旧失败原因，更不能把旧压测／故障记录当作当前成功率或反重力原生客户端用量。本轮没有向真实厂商发起新的推理请求。

## 未关闭的验证

- **Claude 包内归属**：此前 `check-packaged-runtime.mjs` 在 Intel 包的 Claude 本机账号归属断言失败。本轮源码夹具通过，未重新构建并跑完整包内检查，继续保留在 TODO，不标记修复。
- **真实 Claude 渠道切换**：官方登录、独立 API、经 TokenFlow、直接第三方四条路径，需要在真实客户端逐条核对来源、账号、目标和 Token；权限跳过、账号切换、历史无证据与重复索引也要覆盖。
- **反重力直连采集**：SQLite v1 已实现，继续验收其他版本、真实账号／项目切换及完整厂商对账；不能用剩余额度或者当前登录推测历史。当前覆盖见 [直连采集](native-direct-usage.md)。
- **跨平台**：Windows 重跑本页回归并执行 [U04 / U11](../待修复的问题win兼容.md)，不能沿用 macOS 夹具结果。


## Codex Token 计算与官方口径核对（2026-10-17）

### 已确认的定义

OpenAI 的 [用量字段说明](https://developers.openai.com/api/docs/guides/agents-api/observability#understand-token-usage)明确：输入包含缓存读取，输出包含推理；总 Token 是输入加输出。例如输入 5,000（其中缓存 1,500）、输出 900（其中推理 200），总量为 **5,900**，不是 7,600。这是单次 usage 字段的定义，不能据此断言 Codex 个人主页汇总了哪些调用。

[推理文档](https://developers.openai.com/api/docs/guides/reasoning)也把推理计入输出；即使没有可见答复，已产生的推理仍可能有消耗。输入还可能包含指令、历史、工具定义和结果，因此一次用户消息可以产生多次模型调用，Token 不能按消息文字长度估算。

[缓存文档](https://developers.openai.com/api/docs/guides/prompt-caching)将缓存命中率定义为汇总缓存读取除以汇总输入；缓存命中降低的是相应成本，不把实际 Token 数打折。涉及缓存写入的 API 输入拆分为普通输入、缓存读取、缓存写入，三个部分仍包含在总输入中。

| 统计项 | TokenFlow 应遵循的规则 | 当前代码 |
| --- | --- | --- |
| 单响应总量 | 输入＋输出；缓存和推理不重复加 | `local-usage.ts`、`usage-model.ts` 已符合 |
| 输入构成 | 总输入减缓存读取和缓存写入得到普通输入；未知拆分不冒充确定值 | `gateway-observation.ts`、`usage-model.ts` |
| 推理 | 输出的子项，可单独展示，但不再加进总量 | 本机采集及网关观察均保存该子项 |
| 重复通知／复制日志 | 同一响应只计一次；旧累计通知使用增量 | `local-usage.ts`；这是本机去重规则，非对官方日桶实现的推测 |
| 子线程 | 统计真实新响应，按自身证据归属；父日志中的副本不再加一次 | 子线程修复与 v13 索引已验证 |
| 日期／账号 | 本机按请求记录时间和系统本地日汇总，账号必须有证据 | 官方日桶的时区和收录范围仍未确认 |

### Token 数、费用、额度分别处理

[Codex 官方定价说明](https://learn.chatgpt.com/docs/pricing#token-rates)区分原始 Token、购买 credits 和订阅包含用量。credits 按模型及输入／缓存输入／输出费率计算；Codex credits 无独立缓存写入费用，API Key 则遵循 API 价格。速度模式也可能改变消耗倍率；不能把某一费率或 API 账单直接换算为订阅剩余百分比。

产品要求：原始 Token 保留实际计数；费用／credits 若后续展示，应注明模型、计费渠道、速度档位、费率版本和是否估算。官方剩余额度读取服务端窗口。不同厂商的 usage 拆分需分别适配，不能把 OpenAI 的字段包含关系直接套给其他平台。

### 官方个人主页数字的边界

[App Server 文档](https://learn.chatgpt.com/docs/app-server#7-token-usage-chatgpt)提供 `account/usage/read` 的累计字段和 `startDate/tokens` 日桶；缺失可为 null，不能当作零。该节未公布日桶的时区、汇总截止时间或全部请求收录规则；[个人主页说明](https://learn.chatgpt.com/docs/app/settings#profile)介绍了活动指标，也未给出这些公式。

因此，当前可确认的是单响应计数公式已对齐。官方主页 3.5 亿与本地约 6.43 亿的差额不能靠调整输入／缓存／推理加法消除。官方接口快照若后续进入产品，应独立标注账号、原始日期和读取时间，用于对照；不得与本机明细相加或覆盖本机总量。现阶段官方读取仍是诊断功能，不宣称已实现官方汇总视图或日桶对账。待办仍为 USAGE-005，历史证据见 [直连采集记录](native-direct-usage.md#codex-个人主页与本机日志差异排查2026-10-17)。

### 本机验证

只读扫描本机 Codex 的 `sessions` 与 `archived_sessions`，限定北京时间 2026-10-16 的 `token_usage_record`，按响应标识检查重复，并仅输出用量字段汇总：

- 3,635 条记录、3,635 个独立响应；未发现冲突或缺失响应标识；扫描文件未变化。
- 每条都存在 `total_tokens`，**3,635/3,635** 与 `input_tokens + output_tokens` 相同；未发现缓存读取超过输入或推理超过输出。
- Codex 日志自己提供的 `total_tokens` 合计 **642,832,806**，与我们的输入＋输出合计完全相同。这是排除网关前的原始记录总量；此前排除 14 条网关响应的 245,404 Token 后，本机直连为 **642,587,402**。不能把两者当成不同公式。
- 6 个相关测试文件、41 项通过：本机解析／索引、逐请求归属、网关 usage、展示总量及官方读取诊断。覆盖缓存／推理包含关系、流式通知、副本去重和子线程。本轮无生产公式调整、无历史数据重写、无新推理测试请求；Windows 未实测。

复跑回归：

```sh
npx vitest run tests/local-usage.test.ts tests/local-usage-index.test.ts tests/gateway-activity.test.ts tests/usage-model.test.ts tests/usage-attribution.test.ts tests/codex-official-usage-check.test.ts
```

## 其他平台的字段口径复核（2026-10-17）

- [Claude 缓存文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance)：`input_tokens` 不包含缓存读取／写入，三项相加才是完整输入。本机 Claude／Qoder 的 Anthropic 形状日志采用该拆分，但这不证明其官方账号归属。
- [DeepSeek 缓存文档](https://api-docs.deepseek.com/guides/kv_cache/)：hit 和 miss 是请求输入的两部分。已有 `prompt_tokens` 时不能再加 hit；Harness 内部规范化后的字段另按客户端格式解析。
- [Cursor SDK 文档](https://cursor.com/docs/sdk/typescript#token-usage)：SDK 总量为 input＋output＋cacheRead＋cacheWrite；reasoning 已包含在 output，不再次相加。运行时报告与计费明细不保证相同；当前实现优先匹配精确会话账单，不能拿账号总额差分。
- [Qoder 用量文档](https://docs.qoder.com/cli/sdk/cost-usage)：逐请求 Credits 与会话累计是不同范围，不能相加；额度桶和上下文占用也不等于 Token 消耗。本轮没有用 Credits 改写本机 Token。

实际样本、缺口、同账号 Codex 4.664 亿的证据拆分，以及网关混合字段重复缓存的修复见 [跨客户端复核](native-direct-usage.md#跨客户端计数复核与-codex-同账号差额2026-10-17)。这些公开定义说明字段包含关系，不代替各厂商个人主页的收录范围与日界线说明。
