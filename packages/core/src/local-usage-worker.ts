import {parentPort,workerData} from 'node:worker_threads';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {lstat,readdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
import {z} from 'zod';
import {LocalUsageParser,mergeLocalUsageRows,recentLocalUsageRows,type LocalUsageRow,type UsageCoverage} from './local-usage.js';
import {enrichAccountRows,readAccountEvidence,type AttributionRecord} from './usage-attribution.js';
import {enrichNativeLoginRows,readNativeLoginIntervals,type NativeLoginInterval} from './native-usage-logins.js';
import {claudeDesktopViaGateway,codexRouteEvidence,gatewayResponseEvidence,routeChannel,type RouteEvidence} from './local-usage-evidence.js';
import {readAntigravityUsage} from './antigravity-usage.js';
import {readZcodeUsage} from './zcode-usage.js';
import {safePath} from './agent-connections.js';
import {readCursorConversations,type CursorConversation} from './cursor-conversations.js';

type Entry={stamp:string;target:string;rows:LocalUsageRow[];cursorConversations?:CursorConversation[]};
const cache=new Map<string,Entry>();
const path=join(workerData.root,'local-usage-index.json');
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cursorConversations=z.array(z.object({hash:z.string().regex(/^[a-f0-9]{64}$/),createdAt:count})).max(10000);
const cachedRow=z.object({day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),target:z.enum(['codex','claude','claude-desktop','pi','deepseek','workbuddy','workbuddy-ai','qoder','antigravity','zcode']),keyId:z.string().max(100),keyName:z.string().max(100),sourceId:z.literal(''),model:z.string().max(300),requests:count,failed:count,unmeasured:count,inputTokens:count,cachedTokens:count,cacheBaseTokens:count,outputTokens:count,durationMs:count,last:z.string().max(60),origin:z.literal('native'),channel:z.enum(['official','api','unknown']),provider:z.string().max(80),nativeModelUnconfirmed:z.boolean().optional(),nativeAccountEvidence:z.enum(['otel','conflict','login-snapshot']).optional(),nativeOrganizationId:z.string().regex(/^[a-f0-9]{64}$/).optional(),nativeEmailHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),nativeThreadId:z.string().regex(/^[a-f0-9]{64}$/).optional(),nativeAccountId:z.string().regex(/^[a-f0-9]{64}$/).optional(),sampleId:z.string().regex(/^[a-f0-9]{64}$/).optional(),responseHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),cacheWriteTokens:count.optional(),reasoningTokens:count.optional()});
let accountEvidence:AttributionRecord[]=await readAccountEvidence(workerData.root);
let loginIntervals:NativeLoginInterval[]=await readNativeLoginIntervals(workerData.root);
let busy=false;let gatewayEvidence=await gatewayResponseEvidence(workerData.root);let routesByThread=new Map<string,RouteEvidence[]>();let claudeDesktopGateway=false;
async function fileStamp(path:string){const s=await lstat(path);const wal=/\.(?:db|vscdb|sqlite)$/.test(path)?await lstat(path+'-wal').catch(()=>undefined):undefined;return {path,stamp:`${s.mtimeMs}:${s.size}:${wal?.mtimeMs??0}:${wal?.size??0}`,size:s.size};}
async function files(root:string,sqlite=false):Promise<{path:string;stamp:string;size:number}[]>{
 const result:{path:string;stamp:string;size:number}[]=[];
 const visit=async(dir:string,depth:number)=>{if(depth>12||result.length>=5000)return;let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}for(const e of entries){if(e.isSymbolicLink())continue;const p=join(dir,e.name);if(e.isDirectory())await visit(p,depth+1);else if(e.isFile()&&(sqlite?/\.(?:db|pb)$/:/\.(?:jsonl|ndjson|jsonl\.zstd)$/).test(e.name)){const s=await fileStamp(p).catch(()=>undefined);if(s)result.push(s);}}};
 if(sqlite)await safePath(root);
 await visit(root,0);return result.sort((a,b)=>Number(b.stamp.split(':')[0])-Number(a.stamp.split(':')[0]));
}
/** Each DSH log is a sequence of independent Zstandard frames; ignore a torn final append. */
export function* zstdFrames(buffer:Buffer){
 let offset=0;while(offset+5<=buffer.length){const start=offset;if(buffer.readUInt32LE(offset)!==0xfd2fb528)throw Error('Invalid Zstandard frame');offset+=4;const flags=buffer[offset++];if(flags&24)throw Error('Invalid frame flags');const single=!!(flags&32),dict=flags&3,size=flags>>>6;offset+=(single?0:1)+(dict===3?4:dict)+(size?2**size:single?1:0);let complete=false;
  while(offset+3<=buffer.length){const header=buffer.readUIntLE(offset,3);offset+=3;const kind=(header>>>1)&3;if(kind===3)throw Error('Invalid compressed block');offset+=kind===1?1:header>>>3;if(offset>buffer.length)return;if(header&1){complete=true;break;}}
  if(!complete)return;if(flags&4)offset+=4;if(offset>buffer.length)return;yield zstdDecompressSync(buffer.subarray(start,offset),{maxOutputLength:32*1024*1024});
 }
}
async function parseFile(target:string,file:{path:string;size:number}){
 if(target==='antigravity')return readAntigravityUsage(file.path,id=>gatewayEvidence.matches(id));
 if(target==='zcode')return readZcodeUsage(file.path);
 const parser=new LocalUsageParser(target,digest(file.path),{matchesResponse:gatewayEvidence.matches,channelFor:(thread,time)=>routeChannel(routesByThread.get(thread)??[],thread,time),claudeDesktopGateway});if(file.size>256*1024*1024)throw Error('Large local log');
 const accept=(line:string)=>{if(line.length>8*1024*1024)return;try{parser.accept(JSON.parse(line));}catch{/* Partial append or a non-usage line. */}};
 if(file.path.endsWith('.zstd')){if(file.size>32*1024*1024)throw Error('Large compressed log');for(const b of zstdFrames(await readFile(file.path)))for(const line of b.toString('utf8').split('\n'))accept(line);}
 else{const input=createReadStream(file.path);const lines=createInterface({input,crlfDelay:Infinity});try{for await(const line of lines)accept(line);}finally{lines.close();input.destroy();}}
 return parser.rows();
}
function publish(coverage:UsageCoverage[],scanning:boolean){for(const entry of cache.values())entry.rows=enrichAccountRows(enrichNativeLoginRows(entry.rows,loginIntervals),accountEvidence);const rows=[...cache.values()].flatMap(e=>e.rows);parentPort?.postMessage({rows:mergeLocalUsageRows(rows),recent:recentLocalUsageRows(rows),cursorConversations:[...cache.values()].flatMap(e=>e.cursorConversations??[]),coverage,scanning,updatedAt:new Date().toISOString()});}
async function scan(){
 if(busy)return;busy=true;const coverage:UsageCoverage[]=[];const seen=new Set<string>();
 try{
  accountEvidence=await readAccountEvidence(workerData.root);loginIntervals=await readNativeLoginIntervals(workerData.root);gatewayEvidence=await gatewayResponseEvidence(workerData.root);routesByThread=new Map();
  const desktopGateway=workerData.claudeDesktop?await claudeDesktopViaGateway(workerData.claudeDesktop,workerData.gatewayPorts??[]):false;
  if(desktopGateway!==claudeDesktopGateway){claudeDesktopGateway=desktopGateway;for(const[id,entry]of cache)if(entry.target==='claude')cache.delete(id);}
  const codexRoots=workerData.sources.codex as string[];for(const route of await codexRouteEvidence(dirname(codexRoots[0]),workerData.gatewayPorts??[])){const list=routesByThread.get(route.threadId)??[];list.push(route);routesByThread.set(route.threadId,list);}
  for(const entry of cache.values())entry.rows=entry.rows.filter(row=>!row.responseHash||!gatewayEvidence.hashes.has(row.responseHash));
  for(const[target,roots]of Object.entries(workerData.sources as Record<string,string[]>)){
   const found=(await Promise.all(roots.map(root=>(target==='cursor'||target==='zcode'?fileStamp(root).then(f=>[f]):files(root,target==='antigravity')).catch(()=>[])))).flat();const status:UsageCoverage={target,files:found.length,indexed:0,skipped:0,status:found.length?'scanning':'unavailable',...(found.length?{}:{note:'未找到可读取的本机用量记录。'})};coverage.push(status);
   let changed=0;for(const f of found){const id=digest(f.path);seen.add(id);const old=cache.get(id);if(old?.stamp===f.stamp){status.indexed++;continue;}
    if(target==='cursor'){try{const conversations=await readCursorConversations(f.path),after=await fileStamp(f.path);cache.set(id,{stamp:after.stamp===f.stamp?f.stamp:'changed-during-scan',target,rows:[],cursorConversations:conversations});status.indexed++;}catch{status.skipped++;}continue;}
    try{let rows=await parseFile(target,f);const proofs=new Map((old?.rows??[]).filter(row=>!!row.nativeAccountEvidence).map(row=>[row.sampleId,row]));rows=rows.map(row=>{const previous=proofs.get(row.sampleId);return previous&&!row.nativeAccountId&&row.channel!=='api'&&row.inputTokens===previous.inputTokens&&row.outputTokens===previous.outputTokens&&row.cachedTokens===previous.cachedTokens&&(row.cacheWriteTokens??0)===(previous.cacheWriteTokens??0)?{...row,...(row.nativeModelUnconfirmed&&!previous.nativeModelUnconfirmed?{model:previous.model,nativeModelUnconfirmed:undefined}:{}),channel:previous.channel,keyName:previous.keyName,nativeAccountId:previous.nativeAccountId,nativeEmailHash:previous.nativeEmailHash,nativeOrganizationId:previous.nativeOrganizationId,nativeAccountEvidence:previous.nativeAccountEvidence}:row;});const after=await fileStamp(f.path);cache.set(id,{stamp:after.stamp===f.stamp?f.stamp:'changed-during-scan',target,rows});status.indexed++;}catch{status.skipped++;}
    if(++changed%10===0)publish(coverage,true);
   }if(found.length){status.status=status.indexed?'ready':'unavailable';if(status.skipped)status.note='部分记录格式不支持或暂时不可读，未估算其 Token。';}publish(coverage,true);
  }
  for(const id of cache.keys())if(!seen.has(id))cache.delete(id);
  const unsupported:Record<string,string>={
   kimi:'本机未发现 Kimi Code 会话记录，暂无可核对的逐请求 Token 格式；账号授权和官方额度不等于直连用量。',
   trae:'Trae 本机对话库已加密，且官方按请求次数计费，没有可读取的逐请求 Token。',
   cursor:'尚未接入可核对的客户端逐请求 Token 记录；账号授权和官方额度不等于直连用量。',
   xai:'Grok 本机只保存登录与后台状态，对话用量在服务端，没有可读取的逐请求 Token。',
  };
  for(const[target,note]of Object.entries(unsupported))if(!coverage.some(c=>c.target===target))coverage.push({target,files:0,indexed:0,skipped:0,status:'unsupported',note});
  const tmp=`${path}.tmp`;await writeFile(tmp,JSON.stringify({version:15,claudeDesktopGateway,files:Object.fromEntries(cache)}),{mode:0o600});await rename(tmp,path);publish(coverage,false);
 }catch{parentPort?.postMessage({rows:mergeLocalUsageRows([...cache.values()].flatMap(e=>e.rows)),recent:recentLocalUsageRows([...cache.values()].flatMap(e=>e.rows)),coverage,scanning:false,warning:'部分本机用量暂时无法读取，已保留上次统计。'});}
 finally{busy=false;}
}
try{const stat=await lstat(path);if(stat.size<=64*1024*1024){const saved=JSON.parse(await readFile(path,'utf8'));if([7,8,9,10,11,12,13,14,15].includes(saved.version)){claudeDesktopGateway=saved.claudeDesktopGateway===true;for(const[id,e]of Object.entries(saved.files??{})){const v=e as Entry;if(saved.version<13&&v.target==='codex'||saved.version<14&&v.target==='claude'||saved.version<15&&(v.target==='deepseek'||v.target==='qoder'))continue;const parsed=z.array(cachedRow).safeParse(v.rows);if(parsed.success&&typeof v.stamp==='string'&&typeof v.target==='string'&&/^[a-f0-9]{64}$/.test(id)){const conversations=cursorConversations.safeParse(v.cursorConversations);if(v.target==='cursor'&&!conversations.success)continue;cache.set(id,{stamp:v.stamp,target:v.target,rows:parsed.data,...(v.target==='cursor'&&conversations.success?{cursorConversations:conversations.data}:{})});}}}}}catch{/* First scan rebuilds missing metadata. */}
publish([],true);parentPort?.on('message',()=>void scan());void scan();
