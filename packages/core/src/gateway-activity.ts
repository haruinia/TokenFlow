import type {ContextObservation,CompactionReport} from './gateway-context.js';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import {providerUsage,ResponseObserver,type ResponseObservation} from './gateway-observation.js';
import type { UsageLedger } from './usage-ledger.js';

export type GatewayCall={id:string;keyId:string;agent:string;model:string;protocol:string;startedAt:string;durationMs:number;status:number;inputTokens:number|null;outputTokens:number|null;
 /** Part of inputTokens served from the upstream prompt cache, when the upstream reports it. */
 cachedTokens?:number|null;cacheWriteTokens?:number|null;reasoningTokens?:number|null;toolCalls?:number;toolResults?:number;generationMs?:number;timedOutputTokens?:number;
 /** Agent id (codex, claude…), 'key' for exported Keys, 'internal' or 'workspace'. */
 target?:string;
 /** Account or API source that served the call. */
 sourceId?:string;
 compaction?:CompactionReport;context?:ContextObservation[];error?:{code:string;message:string}};
const number=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
// Responses completion events can echo the entire tool catalog. Keep observation
// bounded at the gateway's request-size budget, not the old 512 KiB text limit.
const OBSERVATION_LIMIT_BYTES=16*1024*1024;
/** Observe usage without changing payloads or retaining prompts / completions. */
export function observeUsage(sse:boolean,onEnd:(usage:{inputTokens:number|null;cachedTokens:number|null;outputTokens:number|null;failed:boolean;cacheWriteTokens?:number;reasoningTokens?:number})=>void|Promise<void>,onDetails?:(details:ResponseObservation)=>void) {
 const details=new ResponseObserver();let cacheWriteTokens:number|null=null,reasoningTokens:number|null=null;
 const decoder=new StringDecoder('utf8');let buffer='';let oversized=false;let inputTokens:number|null=null;let cachedTokens:number|null=null;let outputTokens:number|null=null;let failed=false;let terminal=false;let messages=false;let finalMessageUsage=false;let finishing:Promise<void>|undefined;
 const inspect=(raw:string)=>{if(raw==='[DONE]'){if(!messages)terminal=true;return;}try{
  const event=JSON.parse(raw);details.inspect(event);
  if(event.type==='message_start')messages=true;
  if(event.type==='message_delta'&&number(event.usage?.output_tokens)!==null)finalMessageUsage=true;
  if(event.type==='message_stop')terminal=finalMessageUsage;
  if(event.type==='response.completed'||event.type==='response.incomplete')terminal=true;
  const usage=event.usage??event.response?.usage??event.message?.usage;
  if(event.type==='error'||event.type==='response.failed'||event.error)failed=true;
  if(usage){const normalized=providerUsage(messages&&usage.input_tokens!==undefined&&(cachedTokens!==null||cacheWriteTokens!==null)?{...usage,cache_read_input_tokens:usage.cache_read_input_tokens??cachedTokens??0,cache_creation_input_tokens:usage.cache_creation_input_tokens??cacheWriteTokens??0}:usage);if(normalized.cachedTokens!==null)cachedTokens=normalized.cachedTokens;if(normalized.cacheWriteTokens!==null)cacheWriteTokens=normalized.cacheWriteTokens;if(normalized.reasoningTokens!==null)reasoningTokens=normalized.reasoningTokens;
   inputTokens=normalized.inputTokens??inputTokens;outputTokens=normalized.outputTokens??outputTokens;}

 }catch{/* Some SSE frames are control messages, not JSON. */}};
 let bufferedBytes=0;
 const append=(text:string)=>{
  if(oversized)return;
  bufferedBytes+=Buffer.byteLength(text);
  if(bufferedBytes>OBSERVATION_LIMIT_BYTES){buffer='';bufferedBytes=0;oversized=true;}
  else buffer+=text;
 };
 const consume=(text:string)=>{
  if(!sse){append(text);return;}
  for(const part of text.split(/(?<=\n)/)) {
   append(part);
   if(part.endsWith('\n')){if(!oversized&&buffer.startsWith('data:'))inspect(buffer.slice(5).trim());buffer='';bufferedBytes=0;oversized=false;}
  }
 };
 const finish=()=>{
  if(finishing)return finishing;
  consume(decoder.end());if(buffer&&!oversized)inspect(sse?buffer.replace(/^data:\s*/,''):buffer);buffer='';
  finishing=Promise.resolve().then(()=>{onDetails?.(details.result());return onEnd({inputTokens,cachedTokens,outputTokens,failed:failed||(sse&&!terminal),...(cacheWriteTokens===null?{}:{cacheWriteTokens}),...(reasoningTokens===null?{}:{reasoningTokens})});});return finishing;
 };
 const stream=new Transform({transform(chunk,_encoding,callback){consume(decoder.write(chunk));callback(null,chunk);},flush(callback){void finish().then(()=>callback(),error=>callback(error));}});
 stream.once('close',()=>{void finish().catch(()=>undefined);});return stream;
}
export type GatewayUsage={keyId:string;model:string;requests:number;failed:number;inputTokens:number;cachedTokens:number;outputTokens:number;last:string};
export class GatewayActivity {
 private recent:GatewayCall[]=[];
 private usage=new Map<string,GatewayUsage>();
 private total=0;private failed=0;private measured=0;private input=0;private cached=0;private output=0;
 readonly since=new Date().toISOString();
 /** The ledger keeps day-by-day totals across restarts; this class only holds the current run. */
 constructor(private ledger?:UsageLedger){}
 record(call:Omit<GatewayCall,'id'>){
  const cachedTokens=call.cachedTokens===undefined?null:call.cachedTokens;
  this.total++;if(call.status>=400)this.failed++;
  if(call.inputTokens!==null||call.outputTokens!==null)this.measured++;
  this.input+=call.inputTokens??0;this.cached+=cachedTokens??0;this.output+=call.outputTokens??0;
  this.recent.unshift({...call,cachedTokens,id:randomUUID()});this.recent=this.recent.slice(0,100);
  const id=`${call.keyId}\n${call.model}`;const row=this.usage.get(id)??{keyId:call.keyId,model:call.model,requests:0,failed:0,inputTokens:0,cachedTokens:0,outputTokens:0,last:call.startedAt};
  row.requests++;if(call.status>=400)row.failed++;row.inputTokens+=call.inputTokens??0;row.cachedTokens+=cachedTokens??0;row.outputTokens+=call.outputTokens??0;if(call.startedAt>row.last)row.last=call.startedAt;
  this.usage.set(id,row);
  // Preflight token counting is not a generation, so it stays out of the statistics.
  if(call.protocol!=='messages/count_tokens')this.ledger?.add({target:call.target??'key',keyId:call.keyId,keyName:call.agent,sourceId:call.sourceId??'',model:call.model,startedAt:call.startedAt,durationMs:call.durationMs,status:call.status,inputTokens:call.inputTokens,cachedTokens,outputTokens:call.outputTokens,cacheWriteTokens:call.cacheWriteTokens,reasoningTokens:call.reasoningTokens,toolCalls:call.toolCalls,toolResults:call.toolResults,generationMs:call.generationMs,timedOutputTokens:call.timedOutputTokens});
 }
 snapshot(){return {since:this.since,total:this.total,failed:this.failed,measured:this.measured,inputTokens:this.input,cachedTokens:this.cached,outputTokens:this.output,recent:structuredClone(this.recent),usage:[...this.usage.values()].map(row=>({...row}))};}
}
export type GatewayActivitySnapshot=ReturnType<GatewayActivity['snapshot']>;
