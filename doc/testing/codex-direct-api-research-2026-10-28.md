# Codex 供应商直连与 DeepSeek 调研

日期：2026-10-28（America/Los_Angeles）。本轮只做源码、官方文档和隔离协议验证；未修改真实配置或登录，未调用真实供应商推理。

## 结论

**可以增加“供应商直连”作为连接方式，DeepSeek 官方 API 已具备这种基础能力。** 这条路径是 `Codex → api.deepseek.com`，TokenFlow 负责生成可恢复的配置和读取本机用量，不承担推理转发。不能把任意 Chat Completions 兼容 API 都当成 Codex 可直连接口；也不能只改菜单里供应商名称。

DeepSeek 官方已发布 [Codex 接入指南](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)，提供原生 Responses 地址、模型目录和 provider 配置。本次实际打开文档，未执行其安装脚本。其当前示例模型为 `deepseek-flash` 和 `deepseek-v4-pro`；[模型列表文档](https://api-docs.deepseek.com/api/list-models/) 将前者显示为 DeepSeek-V4.1-Flash，并提供上下文、输入模态和思考档位。七牛、硅基流动等平台托管的同名模型，仍需分别核查该平台的协议和真实模型 ID，不能据此推定也可直连。

## 当前客户端与 TokenFlow

本机实际执行 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --version`，返回 `codex-cli 0.165.0-alpha.1.2`。

OpenAI [配置参考](https://learn.chatgpt.com/docs/config-file/config-reference) 只列 `wire_api="responses"`；支持按 provider 设置 `base_url`、`env_key` 或命令式凭据读取，远程压缩能力可为 `unsupported` / `v2`。[兼容要求](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility) 明确：Chat Completions、Anthropic Messages 或健康检查成功不足以证明 Responses 兼容，还要验证流、工具与续聊。

TokenFlow 当前 `connectedConfig()` 仍把所选模型写为 `model_provider="token_flow"`，地址指向本机 `/v1` 或 `/codex/v1`。源码：`packages/core/src/agent-connections.ts:414`。`codex-routing-mode.ts` 将其他 provider 识别为 external，尚没有供应商 API 直连的完整产品入口。因此本报告证明可实现，不表示 .89 已经提供此功能。

## CC Switch 实际做法

核查已有源码固定点 `6d6b7162f122ac0ce1356a14688c8c4f712db3c8`（2026-10-28）：

- [DeepSeek 预设](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src/config/codexProviderPresets.ts#L1709) 指向 `https://api.deepseek.com`，模型 `deepseek-flash`，`apiFormat="openai_responses"`。
- [模型目录逻辑](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/codex_config.rs#L1990) 对 DeepSeek 原生 Responses 路由使用供应商目录，而转换代理使用另一类工具配置。说明直连和格式转换是两条实现路径。
- [配置投影](https://github.com/farion1231/cc-switch/blob/6d6b7162f122ac0ce1356a14688c8c4f712db3c8/src-tauri/src/live/project/codex.rs#L1) 将第三方路由规范到 `model_providers.custom`。选择的是供应商地址；实际 Key 通常写进该表的 `experimental_bearer_token`，已有 `env_key` / 命令鉴权等则沿用。官方 `auth.json` 留给官方登录。它不是“完全不保存 Key”的方案。

## 已运行的隔离验证

研究脚本：[codex-direct-api-probe.mjs](prototypes/codex-direct-api-probe.mjs)。使用真实安装的 Codex、临时 HOME / CODEX_HOME、合成 Key 和本机假 Responses 服务；只合成回复，不调用工具、真实供应商或 TokenFlow。临时目录结束后移除。

```sh
node doc/testing/prototypes/codex-direct-api-probe.mjs \
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
  /tmp/tokenflow-usage-ccswitch-20261028/src-tauri/src/resources/codex_deepseek_catalog_template.json
```

两次运行通过，结果一致：

| 验证 | 结果 |
|---|---|
| 自定义 provider 指向独立 Responses 地址 | 仅一次 `POST /responses`，收到完整终态并成功退出 |
| 模型与强度 | `model=deepseek-flash`、`reasoning.effort=high`、`stream=true` |
| 凭据 | 从测试进程环境变量读取合成 Key；未读取真实登录 |
| 改为 `wire_api="chat"` | 配置加载时报不再支持；未发出任何额外请求 |
| TokenFlow / 真实 DeepSeek 请求 | 均为 0 |

这证明当前客户端的直连配置链路可用；**不等于 DeepSeek 真实账号、工具执行、长对话、压缩或官方↔DeepSeek 往返续聊已验收**。真实供应商兼容性目前依据其官方公开契约，未做付费调用。

## 必须保留的协议边界

DeepSeek [Responses 指南](https://api-docs.deepseek.com/guides/responses_api/) 明确不支持 `previous_response_id`、服务器会话、`context_management` 和 `encrypted_content`，部分工具及参数也有差异。[接口参考](https://api-docs.deepseek.com/api/create-response/) 要求多轮传完整 `input`；函数调用与结果需配对。直连并不能解密已有 OpenAI 历史，也不能恢复任意网关私有检查点。

建议直连明确声明 `remote_compaction="unsupported"`，让 Codex 走本地压缩流程，向当前 DeepSeek 请求可读摘要；不要仅凭 Responses 支持就声明官方远程压缩能力。此建议由两方协议推导，本次未运行真实长上下文压缩。

## 后续产品范围（待实施）

1. 在连接方式中提供“经 TokenFlow / 供应商直连”，只为已核查的 Responses 来源启用直连。选中后写入该供应商 provider、完整地址、真实模型 ID、凭据引用与匹配目录；保留其他设置及可恢复备份。
2. 直连优先用 `env_key` 或受限命令读取凭据；不为了直连把用户真实 Key 再复制进 TokenFlow。环境变量必须确实传到桌面进程，不能只在终端导出就宣称生效。命令读取仍会让客户端在运行时接触 Key，只是不把值重复写进配置。
3. 官方登录文件可以保留；账号头像/刷新与 `requires_openai_auth` 的关系需按安装版本隔离验收，不把“文件仍在”当作“官方与第三方共用一条认证”。
4. 首批用新会话验证：普通流、函数工具、apply_patch、思考档位、取消、长对话本地摘要、重启续聊。旧混合会话单独验证历史转换后再开放，不自动删除或忽略密文。
5. 直连不经过网关计量，沿用本机日志采集；来源和账号归属只能按明确证据标注。不能既把本机记录计一次，又补造一笔网关消费。

以上是可评审的最小范围，不包含后台接管、多 provider 无缝混合或新凭据同步服务。
