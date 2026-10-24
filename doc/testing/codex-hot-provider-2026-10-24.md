# 官方直连停止 TokenFlow 与免进程重启切换验证

2026-10-24。仅新增隔离测试脚本和结果，没有改变生产配置、安装包、登录、历史或桌面进程；`.67` 产品的显式重启流程保持不变。

## 结论

- 官方内建 `openai` provider 的对话与原生压缩可以在 TokenFlow 服务停止后继续，且无需重启 Codex 进程。
- 当前已订阅会话的 `thread/resume(modelProvider=token_flow)` 不会切换 provider。响应可以显示网关模型 ID，但实际 provider 仍是 `openai`，不能据此认定已走网关。
- 同一空闲会话先 `thread/unsubscribe`，再 `thread/resume` 指定新 provider，在没有其他订阅者的实验中立即成功。真实 Gemini 收到请求并回答；同一线程 ID、同一 Codex app-server PID，未使用归档或重启回退。
- 网关完成 Codex 本地摘要后，用相同方法回到官方直连，再关闭 TokenFlow，官方续聊、原生压缩、压缩后续聊继续成功。
- 这修正了“跨 provider 必须重启 Codex 进程”的过度概括：**当前产品实现需要重启，但引擎允许在符合条件时只重建会话。**

## 真实调用实验

脚本：[codex-hot-provider-probe.mts](../../scripts/codex-hot-provider-probe.mts)。安装引擎为 Codex 0.164.0-alpha.11.1，官方模型 `gpt-6-astra`，网关模型 `antigravity/gemini-3.8-flash-low`。

- 临时 HOME、CODEX_HOME、auth 副本（禁用 refresh token）、临时历史与生产 TokenFlow service 实现。
- 原生 `openai` 没有地址覆盖；预先声明独立的 `token_flow` provider，以便同一进程选择。
- 普通网络代理 `127.0.0.1:7897` 用于访问 OpenAI；它不是 TokenFlow 推理代理。
- 用产品接口创建隔离网关授权，然后在启动隔离 Codex 前将默认配置设为 native openai，同时保留网关 provider 声明。
- 全程只有一个隔离 Codex app-server 进程，PID `18158`。测试结束才关闭该进程。

| 阶段 | 实测结果 |
| --- | --- |
| TokenFlow 开启，官方回复 / 原生压缩 | 成功；0 次网关调用 |
| 停止 TokenFlow 并确认监听端口关闭 | Codex PID 保持不变 |
| 官方续聊 / 原生压缩 / 压缩后续聊 | 成功；约 1.9 / 6.9 / 2.7 秒 |
| 重新开启 TokenFlow，直接 resume 已订阅会话 | 返回 provider 仍为 openai |
| 退订当前连接后 resume 到 token_flow | 返回 provider=token_flow |
| 不重启 Codex 的真实 Gemini 续聊 | 成功；实际网关请求 1 次，保留官方标记 |
| 网关新增要求、本地摘要、摘要后续聊 | 成功；2 个标记保留 |
| 退订后 resume 回 openai，再关闭 TokenFlow | 成功 |
| 官方续聊 / 原生压缩 / 压缩后续聊 | 成功；约 9.8 / 9.6 / 4.3 秒，保留 2 个标记 |

TokenFlow 官方转发 hook 计数全程为 0。隔离登录文件字节未变，日志中检测到官方原生 opaque compaction 项。计时是单次样本，不是性能基准。

[原始结果](results/codex-hot-provider-probe-2026-10-24.json)

## 双客户端边界实验

脚本：[codex-provider-subscription-probe.mts](../../scripts/codex-provider-subscription-probe.mts)。使用同一个隔离 app-server 的两条 WebSocket 连接，分别模拟 Codex 窗口与 TokenFlow 管理端。凭据与模型回答均为本机 fixture，不调用外部模型。

- 窗口连接创建并订阅会话，完成一个 fixture turn 使历史持久化。
- 管理端单独取消订阅得到 `notSubscribed`；管理端 resume 指定网关，仍返回 `openai`。
- 管理端退订自己的连接后再 resume，窗口还订阅着时，仍返回 `openai`。
- 两个连接都退订，管理端再 resume，立即返回 `token_flow`，PID `29894` 未变。

因此 TokenFlow 无法靠新建管理连接，单方面替正在订阅的桌面连接完成切换。产品需要桌面会话端参与退订/重载；当前原生模型菜单和现有 TokenFlow API 尚未集成该协调流程。也不能把“关闭一个窗口”当成已释放所有订阅者。

[原始结果](results/codex-provider-subscriptions-2026-10-24.json)

测试夹具修正：初版对未产生 turn 的新线程立即 resume，遇到 `no rollout found`；改为先持久化一个本机 fixture turn。之后移除了“一个 turn 恰好只有一个 HTTP 请求”的错误断言，保留 turn 完成状态及实际本机请求验证，最终通过。未改变 provider 切换断言。

## 官方协议与适用范围

[OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread)说明 `thread/unsubscribe` 作用于当前连接，无订阅后的常规卸载具有空闲宽限期。本次观察到：当前引擎在无订阅且空闲的条件下，resume 新 provider 能立即重建会话，不必等待常规自动卸载。

这是隔离 app-server 的实测，不是已经操控真实桌面窗口完成无感切换的证明。尚未覆盖正在生成、工具执行、全部长期历史、后台任务/子代理、多窗口实际集成或第三方私有检查点转换。若历史中存在 TokenFlow 私有加密检查点，回到官方直连前仍须做兼容转换，不能直接发送给 OpenAI。本次网关使用 Codex 本地可读摘要。

## 复现与检查

```sh
node --import tsx scripts/codex-hot-provider-probe.mts --live --proxy http://127.0.0.1:7897 --out doc/testing/results/codex-hot-provider-probe-2026-10-24.json
node --import tsx scripts/codex-provider-subscription-probe.mts --out doc/testing/results/codex-provider-subscriptions-2026-10-24.json
```

两个脚本 strict TypeScript 检查通过。未改产品源码，未重新打包或替换 .67。
