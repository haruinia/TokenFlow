# 项目文档

项目说明统一存放在 `doc/`。仓库根目录的 README 负责产品介绍与快速启动；本页负责文档导航。

## 从哪里开始

| 需要了解什么 | 文档 |
| --- | --- |
| 产品定位、模型命名和对外展示原则 | [产品定位](产品定位.md) |
| 软件怎么用、支持哪些入口 | [使用指南](guides/usage.md) |
| 桌面、界面、网关、来源适配器如何协作 | [项目架构](architecture.md) |
| 当前还要修什么、如何验收 | [统一 TODO](TODO.md) |
| 用量来源、Codex 官方计数定义、Token／费用／额度边界 | [用量来源与本地验证](testing/usage-attribution.md) |
| 各客户端直连采集覆盖、反重力 SQLite、Cursor 官方明细与账号归属 | [客户端直连用量](testing/native-direct-usage.md) |
| Codex 新账号完整日对账、逐请求日志与官方日桶快照 | [对账记录器](testing/native-direct-usage.md#新账号完整日对账记录器2026-10-17) |
| WorkBuddy 导入后只显示名称，以及名称到路由的映射 | [WorkBuddy 模型名称验证](testing/workbuddy-model-labels.md) |
| 官方登录能否与网关模型并存，Qoder／Codex 名称复核 | [官方登录与自定义模型](testing/official-login-coexist.md) |
| Windows 进程、授权、窗口与完整功能测试 | [Windows 兼容与验收](待修复的问题win兼容.md) |
| 文件清理的范围与恢复方式 | [文件清理](guides/file-cleanup.md) |
| 继续对话已完成的部分和桌面验收 | [继续对话交接](继续对话交接.md) |

## 技术参考

- [WorkBuddy SDK 实现与验证记录](reference/workbuddy-sdk.md)：特定版本的适配依据和历史验证，不代替当前兼容性验收。
- [Claude Desktop 接入研究](reference/claude-desktop-integration.md)：研究资料；独立桌面入口已暂缓，不能当作当前可用功能。
- 依赖来源和授权保留在根目录 [THIRD_PARTY.md](../THIRD_PARTY.md)、[LICENSES](../LICENSES)；不与产品文档合并。
- 构建命令见根目录 [README](../README.md#从源码运行)；Windows 原生环境和打包验收见专门的 [测试说明](待修复的问题win兼容.md#3-windows-全功能测试的执行规则)。

## 历史报告与证据

历史报告保留当时的日期、版本和验证范围，后续修复不会追溯改写成“当时已经通过”。当前待办只在 TODO 中维护。

| 主题 | 记录 |
| --- | --- |
| 最初问题与修复进度 | [历史问题](archive/reports/待修复问题.md)、[2026-10-15 修复进度](archive/reports/repair-progress-2026-10-15.md) |
| 来源目录与反重力故障 | [模型目录](archive/reports/model-catalog-2026-10-15.md)、[目录跟进](archive/reports/model-catalog-followup-2026-10-16.md)、[反重力 EOF／500](archive/reports/antigravity-500-repair-2026-10-15.md) |
| TRAE | [修复记录](archive/reports/trae-repair-2026-10-16.md)、[搜索](archive/reports/trae-web-search-repair-2026-10-16.md)、[整页与查找](archive/reports/trae-web-pages-repair-2026-10-16.md)、[跨平台复核](archive/reports/trae-cross-platform-review-2026-10-16.md) |
| 旧模型发现说明 | [旧版说明](archive/reports/model-discovery-legacy.md)：包含已变化的目录策略，只供追溯 |
| 从 README 移出的修复流水 | [历史 README 记录](archive/reports/readme-progress-2026-10-16.md) |

`archive/evidence/` 保存历史报告使用的证据。原已入库的资料随目录迁移；未审核的本地原始导出保持忽略，不批量提交账号、消息、配置或凭据。部分历史报告引用的原始文件只存在于本地，复现步骤和结论应以 Markdown 报告为准。

## 维护约定

1. 新需求、缺陷和待验收项先加入 [TODO](TODO.md)，使用稳定编号；平台文档通过编号关联，不复制维护多份状态。
2. 当前行为写入 `guides/`，职责与调用链写入 `architecture.md`，可复跑的验证口径写入 `testing/`。
3. 需要保留的日期报告放到 `archive/reports/`，仅作为历史证据；不要把修复流水追加到根 README。
4. 截图、压测输出和含本机数据的原始日志先放 `.tmp/`、`output/` 或 `artifacts/`，整理脱敏结论后再入文档。不要让临时输出变成产品说明。
5. 改名或移动文档时更新相对链接，并检查仓库浏览和本地阅读都能找到入口。`docs/` 已合并，不再新建第二套文档目录。
6. Git 提交标题说明具体问题或行为；正文记录遇到的现象、已证实原因、最终改进、实际执行的验证，以及未完成项／平台限制，并链接对应文档或 TODO 编号。跨分支交付注明依赖提交和需要保留的另一侧改动，便于 `win-fix` 同步；源码、模拟与实机结果分开写，不能把“有测试”写成“已通过”。已推送的简略提交通过后续交接提交补充，不改写历史。当前分支交接见 [Windows 同步说明](待修复的问题win兼容.md#main-与-win-fix-的同步交接2026-10-17)。
