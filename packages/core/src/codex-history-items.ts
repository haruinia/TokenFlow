import {GatewayContextError} from './gateway-context.js';
import {gatewayAgentMessage} from './codex-agent-messages.js';
import {isGatewayCodexItem} from './codex-item-provenance.js';
type Item=Record<string,any>;
const object=(v:unknown):v is Item=>!!v&&typeof v==='object'&&!Array.isArray(v);
const failure=()=>new GatewayContextError('无法恢复这段压缩上下文。请在保留原始会话记录的本机继续，或提供可读交接摘要；原会话未被清空。');
/** Readable history for a gateway that cannot consume native opaque state. */
export function portableCodexItem(item:Item):Item[]{
 if(!object(item))throw failure();
 // Responses Lite declarations describe the tools available in that old turn,
 // not a conversation message. The current request supplies its own tools.
 if(item.type==='additional_tools'||(item.type==='message'&&item.role==='developer'&&Array.isArray(item.tools)&&item.content===undefined))return [];
 if(item.type==='compaction'||item.type==='item_reference')throw failure();
 // Codex's ResponseItem protocol also uses FunctionCallOutput for standalone
 // notifications (call_id is optional), including cross-chat deliveries. The
 // gateway Responses protocol requires paired tool outputs. Translate this
 // distinct event kind at the Codex boundary, before inference or compaction;
 // never fabricate a call or relax validation of an actual call_id.
 if(item.type==='function_call_output'&&item.call_id==null){
  const source=[item.namespace,item.name].filter(value=>typeof value==='string'&&value).join('.');
  const heading={type:'input_text',text:`External tool notification${source?' from '+source:''}:`};
  const content=typeof item.output==='string'?[{type:'input_text',text:item.output}]:Array.isArray(item.output)?item.output.map((part:Item)=>{
   if(object(part)&&['text','input_text','output_text'].includes(part.type)&&typeof part.text==='string')return {type:'input_text',text:part.text};
   if(object(part)&&part.type==='input_image')return structuredClone(part);
   throw failure();
  }):undefined;
  if(!content)throw failure();
  return [{type:'message',role:'user',content:[heading,...content]}];
 }
 if(item.type==='reasoning'){
  const text=(Array.isArray(item.summary)?item.summary:[]).filter((p:Item)=>object(p)&&typeof p.text==='string').map((p:Item)=>p.text).join('\n');
  return text?[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]:[];
 }
 if(item.type==='agent_message')return gatewayAgentMessage(item);
 const value=structuredClone(item);delete value.id;delete value.encrypted_content;
 if(typeof value.role==='string'){
  value.type='message';
  if(typeof value.content==='string')value.content=[{type:value.role==='assistant'?'output_text':'input_text',text:value.content}];
  else if(Array.isArray(value.content))value.content=value.content.filter((p:Item)=>!object(p)||p.type!=='encrypted_content');
 }
 return [value];
}

/** Official input has a separate policy: native encrypted agent tasks,
 * reasoning and compaction are supported here, not gateway decode failures. */
export function officialCodexItem(item:Item,restoredGatewayWindow=false):Item[]{
 const foreign=isGatewayCodexItem(item);
 if(!foreign&&['agent_message','compaction'].includes(item.type))return [item];
 const unsignedReasoning=item.type==='reasoning'&&(!item.encrypted_content||/^rs_chatcmpl[-_]/.test(String(item.id)));
 if(!foreign&&item.type==='reasoning'&&!unsignedReasoning)return [item];
 return foreign||unsignedReasoning||restoredGatewayWindow?portableCodexItem(item):[item];
}
