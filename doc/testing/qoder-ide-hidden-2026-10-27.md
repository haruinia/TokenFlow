# 10.15.26.81：隐藏本地 Agent 的 Qoder IDE 入口

本地 Agent 中只显示 Qoder 独立版，去除 Qoder / Qoder IDE 切换器与 IDE 面板渲染，同时停止该页面额外请求 IDE 登录状态。以前保存的 `qoder-ide` Agent 标签继续通过现有兼容映射回到 `qoder`；旧客户端选择不再决定页面。后端及历史用量数据保留，便于未来恢复支持。

验证：类型检查、生产构建通过。浏览器隔离页面预置旧的两个 localStorage 选择，实际挂载 AgentsPage 后显示 Qoder，不包含 Qoder IDE。M 芯片安装包 19 项运行检查通过，两种架构均通过签名和 DMG 完整性校验。Intel 本次为交叉构建，未把上一版 Rosetta 账号用量归属失败记为已修复，也未声称完成 Intel 真机验收。

交付：`release/v10.15.26.81/installers/` 的 arm64、x64 DMG、SHA256SUMS 和 build-manifest。均为本地临时签名、未做 Apple 公证。

网站为本地独立目录 `analysis-corpus/sites/tokenflow-story-4180/dist`，运行时由 4180 Python 静态服务器提供。更新下载按钮、弹窗、版本标识及 app.js 内容哈希；两个新链接均实际下载校验，HTTP 200，SHA-256 与安装包相同。旧站点入口文件备份在该站点 `research/downloads-before-81/`；旧 release 文件保留。网页文件属于已忽略的本地分析目录，未将整个语料网站加入产品仓库。

本次只生成安装包并更新网站，未重启或替换正在运行的本地应用。
