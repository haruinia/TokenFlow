# 统一网关内置图片接口（.105）

## 根因与边界

用户报告官方模型的内置 `image_gen.imagegen` 不可用。实际失败会话的工具已被调用，2026-11-01 12:02:31Z、12:03:15Z 分别收到 TokenFlow 本机的 `Route POST:/codex/v1/images/edits not found`、`Route POST:/codex/v1/images/generations not found`。请求没有到达 OpenAI，并非模型工具被禁用或官方额度拒绝。

现有统一网关按接口注册转发，并非整个 Codex 通信的透明代理。Responses 对话和压缩已接通，不能据此推断所有新官方工具都兼容。第三方 Responses 适配器删除不支持的 hosted image tool 是另一条路径，本次不改动。

## 修复

- 独立 `codex-official-images.ts` 注册官方共存入口的生成、编辑两个端点；不经过历史展开、子代理消息转换或压缩逻辑。不增加通配代理，不向第三方 API 或 sidecar 发送 ChatGPT 凭据。
- 仅有效共存连接和请求中当前的 ChatGPT Bearer 可以访问。目标固定为 `https://chatgpt.com/backend-api/codex/images/{generations,edits}`，禁止重定向；图片模型由官方图片接口判断，不错误套用聊天模型目录。
- 本机 Codex 原生编辑也是 JSON（`images` 内为 `image_url` / `file_id`），并非公共 API 的 multipart 示例。保留图片模型、提示词、质量、尺寸、背景和引用参数，以及账号、image turn、turn metadata；不转发本机 Key、cookie、第三方 API Key 或已解压的 content-encoding。
- 响应图片字节原样流式返回，保留图片请求 ID、外层请求 ID 和重试时间。客户端断开会取消上游；上游中断不会记为完成。
- 用量沿用已有有界观察器，只记录官方账号归属、模型、Token、状态等元数据。图片/提示词不写入用量记录。响应超过现有 16 MiB 观察预算时仍完整转发，但 Token 记为未测量，不伪造零消耗。

## 验证

- 新增服务边界回归先复现本机 404，再验证生成、编辑、超过默认 1 MiB 的 JSON/zstd 上传、参数与授权保留、本机认证隔离、429/请求 ID、连接失败、取消和流中断，共 7 项。
- 既有 76 项相关测试通过：官方共存 7、用量观察 12、A2A 互通 2、API 来源 55。第三方适配与对话链路保留。
- `node --import tsx scripts/codex-official-images-smoke.mts`：本机安装的 `codex-cli 0.166.0-alpha.5.1`，独立 CODEX_HOME、合成授权和上游，真实执行原生 `image_gen.imagegen` 的生成和本地图片编辑。两次均收到完成事件，图片写入隔离目录；模型 `gpt-image-2`、官方目标路径、认证、image turn ID、编辑引用和两条用量记录均断言通过。夹具自动清理。
- 原生实现核对：`openai/codex` 的 `codex-rs/ext/image-generation/src/backend.rs` 与 `codex-rs/codex-api/src/endpoint/images.rs`（2026-11-01 获取），确认配置 provider 的 Images JSON 路径和请求标识。
- 没有发起真实 OpenAI 图片生成、消耗账号额度或修改生产 Codex 配置/认证/会话。真实供应商可用性仍取决于登录、额度和网络，本轮测试不声称其他所有官方工具均已兼容。

## 安装

typecheck、构建、20 项打包运行时检查、签名核验通过。.105 已替换 `/Applications/TokenFlow.app`，安装文件与构建产物哈希一致；9527 网关 HTTP 200、监听 PID 未变，Codex 配置/认证及 Claude CLI 设置哈希未变。手动重启 TokenFlow 后生效。

回执：`release/v10.15.26.105/install-receipt.json`。安装前程序保留在 `/Applications/.tokenflow-before-105-c6pJ8P/TokenFlow.app`；未清理此前仍被运行进程引用的程序。已删除本次打包使用的隔离 Electron 临时副本。
