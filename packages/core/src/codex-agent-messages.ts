import {GatewayContextError} from './gateway-context.js';
type Item=Record<string,any>;
const object=(v:unknown):v is Item=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Only the explicit agent_message variant enters this gateway task decoder.
 * Official-bound traffic never uses this function. */
export function gatewayAgentMessage(item:Item):Item[]{
 if(item.type!=='agent_message')throw new Error('Expected an agent message');
  // V2's readable prefix is routing metadata, not a plaintext copy of the
  // encrypted task. Dropping its ciphertext silently turns a valid dispatch
  // into an empty task. Gateway models cannot consume this native payload.
  if(Array.isArray(item.content)&&item.content.some((p:Item)=>object(p)&&p.type==='encrypted_content'&&p.encrypted_content))throw new GatewayContextError('Codex 原生子代理消息包含加密任务，当前网关模型无法读取。请使用原生明文子代理协议或支持该加密消息的模型；任务内容未被丢弃。',422,undefined,'codex_encrypted_agent_message');
  const text=(Array.isArray(item.content)?item.content:[]).filter((p:Item)=>object(p)&&typeof p.text==='string').map((p:Item)=>p.text).join('\n');
  return text?[{type:'message',role:'developer',content:[{type:'input_text',text}]}]:[];
}
