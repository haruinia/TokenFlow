# .105 下载页更新

- 4180 现有页面由 .98 更新为 `10.15.26.105`，Apple 芯片和 Intel 下载按钮均指向新版 DMG；同步更新 app.js 缓存版本。
- Apple 芯片包取自已安装且签名核验通过的 .105；Intel 包从同一 Git `607c066` 的构建输出重新打包。两者版本与 Mach-O 架构检查通过；两种架构各有 20 项打包运行时检查通过，Intel 使用 Rosetta，不表示完成实体 Intel Mac 验证。
- 两份 DMG 的 `hdiutil verify` 通过；通过实际局域网地址完整下载，HTTP 200、SHA-256 与发布产物一致。
- 当前地址：`http://10.2.6.48:4180/`。沿用既有 launchd 常驻服务，未重启 TokenFlow 或 Codex。
- 页面旧入口保存在 `release/v10.15.26.105/website-before/`；下载校验回执为 `release/v10.15.26.105/website-verification.json`。站点在已忽略的本地目录 `analysis-corpus/sites/tokenflow-story-4180/dist`。
- 已清理本轮 DMG 临时目录与中断的 Electron 下载片段，保留发布包和校验结果。
