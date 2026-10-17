# macOS 模型弹窗滚动回归

DeepSeek Harness 和 Pi 共用 `AgentModelPicker` / `FlowDialog`。背景 `.nativeMac .tfSide` 是 Electron 原生窗口拖动区域；弹窗即使位于 HTML top layer，仍需显式设置 `-webkit-app-region:no-drag`，否则与侧边栏重叠的位置会丢失滚动和指针输入。

## 验证步骤

1. 在 macOS 桌面版准备足够多的模型来源，使左侧来源列表溢出。
2. 将窗口缩至约 1100 × 910，侧边栏宽度设为约 256，使模型弹窗的来源列表与背景侧边栏在水平方向重叠。
3. 分别打开 DeepSeek Harness 和 Pi 的“管理所选模型”，把指针放在左侧来源条目的中部，用触控板双指上下滑动。列表应移动。
4. 把指针移到同一列表靠右、超出背景侧边栏的位置，确认同样能滚动；再验证右侧模型列表和来源切换。
5. 改变窗口大小、关闭重开弹窗，重复检查。关闭弹窗后，背景侧边栏空白区域仍应可以拖动窗口。

## 已验证的最小对照

使用真实 `AgentModelPicker`、项目 CSS、18 个虚构来源以及宽 256px 的背景 `.tfSide`，在带 `hiddenInset` 标题栏的 Electron 窗口中发送原生滚动输入：

- 修复前：左侧条目中部向下滚动，`scrollTop` 保持 0。
- 为 dialog 设置 `no-drag`：同一输入使 `scrollTop` 从 0 变为 100，向上可回到 0。
- 撤销 `no-drag`：同一输入再次无法滚动。

普通 DOM wheel 事件或 CDP `Input.dispatchMouseEvent` 绕过了这里的原生窗口命中测试。仅用它们测试会漏掉此问题；回归需使用 macOS 原生输入。最小复现不需要真实账号或凭据。
