# 旧对话加密子代理消息调研

日期：2026-10-28—29（America/Los_Angeles，调研跨过午夜）。本轮仅调研和隔离实验，未修改产品协议、用户配置、登录文件或真实会话。

## 结论

已复现用户的同款 422。旧会话会把 `multi_agent_version: v2` 保存到 session_meta 和 turn_context；新配置采用 v1，并不会自动改写这些旧会话。当前安装的 Codex 原版引擎 `0.165.0-alpha.1.2` 中，仅改配置、退订后重载，乃至重新启动隔离 app-server 再恢复同一个旧会话，仍向模型提供 v2 子代理工具，并向第三方子代理发送加密任务。

隔离实验表明，**旧父会话的后续派发可以迁移到 v1**：引擎退出后，仅在合成会话副本中将 session_meta / turn_context 的 multi_agent_version 从 v2 变为 v1，再恢复相同 thread ID，新派发的原生子代理获得完整明文任务。所有 response_item 行字节保持不变。这不是把已经存在的密文解密，也不是已完成可发布的历史迁移实现。

**已经收到密文任务的旧子代理没有被这项实验修复。** 它的密文依然不可读，不能只删掉加密块、拿路由前缀充当任务，或把密文标成明文。可行方向是保留原子任务，让有完整任务上下文的官方父代理重新明确派发一个 v1 新任务；或者只在能以确切身份关联到完整明文副本时恢复。无法证明完整任务存在时不能承诺无损恢复。

## 实际测试

复现入口：

```sh
npx vitest run tests/codex-context.test.ts -t 'rejects encrypted agent tasks'
npx tsx doc/testing/prototypes/codex-old-agent-protocol-research.mts
```

第一项 1 个目标测试通过（断言拒绝密文、明文正常）。第二项使用当前安装的原版 Codex CLI、临时 HOME/CODEX_HOME、虚拟 API key、本机合成 SSE，不读取实际配置/凭据，不请求 OpenAI 或 DeepSeek。子任务正文由测试构造；v2 分支将该参数包装为 encrypted_content，用于复现真实的协议结构，不宣称样本本身由 OpenAI 加密。

| 场景 | 主代理工具协议 | 首次子请求任务明文 | 结果 |
|---|---|---|---|
| v2 旧会话 | v2 | 无，只有加密任务块 | 同款 HTTP 422 |
| 写入 v1 配置后继续已加载会话 | v2 | 无 | HTTP 422 |
| 退订父会话，再按新配置重载 | v2 | 无 | HTTP 422 |
| 重启隔离 app-server，再恢复旧会话 | v2 | 无 | HTTP 422 |
| 同一个新配置中新建会话 | v1 | 有 | 明文请求通过转换层 |
| 离线合成副本仅迁移协议元数据，再恢复原 thread ID | v1 | 有 | 明文请求通过转换层，response_item 字节不变 |

结果：[合成实验记录](results/codex-old-agent-protocol-research-2026-10-28.json)。测试可验证参数实际交付，但合成上游返回固定回复，因此不代表真实 DeepSeek 的推理质量或实际付费模型验收。v1 对真实官方父代理、DeepSeek 子代理的既有验证另见 [此前实验](codex-unified-native-agents-2026-10-27.md)。

## 源码与官方资料

- [codex-agent-messages.ts](../../packages/core/src/codex-agent-messages.ts) 独立处理 agent_message；存在 encrypted_content 时明确返回 422，避免把路由前缀误当任务。普通 reasoning / compaction 不走此分支。
- [codex-history-items.ts](../../packages/core/src/codex-history-items.ts) 把官方保留策略与网关可读转换分开；官方原生加密子代理消息保持原样。
- [codex-unified-agent-catalog.ts](../../packages/core/src/codex-unified-agent-catalog.ts) 为统一模式生成 v1 目录，并配置 multi_agent_v2=false；它处理配置和模型目录，不迁移旧 session_meta。
- [Codex 官方子代理文档](https://learn.chatgpt.com/docs/agent-configuration/subagents) 说明子代理继承父会话 provider、权限和 MCP，角色文件不能覆盖 provider。公开文档未承诺旧 v2 历史能被自动迁移或第三方能解密任务；本次关于持久协议版本的结论来自真实引擎的隔离运行。

## 可实施方向与未验证项

下一阶段应做**明确选择的旧父会话迁移**，而不是全局扫描后自动改所有历史。复用已有备份、文件指纹、原生索引修复与恢复机制，确保关闭/卸载目标会话后再写；迁移只影响未来派发，历史任务内容原样保留。迁移前须检查存活子代理和父子关系，确定已有 v2 子代理是保留为旧任务还是需要重新派发，避免生命周期混用。

尚未验证真实用户的具体失败会话、跨设备同步、历史 v2 子代理的继续/取消/等待、父子 fork 边界、密文任务经原生压缩后的完整恢复，也未验证其他 Codex 版本。不得把这个合成父会话实验当作生产会话可直接批量改元数据的依据。本轮不接管 app-server、不替换引擎、不实施上述迁移。

## 10 月 29 日补测：从未派发过子代理的旧会话

运行 `npx tsx doc/testing/prototypes/codex-unspawned-protocol-research.mts`，使用安装引擎、临时 HOME、虚拟 Key、本机合成响应。整个实验不创建任何子代理，也不调用真实供应商。

- 旧会话先完成一次普通文字回复，只有一个线程，session_meta 和 turn_context 已保存 `multi_agent_version=v2`。
- 更新目录与配置为 v1，退订旧会话并明确按 `modelProvider=token_flow` 恢复；引擎返回 provider 已从合成的 `fixture_old` 变为 `token_flow`，但后续请求的原生工具仍是 v2。
- 隔离引擎重载配置后新建会话，工具为 v1。首次探测同一已运行引擎中新建会话仍为 v2，表明该进程还保有旧配置/目录；不能把仅写配置等同于已加载新配置。

结果：[未派发场景记录](results/codex-unspawned-protocol-research-2026-10-29.json)。这确认子代理协议设置不依赖实际派发过子代理。当前 `codexMigrationClient` 只提交并校验 provider/model；统一目录配置不会覆盖旧会话持久协议，旧会话兼容迁移尚未包含这一字段。没有改真实配置、登录或历史，也没有实施产品迁移。
