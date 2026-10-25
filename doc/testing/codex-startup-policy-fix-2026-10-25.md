# .71：修复桌面启动时组织设置检查被误路由

用户启用 .70 混合模式并重启 Codex 后，桌面提示“应用程式已暂停，直到能安全载入组织设置”。

## 根因与复现

桌面在启动 app-server 前执行 `app-server --print-startup-config --startup-client-info <JSON>`。这是一次性官方 CLI 检查，正常返回 `{appServerVersion, configRequirements}`。桌面还为恢复操作准备带 `--startup-sign-out` 的命令。

.70 的启动分类只排除了 schema、daemon、proxy 等命令，误把启动检查认作 stdio 服务，转给独立 `codex-app-server`。该二进制不支持 `--print-startup-config`，以退出码 2 报 `unexpected argument '--print-startup-config' found`。桌面将无法得到有效启动配置呈现为通用组织设置暂停提示。这条复现不需要登录或网络：相同空白临时 HOME 下，官方 CLI 返回成功，.70 路由失败。

此前真实派发、压缩及继续对话测试直接进入 JSON-RPC initialize，漏掉了桌面在这之前的一次性配置检查。以后启动集成验收需要覆盖桌面 preflight 和长期 stdio 两条入口，不能用派发成功代替桌面完整启动验收。

## 修复

启动检查、对应恢复命令及 help/version 原样交给官方 CLI，且不进入 JSON-RPC 桥。原生子代理兼容引擎继续只承担 stdio app-server。未关闭组织配置加载、未伪造成功响应、未修改管理策略，也没有自动执行退出登录。

## 验证

- 新增启动检查/恢复路由用例：修复前 1 项失败，修复后相关 15 项全部通过。
- `node --import tsx scripts/codex-startup-config-probe.mts`：真实引擎、空白临时 HOME、不用凭据；修复前退出码 2，修复后结果与官方 CLI 相同。
- 同脚本加 `--bridge dist/codex-provider-bridge.js`：生产 bridge 输出与官方 CLI 相同，未混入 JSON-RPC 封装。
- 当前真实账号的官方一次性启动检查也已成功；仅检查响应结构，不输出组织配置或凭据。
- TypeScript 检查、生产构建通过。最终安装和签名信息保存在 release/v10.15.26.71/install-receipt.json。
