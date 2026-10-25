# .72：兼容桌面长期服务的启动参数

用户在 .71 中遇到 `unexpected argument '--analytics-default-enabled' found`，退出码 2。此前 .71 修复了前置 `--print-startup-config` 检查，却遗漏了随后长期 app-server 进程使用的参数。

## 复现和根因

当前桌面 `application-network-startup` 构造的常规 argv 是 `-c features.code_mode_host=true app-server --analytics-default-enabled`；有服务地址覆盖时，`-c` 参数也可能放在 `app-server` 后面。官方 CLI 支持此 analytics 默认值标志，独立 app-server 的 CLI 原先没有它。旧测试直接传 `app-server --listen stdio://`，未复现桌面的实际 argv，因此没发现该缺口。

`node --import tsx scripts/codex-desktop-startup-probe.mts` 在空白 HOME 和隔离版本化运行时中复现了用户同样的错误。它不读取登录、不发推理请求、不重启桌面客户端。

## 修复范围

在原生独立 app-server 中增加 `--analytics-default-enabled`，将该布尔值传入与官方 CLI 相同的 `run_main_with_transport_options` 默认值参数。配置中的显式 opt-out 仍优先，不将该标志改写成 `-c analytics.enabled=true`。同时支持官方 `--stdio` 简写及它与显式 listen 的冲突规则。

前置组织策略检查、退出登录恢复命令、帮助和版本查询仍由 .71 的启动分类交给官方 CLI。官方程序不覆盖；新兼容引擎生成独立版本目录，旧版保留。本次没有关闭组织策略、改变账号或全局网络配置。

## 验收

- 参数和桥回归 16 项通过；TypeScript 检查及生产构建通过。
- 新增完整启动探针：桌面标准 argv、analytics 显式关闭、无显式 analytics 设置、`--stdio`。每组验证 initialize、config/read、configRequirements/read 和 thread/start。修复前真实退出码 2，修复后三组全部通过，见 `results/codex-desktop-startup-v72-2026-10-25.json`。
- 新 release 引擎的原生官方→网关派发、权限配置、列表、取消和失败通知回归通过，见 `results/codex-native-product-control-v72-2026-10-25.json`。前置组织设置检查的生产 bridge 探针仍通过。
- 仍需用户从 TokenFlow 重启 Codex，验收真实窗口和官方主代理派发 DeepSeek 子代理。不得将协议验收表述为所有桌面功能完全等价。

最终安装包的 bridge 重跑完整启动探针通过，并确认实际子进程使用本次原生引擎 revision。19 项打包运行检查、ad-hoc 签名及 strict 校验通过。安装回执位于 `release/v10.15.26.72/install-receipt.json`；旧版 .71 保留在同目录 `installed-before-72.app`。
