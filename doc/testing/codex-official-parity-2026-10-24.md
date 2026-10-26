# 官方模型共存：参数与压缩实测

日期：2026-10-24（America/Los_Angeles）。安装的 TokenFlow 为 10.15.26.64，Codex 引擎为 0.164.0-alpha.11.1。

## 结论

当前共存配置不能宣称与官方原生行为完全相同。模型、思考强度、快速档位字段可以保留，但未声明远程压缩能力的自定义 provider 会触发 Codex 的本地摘要流程。该流程把摘要提示作为普通请求交给所选官方模型；这不是 TokenFlow 的网关摘要算法，也不是官方不透明远程压缩协议。

只在隔离配置中增加 `model_providers.token_flow.capabilities.remote_compaction = "v2"`，相同引擎即改发官方远程压缩触发器。本轮未修改生产路由生成器、用户配置、登录或历史，也未安装／重启应用。

## 本机证据

验证前后磁盘上的 `~/.codex/config.toml` 均为默认 `openai` provider，无 9527 网关地址，默认思考强度 high、服务档位 default。活动线程可以另有覆盖，配置本身不能证明所有已运行进程的在途请求路由。

仅检查当前会话的结构元数据，没有保存聊天正文：

- 03:17:56 的压缩替换历史包含官方加密 `compaction` 项。
- 04:19:37 的压缩记录为 15,442 字符可读摘要，替换历史没有加密 `compaction` 项。
- 最近几轮上下文记录为 `gpt-6-astra`、high。

记录格式与以下隔离对照一致，但不单凭格式断言某次历史压缩的所有配置细节。

## 已安装 Codex 引擎的隔离对照

使用真实缓存的官方模型元数据、合成登录和本机模拟上游，不使用真实账号推理。每组从独立 HOME/CODEX_HOME 启动安装的引擎，经 app-server `turn/start` 切换模型、effort、serviceTier，再显式调用 `thread/compact/start`。

| 配置 | 模型／强度／priority 发出正确 | 压缩请求 |
| --- | --- | --- |
| 内置 openai provider | 是 | Responses `compaction_trigger` |
| 当前 token_flow provider，无能力声明 | 是 | 普通 Responses 请求，包含本地摘要提示 |
| token_flow，声明 remote_compaction=v2 | 是 | Responses `compaction_trigger` |

参数组合：gpt-6-astra / low / default；gpt-6-astra / high / priority；gpt-6.1-sol / xhigh / default。default 在传输中省略，priority 原值发出。

可复现命令（当前配置的原生压缩一致性断言**预期失败**）：

```sh
node --import tsx scripts/codex-official-parity-smoke.mts --require-native-compaction --out doc/testing/results/codex-official-parity-2026-10-24.json
```

这验证的是引擎生成请求的行为，不是实际点击桌面模型选择器，也不覆盖长历史自动阈值触发。

## 真实官方服务对照

使用现有官方登录，只读取凭据、不刷新或修改登录。在临时 HOME 中启动生产 `createDesktopService`，独立的合成网关来源只用于建立共存配置；推理请求全部发往固定官方主机。没有调用第三方模型或传输真实聊天内容。网络使用本机已配置的系统代理 127.0.0.1:7897。

```sh
node --import tsx scripts/codex-official-live-verification.mts --proxy http://127.0.0.1:7897
node --import tsx scripts/codex-official-live-verification.mts --proxy http://127.0.0.1:7897 --priority-only
```

观察到 9 个 HTTP 200 且完成的推理／压缩响应，官方 usage 合计 554 Token：

- gpt-6-astra 的极短普通请求，直达官方与通过隔离 TokenFlow 服务均成功，返回模型正确。
- gpt-6-astra 和 gpt-6.1-sol 的 high / priority 请求分别做了直达与转发配对。四次官方响应的模型均正确，`reasoning.effort` 均回显 high；`service_tier` **均返回 default**。
- TokenFlow 在官方出站边界记录的 priority 未被删除或改写。两条路径均回 default，不能归因于 TokenFlow 把请求降档；同样不能宣称快速服务已实际启用。完整桌面元数据、账号权益和官方调度原因仍未确定。
- 显式远程压缩请求经过 TokenFlow 后，官方返回了加密 `compaction` 项。只带该项与新问题续聊，成功返回压缩前的合成标记 PARITY_7284。

这证明官方压缩协议可以通过转发链路工作；不能替代 Codex provider 能力声明，也不证明跨提供商长对话摘要无损。高强度测试使用极短任务，reasoning token 为 0 不用于推断强度是否被降低。

首次普通 Node fetch 没有继承 macOS 系统代理，连接失败；改为显式使用已发现的系统代理后完成上述对照。没有为此修改系统网络设置。

## 服务测试与建议

`tests/codex-coexist.test.ts` 补充生产入口参数保留断言，覆盖 reasoning、service_tier、官方 opaque compaction、Responses compaction_trigger 及 /responses/compact；未知模型和凭据隔离断言保留。与 `tests/codex-context.test.ts` 合计 41 项通过，项目 typecheck 通过。

建议先保持当前官方配置。若继续使用同一会话混合模型，应先修复并回归共存配置的远程压缩能力声明，然后验证网关压缩往返与真实长对话；WebSocket 仍关闭，TokenFlow 仍是可用性依赖，不能承诺与原生完全等价。

能力配置语义参考 [OpenAI 官方配置文档](https://learn.chatgpt.com/docs/config-file/config-reference)。
