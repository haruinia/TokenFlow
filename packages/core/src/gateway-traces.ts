import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHmac,createHash} from 'node:crypto';
import {z} from 'zod';
import type {GatewayCall} from './gateway-activity.js';
import type {ResponseObservation} from './gateway-observation.js';
import {appendGatewayResponseHashes,appendGatewayResponseRefs,type LegacyResponseRef} from './gateway-response-evidence.js';
const counter=z.number().nonnegative();
const toolSchema=z.object({id:z.string().max(64),name:z.string().max(128),status:z.enum(['pending','returned','error']),result:z.string().max(16384).optional(),truncated:z.boolean().optional(),returnedAt:z.string().optional()});
const contextSchema=z.object({phase:z.enum(['inference','summary']),contextWindowTokens:counter.nullable(),requestBytes:counter,instructionsBytes:counter,inputBytes:counter,historyBytes:counter,toolsBytes:counter,inputItems:counter,historyItems:counter,toolsCount:counter,usage:z.record(z.union([counter,z.record(counter)])),terminal:z.object({status:z.string().max(20),outputType:z.string().max(20),errorCode:z.enum(['invalid_terminal_response','incomplete_stream']).optional()})});
const traceSchema=z.object({id:z.string().uuid(),runId:z.string().uuid(),keyId:z.string().max(80),agent:z.string().max(160),target:z.string().max(80),sourceId:z.string().max(80),model:z.string().max(300),protocol:z.string().max(80),context:z.array(contextSchema).max(128).optional(),compaction:z.object({inputBytes:counter,outputBytes:counter,calls:counter,reused:counter,durationMs:counter,inputTokens:counter.nullable(),outputTokens:counter.nullable(),cachedTokens:counter.nullable(),cacheWriteTokens:counter.nullable().default(null),reasoningTokens:counter.nullable(),failed:z.boolean(),unmetered:z.boolean().default(false),cacheWriteFailed:z.boolean().optional()}).optional(),startedAt:z.string(),durationMs:counter,status:counter,error:z.object({code:z.string().max(128),message:z.string().max(1024)}).optional(),inputTokens:counter.nullable(),cachedTokens:counter.nullable(),cacheWriteTokens:counter.nullable(),outputTokens:counter.nullable(),reasoningTokens:counter.nullable(),firstOutputMs:counter.optional(),generationMs:counter.optional(),responseRef:z.string().optional(),responseHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),inputs:z.object({system:counter,user:counter,assistant:counter,tool:counter}),toolCallCount:counter.optional(),toolResultCount:counter.optional(),tools:z.array(toolSchema).max(64),results:z.array(toolSchema).max(64)});
export type GatewayTrace=z.infer<typeof traceSchema>;
export type TraceSummary=Omit<GatewayTrace,'tools'|'results'> & {toolCalls:number;toolResults:number;toolNames:string[]};
type RawResult={id:string;name:string;result:string;error:boolean;truncated:boolean};
export type RequestTrace={inputs:GatewayTrace['inputs'];results:RawResult[];previousResponse?:string};
const secretNames=/^(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|token|secret|client[_-]?secret)$/i;
export function redactTraceText(s:string){return s.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [已隐藏]').replace(/\b(?:sk-|tfl_)[A-Za-z0-9_-]{12,}/g,'[密钥已隐藏]').replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|token|secret|client[_-]?secret)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s"',;}]+)/gi,'$1[已隐藏]');}
function resultText(value:unknown){
 // Attachments and binary payloads are summarized, never copied into trace storage.
 const clean=(v:unknown,depth=0):unknown=>{
  if(depth>8)return '[结构过深，已省略]';
  if(typeof v==='string')return redactTraceText(v).slice(0,16384);
  if(Array.isArray(v))return v.slice(0,64).map(item=>clean(item,depth+1));
  if(v&&typeof v==='object'){
   const data=v as Record<string,unknown>;
   if(['image','image_url','input_image','file','input_file'].includes(String(data.type)))return {type:data.type,note:'附件内容未保存'};
   return Object.fromEntries(Object.entries(data).slice(0,64).map(([k,item])=>[k,secretNames.test(k)?'[已隐藏]':clean(item,depth+1)]));
  }
  return v;
 };
 const output=typeof value==='string'?redactTraceText(value):JSON.stringify(clean(value))??'';
 return {result:output.slice(0,16384),truncated:output.length>16384};
}
/** Capture tool results after the latest human message; never save user/assistant message bodies. */
export function requestTrace(raw:unknown):RequestTrace{
 const body=(raw&&typeof raw==='object'?raw:{}) as Record<string,any>;const items=Array.isArray(body.messages)?body.messages:Array.isArray(body.input)?body.input:[];
 const names=new Map<string,string>();
 const inputs={system:typeof body.system==='string'||Array.isArray(body.system)?1:0,user:0,assistant:0,tool:0};
 let results:RawResult[]=[];
 const add=(id:unknown,name:unknown,content:unknown,error:unknown)=>{if(typeof id!=='string'||id.length>512)return;const text=resultText(content);results.push({id,name:typeof name==='string'&&name?name.slice(0,128):names.get(id)??'',...text,error:error===true});inputs.tool++;};
 for(const item of items){
  if(!item||typeof item!=='object')continue;
  if(item.type==='function_call'&&typeof item.call_id==='string'&&typeof item.name==='string')names.set(item.call_id,item.name.slice(0,128));
  if(item.type==='function_call_output'){add(item.call_id,'',item.output,item.is_error);continue;}
  if(item.role==='tool'||item.role==='function'){add(item.tool_call_id??item.name,item.name,item.content,item.is_error);continue;}
  if(item.role==='system'||item.role==='developer'){inputs.system++;continue;}
  if(item.role==='assistant'){inputs.assistant++;for(const t of item.tool_calls??[])if(typeof t.id==='string'&&typeof t.function?.name==='string')names.set(t.id,t.function.name.slice(0,128));for(const c of Array.isArray(item.content)?item.content:[])if(c.type==='tool_use'&&typeof c.id==='string'&&typeof c.name==='string')names.set(c.id,c.name.slice(0,128));continue;}
  if(item.role==='user'){
   const content=Array.isArray(item.content)?item.content:[];
   if(!content.length||content.some((c:any)=>c?.type!=='tool_result')){inputs.user++;results=[];}
   for(const c of content)if(c?.type==='tool_result')add(c.tool_use_id,'',c.content,c.is_error);
  }
 }
 return {inputs,results:results.slice(-4096),...(typeof body.previous_response_id==='string'?{previousResponse:body.previous_response_id.slice(0,512)}:{})};
}
const fileSchema=z.object({version:z.literal(1),salt:z.string().length(64),seenResults:z.array(z.string().length(64)).max(10000).optional(),records:z.array(traceSchema).max(1000)});
export class GatewayTraces{
 private records:GatewayTrace[]=[];private seenResults=new Set<string>();private pendingResponseHashes=new Set<string>();private pendingResponseRefs:LegacyResponseRef[]=[];private salt=randomBytes(32).toString('hex');private dirty=false;private timer?:NodeJS.Timeout;private writing=Promise.resolve();warning='';
 private path:string;
 private constructor(private root:string){this.path=join(root,'gateway-traces.json');}
 static async open(root:string){const store=new GatewayTraces(root);try{const file=await readFile(store.path,'utf8');if(Buffer.byteLength(file)>32*1024*1024)throw Error('oversize');const data=fileSchema.parse(JSON.parse(file));store.salt=data.salt;store.records=data.records;store.seenResults=new Set(data.seenResults??data.records.flatMap(r=>r.results.map(t=>t.id)));for(const row of data.records){if(row.responseHash)store.pendingResponseHashes.add(row.responseHash);else if(row.responseRef)store.pendingResponseRefs.push({salt:data.salt,keyId:row.keyId,responseRef:row.responseRef});}store.prune();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT'){await rename(store.path,`${store.path}.unreadable-${Date.now()}`).catch(()=>{});store.warning='轨迹文件无法读取，原文件已保留，开始记录新轨迹。';}}if(store.pendingResponseHashes.size||store.pendingResponseRefs.length){store.dirty=true;await store.flush();}return store;}
 private ref(key:string,id:string){return createHmac('sha256',this.salt).update(`${key}\n${id}`).digest('hex');}
 record(call:Omit<GatewayCall,'id'>,request:RequestTrace,response:ResponseObservation={tools:[]}){
  const id=randomUUID(),byTool=new Map<string,{record:GatewayTrace;tool:GatewayTrace['tools'][number]}>();for(const record of this.records)for(const tool of record.tools)if(!byTool.has(tool.id))byTool.set(tool.id,{record,tool});
  const parent=request.results.map(r=>byTool.get(this.ref(call.keyId,r.id))?.record).filter(Boolean).at(-1)??(request.inputs.user===0&&request.previousResponse?this.records.find(r=>r.keyId===call.keyId&&r.responseRef===this.ref(call.keyId,request.previousResponse!)):undefined);
  const item:GatewayTrace={id,runId:parent?.runId??id,keyId:call.keyId,agent:call.agent,target:call.target??'key',sourceId:call.sourceId??'',model:call.model,protocol:call.protocol,startedAt:call.startedAt,durationMs:call.durationMs,status:call.status,...(call.compaction?{compaction:structuredClone(call.compaction)}:{}),...(call.context?.length?{context:call.context.slice(-128).map(row=>contextSchema.parse(row))}:{}),...(call.error?{error:{code:redactTraceText(call.error.code).slice(0,128),message:redactTraceText(call.error.message).slice(0,1024)}}:{}),inputTokens:call.inputTokens,cachedTokens:call.cachedTokens??null,cacheWriteTokens:call.cacheWriteTokens??null,outputTokens:call.outputTokens,reasoningTokens:call.reasoningTokens??null,inputs:request.inputs,tools:[],results:[],...(response.responseId?{responseRef:this.ref(call.keyId,response.responseId),responseHash:createHash('sha256').update(`response:${response.responseId}`).digest('hex')}:{}),...(response.firstOutputAt===undefined?{}:{firstOutputMs:Math.min(call.durationMs,Math.max(0,response.firstOutputAt-Date.parse(call.startedAt))),generationMs:response.generationMs})};
  const returned=this.seenResults;let newResults=0;
  for(const result of request.results){const ref=this.ref(call.keyId,result.id);const old=byTool.get(ref);if(old?old.tool.status!=='pending':returned.has(ref))continue;returned.add(ref);newResults++;
   const tool:z.infer<typeof toolSchema>={id:ref,name:old?.tool.name??result.name??'',status:result.error?'error':'returned',result:result.result,truncated:result.truncated,returnedAt:call.startedAt};
   if(item.results.length<64)item.results.push(tool);if(old)Object.assign(old.tool,tool);
  }
  const unique=new Set<string>();for(const tool of response.tools){const ref=this.ref(call.keyId,tool.id);if(unique.has(ref))continue;unique.add(ref);item.tools.push({id:ref,name:tool.name,status:'pending'});}
  item.toolCallCount=response.toolsCount??item.tools.length;item.toolResultCount=newResults;while(this.seenResults.size>10000)this.seenResults.delete(this.seenResults.values().next().value!);
  if(item.responseHash)this.pendingResponseHashes.add(item.responseHash);
  this.records.unshift(item);this.prune();this.dirty=true;if(!this.timer){this.timer=setTimeout(()=>{this.timer=undefined;void this.flush();},1500);this.timer.unref?.();}
  return {toolCalls:item.toolCallCount,toolResults:newResults};
 }
 private prune(){const cutoff=Date.now()-30*86400_000;this.records=this.records.filter(r=>Date.parse(r.startedAt)>=cutoff).slice(0,1000);let bytes=0;this.records=this.records.filter(r=>{bytes+=Buffer.byteLength(JSON.stringify(r));return bytes<=16*1024*1024;});}
 list(filter:{target?:string;sourceId?:string;keyId?:string;kind?:'api';days?:number;limit?:number}={}):TraceSummary[]{const date=new Date();date.setHours(0,0,0,0);date.setDate(date.getDate()-((filter.days??0)-1));const cutoff=filter.days?date.getTime():0;
  return this.records.filter(r=>(!filter.kind||/^api-[a-f0-9]{24}\//.test(r.model))&&(!filter.target||r.target===filter.target)&&(!filter.sourceId||r.sourceId===filter.sourceId)&&(!filter.keyId||r.keyId===filter.keyId)&&Date.parse(r.startedAt)>=cutoff).slice(0,filter.limit??100).map(({tools,results,...record})=>({...record,toolCalls:record.toolCallCount??tools.length,toolResults:record.toolResultCount??results.length,toolNames:[...new Set([...tools,...results].map(t=>t.name).filter(Boolean))]}));}
 get(id:string){const record=this.records.find(r=>r.id===id);return record?structuredClone(record):undefined;}
 async flush(){if(this.timer){clearTimeout(this.timer);this.timer=undefined;}this.writing=this.writing.then(async()=>{if(!this.dirty)return;this.dirty=false;try{const hashes=[...this.pendingResponseHashes];await appendGatewayResponseHashes(this.root,hashes);await appendGatewayResponseRefs(this.root,this.pendingResponseRefs);this.pendingResponseRefs=[];for(const hash of hashes)this.pendingResponseHashes.delete(hash);await writeFile(`${this.path}.tmp`,JSON.stringify({version:1,salt:this.salt,seenResults:[...this.seenResults],records:this.records}),{mode:0o600});await rename(`${this.path}.tmp`,this.path);this.warning='';}catch{this.dirty=true;this.warning='轨迹暂未写入磁盘，请检查资料目录权限。';}});return this.writing;}
 async clear(){this.records=[];this.dirty=true;await this.flush();}
 close(){return this.flush();}
}
