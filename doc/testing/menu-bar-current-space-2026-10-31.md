# 菜单栏面板在当前桌面显示 · 10.15.26.103

原来用普通 BrowserWindow 的 `show()` 再 `focus()`，macOS 会激活应用，可能切回工作台所在的 Space。现在仅菜单栏额度窗口使用 `type: panel`，并去掉重复 focus；主工作台与 Dock 行为不变。

Electron 40.10.6 的原生实现对 panel 的 Show／Focus 跳过应用激活；panel 自带全 Space 与全屏辅助窗口行为，仍可取得键盘焦点，所以保留 Esc 与失焦收起。无需切换系统桌面设置、隐藏 Dock 或注册全局快捷键。

验证：原生隔离窗口的 `isVisibleOnAllWorkspaces()` 断言在旧实现为 false，新实现为 true；原有刷新、失焦／Esc 收起及隐藏后停轮询验证通过。此断言验证真实窗口的 Space 属性，不等于逐种多显示器／用户桌面布局都完成了手动演练。

类型检查、生产构建、20 项打包运行检查与签名验证通过，已替换本地安装为 .103。网关 HTTP 200、监听进程、Codex 配置／认证、Claude CLI 配置保持不变，未重启运行中的应用；用户下次打开 TokenFlow 加载新版。回执：`release/v10.15.26.103/install-receipt.json`。隔离窗口已退出，临时运行时已清理。

依据：
- https://www.electronjs.org/docs/latest/api/structures/base-window-options#platform-notices
- https://github.com/electron/electron/blob/v40.10.6/shell/browser/native_window_mac.mm
