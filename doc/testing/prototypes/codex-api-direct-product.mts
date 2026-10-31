/** Installed native engine + product-generated direct configuration; synthetic upstream only. */
import assert from 'node:assert/strict';
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
const start=async()=>{
 proc=spawn(engine,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});proc.stderr.resume();buffer='';
 proc.stdout.on('data',(c:any)=>{buffer+=c;let at;while((at=buffer.indexOf('\n'))>=0){let m;try{m=JSON.parse(buffer.slice(0,at));}catch{}buffer=buffer.slice(at+1);if(!m)continue;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else events.push(m);}});
 await rpc('initialize',{clientInfo:{name:'tokenflow_direct_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
};
const stop=async()=>{if(proc&&proc.exitCode===null)await new Promise<void>(r=>{const timer=setTimeout(()=>proc.kill('SIGKILL'),3000);proc.once('exit',()=>{clearTimeout(timer);r();});proc.kill();});};
const complete=async(at:number)=>{for(let i=0;i<200;i++){const done=events.slice(at).find(e=>e.method==='turn/completed');if(done){assert.equal(done.params.turn.status,'completed',JSON.stringify(done.params));return;}await new Promise(r=>setTimeout(r,100));}throw Error('Turn timeout');};
const files=async(dir:string):Promise<string[]>=>{let out:string[]=[];for(const e of await readdir(dir,{withFileTypes:true})){const f=join(dir,e.name);if(e.isDirectory())out.push(...await files(f));else if(e.name.endsWith('.jsonl'))out.push(f);}return out;};
try{
 const config=join(home,'config.toml'),before='model="official-test"\nmodel_provider="openai"\ncli_auth_credentials_store="file"\n[analytics]\nenabled=false\n';await writeFile(config,before);
 const jwt=Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic'}})).toString('base64url');const auth=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:`x.${jwt}.x`,id_token:`x.${jwt}.x`,account_id:'synthetic'}});await writeFile(join(home,'auth.json'),auth);
 const manager=new CodexApiDirect(root,config,async()=>[]),selection={sourceId:'a'.repeat(24),name:'Synthetic API',model:'direct-model',baseURL:`http://127.0.0.1:${(server.address() as any).port}`,apiKey:'synthetic-api-key',capabilities:{contextWindow:1048576,reasoning:{levels:['low','high','max'] as Array<'low'|'high'|'max'>,default:'max' as const}}};
 await manager.apply(selection,codexConfigRevision(before));
 await start();const menu=(await rpc('model/list',{})).data.find((m:any)=>m.model==='direct-model');assert.ok(menu,'Native model list missing configured model');assert.deepEqual(menu.supportedReasoningEfforts.map((v:any)=>v.reasoningEffort),['low','high','max']);
 const created=await rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'}),threadId=created.thread.id;
 assert.equal(created.thread.modelProvider,codexApiProvider(selection.sourceId));
 let at=events.length;await rpc('turn/start',{threadId,input:[{type:'text',text:'DIRECT_TASK: run printf DIRECT_TOOL_OK, then reply.'}]});await complete(at);assert.ok(requests.some(r=>r.toolOutputVerified),'Native tool was not executed successfully');
 phase='compact';at=events.length;await rpc('thread/compact/start',{threadId});await complete(at);
 phase='continue';at=events.length;await rpc('turn/start',{threadId,input:[{type:'text',text:'Continue using the summary.'}]});await complete(at);await stop();
 phase='restart';await start();await rpc('thread/resume',{threadId});at=events.length;await rpc('turn/start',{threadId,input:[{type:'text',text:'Continue after restart.'}]});await complete(at);await stop();
 assert.ok(requests.filter(r=>['continue','restart'].includes(r.phase)).every(r=>r.hasSummary));
 assert.ok(requests.filter(r=>r.phase==='tools'||r.phase==='restart').every(r=>r.effort==='max'),'Native engine did not preserve max effort');
 const history=(await Promise.all((await files(join(home,'sessions'))).map(f=>readFile(f,'utf8')))).join('\n');assert.ok(history.includes('DIRECT_SAVED_SUMMARY'));assert.ok(history.includes('compacted'));
 assert.equal(await readFile(join(home,'auth.json'),'utf8'),auth,'Native client changed retained official auth');
 await manager.restore(codexConfigRevision(await readFile(config,'utf8')));assert.equal(await readFile(config,'utf8'),before);
 console.log(JSON.stringify({passed:true,engineVersion:execFileSync(engine,['--version'],{encoding:'utf8'}).trim(),isolated:true,tokenFlowServerStarted:false,officialAuthUnchanged:true,nativeModelEfforts:['low','high','max'],nativeToolRoundtrip:true,nativeLocalCompaction:true,continuedAfterCompaction:true,continuedAfterRestart:true,configurationRestored:true,requests},null,2));
}finally{await stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
