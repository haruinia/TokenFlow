# .91 同事反馈：旧协议恢复与旧摘要读取

## 范围与证据边界

反馈包括切回官方时 `codex_agent_protocol_conflict`，以及请求期间“无法恢复这段压缩上下文”。目前只有截图及错误文案，尚无同事的实际模型路由、Codex 版本、是否跨设备同步的信息。本次用合成历史复现了两个完全相同的报错，确认代码缺口；不能据此声称同事的全部案例已经定位。

.91 修改协议控制元数据、离线编辑事务和备份存储。没有更改 `CodexContext.recover` 的历史读取策略，也没有更改网关的摘要生成策略。协议迁移不解密已有密文任务。备份差异存储与模型上下文压缩是独立功能。

## 复现与修复

首次运行以下命令，两项失败且分别产生反馈中的两条错误：

```sh
npx vitest run tests/codex-agent-protocol-migration.test.ts tests/codex-context.test.ts -t 'older baseline|legacy plaintext compaction'
```

1. **协议恢复误判**：不可变旧备份没有协议字段，后续 Codex turn_context 写入已支持的 v2。旧逻辑除了验证版本，还要求当前值与旧记录相符，误将正常后续记录判为冲突。现在先校验当前版本是否受支持，再按目标迁移；恢复始终使用保存的原语义，原来 absent 就移除字段，让恢复后的原生配置决定。未将所有缺省值强制设为 v2。未知未来版本及不完整 JSONL 继续停止，错误文案区分版本不支持、记录损坏和备份格式无效。
2. **旧可读摘要漏读**：Codex 历史可用 `compacted.message` 保存摘要，且 `replacement_history` 为空。恢复程序只读取 replacement_history，导致本地明明有摘要仍报无法恢复。现在按时间顺序重放这种旧格式：保留用户请求，使用已保存摘要替换先前工作记录，再处理后续回滚。非空 replacement_history 仍优先，不把密文旁边任意 message 视为可替代密文的摘要。不会调用模型重新编造摘要或重写原会话。

参考官方源码：
- [rollout_reconstruction.rs @5425d3e6](https://github.com/openai/codex/blob/5425d3e6/codex-rs/core/src/session/rollout_reconstruction.rs)：legacy compaction 的正向重放。
- [compact.rs @5425d3e6](https://github.com/openai/codex/blob/5425d3e6/codex-rs/core/src/compact.rs)：collect_annotated_user_messages 与 build_compacted_history。

TokenFlow 恢复时保留可读用户请求，不复刻 Codex 的 20k 用户消息裁剪上限；后续长度控制仍由原有网关上下文逻辑处理。

## 验证

- 10 个相关测试文件共 **228 项通过**：协议、迁移、恢复、摘要、回滚、分支边界、备份、原生投影、官方共存及账号切换。类型检查与 diff 空白检查通过。
- 集成回归覆盖旧清单未记录协议、旧备份缺省而当前追加 v2，进入网关及直接恢复官方均成功；后续聊天正文与不可变备份保留。
- 官方共存服务测试继续验证原生密文直接交给官方接口，`responses` 与 `responses/compact` 请求体及 reasoning/service_tier 保持，未调用网关摘要恢复分支。
- [原版引擎摘要差分脚本](prototypes/codex-legacy-summary-recovery.mts)、[结果](results/codex-legacy-summary-recovery-2026-10-29.json)：已安装 `codex-cli 0.165.0-alpha.1.2`，隔离 HOME，虚拟认证，本机模拟 SSE。原版 Codex 与 TokenFlow 均读取同一旧摘要、保留原始任务；TokenFlow 不读取压缩点之后的续聊，不改源文件。探针最初遗漏必需 timestamp，原版忽略了该合成行；修正为有效原生格式后通过，不将无效夹具误判为产品问题。
- [原版引擎协议往返结果](results/codex-colleague-protocol-roundtrip-2026-10-29.json)：实际产品迁移类在同一合成父会话中完成 v2 → 网关 v1 → 原始 v2；原生网关子代理收到明文任务并完成，恢复后父会话继续一轮。

## 未验证与生效状态

后续进展：已完成额外审查和重新构建安装，见 [.91 发布复核](release-91-review-2026-10-29.md)。下面保留首次源码修复时的验证边界；运行中的应用未在发布期间重启。

没有读取同事的真实对话或凭据，也没有付费模型请求。未安装新应用、未重启真实 Codex/TokenFlow、未迁移或清理生产历史。此轮修复在源码，应用版本仍为 .91。

只有官方密文而没有对应可读历史时，第三方模型不能解密它；不能把空上下文当作成功恢复。官方模型走共存官方入口时通常无需解密，直接传回官方。若同事在该入口仍遇到相同错误，还需确认是否实际选了另一授权来源的 `codex/...` 网关模型、是否包含 TokenFlow 私有检查点，以及本地历史是否完整。
