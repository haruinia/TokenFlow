# 同一 provider 下的压缩能力分流验证

2026-10-24；仅隔离验证，未修改生产路由、用户配置、登录或真实会话，未安装应用。

## 方法

使用已安装 Codex 0.164.0-alpha.11.1，临时 HOME/CODEX_HOME、合成认证、本地合成 Responses 服务。复用实际模型元数据，为第三方建立测试别名 `tf-fixture-gateway`。同一线程依次选择 `gpt-6-astra → tf-fixture-gateway → gpt-6-astra`，每次完成一轮后显式请求压缩。

```sh
node --import tsx scripts/codex-official-parity-smoke.mts --mixed-compaction-probe --out doc/testing/results/codex-mixed-compaction-2026-10-24.json
```

## 结果

| provider 能力 | 官方第一轮 | 模拟网关 | 切回官方 |
|---|---|---|---|
| remote_compaction=unsupported | Codex 摘要提示词 | Codex 摘要提示词 | Codex 摘要提示词 |
| remote_compaction=v2 | compaction_trigger | compaction_trigger | compaction_trigger |

请求中的模型和 high 思考强度与选择一致。两组实验均通过断言。

当前配置方式不会自动按模型分流。对照 OpenAI Codex 源码 970111f（2026-10-23），`protocol/src/openai_models.rs` 的 ModelInfo 没有逐模型 remote_compaction 配置字段；`core/src/tasks/compact.rs` 和 `core/src/session/turn.rs` 根据 provider.capabilities().remote_compaction 选择远程或摘要路径。因此不能把文档中的“模型和回合可进一步限制能力”解释成已经具备可用的逐模型压缩开关。

这是路由/协议可行性测试，不是真实第三方模型的上下文理解测试，也没有验证自动阈值、真实加密状态跨供应商恢复或所有未来客户端版本。

## CC Switch 对照

最新稳定版 v4.0.19（2026-10-23）支持聚合模式保留官方登录。官方作为默认供应商、第三方模型用前缀分流，两者都经过其本地代理。它在 Chat/Anthropic 转换路径将远程压缩触发转换为模型摘要，再以自有 Base64 封装返回压缩条目；这不等同于由 Codex 本地压缩路径完成。

- https://github.com/farion1231/cc-switch/blob/v4.0.19/docs/user-manual/en/4-proxy/4.6-aggregation.md
- https://github.com/farion1231/cc-switch/blob/v4.0.19/src-tauri/src/proxy/providers/codex_compaction.rs

后续方案仍需选择：分开 provider/session 以使用各自原生压缩路径，或者统一 provider 并提供明确标识的压缩兼容层。此次未启用任何方案。
