/** Bounded structural evidence for compaction feedback loops. Never retains
 * prompts, tool definitions/arguments, output text, credentials or arbitrary keys. */
type Item=Record<string,unknown>;
export type ContextObservation={
 phase:'inference'|'summary';contextWindowTokens:number|null;
 requestBytes:number;instructionsBytes:number;inputBytes:number;historyBytes:number;toolsBytes:number;inputItems:number;historyItems:number;toolsCount:number;
 usage:Record<string,number|Record<string,number>>;
 terminal:{status:string;outputType:string;errorCode?:'invalid_terminal_response'|'incomplete_stream'|'invalid_stream_event'|'context_persistence_failed'};
};
const object=(value:unknown):value is Item=>!!value&&typeof value==='object'&&!Array.isArray(value);
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value??null));
export function contextObservation(phase:ContextObservation['phase'],request:Item,response:Item,contextWindowTokens?:number,errorCode?:ContextObservation['terminal']['errorCode']):ContextObservation{
 const input=Array.isArray(request.input)?request.input:[],history=input.filter(item=>!object(item)||!['developer','system'].includes(String(item.role)));
 const usage:ContextObservation['usage']={},raw=object(response.usage)?response.usage:{};
 const counters=['input_tokens','output_tokens','total_tokens','prompt_tokens','completion_tokens','cache_read_input_tokens','cache_creation_input_tokens','cache_write_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens'];
 const copy=(source:Item,keys:string[])=>Object.fromEntries(keys.filter(key=>Number.isSafeInteger(source[key])&&Number(source[key])>=0).map(key=>[key,source[key] as number]));
 Object.assign(usage,copy(raw,counters));
 for(const key of ['input_tokens_details','prompt_tokens_details','output_tokens_details','completion_tokens_details'])if(object(raw[key]))usage[key]=copy(raw[key],['cached_tokens','cache_write_tokens','reasoning_tokens']);
 return {phase,contextWindowTokens:contextWindowTokens??null,requestBytes:bytes(request),instructionsBytes:bytes({instructions:request.instructions,input:input.filter(item=>object(item)&&['developer','system'].includes(String(item.role)))}),inputBytes:bytes(input),historyBytes:bytes(history),toolsBytes:bytes(request.tools??[]),inputItems:input.length,historyItems:history.length,toolsCount:Array.isArray(request.tools)?request.tools.length:0,usage,
 terminal:{status:['completed','incomplete','failed','in_progress'].includes(String(response.status))?String(response.status):'invalid',outputType:Array.isArray(response.output)?'array':response.output===undefined?'missing':response.output===null?'null':typeof response.output,...(errorCode?{errorCode}:{})}};
}
