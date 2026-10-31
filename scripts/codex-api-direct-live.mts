import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {probeCodexApi} from '../packages/core/src/codex-api-capability.js';
import {CodexApiDirect,codexConfigRevision} from '../packages/core/src/codex-api-direct.js';
import {migrationBinary} from '../packages/core/src/codex-runtime.js';
import {createNetworkProxy} from '../packages/core/src/network-proxy.js';
if(!process.argv.includes('--live')||!process.send)throw Error('Explicit live helper required');
const chunks:string[]=[];for await(const chunk of process.stdin)chunks.push(String(chunk));const selection=JSON.parse(chunks.join(''));
let sequence=0;const waiting=new Map<number,(v:string)=>void>();process.on('message',(m:any)=>{const done=waiting.get(m?.id);if(done){waiting.delete(m.id);done(m.result);}});
const network=await createNetworkProxy(url=>new Promise(resolve=>{const id=++sequence;waiting.set(id,resolve);process.send!({type:'resolve-proxy',id,url});}));network.installFetch();
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-api-live-')),home=join(root,'home'),work=join(root,'work');await mkdir(home);await mkdir(work);
let phase='capability',proc:any,next=0,buffer='';const pending=new Map<number,any>(),events:any[]=[],usage:any[]=[],rejections:any[]=[];
const send=(m:any)=>proc.stdin.write(JSON.stringify(m)+'\n');
const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++next,t=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},20000);pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v);},reject:(e:any)=>{clearTimeout(t);reject(e);}});send({id,method,params});});
const engine=await migrationBinary();
const start=async()=>{
 proc=spawn(engine,['app-server','--listen','stdio://'],{cwd:work,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,HTTPS_PROXY:network.url,HTTP_PROXY:network.url,NO_PROXY:'127.0.0.1,localhost'},stdio:['pipe','pipe','pipe']});proc.stderr.resume();buffer='';
 proc.stdout.on('data',(c:any)=>{buffer+=c;let at;while((at=buffer.indexOf('\n'))>=0){let m;try{m=JSON.parse(buffer.slice(0,at));}catch{}buffer=buffer.slice(at+1);if(!m)continue;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error('Native RPC rejected request')):p.resolve(m.result);}else events.push(m);}});
 await rpc('initialize',{clientInfo:{name:'tokenflow_api_live_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
};
const stop=async()=>{if(proc&&proc.exitCode===null)await new Promise<void>(r=>{const t=setTimeout(()=>proc.kill('SIGKILL'),3000);proc.once('exit',()=>{clearTimeout(t);r();});proc.kill();});};
const complete=async(at:number)=>{for(let i=0;i<900;i++){const done=events.slice(at).find(e=>e.method==='turn/completed');if(done){assert.equal(done.params.turn.status,'completed','Native turn did not complete');return;}await new Promise(r=>setTimeout(r,100));}throw Error('Native turn timeout');};
try{
 const fetcher:typeof fetch=async(input,init)=>{const response=await fetch(input,init);if(!response.ok){try{const body=await response.clone().json() as any;const error=body.error??body;rejections.push({status:response.status,code:error.code,param:error.param,message:typeof error.message==='string'?error.message.split(selection.apiKey).join('[redacted]').slice(0,500):undefined});}catch{}}return response;};
 const result=await probeCodexApi(selection,new AbortController().signal,u=>usage.push({inputTokens:u.inputTokens,outputTokens:u.outputTokens}),fetcher);
 const config=join(home,'config.toml'),before='model_provider="openai"\ncli_auth_credentials_store="file"\n[analytics]\nenabled=false\n';await writeFile(config,before);const manager=new CodexApiDirect(root,config,async()=>[]);await manager.apply(selection,codexConfigRevision(before));
 phase='native-turn';await start();const thread=(await rpc('thread/start',{cwd:work,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
 let at=events.length;await rpc('turn/start',{threadId:thread,input:[{type:'text',text:'Compatibility check. Remember the exact marker TF_DIRECT_729. Reply only TF_DIRECT_729. Do not call tools or inspect files.'}]});await complete(at);
 for(const effort of ['low','high','max']){
  phase='native-effort-'+effort;at=events.length;await rpc('turn/start',{threadId:thread,effort,input:[{type:'text',text:'Reply with the remembered marker only. Do not use tools.'}]});await complete(at);
  const text=events.slice(at).filter(e=>e.method==='item/completed').map(e=>e.params?.item?.text??'').join('');assert.ok(text.includes('TF_DIRECT_729'),'Marker missing in '+effort);
 }
 phase='native-compact';at=events.length;await rpc('thread/compact/start',{threadId:thread});await complete(at);await stop();
 phase='native-resume';await start();await rpc('thread/resume',{threadId:thread});at=events.length;await rpc('turn/start',{threadId:thread,input:[{type:'text',text:'What was the exact marker? Reply with it only. Do not call tools.'}]});await complete(at);
 const answer=events.slice(at).filter(e=>e.method==='item/completed').map(e=>e.params?.item?.text??'').join('');assert.ok(answer.includes('TF_DIRECT_729'),'Marker missing after compact and restart');await stop();
 await manager.restore(codexConfigRevision(await readFile(config,'utf8')));assert.equal(await readFile(config,'utf8'),before);
 console.log(JSON.stringify({check:'codex-api-direct-live',passed:true,model:selection.model,host:'api.deepseek.com',engineVersion:execFileSync(engine,['--version'],{encoding:'utf8'}).trim(),capability:result,nativeEfforts:['low','high','max'],declaredContextWindow:1048576,nativeCompaction:true,nativeResume:true,markerRetained:true,tokenFlowGatewayUsed:false,productionConfigChanged:false,probeUsage:usage}));
}catch(error){console.log(JSON.stringify({check:'codex-api-direct-live',passed:false,phase,model:selection.model,message:error instanceof Error?error.message.split(selection.apiKey).join('[redacted]').slice(0,250):'Failed',probeUsage:usage,rejections}));process.exitCode=1;}
finally{await stop();await network.close();await rm(root,{recursive:true,force:true});process.disconnect?.();}
