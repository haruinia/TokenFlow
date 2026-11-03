import {RunnerCoreError} from './errors.js';
type Version='v1'|'v2'|'disabled'|null;
export type AgentProtocolBaseline={version:1;fallback:Version;records:{key:string;value:Version;observed?:Version}[]};
const fail=(reason:string)=>new RunnerCoreError(`${reason}，子代理协议迁移已停止；原记录和备份保留。`,{statusCode:409,code:'codex_agent_protocol_conflict'});
const version=(value:unknown):Version=>{if(value===undefined||value===null)return null;if(value==='v1'||value==='v2'||value==='disabled')return value;throw fail('旧会话包含尚不支持的子代理协议版本');};
function records(text:string){
 let malformed=false;const found=text.split('\n').flatMap((line,index)=>{
  if(!line.trim())return [];
  let row:any;try{row=JSON.parse(line);}catch{malformed=true;return [];}
  if(!['session_meta','turn_context'].includes(row?.type)||!row.payload||typeof row.payload!=='object')return [];
  const key=row.type==='session_meta'?'session':typeof row.payload.turn_id==='string'?`turn:${row.payload.turn_id}`:Number.isSafeInteger(row.ordinal)?`ordinal:${row.ordinal}`:`line:${index}`;
  return [{line,index,row,key,value:version(row.payload.multi_agent_version)}];
 });
 if(found.length&&malformed)throw fail('旧会话记录不完整或格式无效');return found;
}
/** Only protocol control metadata is owned here. Never decode, prune, normalize,
 * or re-label encrypted tasks, ordinary messages, tool results or compaction. */
export function captureAgentProtocol(text:string,gatewayBorn=false):AgentProtocolBaseline{
 const saved=records(text);
 return {version:1,fallback:gatewayBorn?null:saved.at(-1)?.value??null,records:saved.map(r=>({key:r.key,value:gatewayBorn?null:r.value,...(gatewayBorn?{observed:r.value}:{})}))};
}
export function rewriteAgentProtocol(text:string,baseline:AgentProtocolBaseline,target:'gateway'|'native'){
 if(baseline.version!==1||!Array.isArray(baseline.records))throw fail('旧会话的协议备份格式无效');
 const saved=new Map(baseline.records.map(r=>[r.key,version(r.value)]));version(baseline.fallback);
 for(const r of baseline.records)if(r.observed!==undefined)version(r.observed);
 const lines=text.split('\n');
 for(const r of records(text)){
  const original=saved.has(r.key)?saved.get(r.key)!:baseline.fallback;
  const desired=target==='gateway'?'v1':original;
  if(r.value===desired)continue;
  // Codex can persist a known protocol on later turns even when the immutable
  // baseline omitted it. That is not evidence of a conflicting owner. `records`
  // validates current versions; restore uses the saved pre-migration setting,
  // including absence. Unknown future versions still fail before any rewrite.
  if(desired===null)delete r.row.payload.multi_agent_version;else r.row.payload.multi_agent_version=desired;
  lines[r.index]=JSON.stringify(r.row);
 }
 return lines.join('\n');
}
