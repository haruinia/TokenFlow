import {CodexApiAccess} from '../../../packages/core/src/codex-api-access.js';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parse,stringify} from 'smol-toml';
import {codexModelCatalog} from '../../../packages/core/src/codex-model-catalog.js';
import {CodexThreadMigration,codexMigrationClient} from '../../../packages/core/src/codex-thread-migration.js';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {portableCodexItem} from '../../../packages/core/src/codex-history-items.js';
const engine='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-protocol-roundtrip-')),home=join(root,'codex');await mkdir(home);
const parent='gpt-6.1-sol',child='fixture/deepseek';
const calls:any[]=[],events:any[]=[],pending=new Map<number,any>();let phase='original-v2',issued=false,seq=0,buffer='',proc:any;
const server=createServer(async(req,res)=>{try{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw),declarations=[...(body.tools??[]),...(body.input??[]).flatMap((i:any)=>i.tools??[])];
 const tools=declarations.flatMap((t:any)=>t.type==='namespace'?t.tools.map((f:any)=>({...f,namespace:t.name})):[t]);
 const version=tools.some((t:any)=>t.name==='followup_task')?'v2':tools.some((t:any)=>t.name==='spawn_agent')?'v1':'absent';
 calls.push({phase,model:body.model,version,childTask:body.model===child?JSON.stringify(body.input).includes('ROUNDTRIP_CHILD_OK'):undefined});
 if(body.model===child)for(const item of body.input??[])portableCodexItem(item);
 let item:any={id:'msg_'+calls.length,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:body.model===child?'ROUNDTRIP_CHILD_OK':'ROUNDTRIP_PARENT_OK',annotations:[]}]};
 if(phase==='gateway-v1'&&body.model===parent&&!issued){
  assert.equal(version,'v1');issued=true;const t=tools.find((t:any)=>t.name==='spawn_agent');assert.ok(t);
  item={id:'fc_roundtrip',type:'function_call',call_id:'call_roundtrip',name:t.name,...(t.namespace?{namespace:t.namespace}:{}),status:'completed',arguments:JSON.stringify({model:child,fork_context:false,message:'Do not use tools or inspect files. Reply ROUNDTRIP_CHILD_OK.'})};
 }
 const response={id:'resp_'+calls.length,object:'response',status:'completed',model:body.model,output:[item],usage:{input_tokens:30,output_tokens:5,total_tokens:35}};
 res.writeHead(200,{'content-type':'text/event-stream'});res.end([{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
 }catch(e){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:String(e)}}));}});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const config=async(version:string,provider:string)=>{
 const catalog:any=codexModelCatalog([parent,child]);for(const m of catalog.models)m.multi_agent_version=version;
 await writeFile(join(root,'catalog.json'),JSON.stringify(catalog));
 const route={name:'Synthetic local probe',base_url:`http://127.0.0.1:${(server.address() as any).port}/v1`,wire_api:'responses',experimental_bearer_token:'synthetic-only',requires_openai_auth:false,supports_websockets:false};
 await writeFile(join(home,'config.toml'),stringify({model:parent,model_provider:provider,model_catalog_json:join(root,'catalog.json'),cli_auth_credentials_store:'file',web_search:'disabled',features:{apps:false,multi_agent:true,multi_agent_v2:version==='v2',model_catalog_in_context:true},analytics:{enabled:false},model_providers:{fixture_official:route,token_flow:route}}));
};
const send=(m:any)=>proc.stdin.write(JSON.stringify(m)+'\n');
const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout '+method));},20000);pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v);},reject:(e:any)=>{clearTimeout(t);reject(e);}});send({id,method,params});});
const start=async()=>{
 proc=spawn(engine,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});proc.stderr.resume();buffer='';
 proc.stdout.on('data',(c:any)=>{buffer+=c;let at;while((at=buffer.indexOf('\n'))>=0){let m;try{m=JSON.parse(buffer.slice(0,at));}catch{}buffer=buffer.slice(at+1);if(!m)continue;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else events.push(m);}});
 await rpc('initialize',{clientInfo:{name:'tokenflow_roundtrip_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
};
const stop=async()=>{if(proc&&proc.exitCode===null)await new Promise<void>(r=>{proc.once('exit',()=>r());proc.kill();});};
const wait=async(test:()=>boolean)=>{for(let i=0;i<600;i++){if(test())return;await new Promise(r=>setTimeout(r,100));}throw Error('Probe timeout');};
const turn=async(id:string)=>{const at=events.length;await rpc('turn/start',{threadId:id,input:[{type:'text',text:'Continue the isolated protocol test.'}]});await wait(()=>events.slice(at).some(e=>e.method==='turn/completed'&&e.params?.threadId===id));assert.equal(events.slice(at).find(e=>e.method==='turn/completed'&&e.params?.threadId===id).params.turn.status,'completed');};
const files=async(dir:string):Promise<string[]>=>{let out:string[]=[];for(const e of await readdir(dir,{withFileTypes:true})){const f=join(dir,e.name);if(e.isDirectory())out.push(...await files(f));else if(e.name.endsWith('.jsonl'))out.push(f);}return out;};
const changes:any[]=[];
const migration=()=>new CodexThreadMigration(root,join(home,'config.toml'),async()=>proc&&proc.exitCode===null?[proc.pid]:[],home=>codexMigrationClient(home,engine));
const legacyJournal=async(id:string)=>{
 const name=(await readdir(home)).filter(n=>/^state_\d+\.sqlite$/.test(n)).sort().at(-1)!;const db=new DatabaseSync(join(home,name),{readOnly:true});
 const row:any=db.prepare('SELECT id,model_provider AS provider,model,rollout_path AS rollout,source,archived FROM threads WHERE id=?').get(id);db.close();assert.ok(row);
 const j=randomUUID(),dir=join(root,'codex-thread-backups',j);await mkdir(dir,{recursive:true});await writeFile(join(dir,'0.jsonl'),await readFile(row.rollout));
 await writeFile(join(dir,'manifest.json'),JSON.stringify({version:1,id:j,createdAt:new Date().toISOString(),state:'migrated',entries:[{...row,provider:'fixture_official',model:parent,nextModel:parent,state:'migrated'}]}));
};
try{
 await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'synthetic-only'}),{mode:0o600});
 await config('v2','fixture_official');await start();const original=await rpc('thread/start',{cwd:root,model:parent,modelProvider:'fixture_official',approvalPolicy:'never',sandbox:'read-only'});const id=original.thread.id;await turn(id);await rpc('thread/unsubscribe',{threadId:id});await rpc('thread/resume',{threadId:id,model:parent,modelProvider:'token_flow'});await stop();await legacyJournal(id);
 await migration().prepare(parent,[parent,child]);await config('v1','token_flow');await migration().migrate(parent,[parent,child]);changes.push({target:'gateway',status:await migration().status()});await start();const gateway=await rpc('thread/resume',{threadId:id,model:parent,modelProvider:'token_flow'});assert.equal(gateway.thread.modelProvider,'token_flow');phase='gateway-v1';const ev=events.length;await turn(id);await wait(()=>calls.some(c=>c.model===child));await wait(()=>events.slice(ev).some(e=>e.method==='turn/completed'&&e.params?.threadId!==id));assert.equal(events.slice(ev).find(e=>e.method==='turn/completed'&&e.params?.threadId!==id).params.turn.status,'completed');await stop();

 // A brand-new v1 chat changes model inside the unified provider, then returns
 // from the shared API configuration overlay. Synthetic transport only; no encrypted task is made.
 await start();phase='fresh-official';const fresh=(await rpc('thread/start',{cwd:root,model:parent,modelProvider:'token_flow',approvalPolicy:'never',sandbox:'read-only'})).thread.id;await turn(fresh);
 phase='fresh-gateway';let offset=events.length;await rpc('turn/start',{threadId:fresh,model:child,input:[{type:'text',text:'Continue the fresh chat with the gateway model.'}]});await wait(()=>events.slice(offset).some(e=>e.method==='turn/completed'&&e.params?.threadId===fresh));assert.equal(events.slice(offset).find(e=>e.method==='turn/completed'&&e.params?.threadId===fresh).params.turn.status,'completed');await stop();
 const beforeApi=await readFile(join(home,'config.toml'),'utf8'),api=new CodexApiAccess(root,join(home,'config.toml'),async()=>[]);
 await api.apply({sourceId:'a'.repeat(24),model:child,name:'Synthetic API',baseURL:'http://127.0.0.1:'+((server.address() as any).port)+'/v1',apiKey:'synthetic-only'},await api.revision());
 assert.equal(parse(await readFile(join(home,'config.toml'),'utf8')).model_provider,'custom');await api.restore(await api.revision());const restoredApi:any=parse(await readFile(join(home,'config.toml'),'utf8'));delete restoredApi.model_providers.custom;assert.deepEqual(restoredApi,parse(beforeApi));await start();await rpc('thread/resume',{threadId:fresh,model:parent,modelProvider:'token_flow'});phase='fresh-after-api-official';await turn(fresh);
 phase='fresh-after-api-gateway';offset=events.length;await rpc('turn/start',{threadId:fresh,model:child,input:[{type:'text',text:'Continue after returning from API mode.'}]});await wait(()=>events.slice(offset).some(e=>e.method==='turn/completed'&&e.params?.threadId===fresh));assert.equal(events.slice(offset).find(e=>e.method==='turn/completed'&&e.params?.threadId===fresh).params.turn.status,'completed');await stop();
 for(const name of ['fresh-official','fresh-gateway','fresh-after-api-official','fresh-after-api-gateway'])assert.equal(calls.find(c=>c.phase===name)?.version,'v1');
 await migration().restore(parent);await config('v2','fixture_official');changes.push({target:'native',status:await migration().status()});await start();const restored=await rpc('thread/resume',{threadId:id,model:parent,modelProvider:'fixture_official'});assert.equal(restored.thread.modelProvider,'fixture_official');phase='restored-v2';await turn(id);await stop();
 assert.equal(calls.find(c=>c.phase==='original-v2').version,'v2');assert.equal(calls.find(c=>c.phase==='gateway-v1').version,'v1');assert.ok(calls.some(c=>c.model===child&&c.childTask));assert.equal(calls.find(c=>c.phase==='restored-v2').version,'v2');
 const report={engineVersion:execFileSync(engine,['--version'],{encoding:'utf8'}).trim(),scope:'installed native engine, isolated HOME, synthetic upstream; no production auth/config/history or paid requests',sameParentThreadId:original.thread.id===gateway.thread.id&&gateway.thread.id===restored.thread.id,syntheticProviderRoute:['fixture_official','token_flow','fixture_official'],usesProductMigration:true,startsFromLegacyJournal:true,changes,calls};
 console.log(JSON.stringify(report,null,2));
}finally{await stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true,maxRetries:3});}
