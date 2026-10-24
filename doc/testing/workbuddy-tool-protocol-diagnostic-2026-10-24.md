# WorkBuddy 工具协议失败诊断（2026-10-24）

## 结论

用户在 .59 的 Claude Desktop A2A 中遇到 `workbuddy/deepseek-v4.1-flash` HTTP 502、`workbuddy_tool_protocol`。最初 8 次同来源合成真实请求均成功，当时未复现原 502。随后 .60 的 01:58:40 实际失败已定位为 `invalid_args`；后续确认并修复了共享 JSON Schema 转换的确定性误拒与参数改写缺陷，详见末节。**该次私人请求的原 schema/参数未保留，尚不能唯一证明它命中哪一个已修复分支。**

已补齐安全诊断：保留稳定的 `workbuddy_tool_protocol` code，增加固定 `toolIssue` 子类，并在错误 message 中保留固定枚举标签，使现有 trace 只保存 code/message 时仍能区分失败。未知工具、未结束工具块、坏 JSON、参数校验失败、截断及并行限制继续拒绝，没有放宽校验或自动执行工具。

## 已有真实证据与边界

主代理安全核对的既有 trace 显示：08:26:02.659Z 成功返回 1 个工具；08:26:20.507Z 带 1 个工具结果续轮失败；08:26:37.831Z 又成功返回 1 个工具；08:28:48.514Z 另一带结果续轮失败；08:29:11.924Z 无结果的重试也失败。旧 trace 只有聚合协议类别，无法从中判定具体工具失败分支。

真实探测使用同一故障 WorkBuddy 来源、独立临时 SDK profile、合成工具与历史，未执行任何工具：

| 组别 | 合成规模 | 请求 | 结果 |
| --- | --- | --- | --- |
| 基础 | 12 个 MCP 名称工具、已有工具结果、两轮续聊 | Messages 2 次、Responses 2 次 | 4/4 HTTP 200，各返回 1 个工具 |
| 复杂 | 115 个工具，含 Bash/Read 与 dotted/双下划线 MCP 名称、100 轮合成工具历史 | Messages 2 次、Responses 2 次 | 4/4 HTTP 200，各返回 1 个工具 |

所有探测均观察到已注册包装工具名、完整 block_stop、有效参数 JSON、正常 tool_use/end_turn，没有 orphan delta。单请求约 3.7–6.7 秒。合成规模接近客户端工具数量，不代表复用了原请求的私人 schema、描述或正文，因此成功不能证明原场景已经恢复。

维护脚本：`scripts/workbuddy-tool-protocol-audit.ts`，必须显式 `--live`；每次调用最多 4 个请求。`--complex` 选择复杂组。脚本仅在自身进程中观察 SDK transport 的结构，不改变事件，不记录模型正文、工具名、参数、签名或凭据；临时 profile 在结束后删除。

结构报告为 ignored artifacts：

- `artifacts/workbuddy-tool-protocol-audit.json`
- `artifacts/workbuddy-tool-protocol-audit-complex.json`

本轮已停止追加真实请求；未重启 .59、未修改用户配置、未构建或打包。

## 共享诊断机制

runtime 与 SDK declarations 增加以下固定枚举：

| toolIssue | 仍被拒绝的情况 |
| --- | --- |
| unknown_name | 不在本次注册映射中的工具 |
| unfinished_block | 工具块未收到结束事件 |
| invalid_json | 参数片段无法解析为 JSON |
| invalid_args | 参数不符合已声明 schema |
| truncated_turn | max_tokens、context window、refusal 等未正常完成的工具轮 |
| parallel_limit | 返回多个工具，违反本次单工具要求 |
| orphan_delta | 参数片段没有对应工具块 |
| input_limit | 参数超过既有大小限制 |

`failureDiagnostic` 只接受固定 issue；toolBlocks/unfinishedToolBlocks 只接受有界安全非负整数，拒绝任意字符串或负数。诊断不包含工具名、参数、原始异常或请求文本。

`codebuddy.ts` 将 issue 接到现有安全错误封装；`upstream-errors.ts` 只接收白名单枚举，生成固定 message。重复协议归一化只能从完全匹配的固定 message 复原 issue，不从任意上游文本猜测子类。稳定 code 及旧 generic message 保持兼容。

Messages 与 Responses 的 buffered/stream 共用此机制。stream 即使只保留固定 message，现有 gateway trace 的 `error.code/message` 也能保留子类；没有新增日志或 trace payload 字段。

## 回归验证

先加入诊断断言并运行：14 failed、72 passed；失败恰为 runtime 的 7 个缺失子类和错误归一化的 7 个缺失子类。之后实现诊断并保留既有拒绝测试。

```sh
npx vitest run tests/codebuddy-runtime.test.ts tests/codebuddy-sdk.test.ts tests/codebuddy-sdk-service.test.ts tests/upstream-errors.test.ts
```

结果：4 files、126 tests 全部通过。覆盖 runtime 分类与拒绝、任意计数字段过滤、所有 8 个子类在 Messages/Responses buffered/stream 中的呈现，以及 32 个端到端 fixture 失败在最终 gateway trace 中保留固定子类 message。合成私人标记未出现在公开错误或诊断中。

下一次用户原场景若再次失败，可以从 `workbuddy_tool_protocol` 的固定 message 标签区分具体子类，再针对真实证据建立修复回归。本报告不将诊断增强称为原 502 的修复。

## .60 invalid_args 后续：原始 schema 语义修复

用户在 2026-10-24 01:58:40 America/Los_Angeles 实际再次收到 `invalid_args`。这证明失败发生在参数校验，但单靠该枚举无法区分原 schema 拒绝，还是 JSON Schema→Zod 转换制造了额外限制。

已建立运行真实 runtime 校验路径的最小红灯：

```json
{
  "type": "object",
  "properties": {
    "selection": {
      "type": "object",
      "properties": {"id": {"type": "string"}, "name": {"type": "string"}},
      "oneOf": [{"required": ["id"]}, {"required": ["name"]}]
    }
  },
  "required": ["selection"]
}
```

合成参数 `{"selection":{"id":"synthetic"}}` 符合原 schema。Zod 4.3.6 `fromJSONSchema` 将没有显式 type 的 required-only 子分支转为任意值，两个分支都匹配，随后 xor 错误拒绝合法参数。该差分已验证：原 JSON Schema validator 接受，旧 runtime 返回 `invalid_args`。

同一旧 runtime 命令共得到 6 个红灯：required-only oneOf、tuple 允许额外项、tuple 未声明 minItems 时允许短数组、合法 RFC3339 offset datetime、合法相对 URI reference 被误拒，以及 default annotation 被擅自插入参数。后者会改变交给客户端的原始参数。

### 实现

- 新增独立 `client-schema.js/.d.ts`，按原始 JSON Schema 用 AJV 验证，callback 和 streamed proposal 共用同一 validator。
- MCP 通过公开的低层 tools/list handler 广播原始声明。Zod 仅作为 SDK 的 object transport，不再转换工具声明或负责最终语义校验；MCP callback 在提议前仍验证原始 schema。
- 不进行类型 coercion、default 插入或额外属性删除；合法参数按原对象返回。实际无效参数继续拒绝，不回退 loose schema。
- root 顶层需要 object 参数；为没有 type 的 union 就地补充 object，保留 `$defs`、`definitions`、`#/properties/...` 等根相对引用路径，不把整个 schema 移到 allOf 下。
- 显式 draft-06/07 使用 legacy validator，并加载 draft-06 meta；显式 2020-12 使用对应 validator。未声明 dialect 时，旧 `items: [...]` tuple 语法选择 draft7，其余选择 2020-12。未知 dialect、缺失/外部 refs、非法 schema 均失败关闭为 `tool_schema`，不会联网解析引用。
- runtime 显式锁定 `@modelcontextprotocol/sdk@1.32.1`、`ajv@8.20.0`、`ajv-formats@3.0.1`，workspace lock 同步。新增依赖及 draft-06 meta 在源运行时可解析；最终 app 外置 runtime 检查由主代理执行。

### 红绿与真实 SDK 验证

```sh
npx vitest run tests/codebuddy-runtime.test.ts -t 'original JSON Schema semantics'
```

旧实现：6 failed。修复后这些断言全部通过。

```sh
npx vitest run tests/codebuddy-client-schema.test.ts tests/codebuddy-schema-mcp.test.ts tests/codebuddy-runtime.test.ts tests/codebuddy-sdk.test.ts tests/codebuddy-sdk-service.test.ts tests/upstream-errors.test.ts
```

结果：6 files、151 tests 全绿。新增原生 schema 对照覆盖 anyOf/oneOf/nullable/array、additionalProperties、uniqueItems/contains、refs、各 dialect 与无效 schema；真实 in-memory MCP Client 验证 tools/list 声明和合法/非法 callTool 与 stream 校验一致。原有未知工具、未结束块、坏 JSON、截断、并行等拒绝测试仍通过。

按授权新增 opt-in `--schema-cases`，保留原 simple/complex 模式，仅执行 Messages/Responses 各一次合成 required-only oneOf 工具提议：

- Messages：HTTP 200、1 个工具、`schemaCaseMatched=true`，约 4.53 秒。
- Responses：HTTP 200、1 个工具、`schemaCaseMatched=true`，约 6.01 秒。

两个请求均经真实 pinned SDK/MCP transport、registered name、完整 block、有效 JSON；没有执行工具。结构结果位于 ignored `artifacts/workbuddy-tool-protocol-audit-schema-cases.json`，不含参数或私人正文。没有重发用户请求，也未读取/持久化用户失败参数。

当前结论是：共享转换误拒与参数改写机制已由红绿测试和有界真实 SDK 验证修复。01:58:40 原始请求缺少精确 schema/参数证据，因此其唯一归因和用户原场景恢复仍需后续真实使用确认；不把合成成功写成原请求已验证成功。本分工未打包、安装或提交。
