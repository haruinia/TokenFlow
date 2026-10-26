# Codex 共存模式下切换及恢复官方账号

日期：2026-10-24。

## 复现与根因

修复前先运行 `npx vitest run tests/codex-coexist-account-switch.test.ts`，两个隔离服务回归均失败：

- 共存模式切换官方账号后，实际返回 `gatewayConnected: false`、`codexCoexist: false`、`provider: openai`，与保留网关的预期相反。
- 候选账号官方目录返回 403 时，旧实现仍返回 200 并切换账号、移除网关。

根因由三层组成：服务的官方账号切换与恢复接口无条件调用 `restoreConnection()`；账号管理器默认重写为 `model_provider = "openai"`；身份变化没有同步刷新共存目录和服务端允许的官方模型 ID。只有调整 UI 选中状态无法解决。

## 实现与数据保护

共存连接通过 TokenFlow 的单个 `token_flow` provider 在同一菜单承载官方及网关模型，并由 TokenFlow 按模型 ID 分流。本次修改共存下的官方身份切换和恢复，不声称 Codex 原生菜单提供多个 provider。

共存身份操作保留连接 ID、Key、provider 定义、网关模型选择与用户设置。先使用候选身份向固定官方地址读取新目录，再在共享 Codex 配置锁内提交身份、目录引用、接入记录及内存允许列表。读取新目录失败即停止，不以旧账号目录兜底。被新账号移除的当前官方模型改选该连接原有网关默认模型；原始登录备份跨 A → B 切换保留。

新目录先写入内容地址文件，再允许配置指向它。接入记录仅更新其原有配置基线中的目录及相关模型字段，避免把用户后加的项目、偏好等设置误记为 TokenFlow 所有，导致之后停用网关时丢失。

身份、配置和备份写入使用字节预期检查；回滚只替换本事务写入的内容。一个回滚参与者失败时仍尝试其他参与者并保留 prepared 备份。身份切换和原登录恢复均记录本次 checkpoint，允许在 auth、config、record 不同提交阶段产生的 prepared 中断状态恢复原登录与共存连接。

普通互斥模式继续走已有官方 provider、断开网关及历史恢复流程。共存身份操作不重新迁移对话路由。

## 验证

回归命令：

```bash
npx vitest run tests/codex-coexist-account-switch.test.ts tests/codex-accounts.test.ts tests/codex-accounts-service.test.ts tests/codex-coexist.test.ts tests/agent-connections.test.ts tests/agent-model-switching.test.ts tests/codex-catalog-refresh.test.ts tests/codex-switch-lifecycle.test.ts
npm run typecheck
node --import tsx scripts/codex-coexist-smoke.mts /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --switch-accounts
```

最终相关回归为 8 个文件、137 项全部通过，包含新增身份事务回归 16 项；类型检查通过。

隔离服务覆盖：多次身份切换与恢复、新账号目录/允许 ID 刷新、旧 ID 拒绝、原备份保留、目录读取失败、提交失败、回滚参与者失败、外部登录并发修改、并发切换锁及过期 revision、所选官方模型权限消失、用户新增设置在后续停用网关时保留。切换及恢复分别覆盖 auth/config/record 三种 prepared 中断状态，并重启隔离服务后恢复。

真实安装 Codex app-server smoke 使用临时 HOME、CODEX_HOME、合成 JWT 和合成提供方。先验证混合菜单与同一对话交替选官方/网关、重启、分页、失败回合前 fork；再切换合成官方账号，重启 app-server，确认菜单只列新账号官方模型和原网关，二者都完成 turn；恢复原账号后再次验证原官方模型与原网关完成 turn。连接 ID、Key、provider 和原 auth 原文均保留。实际 route 序列为 `gateway, official, gateway, official, official, gateway, official, gateway, official, gateway`，其中一条官方请求按夹具预设失败，供 fork 路径验证。凭据隔离检查通过。

所有验证均没有对本机真实 Codex 登录、配置或对话写入，没有停止用户进程，没有调用真实上游或发送私有内容；没有打包、安装或提交。

## 边界

prepared 回归验证的是**中断状态恢复（锁已释放）**：通过注入异常制造各阶段状态，正常 finally 释放锁后重启服务。没有声称操作系统强杀或机器掉电后可自动清除残留锁。现有配置锁保护仍保留；进程异常退出留下锁时需先检查锁文件，本轮未扩大到全局锁恢复机制。

真实上游账号权限与厂商在线响应没有在本轮调用；官方目录和响应均由合成夹具提供。真实 Codex 运行时解析菜单、选择模型、授权读取和经过 TokenFlow 分流的兼容性由已安装程序执行验证。
