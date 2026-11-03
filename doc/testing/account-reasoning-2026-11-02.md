# 账号来源的推理参数

## 接通范围

- Cursor：从当前账号 SDK 模型的 `reasoning_effort` / `effort` 参数提取明确支持的档位；默认值来自默认 variant。能力查询经过账号、启用状态、目录有效期检查，并接入统一 Codex 模型目录。发现与派发使用同一参数选择函数，其他 context / fast 参数不变。
- WorkBuddy：账号目录识别原生 `reasoning.supportedEfforts`；显式 `supported_reasoning_levels` 优先，空列表不会被补成默认档位。Responses `reasoning.effort`、Chat `reasoning_effort`、Messages `output_config.effort` 传到 SDK query 的 `effort`。原生 thinking budget 转为 SDK `budgetTokens`；明确关闭优先，不同时发送冲突的 effort。
- Codex、Claude、Gemini、Antigravity：保留既有模型目录和中转转换。官方共存模型元数据不修改。
- Qoder：当前原生转换只有模型思考标志和 none 关闭，没有可验证的离散强度接口，不虚构 low/medium/high。

未声明档位的模型不依据名字或 supportsReasoning 布尔值推测。不开探针、不生成付费请求、不读写会话或认证配置。

## 验证范围

测试覆盖 Cursor 真实 SDK 接口的替身调用参数、账号隔离与目录失效、Codex 目录输出，WorkBuddy 三种客户端协议至 SDK 包装层，再至 query options，以及 Go 目录解析/管理接口。SDK 源码确认 options.effort 进入进程启动的 --effort，thinking.disabled 会关闭思考并省略 effort。

这些是隔离协议与构建验证，不代表已对每个真实账号、每个模型完成收费推理测试。运行中的已安装应用未替换或重启；新档位需使用新构建，刷新账号目录并重新应用模型列表。

顺带更新模型能力测试中的旧配置还原断言：当前既有 API 直连策略会保留无凭据的 inactive custom provider。测试验证恢复官方 provider、清除本次思考档位和目录、移除 API key；不再要求配置文本逐字相同。没有改动直连实现。

最终隔离回归：8 个 Vitest 文件、205 项通过；Go `TestOfficialCatalog*` 通过；类型检查与生产构建通过。Cursor 双账号 fixture 的备用 REST 目录也改为返回同一模拟目录，防止并发模拟 SDK 导入走到真实目录接口；未修改产品重试逻辑。
