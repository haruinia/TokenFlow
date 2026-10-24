import {safeFailure} from './login/diagnostics.js';
// Only known categories cross the gateway boundary. Never return raw provider
// messages: they can contain request content or credentials.
const known:Record<string,{message:string;type:string;wireMessage?:string}>={
 qoder_resource_limit:{type:'rate_limit_error',message:'Qoder 返回资源限流（RESOURCE_LIMIT），当前模型容量不足。请求尚未完成，请稍后重试；这不表示模型 ID 无效或登录失效。'},
 qoder_capacity_wait_exhausted:{type:'rate_limit_error',message:'Qoder 当前模型容量不足，本次自动等待重试已结束，或上游要求的等待时间超过本次等待预算。请稍后重试或选择其他模型；原账号和模型配置保留。'},
 qoder_rate_limited:{type:'rate_limit_error',message:'Qoder 请求受限，请稍后重试并检查官方额度。'},
 qoder_authentication_failed:{type:'authentication_error',message:'Qoder 拒绝了当前授权，请检查所选账号的登录状态。'},
 qoder_access_denied:{type:'permission_error',message:'Qoder 拒绝了本次访问，请检查所选账号对该模型的权限。'},
 qoder_request_rejected:{type:'invalid_request_error',message:'Qoder 拒绝了请求参数，请保留调用记录用于排查兼容性。'},
 qoder_upstream_error:{type:'provider_error',message:'Qoder 在响应流中返回服务错误，本次请求未完成，请稍后重试。'},
 cursor_model_not_found:{type:'invalid_request_error',message:'Cursor 上游找不到所选模型（model not found）。请刷新该来源的模型列表，或选择该账号实际可用的其他模型。'},
 cursor_region_unsupported:{type:'permission_error',message:'Cursor 明确拒绝了当前地区对该模型供应商的访问。模型可能仍出现在官方目录中；请查看 Cursor 的地区支持说明或选择受支持的模型。这不表示账号登录失效。'},
 cursor_plan_required:{type:'authentication_error',message:'Cursor 官方返回 plan_required：当前账号套餐不支持此 API，请在官方确认 Pro 或团队套餐后刷新。'},
 cursor_authentication_failed:{type:'authentication_error',message:'Cursor 授权已失效，请重新连接账号。'},
 cursor_permission_denied:{type:'authentication_error',message:'Cursor API 权限不足，请在官方账号或团队设置中确认权限。'},
 cursor_rate_limited:{type:'rate_limit_error',message:'Cursor 请求受限，请检查官方额度或稍后重试。'},
 cursor_timeout:{type:'timeout_error',message:'Cursor 连接超时，请检查网络后刷新。'},
 cursor_network_error:{type:'provider_error',message:'Cursor 网络连接失败，请检查网络后刷新。'},
 cursor_backend_override:{type:'configuration_error',message:'检测到 CURSOR_BACKEND_URL 覆盖，请移除后重启；SDK 授权与模型目录使用不同的官方地址。'},
 cursor_upstream_unavailable:{type:'provider_error',message:'Cursor 上游暂不可用（unavailable），可能是服务或连接故障；可以切换网络后刷新试试。'},
 cursor_upstream_internal:{type:'provider_error',message:'Cursor 上游返回内部错误（internal），请稍后重试。'},
 cursor_request_rejected:{type:'invalid_request_error',message:'Cursor 上游拒绝了模型或请求参数，请检查所选模型和请求格式。'},
 cursor_tls_error:{type:'provider_error',message:'Cursor TLS 握手或证书验证失败，请检查代理与证书，可以切换网络后刷新试试。'},
 cursor_dns_error:{type:'provider_error',message:'Cursor 域名解析失败，请检查 DNS，可以切换网络后刷新试试。'},
 cursor_upstream_error:{type:'provider_error',message:'Cursor 调用失败，尚未识别具体原因。请保留调用记录用于排查；不能据此判断模型目录或账号授权失效。'},
 cursor_unavailable:{type:'source_unavailable',message:'Cursor 尚未授权，或所选账号、模型暂不可用。'},
 cursor_cancelled:{type:'request_cancelled',message:'请求已取消'},
 cursor_busy:{type:'rate_limit_error',message:'Cursor 正在处理另一个请求，请稍后重试。'},
 cursor_tool_required:{type:'upstream_protocol_error',message:'Cursor 未按要求生成工具调用，请重试或选择其他模型。'},
 workbuddy_sdk_failed:{type:'provider_error',message:'WorkBuddy 官方 SDK 或上游请求失败，请稍后重试。'},
 workbuddy_rate_limited:{type:'rate_limit_error',message:'WorkBuddy 来源限流，请稍后重试或选择其他模型。'},
 workbuddy_authentication_failed:{type:'authentication_error',message:'WorkBuddy 登录已失效，请重新授权所选账号。'},
 workbuddy_text_mismatch:{type:'upstream_protocol_error',message:'WorkBuddy SDK 的流式文本与最终消息不一致，本次响应未完成。'},
 workbuddy_model_mismatch:{type:'upstream_protocol_error',message:'WorkBuddy SDK 返回的模型与所选模型不一致，本次响应未接受。'},
 workbuddy_missing_result:{type:'upstream_protocol_error',message:'WorkBuddy SDK 结束时未返回最终结果，本次响应未完成。'},
 workbuddy_context_limit:{type:'invalid_request_error',message:'WorkBuddy SDK 报告输入或上下文超过限制，请缩短对话后重试。'},
 workbuddy_output_limit:{type:'invalid_request_error',message:'WorkBuddy SDK 报告输出预算无效或超过限制。'},
 workbuddy_tool_schema:{type:'invalid_request_error',message:'WorkBuddy SDK 报告工具定义不兼容，请检查工具参数结构。'},
 workbuddy_tool_protocol:{type:'upstream_protocol_error',message:'WorkBuddy SDK 的工具调用不完整或不符合本次工具定义。'},
 workbuddy_turn_limit:{type:'upstream_protocol_error',message:'WorkBuddy SDK 达到回合限制，但未返回可交给客户端的工具调用。'},
 workbuddy_sdk_startup:{type:'provider_error',message:'WorkBuddy SDK 的 CLI 启动失败，请检查本地运行环境。'},
 workbuddy_sdk_execution:{type:'provider_error',message:'WorkBuddy SDK 返回执行错误，尚未识别到具体上游错误类型。'},
 workbuddy_sdk_transport:{type:'provider_error',message:'WorkBuddy SDK 通信中断，本次响应未完成。'},
 workbuddy_output_failed:{type:'upstream_protocol_error',message:'WorkBuddy 返回的模型或工具调用不符合本次请求。'},
 workbuddy_credential_failed:{type:'authentication_error',message:'无法读取 WorkBuddy 账号授权，请检查账号状态。'},
 workbuddy_setup_failed:{type:'provider_error',message:'WorkBuddy 本地请求准备失败，请检查目录权限和空间。'},
 workbuddy_timeout:{type:'timeout_error',message:'WorkBuddy 请求超过等待时限，请稍后重试或缩短对话。'},
 a2a_parallel_tools_violated:{type:'upstream_protocol_error',message:'来源返回了多个工具调用，与本次单工具调用要求不符。'},
 a2a_invalid_request:{type:'invalid_request_error',message:'来源拒绝了本次请求的参数或工具定义。账号和模型配置仍保留；请检查请求兼容性，重新登录不能修复此类参数错误。',wireMessage:'The source rejected request parameters.'},
 a2a_source_policy_blocked:{type:'source_policy_blocked',message:'WorkBuddy 拒绝了本次请求所属的调用渠道（错误 11128：未获批准的调用渠道）。这是来源端的渠道授权错误；重写本地接口、Key 或重新登录不能解除。其他测试会话成功不代表当前客户端已恢复。',wireMessage:'The source rejected this invocation channel under its security policy.'},
 a2a_structured_output_unsupported:{type:'unsupported_feature',message:'该来源暂不支持严格 JSON 或 JSON Schema 输出。请使用普通文本，或选择支持结构化输出的来源。',wireMessage:'Structured output is not supported by this source adapter.'},
 a2a_server_tool_unsupported:{type:'unsupported_feature',message:'该来源支持客户端函数工具，暂不支持服务端内置工具。请关闭内置网页搜索等服务端工具，或选择支持它们的来源。',wireMessage:'This source supports client function/custom tools only; server-side or unknown tool types are not supported.'},
 upstream_context_length:{type:'invalid_request_error',message:'上游拒绝了超出模型上下文窗口的输入。请减少本轮附件或工具定义，或选择支持更长上下文的模型。'},
 upstream_rate_limited:{type:'rate_limit_error',message:'上游返回限流或容量不足，请稍后重试或选择其他模型。'},
};
const workbuddyToolIssueMessages={
 unknown_name:'WorkBuddy SDK 返回未声明的工具名，工具调用未接受（unknown_name）。',
 unfinished_block:'WorkBuddy SDK 的工具块未完整结束，工具调用未接受（unfinished_block）。',
 invalid_json:'WorkBuddy SDK 的工具参数不是完整 JSON，工具调用未接受（invalid_json）。',
 invalid_args:'WorkBuddy SDK 的工具参数不符合声明结构，工具调用未接受（invalid_args）。',
 truncated_turn:'WorkBuddy SDK 的工具响应被截断或未正常结束，工具调用未接受（truncated_turn）。',
 parallel_limit:'WorkBuddy SDK 返回多个工具调用，超出本次单工具要求（parallel_limit）。',
 orphan_delta:'WorkBuddy SDK 返回没有对应工具块的参数片段，工具调用未接受（orphan_delta）。',
 input_limit:'WorkBuddy SDK 的工具参数超过大小限制，工具调用未接受（input_limit）。',
};
type ToolIssue=keyof typeof workbuddyToolIssueMessages;
type ErrorDetail={code?:string;type?:string;param?:unknown;message?:string;fields?:unknown;toolIssue?:unknown};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
// Some Responses bridges wrap an already structured provider error inside
// `message`. Read that envelope before classification so its category survives.
function errorEnvelope(body:string):{error?:ErrorDetail}{
 try{
  const value:unknown=JSON.parse(body);if(!record(value))return {};
  const detail=record(value.error)?value.error:record(value.response)&&record(value.response.error)?value.response.error:value;
  if(typeof detail.message==='string'){
   const nested=errorEnvelope(detail.message);if(nested.error)return nested;
  }
  return ['code','type','message','param','fields'].some(key=>key in detail)?{error:detail as ErrorDetail}:{};
 }catch{return {};}
}
export function upstreamError(status:number,body:string):{code?:string;type:string;message:string;param?:string;toolIssue?:ToolIssue}{
 const parsed=errorEnvelope(body);
 const code=typeof parsed?.error?.code==='string'?parsed.error.code:undefined;const message=typeof parsed?.error?.message==='string'?parsed.error.message:'';
 if(code==='workbuddy_tool_protocol'){
  // The fixed message preserves this subtype in existing traces even when an
  // intermediary keeps only error.code/message. Never inspect arbitrary names,
  // arguments, or provider text to invent a tool subtype.
  const issue=parsed.error?.toolIssue;
  const toolIssue=typeof issue==='string'&&Object.hasOwn(workbuddyToolIssueMessages,issue)?issue as ToolIssue:(Object.keys(workbuddyToolIssueMessages) as ToolIssue[]).find(key=>message===workbuddyToolIssueMessages[key]);
  return {code,...known.workbuddy_tool_protocol!,...(toolIssue?{toolIssue,message:workbuddyToolIssueMessages[toolIssue]}:{})};
 }
 if(code==='workbuddy_invalid_request'||code==='cursor_invalid_request'){
  const fields=Array.isArray(parsed?.error?.fields)?parsed.error.fields.filter((field:unknown)=>typeof field==='string'&&/^(?:tools|input|messages|reasoning|model|stream|instructions|system|tool_choice|parallel_tool_calls|max_tokens|max_output_tokens|max_completion_tokens|reasoning_effort)(?:\.(?:[0-9]+|name|type|content|parameters|summary|effort))*$/.test(field)).slice(0,5):[];
  const detail=fields.length?`（字段：${fields.join('、')}）`:'';
  return {code,type:'invalid_request_error',message:code==='workbuddy_invalid_request'?`WorkBuddy 请求格式不兼容${detail}。请保留此错误用于排查；切换账号或重写配置不能修复请求格式。`:`Cursor 请求格式不支持${detail}：请检查所标注的消息内容或工具格式；服务端工具和严格 JSON 输出暂不可用。`};
 }
 const entry=code&&Object.hasOwn(known,code)?[code,known[code]] as const:Object.entries(known).find(([,value])=>message===value.wireMessage);
 if(entry)return {code:entry[0],type:entry[1].type,message:entry[1].message};
 if(['context_length_exceeded','context_too_large'].includes(code??''))return {code:'upstream_context_length',...known.upstream_context_length!};
 if(status===429||['rate_limit_exceeded','rate_limit_error'].includes(code??'')||parsed.error?.type==='rate_limit_error')return {code:'upstream_rate_limited',...known.upstream_rate_limited!};
 if(status===400||code==='upstream_invalid_request'){
  const param=typeof parsed?.error?.param==='string'?parsed.error.param:message.match(/^([A-Za-z0-9_.\[\]]{1,256}):(?:\s|$)/)?.[1]??'';
  // Retain only structural request paths; arbitrary parameter names can contain
  // user data. Raw upstream messages never cross this boundary.
  const safeParam=param.length<=256&&/^(?:input|messages|tools|model|instructions|system|reasoning|thinking|text|response_format|tool_choice|max_tokens|max_output_tokens)(?:\[\d{1,9}\]|\.(?:\d{1,9}|content|type|text|role|name|custom|function|parameters|input_schema|schema|format|strict|effort|summary|call_id|arguments|output|encrypted_content|thinking|signature|budget_tokens|anyOf|oneOf|allOf|items))*$/.test(param)?param:'';
  if(safeParam||['upstream_invalid_request','invalid_request_error','invalid_type','invalid_value','missing_required_parameter','unsupported_parameter','unsupported_value','invalid_parameter'].includes(code??'')||parsed?.error?.type==='invalid_request_error')return {code:'upstream_invalid_request',type:'invalid_request_error',...(safeParam?{param:safeParam}:{}),message:`上游拒绝了请求格式或参数${safeParam?`（字段：${safeParam}）`:''}。请保留此错误用于排查协议兼容性；切换账号或修改 DNS 不能修复参数错误。`};
 }
 if(message.includes('User location is not supported for the API use'))return {code:'region_not_supported',type:'region_not_supported',message:'所选账号的上游服务不支持当前地区使用 API。请查看提供商的地区支持说明；重新登录不能解决此限制。'};
 if(status>=500&&/auth_unavailable|cooling down/.test(message))return {code:'source_cooldown',type:'source_unavailable',message:'所选来源因最近的上游错误暂时无法接收请求。网关会保留账号和模型配置；请稍后重试，持续失败时检查来源的实际调用错误。'};
 if(status>=500&&/^(qoder|workbuddy): (model response reported an error|upstream reported an error)/.test(message))return {code:'source_model_error',type:'provider_error',message:'来源服务在模型响应中返回错误，本次调用未完成。接口配置不代表调用成功；请缩短对话后重试或选择其他模型。'};
 const network=safeFailure(message);
 if(status>=500&&['tls','dns','timeout','connection_refused','connection_closed','proxy_auth','proxy'].includes(network.code))return {code:'upstream_'+network.code,type:'provider_error',message:`上游连接失败：${network.reason}。请检查系统代理、分流和 DNS；尚不能据此判断账号授权失效。`};
 return {type:'provider_error',message:`上游模型请求失败（HTTP ${status}）。请检查该来源的调用记录；重写客户端配置不一定能解决。`};
}
export async function readUpstreamError(response:Response){
 const reader=response.body?.getReader();if(!reader)return '';
 const chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>65536)return '';chunks.push(part.value);}return Buffer.concat(chunks).toString('utf8');}
 finally{await reader.cancel().catch(()=>{});}
}
