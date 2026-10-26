# Codex 续聊与压缩鲁棒性复核（2026-10-24）

本次从 `cccc283` 复核此前修复的跨功能行为。使用 diagnosing-bugs 的先复现再修复流程；所有新增数据均为随机临时目录中的合成历史、合成响应和合成身份。没有读取或修改真实 Codex 配置、历史、凭据，没有启动真实账号推理，没有结束已有客户端。未重复全仓 1489/1518 项检查；主代理负责最终整体回归和安装。

## 结论与验证边界

| 范围 | 结论 | 证据与边界 |
| --- | --- | --- |
| 续聊、私有 checkpoint 切官方、持久化再恢复 | 已验证合成闭环；本轮发现并修复回放分歧 | 新回归同时经过真正的 GatewayContext.compact、官方请求转换、prepareOfficial 写回、后续原生 opaque checkpoint 本地恢复、再次网关请求与幂等写回。旧 user 被覆盖，当前 user 恰好一次，新规则和顺序保留。 |
| stream 失败与成功历史 | 已验证所列失败模式；本轮补齐源流异常边界 | reset、坏 JSON、EOF、非法 DONE、存储失败、上游 failed/flat/nested error，均有安全 typed terminal、一次失败回调；取消与成功各自结束，失败不写成功历史。正常成功保存先于终结发出。 |
| 压缩并发和缓存 | 已验证路由隔离及成功摘要复用 | 同身份在途合并；来源、模型、owner 任一不同都独立发送，健康调用不继承另一来源 429。成功 portable 摘要跨来源/模型/owner 和重启仍复用。没有提高压缩阈值、改 usage 口径或截断工具。 |
| 历史分页、回退、编辑/分支和重启 | 先前隔离原生 smoke 已验证；本轮回归相关源码与测试 | 见 [10-23 报告](codex-continuation-repair-2026-10-23.md) 的真实 installed Codex 合成分页、失败前 fork、回退、重启、损伤祖先投影重建。原生 projector 在授权迁移且客户端已退出后运行。没有以本轮单测替代用户原对话验收。 |
| 官方与网关共存、凭据分流 | 本轮服务 fixture 通过；先前真实 CLI 合成 smoke 已验证 | `codex-coexist.test.ts` 通过来源切换、固定官方 host、独立认证头及重启；前次隔离 smoke 让官方 mock 拒绝 tfctx/resp_tf 引用，并验证合成 auth.json 字节不变。没有使用真实官方账号，不能据此宣称线上真实授权已验收。 |
| 坏 TOML 覆盖与恢复 | 本轮只读复核；认证模块另有隔离回归 | 恢复以可解析 journal 或最小配置为基础，raw bytes/text 备份与 revision 检查保留；共享配置锁控制 mutation。未发现可复现的新覆盖故障，也未进行真实 profile 故障注入。认证重复弹窗不由这些上下文测试证明解决。 |
| 原持续 11 次压缩、244800 阈值与约 246k 输入 | 仍属部分验证 | 现有结构观测能区分固定 instructions/tools 与历史，完整输入/缓存保留；未保存用户原请求，不能把合成大工具 fixture 当作原根因，也不能保证真实供应商摘要质量、耗时和缓存命中率。 |

## 发现一：流异常越过旧 TransformStream.flush

旧处理依赖 `flush` 补缺失终结，但源流 `reader.error/reset` 和 JSON 解析异常直接使 downstream read 拒绝，flush 不执行，onError 计数为零。另有源发送 completed 后不关闭连接会无限等待；保存成功历史失败也只是原始读错误。上游 failed/error 的任意 message 原样穿透安全边界。

先用 `.tmp/audit-2026-10-24/codex-audit.mts` 复现 reset/坏 JSON：读异常、无 typed failure、onError=0、无保存。正式 `gateway-stream-failures.test.ts` 先红后绿，13 项：

- reset、坏 JSON、缺 terminal 的 EOF 和 DONE 统一安全失败，源 reader 解锁，无成功历史。
- 实际临时文件系统错误引发 context_persistence_failed，不泄露路径，也不发送 completed。
- terminal 到达即结束并 cancel 源；后续成功/失败不再转发，不产生第二 terminal。
- 保留 pull backpressure，consumer cancel 一次触发 onCancel；AbortSignal 是取消，不合成来源故障。
- upstream failed/flat/nested error 使用公共 `upstreamError`，保留 status/usage、可识别错误码和 sequence；onError 一次。顶层 type 始终是 Responses 的 error，不被错误类别覆盖。
- `[DONE]` 在 Responses completed/incomplete 之前到达，立即发 incomplete_stream，不把非 JSON marker 转发给 typed consumer。有效 terminal 之后的帧已被丢弃。

实现 `responses-stream.ts` 统一源读取、帧解析边界、取消、释放和终结；`GatewayContext` 只负责 Responses 语义与公共安全错误映射。保留 Codex 识别的 context_length_exceeded wire code。状态和 usage 原样保留；没有凭空制造成功或 token 数。

## 发现二：线上 checkpoint 与落盘恢复语义分歧

独立 `.tmp/audit-2026-10-24/checkpoint-materialization.mts` 使用真实 compact 生成 authenticated coveredUsers。旧线上恢复只留下 LATEST_RETAINED，而 prepareOfficial 写回得到 LATEST_RETAINED、OLD_ALREADY_SUMMARIZED、LATEST_RETAINED：

1. 写回解密丢弃 coveredUsers，让被摘要覆盖的旧 user 复活。
2. 写回先 portable normalize 字符串为 input_text 数组，再与未归一化内容做 JSON 比较，当前 user 重复。
3. recover 的 replacement_history 只重置输入，丢弃 checkpoint 前新规则；在线路径对象键序不同也无法判同一消息。

新增纯 `checkpoint-window.ts` 共享消息 canonical identity 和窗口 replay：先还原 checkpoint，再携带未覆盖且不在还原窗口中的前置 user/system/developer，保留顺序；工具/assistant 的旧窗口被 checkpoint 替换。字符串与文本数组、对象键顺序不影响身份。先做 replay 再 portable normalize。

`decodeCheckpointWindow` 保留认证 metadata；GatewayContext.expand/forOfficial 与 CodexContext.prepareOfficial/recover 共用 replay。新 checkpoint 覆盖集合加入 canonical HMAC，同时保留旧 HMAC，已有 token 继续可解密/匹配；没有记录正文或凭据。旧无覆盖 metadata 的 token 不猜测哪些旧用户被摘要。

正式 fixture `checkpoint-replay-consistency.test.ts` 先红（两个当前 user），修后验证全部路径相同、旧 user 不复活、新规则保留、canonical 当前 user 一次、重复 replay 与迁移幂等。原 CodexContext 38 项继续通过，包含原历史备份、变更 revision、坏数据停止与分支/回退边界。未改动投影迁移策略。

## 发现三：portable 完成缓存误用于在途 transport identity

先前 summaryCacheKey 的 portable scope 合理地用于可复用的已完成摘要，但同一个 key 也用于 pending transport。同步 fixture 让 A 正在请求时 B 确实到达 pending lookup；A 返回 429，B 的健康 send 从未执行，错误随在途 promise 跨来源传播。

正式 `compaction-attempt-scope.test.ts` 四组，修复前异来源/模型/owner 三组红，同身份共享绿。现在成功缓存仍使用原来的 portable key；在途 key 必须提供实际 `{owner,source,model}`，再与完成 cacheKey 一起 HMAC。传的是已有不含秘密的 owner Key ID、来源 ID、模型，不把 token 或原始凭据放进 key/日志。不同 scope 各自失败或成功，同 scope 仍共享单次调用，失败 attempt 会清理。成功摘要跨路由与进程重启复用未改变。

已有同 scope transport 取消后的重试和分块失败后的已完成缓存复用回归继续通过；没有把容量/认证语义错误自动重试成成功。

## 定向验证

```sh
npx vitest run tests/gateway-stream-failures.test.ts tests/gateway-context.test.ts \
 tests/gateway-context-replay.test.ts tests/gateway-context-usage.test.ts \
 tests/gateway-context-service.test.ts tests/gateway-compaction-regression.test.ts \
 tests/compaction-attempt-scope.test.ts tests/checkpoint-replay-consistency.test.ts \
 tests/codex-context.test.ts tests/context-summary.test.ts \
 tests/initial-compaction.test.ts tests/codex-coexist.test.ts
npm run typecheck
git diff --check
```

12 文件 164 项通过，npm run typecheck 与 git diff --check 通过。随后补充嵌套 error 的显式 status_code（409）优先于推断类型的红灯，SSE 文件最终 13 项通过；最终 typecheck 与 diff check 复跑通过。本轮仅修这三类有精确 fixture 的问题，不把“原报错消失”或已有全仓绿灯当作真实供应商/原始受影响对话已恢复的证据。
