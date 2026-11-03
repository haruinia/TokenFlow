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
import {CodexApiAccess} from '../../../packages/core/src/codex-api-access.js';
import {migrationBinary} from '../../../packages/core/src/codex-runtime.js';
const engine=await migrationBinary(),root=await mkdtemp(join(await realpath(tmpdir()),'tf-native-api-')),home=join(root,'home');await mkdir(home);
let phase='api-a',sentTool=false,proc:any,seq=0,buffer='';const events:any[]=[],pending=new Map<number,any>(),requests:any[]=[];
const server=createServer(async(req,res)=>{
 try{
  let bytes=Buffer.concat(await Array.fromAsync(req));if(req.headers['content-encoding']==='zstd')bytes=zstdDecompressSync(bytes);if(req.headers['content-encoding']==='gzip')bytes=gunzipSync(bytes);
  const body=JSON.parse(bytes.toString());assert.equal(req.headers.authorization,phase==='api-b'?'Bearer synthetic-api-b':'Bearer synthetic-api-key');assert.equal(req.url,'/responses');
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
 const config=join(home,'config.toml');await writeFile(config,'model="direct-model"\nmodel_provider="openai"\ncli_auth_credentials_store="file"\n[analytics]\nenabled=false\n');
 const jwt=Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-only',chatgpt_plan_type:'plus'},exp:4102444800})).toString('base64url');
 const login=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'x.'+jwt+'.x',id_token:'x.'+jwt+'.x',refresh_token:'synthetic-refresh',account_id:'synthetic-only'}});await writeFile(join(home,'auth.json'),login);
 const api=new CodexApiAccess(root,config,async()=>[]),a={sourceId:'a'.repeat(24),name:'Synthetic API A',model:'direct-model',baseURL:'http://127.0.0.1:'+(server.address() as any).port,apiKey:'synthetic-api-key'},b={...a,sourceId:'b'.repeat(24),name:'Synthetic API B',apiKey:'synthetic-api-b'};
 await api.apply(a,await api.revision());assert.deepEqual(await api.launchEnvironment(),{});await start();
 const created=(await rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'})).thread;
 assert.equal(created.modelProvider,'custom');let at=events.length;await rpc('turn/start',{threadId:created.id,input:[{type:'text',text:'DIRECT_TASK: remember this marker.'}]});await complete(at);
 phase='compact';at=events.length;await rpc('thread/compact/start',{threadId:created.id});await complete(at);await stop();
 await api.apply(b,await api.revision());phase='api-b';await start();
 const resumed=(await rpc('thread/resume',{threadId:created.id})).thread;assert.equal(resumed.modelProvider,'custom');
 at=events.length;await rpc('turn/start',{threadId:created.id,input:[{type:'text',text:'Continue after switching API source.'}]});await complete(at);assert.ok(requests.some(r=>r.phase==='api-b'&&r.hasSummary));await stop();
 await api.restore(await api.revision());assert.equal(await readFile(join(home,'auth.json'),'utf8'),login);await start();
 const opened=(await rpc('thread/resume',{threadId:created.id})).thread;assert.equal(opened.modelProvider,'custom');await stop();
 console.log(JSON.stringify({engineVersion:execFileSync(engine,['--version'],{encoding:'utf8'}).trim(),scope:'isolated native Codex engine; synthetic API servers and ChatGPT credentials only',sharedProvider:true,apiBResumesSameThread:resumed.id===created.id,readableSummaryReused:true,officialLoginPreserved:true,inactiveApiHistoryOpens:true,requests:requests.map(r=>({phase:r.phase,hasSummary:r.hasSummary}))},null,2));
}finally{await stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
