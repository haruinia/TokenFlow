import {DatabaseSync} from 'node:sqlite';
import {lstat} from 'node:fs/promises';
import {safePath} from './agent-connections.js';
import {LocalUsageParser,type LocalUsageRow} from './local-usage.js';

/** Coding-plan and account families spend the signed-in Zhipu/Z.ai plan; key, pay-as-you-go and custom providers are API usage. */
export function zcodeChannel(provider:string):'oauth'|'api-key'|undefined{
 const id=provider.toLowerCase();
 if(id==='custom'||/(?:^|-)api(?:-key)?$/.test(id))return 'api-key';
 if(/^(?:bigmodel|zai|zhipu)(?:-|$)/.test(id))return 'oauth';
 return undefined;
}

/** ZCode `model_usage`: one row per model attempt. Like the AI SDK it is built on, input already
 * contains cache reads/writes and `computed_total_tokens` is input + output; reasoning is part of output. */
export async function readZcodeUsage(path:string):Promise<LocalUsageRow[]>{
 for(const p of [path,path+'-wal',path+'-shm'])await safePath(p);
 const stat=await lstat(path);if(!stat.isFile()||stat.size>512*1024*1024)throw Error('Unsupported ZCode database');
 const db=new DatabaseSync(path,{readOnly:true}),parser=new LocalUsageParser('zcode',path);
 try{
  db.exec('PRAGMA busy_timeout=1000;BEGIN');
  const rows=db.prepare(`SELECT id,provider_id,model_id,started_at,completed_at,input_tokens,output_tokens,reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens FROM model_usage WHERE input_tokens>0 OR output_tokens>0 ORDER BY started_at LIMIT 200001`).all();
  if(rows.length>200000)throw Error('Large ZCode usage table');
  for(const row of rows){
   const time=Number(row.completed_at??row.started_at),provider=String(row.provider_id??''),model=String(row.model_id??'');
   if(!Number.isFinite(time)||time<946684800000||!model||/token.?flow/i.test(provider))continue;
   const input=Number(row.input_tokens)||0,read=Number(row.cache_read_input_tokens)||0,write=Number(row.cache_creation_input_tokens)||0,channel=zcodeChannel(provider);
   parser.accept({id:String(row.id),timestamp:new Date(time).toISOString(),requestedModel:model,...(channel?{authType:channel}:{}),message:{model,usage:{input_tokens:Math.max(0,input-read-write),cache_read_input_tokens:read,cache_creation_input_tokens:write,output_tokens:Number(row.output_tokens)||0,output_tokens_details:{thinking_tokens:Number(row.reasoning_tokens)||0}}}});
  }
  return parser.rows();
 }finally{db.close();}
}
