# 原生官方直连与网关往返验证

2026-10-24，验证通过。仅增加测试脚本和记录；没有修改产品路由、真实配置、登录或当前安装。此前 .64 / .66 应用及源码快照保持不变。

## 实际链路

- 官方：已安装 Codex 0.164.0-alpha.11.1 的内置 `openai` provider；没有 `openai_base_url` 或自定义 OpenAI provider URL，没有 TokenFlow 推理地址或遥测地址。
- 沿用现有 127.0.0.1:7897 上网代理，属于普通网络代理，不是 TokenFlow。测试中的“直连”指官方推理不经过 TokenFlow。
- 网关：临时生产 TokenFlow service，使用现有反重力 Gemini 3.8 Flash Low。
- 使用隔离 HOME / CODEX_HOME、随机合成任务；临时复制官方登录，刷新令牌替换为不可用测试值，结束后删除临时目录。未使用真实对话内容。

## 步骤及证据

1. 官方直连创建会话，记住 A，完成原生压缩；本地 rollout 验证存在非 TokenFlow 的 opaque compaction 项。
2. 对仍加载并订阅的线程调用 `thread/resume`，请求 provider 从 openai 切到 token_flow。实际返回仍是 openai；该操作没有热切换当前连接。
3. 停止隔离客户端进程，改隔离配置并重新加载同一 thread ID 到 token_flow。Gemini 从本地恢复的历史读回 A，加入 B，完成摘要压缩。验证本地存在 TokenFlow 检查点。
4. 客户端停止后，调用现有 `CodexContext.prepareOfficial`，备份并将该检查点物化为可读内容；迁移 1 个 rollout。
5. 关闭隔离的 TokenFlow service 和网关测试转发器，检查对应监听端口确已关闭。
6. 重新加载同一线程到原生 openai，完成以下三个操作：续聊（11.1 秒）、原生压缩（12.1 秒）、压缩后再次续聊（6.2 秒）。两次回复都读回 A 和 B。
7. 官方推理进入 TokenFlow 官方转发 hook 的次数始终为 0。原生使用记录解析器从隔离日志读取到 5 个官方用量样本，说明推理代理不是本地 token 统计的前提。

以上是一次短任务实测，未证明任意长历史、自动阈值、全部工具或桌面 UI 内的无重载切换；实际重启的是隔离 app-server 进程，未退出用户正在使用的 Codex 或 TokenFlow。

## 结论

官方直连可隔离 TokenFlow 退出、升级、故障对官方推理的影响，并保留原生压缩。推荐将其作为注重官方体验和可用性的默认模式。

跨 provider 继续原任务仍需要两类处理：
- 官方密文进入第三方：根据准确匹配的本地历史恢复可读内容，不能解密官方密文。
- 网关检查点进入真正的官方直连：停止正在使用该历史的客户端后，备份并物化可读历史，再重新加载。直连时不会有 TokenFlow 在线替请求转换。

本次通过显式 provider 切换和重新加载实现往返，没有实现“一个模型菜单自动按模型直连/代理”。源码中空闲且无订阅的加载线程可能允许重建，不应把本次已订阅线程的结果泛化成所有 app-server 恢复路径都必须重启进程。产品需另外设计可靠的模式切换和会话重载流程。

## 复现

```sh
node --import tsx scripts/codex-direct-roundtrip.mts --live --proxy http://127.0.0.1:7897 --out doc/testing/results/codex-direct-roundtrip-live-2026-10-24.json
```

脚本 strict TypeScript 检查通过。结果文件保留阶段、时间、请求数量和 token 计数，不保存登录凭据、完整官方密文或用户对话内容。
