/** Installed native engine + product-generated direct configuration; synthetic upstream only. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createDesktopService} from '../../../packages/core/src/service.js';
import {DatabaseSync} from 'node:sqlite';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zstdDecompressSync,gunzipSync} from 'node:zlib';
import {CodexApiDirect,codexConfigRevision,codexApiProvider} from '../../../packages/core/src/codex-api-direct.js';
import {migrationBinary} from '../../../packages/core/src/codex-runtime.js';
const engine=await migrationBinary(),root=await mkdtemp(join(await realpath(tmpdir()),'tf-native-api-')),home=join(root,'home');await mkdir(home);
let phase='tools',sentTool=false,proc:any,seq=0,buffer='';const events:any[]=[],pending=new Map<number,any>(),requests:any[]=[];
const server=createServer(async(req,res)=>{
 try{
  let bytes=Buffer.concat(await Array.fromAsync(req));if(req.headers['content-encoding']==='zstd')bytes=zstdDecompressSync(bytes);if(req.headers['content-encoding']==='gzip')bytes=gunzipSync(bytes);
  const body=JSON.parse(bytes.toString());assert.equal(req.headers.authorization,'Bearer synthetic-api-key');assert.equal(req.url,'/responses');
  requests.push({phase,path:req.url,effort:body.reasoning?.effort,toolResult:body.input?.some((i:any)=>i.type==='function_call_output'),toolOutputVerified:body.input?.some((i:any)=>i.type==='function_call_output'&&JSON.stringify(i.output).includes('DIRECT_TOOL_OK')&&!JSON.stringify(i.output).includes('Unknown tool')),hasSummary:JSON.stringify(body.input).includes('DIRECT_SAVED_SUMMARY'),tools:body.tools?.map((t:any)=>t.name??t.type)});
  let item:any;
  if(phase==='tools'&&!sentTool){sentTool=true;item={id:'fc_test',type:'function_call',name:'exec_command',call_id:'call_native',arguments:JSON.stringify({cmd:'printf DIRECT_TOOL_OK',workdir:root})};}
  else item={id:'msg_'+requests.length,type:'message',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:phase==='compact'?'DIRECT_SAVED_SUMMARY: task marker DIRECT_TASK; tool returned DIRECT_TOOL_OK.':'DIRECT_REPLY_OK'}]};
  const response={id:'resp_'+requests.length,object:'response',status:'completed',model:'direct-model',output:[item],usage:{input_tokens:100,output_tokens:10,total_tokens:110}};
  res.writeHead(200,{'content-type':'text/event-stream'});res.end([{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
 }catch(error){res.writeHead(500);res.end('Synthetic fixture rejected request');}
});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const send=(m:any)=>proc.stdin.write(JSON.stringify(m)+'\n');
const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout '+method));},20000);pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v);},reject:(e:any)=>{clearTimeout(t);reject(e);}});send({id,method,params});});
const start=async(engineHome=home)=>{
 proc=spawn(engine,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:engineHome},stdio:['pipe','pipe','pipe']});proc.stderr.resume();buffer='';
 proc.stdout.on('data',(c:any)=>{buffer+=c;let at;while((at=buffer.indexOf('\n'))>=0){let m;try{m=JSON.parse(buffer.slice(0,at));}catch{}buffer=buffer.slice(at+1);if(!m)continue;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else events.push(m);}});
 await rpc('initialize',{clientInfo:{name:'tokenflow_direct_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
};
const stop=async()=>{if(proc&&proc.exitCode===null)await new Promise<void>(r=>{const timer=setTimeout(()=>proc.kill('SIGKILL'),3000);proc.once('exit',()=>{clearTimeout(timer);r();});proc.kill();});};
const complete=async(at:number)=>{for(let i=0;i<200;i++){const done=events.slice(at).find(e=>e.method==='turn/completed');if(done){assert.equal(done.params.turn.status,'completed',JSON.stringify(done.params));return;}await new Promise(r=>setTimeout(r,100));}throw Error('Turn timeout');};
const files=async(dir:string):Promise<string[]>=>{let out:string[]=[];for(const e of await readdir(dir,{withFileTypes:true})){const f=join(dir,e.name);if(e.isDirectory())out.push(...await files(f));else if(e.name.endsWith('.jsonl'))out.push(f);}return out;};
let service:any;
try{
 const config=join(home,'config.toml'),original='model="direct-model"\nmodel_provider="openai"\ncli_auth_credentials_store="file"\n[analytics]\nenabled=false\n';await writeFile(config,original);
 await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'synthetic-api-key'}));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const proxyPort=(allocator.address() as any).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const secrets=new Map<string,string>();
 service=await createDesktopService({root,token:'synthetic-admin',localKey:'synthetic-sidecar',proxyPort,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),nativeCredentialsOnDemand:true,agentProcesses:async()=>[],nativeProcesses:async()=>[],desktopProcesses:async()=>[],agentPaths:Object.fromEntries(['codex','claude','qoder','workbuddy','workbuddy-ai','deepseek','pi'].map(t=>[t,t==='codex'?config:join(root,t,'config.json')])),secrets:{get:async(id:string)=>secrets.get(id)??'',set:async(id:string,value:string)=>{secrets.set(id,value);}}});
 const address=await service.app.listen({host:'127.0.0.1',port:0});await service.proxy.start();
 const headers={host:new URL(address).host,authorization:'Bearer synthetic-admin'};
 const post=async(url:string,payload:any)=>{const response=await service.app.inject({url,method:'POST',headers,payload});assert.equal(response.statusCode,200,response.body);return response.json();};
 const target=async()=>(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:any)=>t.id==='codex');
 const source=await post('/api/sources',{name:'Synthetic API',baseURL:`http://127.0.0.1:${(server.address() as any).port}`,protocol:'responses',models:['direct-model'],apiKey:'synthetic-api-key'});
 const connect=async()=>post('/api/a2a/connect',{target:'codex',sourceId:source.id,model:`api-${source.id}/direct-model`,revision:(await target()).revision});
 await connect();phase='continue';await start();const old=(await rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
 let at=events.length;await rpc('turn/start',{threadId:old,input:[{type:'text',text:'Synthetic gateway history marker.'}]});await complete(at);await stop();

 const api=async()=>(await service.app.inject({url:'/api/a2a/codex-api',headers})).json();
 // Simulate one API-only chat created by .96's shared-home configuration.
 await post('/api/a2a/restore',{id:(await target()).connection.id,revision:(await target()).revision});
 const legacy=new CodexApiDirect(root,config,async()=>[]);
 await legacy.apply({sourceId:source.id,name:'Synthetic API',model:'direct-model',baseURL:`http://127.0.0.1:${(server.address() as any).port}`,apiKey:'synthetic-api-key'},await legacy.revision());
 await start();const legacyId=(await rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
 at=events.length;await rpc('turn/start',{threadId:legacyId,input:[{type:'text',text:'LEGACY_API_ONLY'}]});await complete(at);
 const legacyArchived=(await rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
 at=events.length;await rpc('turn/start',{threadId:legacyArchived,input:[{type:'text',text:'LEGACY_API_ARCHIVED'}]});await complete(at);await rpc('thread/archive',{threadId:legacyArchived});await stop();
 await legacy.restore(await legacy.revision());
 const beforeConfig=await readFile(config,'utf8'),beforeAuth=await readFile(join(home,'auth.json'),'utf8');
 await post('/api/a2a/codex-api/apply',{sourceId:source.id,revision:(await api()).revision});
 const apiHome=(await api()).active.home;
 assert.equal(await readFile(config,'utf8'),beforeConfig);assert.equal(await readFile(join(home,'auth.json'),'utf8'),beforeAuth);
 await start(apiHome);const results:any={originalConfigUntouched:true,originalAuthUntouched:true};
 const list=async()=>(await rpc('thread/list',{modelProviders:[],sourceKinds:['cli','vscode'],useStateDbOnly:true})).data;
 assert.ok((await list()).some((t:any)=>t.id===legacyId));results.legacyApiAdopted=true;
 assert.ok((await rpc('thread/list',{modelProviders:[],archived:true,useStateDbOnly:true})).data.some((t:any)=>t.id===legacyArchived));
 assert.ok(!(await list()).some((t:any)=>t.id===old));
 await assert.rejects(rpc('thread/resume',{threadId:old}));results.originalUnavailableInApi=true;
 const created=(await rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
 at=events.length;await rpc('turn/start',{threadId:created,input:[{type:'text',text:'Synthetic direct API history marker.'}]});await complete(at);
 phase='compact';at=events.length;await rpc('thread/compact/start',{threadId:created});await complete(at);await stop();
 await post('/api/a2a/codex-api/restore',{revision:(await api()).revision});await start();
 const restored=await rpc('thread/resume',{threadId:old});assert.equal(restored.thread.modelProvider,'openai');
 assert.ok(!(await list()).some((t:any)=>t.id===legacyId));results.legacyApiArchivedInOriginal=true;
 assert.ok(!(await list()).some((t:any)=>t.id===created));await assert.rejects(rpc('thread/resume',{threadId:created}));results.apiUnavailableInOfficial=true;await stop();
 await post('/api/a2a/codex-api/apply',{sourceId:source.id,revision:(await api()).revision});await start((await api()).active.home);
 await rpc('thread/resume',{threadId:created});phase='continue';const count=requests.length;at=events.length;await rpc('turn/start',{threadId:created,input:[{type:'text',text:'Continue the same API summary.'}]});await complete(at);
 results.apiSummaryReused=requests.slice(count).some(r=>r.hasSummary);assert.ok(results.apiSummaryReused);await stop();
 const second=await post('/api/sources',{name:'Other API',baseURL:`http://127.0.0.1:${(server.address() as any).port}`,protocol:'responses',models:['direct-model'],apiKey:'synthetic-api-key'});
 await post('/api/a2a/codex-api/apply',{sourceId:second.id,revision:(await api()).revision});await start((await api()).active.home);
 assert.ok(!(await list()).some((t:any)=>t.id===created||t.id===old));await assert.rejects(rpc('thread/resume',{threadId:created}));results.apiSourcesSeparated=true;await stop();
 await post('/api/a2a/codex-api/restore',{revision:(await api()).revision});await connect();
 const dbPath=(await readdir(home)).find(n=>/^state_\d+\.sqlite$/.test(n))!;const db=new DatabaseSync(join(home,dbPath),{readOnly:true});assert.equal(db.prepare('select id from threads where id=?').get(created),undefined);db.close();results.apiExcludedFromOriginalDatabase=true;
 results.apiExcludedFromBackups=true;for(const entry of await readdir(join(root,'codex-thread-backups'),{withFileTypes:true})){if(!entry.isDirectory())continue;const manifest=JSON.parse(await readFile(join(root,'codex-thread-backups',entry.name,'manifest.json'),'utf8'));if(manifest.entries.some((e:any)=>e.id===created))results.apiExcludedFromBackups=false;}assert.ok(results.apiExcludedFromBackups);
 console.log(JSON.stringify(results,null,2));
}finally{await stop();await service?.app.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
