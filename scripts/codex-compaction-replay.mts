// Read-only replay of a selected local checkpoint in an isolated context store.
// --live-summary uses the already selected local gateway source for summaries;
// otherwise the summarizer is synthetic. No user rollout/config is modified.
// Output contains only sizes, timings and assertions, never plaintext or keys.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {parse} from 'smol-toml';
import {GatewayContext} from '../packages/core/src/gateway-context.js';
import {codexContextScope,portableCodexItem} from '../packages/core/src/codex-context.js';
const id=process.argv[2];assert.ok(id,'Thread ID required');const live=process.argv.includes('--live-summary');
const home=join(homedir(),'.codex'),data=join(homedir(),'Library/Application Support/desktop-browser-agent');
const db=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true});
const row=db.prepare('select model,rollout_path from threads where id=?').get(id) as {model:string;rollout_path:string};db.close();assert.ok(row);
const rows=(await readFile(row.rollout_path,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
const c=rows.filter(r=>r.type==='compacted'&&r.payload.replacement_history?.some((i:any)=>i.encrypted_content?.startsWith('tfctx1.'))).at(-1);assert.ok(c);
const original=c.payload.replacement_history,marker='ISOLATED_REPLAY_READ_ONLY_NO_EXECUTION';
const input=[...original,{type:'message',role:'user',content:[{type:'input_text',text:marker}]}];
const root=await mkdtemp(join(tmpdir(),'tf-compact-replay-'));const size=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
try{
 await mkdir(join(root,'gateway-context'),{mode:0o700});await writeFile(join(root,'gateway-context/key'),await readFile(join(data,'gateway-context/key')),{mode:0o600});
 const context=await GatewayContext.open(root),migration={rebuildsInstructions:true,scope:codexContextScope,normalize:portableCodexItem,recover:async()=>{throw Error('Unexpected foreign recovery');}};
 const config=parse(await readFile(join(home,'config.toml'),'utf8')) as any,p=config.model_providers?.token_flow;assert.ok(!live||p?.base_url?.startsWith('http://127.0.0.1:9527/'));
 const summaryCalls:any[]=[];let before:any,after:any,report:any;
 const complete={status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Historical decisions retained; continue the current task read-only.'}]}],usage:{input_tokens:100,output_tokens:20,total_tokens:120}};
 await context.response('responses',{model:row.model,input,store:false},'test','source',async(_p,b)=>{before=b;return Response.json(complete);},migration);
 const started=Date.now();
 const result=await context.response('responses',{model:row.model,input:[...input,{type:'compaction_trigger'}],store:false},'test','source',async(_path,b)=>{
  summaryCalls.push({bytes:size(b)});console.log(JSON.stringify({summaryCall:summaryCalls.length,live,bytes:size(b)}));
  if(!live)return Response.json(complete);
  return fetch(p.base_url+'/responses',{method:'POST',headers:{'content-type':'application/json',...p.http_headers},body:JSON.stringify(b),signal:AbortSignal.timeout(600000)});
 },migration,{onCompaction:r=>{report=r;}});
 assert.ok(result.ok);const compact=await result.json() as any;
 const resumed=await GatewayContext.open(root);
 await resumed.response('responses',{model:row.model,input:[...original.filter((i:any)=>i.role==='developer'),...compact.output],store:false},'test','source',async(_p,b)=>{after=b;return Response.json(complete);},migration);
 assert.ok(size(after.input)<size(before.input)*0.5,'Historical fixed overhead did not shrink');
 assert.ok(JSON.stringify(after.input).includes(marker));
 const unknown=before.input.filter((i:any)=>i.role==='system');for(const i of unknown)assert.ok(after.input.some((v:any)=>JSON.stringify(v)===JSON.stringify(i)));
 const official=await resumed.forOfficial({model:'official',input:[...original.filter((i:any)=>i.role==='developer'),...compact.output]},[codexContextScope],portableCodexItem);
 assert.ok(JSON.stringify(official.input).includes(marker));assert.ok(!JSON.stringify(official.input).includes('tfctx1.'));
 console.log(JSON.stringify({passed:true,thread:id,liveSummary:live,realContinuation:false,checkpointAt:c.timestamp,model:row.model,beforeBytes:size(before.input),afterBytes:size(after.input),beforeRules:before.input.filter((i:any)=>i.role==='developer').length,afterRules:after.input.filter((i:any)=>i.role==='developer').length,summaryCalls:summaryCalls.length,durationMs:Date.now()-started,report,officialHandoff:true,originalFilesWritten:0}));
}finally{await rm(root,{recursive:true,force:true});}
