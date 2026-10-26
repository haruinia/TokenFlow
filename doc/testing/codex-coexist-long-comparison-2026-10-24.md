# 长历史续聊、旧配置对照与版本备份

2026-10-24。新兼容方案和旧压缩配置对照均通过两次官方/网关往返。未替换当前安装，未修改真实用户配置或会话。

## 测试方法和边界

- 客户端：已安装 Codex 0.164.0-alpha.11.1；服务：源码中的生产 TokenFlow service。
- 真实上游：官方 gpt-6-astra、反重力 antigravity/gemini-3.8-flash-low。
- 隔离 HOME/CODEX_HOME，用实际 Codex 客户端写入 12 批合成历史，共 394590 字节（约 385 KiB）。历史创建阶段返回模拟响应，压缩和续聊阶段使用真实模型。
- 历史在开头、中段、末尾分别埋入随机标识，往返途中另加入三个要求标识。最终要求恢复全部六个标识。
- 另检查 eu-west-2、730、backup 三个业务约束关键词是否出现在最终回复；这不是对任意自然语言约束的完整语义验证。
- 历史种子使用合成 token 用量以避免创建期间自动压缩。实际测试显式触发压缩，不证明自动阈值触发或所有超长真实任务均无损。
- 首次官方压缩实测输入约 101k token；新方案跨网关请求最大约 140k token。
- 旧配置对照是在同一源码测试服务中移除隔离配置的 remote_compaction 能力，复现 .64 的 Codex 本地摘要路径；不是启动旧版 GUI。两组顺序运行，历史结构和模型一致，随机标识不同。

## 结果

| 阶段 | 旧配置：Codex 文字摘要 | 新方案：官方原生 / 网关兼容摘要 |
|---|---:|---:|
| 第一次官方压缩 | 16.0 秒 | 26.5 秒 |
| 第一次网关压缩 | 49.1 秒 | 78.0 秒 |
| 第二次官方压缩 | 11.4 秒 | 21.9 秒 |
| 第二次网关压缩 | 8.1 秒 | 9.7 秒 |
| 最终官方续聊 | 六个标识全部保留 | 六个标识全部保留 |

新方案首次网关摘要分成九次模型调用，第二次只需一次。旧配置的官方摘要已是可读文本，第一次网关本地摘要只需一个普通模型请求。新方案无法把官方密文直接交给第三方，需要从本地历史恢复可读内容，所以首次跨模型后的网关压缩要处理更多历史。

本次单样本中旧配置更快，和用户体感一致；模型排队、缓存和生成长度均会影响耗时，不能把这里的数字当作固定性能保证。新方案的价值是保留官方原生压缩，而不是承诺更快。

结果文件：
- `results/codex-coexist-long-live-2026-10-24.json`
- `results/codex-coexist-long-legacy-live-2026-10-24.json`
- 两组对应 fixture 结果也保留。

可复现命令：
```sh
node --import tsx scripts/codex-coexist-roundtrip.mts --live --long --proxy http://127.0.0.1:7897 --out doc/testing/results/codex-coexist-long-live-2026-10-24.json
node --import tsx scripts/codex-coexist-roundtrip.mts --live --long --legacy-local --proxy http://127.0.0.1:7897 --out doc/testing/results/codex-coexist-long-legacy-live-2026-10-24.json
```

## 版本保存

- `release/v10.15.26.64/TokenFlow.app`：从当前安装目录复制，未停止原应用；严格签名验证通过。
- `release/v10.15.26.64/source-b1ce012.tar.gz`：现有 Git 保存点 b1ce012 的源码，package.json 标记 .64。`backup-manifest.json` 记录源码与 app.asar 的 SHA-256。
- `release/v10.15.26.65/TokenFlow.app`：此前额度显示修复版仍保留。
- `release/v10.15.26.66/TokenFlow.app`：本次官方原生/网关摘要兼容方案，也包含此前额度显示修复。已构建、临时签名，严格签名验证及 19 项打包运行时检查通过。
- `release/v10.15.26.66/source-working-tree.tar.gz`：当前源码及未提交的测试/文档快照；不含账号凭据、真实会话、node_modules 或发布目录。
- `release/v10.15.26.66/backup-manifest.json`：快照与应用校验值、源码基准和验证状态。

新版本仅保存，未安装。当前 /Applications/TokenFlow.app 仍是 .64，现有连接未改动。
