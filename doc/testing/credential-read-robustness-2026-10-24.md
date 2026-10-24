# 认证读取复用与并发回归（2026-10-24）

## 结论与证据范围

已实现按凭据 scope/revision 复用在途、成功和失败结果；后台观察/自动导入不再绕过失败状态重新解密，用户主动刷新/导入可重试失败。写入前校验仍使用独立 fresh 读取。新增缓存只在进程内存中，不持久化明文，不更改 Keychain ACL，也不保存系统密码。

本报告的调用次数来自隔离 mock；它们是 `safeStorage.decryptString`、Qoder crypto adapter 或 `security -w` 的调用次数，**不是系统弹窗次数**。用户报告的 6 次提示涉及 TokenFlow、Qoder、Qoder IDE 不同项目。首次访问不同 Keychain 条目仍需各自授权，本轮不能承诺首次 6 次变为 1 次，也没有主动触发系统授权进行验证。

## 调用图与红灯

原有启动读取链为：

1. main 在获准后预热 TokenFlow safeStorage，并读取内部网关密钥。
2. service 构造时观察本机登录，listen 时再次观察，之后每 5 秒观察。
3. main 调用自动发现；自动发现对每个客户端执行完整凭据导入。
4. Qoder App、IDE 原来仅缓存身份投影；导入直接再次解密相同数据。Claude 成功读取可复用，但拒绝后下一轮观察再次运行 protected `security -w`。

首次执行 `npx vitest run tests/credential-access-audit.test.ts`：8 tests 中 7 failed、1 passed，测试本体耗时 36ms。最小夹具结果：

| 夹具 | 修复前受保护操作次数 | 修复后 |
| --- | ---: | ---: |
| Qoder App：并发 status/usage 后自动导入同一 revision | 2 | 1 |
| Qoder IDE：并发 status/usage 后自动导入同一 revision | 2 | 1 |
| Qoder App/IDE：身份解密拒绝后自动导入 | 各 2 | 各 1 |
| Claude：相同 metadata、3 轮被拒绝的后台观察 | 3 | 1 |
| TokenFlow：同一被拒绝密文，2 个并发 get 加 1 个顺序 get | 3 | 1 |
| TokenFlow：成功 get 后 set 验证旧密文 | 2 | 1 |

## 实现与接口

`packages/core/src/revision-credential-access.ts` 为无平台依赖的共享模块，每个实例对应一个 credential scope，只保留当前 revision：

- `read(source, load, {mode})`：source 在 mutation epoch 内获取 revision/input；cached 合并在途、成功、失败；retry 只重试已经结束的失败；fresh 开启新 epoch，强制独立校验。
- `invalidate()` 使旧 source/旧 protected load 的结果过期；`seed(revision,value)` 发布成功写入后的结果。
- source 请求序号防止更早启动、较晚返回的旧 revision 回切当前状态。加载前、完成后均检查状态；过期结果返回 409，不发布旧凭据。
- `onSuccess` 只在当前结果仍有效时执行，包括成功缓存命中，用于清理已恢复读取的 warning/unreadable 状态。
- fresh 并发互相使旧 epoch 过期；调用方必须串行化同 scope 的 mutation。不同 scope 独立。

Qoder App 与 IDE 各自缓存完整已解密 document；status、usage、import 只做投影，仍保留独立客户端身份和密文来源。文件/认证行删除、密文变化、账号应用/恢复都会使旧状态失效。`status(true)`、`importCredential({retry:true})` 可主动重试。

Claude 根据 Keychain 属性 metadata 指纹复用读取；拒绝结果在同 revision 内保留。写入按同条目排队并强制校验；旧读取不能在写后返回旧凭据。`ClaudeAccountStore.write` 的状态比较与文档写入共用同一次 fresh snapshot，移除原先连续两次 fresh 读取。

Secrets 按 name 串行化 set/remove，临时文件使用唯一名称；不同 name 不互相阻塞。readFile 也包含在 epoch 内，防止 set/seed 后晚到的旧文件读取恢复旧值。成功读取的旧密文验证复用内存结果；不可读原文件替换前仍备份。显式恢复后清除对应读取警告及不可读状态，临时网关警告单独保留。

service 只增加用户操作的 retry 接线：自动 discovery 保持 cached；本机导入及 A2A 显式导入可 retry；native Claude `?refresh=1` 可 retry。`localCredential` 新增第 4 个可选 retry 参数；`Secrets.get` 新增第 2 个可选 retry 参数。旧调用兼容。

## 验证

以下定向命令通过：17 files、140 tests，约 13 秒。

```sh
npx vitest run tests/credential-access-audit.test.ts tests/credential-access-service.test.ts tests/claude-keychain-mutation.test.ts tests/secrets-races.test.ts tests/revision-credential-access.test.ts tests/secrets.test.ts tests/claude-keychain-read.test.ts tests/claude-keychain.test.ts tests/native-accounts.test.ts tests/desktop-accounts.test.ts tests/qoder-ide-login.test.ts tests/startup-credential-order.test.ts tests/desktop-accounts-service.test.ts tests/native-accounts-service.test.ts tests/local-credentials.test.ts tests/qoder-crypto-session.test.ts tests/credential-access.test.ts
```

`npm run typecheck`、`git diff --check` 均通过。

新增覆盖包括：

- 同 scope/revision 的成功、失败、并发复用，retry/fresh 区分及不同 scope 隔离。
- source 早启动晚返回、protected load 晚完成、加载前已过期、seed/删除/新 revision 后拒绝旧结果。
- Secrets 同名并发写入、不同名称并行、写后删除、唯一临时文件、恢复后警告清除、旧失败不覆盖新成功。
- Qoder 两版本的自动导入复用、显式恢复、删除/重建、密文变化、旧解密晚到。
- Claude 同 metadata 强制校验、并发写排队、删除重建、明确失败退出后的下一次写恢复。
- fixture service 的自动发现拒绝复用、主动 refresh/import retry、返回值不暴露合成 token。

新增 fixture 全部使用临时目录、mock 存储/进程或 fake sidecar，不读取真实账户认证，不调用真实 `security`，不启动 Qoder helper，不触发系统授权。此次未构建、打包或重装；全量回归和安装验证由主代理另行记录。

## 已知边界与后续方向

- Claude 被动变更检测依赖 metadata。完全相同 metadata 下的外部密码替换无法由普通 cached 观察识别；mutation fresh 不受此限制。主动 retry 成功缓存仍复用，不将每次刷新变为新的 protected read。
- 既有 Claude `security -i` 写超时路径只发送终止信号、依赖 close 事件结算。该写入边界本轮未建立故障验证，也未扩大修改。新增队列已验证明确失败退出后可以恢复，不能据此声称无 close 的写超时已解决。
- 跨启动复用可另行设计为“精确来源密文 digest + 已验证身份 + 既有可用导入 grant 引用”。需要统一自动发现策略、加密保存证据、来源变化/条目缺失/显式操作时失效；本轮没有实现或保存此类缓存。

### 跨启动后续设计，未实施

用户实测 .59 选择“允许”后仍出现 6 次系统提示，工作台正常打开。该次没有逐窗记录项目名，不能推断每个项目各两次。这证明当前进程内读取复用没有降低该次初始系统提示次数，不能据 mock 调用下降声称系统提示已经减少。

后续只读审查确认：service 构造时先 `await observeNativeLogins()`，此时 `proxy.start()` 尚未执行、snapshot 的 accounts 仍为空；启动之后的自动 discovery 才加载已导入授权。因此仅在 import 中跳过重复读取不能避免启动观察已触发两个 Qoder helper。若以后实施，必须让同一 coordinator 管理被动 usage/status/自动导入，并等待保存授权的 inventory 就绪后统一决定复用；等待期间不能伪造 signed-in/signed-out 状态。

可复用证据至少应绑定版本、客户端/规范化来源路径、精确原始认证密文 digest、上次真实读取并验证的身份、精确导入 grant 引用与凭据 revision。只有来源完全未变且该 grant 当前存在、身份相符、启用且可用时，才可跳过后续启动的 Qoder 被动解密。来源、账号、grant 或可用性变化都必须失效；explicit import/refresh/mutation 仍真实读取。证据可以由 TokenFlow 现有加密存储保护，但不能保存 Qoder 明文 document、主密钥，或单独相信已登录标记。

现有 `snapshot.nativeClients` 表示 Qoder 两种产品的兼容性，并非来源证明，不能拿来绑定 evidence；`desktopNativeAccounts.switchable` 要求完整刷新字段与有效期，比部分推理可用 grant 的条件更严格，也不能直接代替 grant inventory 的可用性判断。需要独立的 server-only 验证接口，不能从展示标签或任意同 UID 账号猜测精确授权。

用户随后要求优先完成其他既有任务，本轮到此停止：仅完成上述只读设计判断，未新增或运行跨启动 fixture，未实施生产代码、持久证据或自动发现策略变更。
