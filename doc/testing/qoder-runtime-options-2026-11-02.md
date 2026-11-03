# Qoder 推理档位、上下文与压缩阈值

## 核对证据

只读核对本机 Qoder IDE 程序及 `aicoding.modelConfigs.cache.assistant` 模型缓存（只提取公开模型配置，不读取认证或聊天记录）：

- DeepSeek-Flash / dfmodel：上下文 200000 / 400000 / 1000000，默认 200000；思考 low / high / max，默认 high，可关闭。
- DeepSeek-V4-Pro / dmodel：同样三个上下文选项，默认 200000；思考 high / max，默认 max，可关闭。
- IDE 读取 `contextConfig[*].tokenCount/isDefault` 与 `thinkingConfig.enabled.efforts`；生成 `parameters.context_length`、`parameters.reasoning_effort`。不能用模型名称猜档位，也不能把最大输入量当作当前上下文。

此前中转只映射思考开关；模型目录继承 131072 的静态 context_length，即使最大输入量是 1000000。已有 Codex 目录因此只有 117964 的压缩阈值且没有档位选项。

## 实现边界

1. Sidecar 从当前账号已允许的 Qoder 模型提取白名单化的 runtime options；没有加入目录外的 IDE 模型。克隆注册表记录时复制选项数组。
2. 默认上下文覆盖静态预设；原生档位和默认档位通过管理接口进入 TokenFlow 能力缓存和 Codex 模型目录。
3. Codex 的模型选择面板中，已选 Qoder 模型提供上下文选择。只显示实际声明的选项；选择跟随来源及模型保存。其他客户端和 API Key 导出界面不展示这个 Codex 配置控件。
4. 应用时固定已解析的上下文；生成目录、初始压缩调度、普通调用及摘要调用共用它。200K / 400K / 1M 对应 180K / 360K / 900K 压缩阈值。保留已有小窗口切换兼容策略。
5. Responses / Chat / Messages 的档位转换为原生 reasoning_effort；保留原始请求中的明确档位，避免通用翻译丢失 max。context_length 从原始信封恢复，严格限定数值和当前账号模型的允许值。没有合并任意原始字段。
6. 所有原生思考标志一致；none 或明确 disabled 关闭思考。省略参数时使用来源默认值。旧目录可以更新为新发现的 Qoder 默认值；显式选定窗口不会在刷新时退回默认。官方模型目录不变。

## 验证

- Go 目录解析：原生选项、默认值、排除无效档位、注册表复制隔离。
- Go 执行器：三种请求格式，经实际翻译与 Qoder 编码后检查线上的 payload（隔离 HTTP 上游）；上下文、档位和模型标识保持一致。
- Go 参数处理：合法窗口与档位组合、默认值、未知窗口/档位拒绝、原始信封只恢复指定字段。
- TS：能力读取、不同窗口生成不同压缩阈值、更新旧目录、官方目录保留、刷新幂等。
- 隔离 TokenFlow 服务：拒绝未声明窗口且不改配置；选择 1M、写入 900K 阈值、发请求及服务重启后再次发请求，均由模拟上游核对 1M。
- 本机已安装 Codex 引擎：`npx tsx scripts/qoder-codex-options-probe.mts`，独立数据目录、不可连接的测试上游，仅 model/list；确认 none/low/high/max 和默认 high。
- 回归还更新了原有重启测试的一条陈旧断言：既有 Codex 启动调用包含空 options 参数。这不涉及重启行为修改。

类型检查、前后端构建及 macOS ARM64 sidecar 构建通过。未向真实 Qoder 发送收费推理，未做真实账号长对话压缩验证；没有安装或重启生产应用，也未改生产认证、会话或配置文件。

最终 TS 回归：10 个文件、136 项通过；Go `TestOfficialCatalog*` 与 Qoder/WorkBuddy/AgentContract 相关执行器测试通过。本机 Codex model/list smoke 通过。
