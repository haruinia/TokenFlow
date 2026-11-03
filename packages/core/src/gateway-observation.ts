import {upstreamError} from './upstream-errors.js';
/** Disjoint provider accounting normalized to inclusive input for the existing gateway budget. */
const n=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
export function providerUsage(raw:unknown){
 const u=(raw&&typeof raw==='object'?raw:{}) as Record<string,any>;
 const read=n(u.cache_read_input_tokens)??n(u.input_tokens_details?.cached_tokens)??n(u.prompt_tokens_details?.cached_tokens)??n(u.prompt_cache_hit_tokens);
 const write=n(u.cache_creation_input_tokens)??n(u.input_tokens_details?.cache_write_tokens)??n(u.prompt_tokens_details?.cache_write_tokens)??n(u.cache_write_tokens);
 const separateInput=n(u.input_tokens);let input=separateInput??n(u.prompt_tokens);
 // Chat Completions prompt_tokens already includes caches, even when a
 // compatible provider also returns Anthropic-style cache aliases.
 if(separateInput!==null&&('cache_read_input_tokens' in u||'cache_creation_input_tokens' in u))input=separateInput+(n(u.cache_read_input_tokens)??0)+(n(u.cache_creation_input_tokens)??0);
 if(input===null&&n(u.prompt_cache_miss_tokens)!==null&&read!==null)input=n(u.prompt_cache_miss_tokens)!+read+(write??0);
 const total=n(u.total_tokens);
 return {inputTokens:input,cachedTokens:read,cacheWriteTokens:write,outputTokens:n(u.output_tokens??u.completion_tokens),reasoningTokens:n(u.output_tokens_details?.reasoning_tokens)??n(u.completion_tokens_details?.reasoning_tokens),...(total===null?{}:{reportedTotalTokens:total})};
}
export type ObservedTool={id:string;name:string};
export type ResponseObservation={tools:ObservedTool[];error?:{code:string;message:string};toolsCount?:number;firstOutputAt?:number;generationMs?:number;responseId?:string};
/** Only tool identities/timing are retained; never assistant text, reasoning, or arguments. */
export class ResponseObserver{
 private error?:{code:string;message:string};
 private tools=new Map<string,ObservedTool>();private indices=new Map<string,string>();private first?:number;private responseId?:string;
 constructor(private now=()=>Date.now()){}
 inspect(e:any){
  if(e.type==='error'||e.type==='response.failed'||e.error){const safe=upstreamError(502,JSON.stringify({error:e.error??e.response?.error??(e.type==='error'?e:undefined)}));this.error={code:safe.code??safe.type,message:safe.message};}
  if(typeof e.response?.id==='string')this.responseId=e.response.id;
  if(e.type==='message_start'&&typeof e.message?.id==='string')this.responseId=e.message.id;
  if(e.type==='message'&&typeof e.id==='string')this.responseId=e.id;
  if(typeof e.id==='string'&&(e.object==='chat.completion'||e.object==='response'))this.responseId=e.id;
  const tool=(id:unknown,name:unknown,key?:string)=>{
   if(typeof id!=='string'&&key)id=this.indices.get(key);
   if(typeof id!=='string')return;
   if(key){const previous=this.indices.get(key);if(previous&&previous!==id)this.tools.delete(previous);this.indices.set(key,id);}
   const old=this.tools.get(id);if(typeof name==='string'&&name)this.tools.set(id,{id,name:(key?.startsWith('chat:')&&old&&name!==old.name?old.name+name:name).slice(0,128)});else if(old)this.tools.set(id,old);
  };
  const item=e.item;if(item?.type==='function_call')tool(item.call_id??item.id,item.name,typeof item.id==='string'?`response:${item.id}`:undefined);
  if(e.type==='content_block_start'&&e.content_block?.type==='tool_use')tool(e.content_block.id,e.content_block.name);
  for(const choice of e.choices??[]){
   const msg=choice.delta??choice.message;
   for(const t of msg?.tool_calls??[])tool(t.id,t.function?.name,`chat:${choice.index??0}:${t.index??0}`);
   if(msg?.function_call?.name)tool(`legacy:${choice.index??0}`,msg.function_call.name);
  }
  for(const output of e.response?.output??e.output??[])if(output.type==='function_call')tool(output.call_id??output.id,output.name,typeof output.id==='string'?`response:${output.id}`:undefined);
  for(const block of e.content??[])if(block.type==='tool_use')tool(block.id,block.name);
  const active=e.type==='response.output_text.delta'||e.type==='response.reasoning_text.delta'||e.type==='response.reasoning_summary_text.delta'||e.type==='response.function_call_arguments.delta'||e.type==='content_block_delta'||e.choices?.some((c:any)=>c.delta?.content||c.delta?.reasoning_content||c.delta?.reasoning||c.delta?.tool_calls?.length);
  if(active&&this.first===undefined)this.first=this.now();
 }
 result():ResponseObservation{return {...(this.error?{error:this.error}:{}),tools:[...this.tools.values()].slice(0,64),toolsCount:this.tools.size,...(this.first===undefined?{}:{firstOutputAt:this.first,generationMs:Math.max(0,this.now()-this.first)}),...(this.responseId?{responseId:this.responseId}:{})};}
}
