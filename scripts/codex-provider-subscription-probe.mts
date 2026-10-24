/** Two-client protocol probe. Synthetic auth and one loopback fixture turn. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {stringify} from 'smol-toml';
const root=await mkdtemp(join(tmpdir(),'tf-provider-subscriptions-')),home=join(root,'codex');
await mkdir(home);await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-no-inference'}),{mode:0o600});
const cached=JSON.parse(await readFile(join(homedir(),'.codex/models_cache.json'),'utf8'));const catalog=join(root,'models.json');await writeFile(catalog,JSON.stringify({models:cached.models}));
let fixtureCalls=0;
const fixture=createServer(async(req,res)=>{for await(const _ of req){}fixtureCalls++;const item={type:'message',id:'msg_fixture',role:'assistant',content:[{type:'output_text',text:'Fixture acknowledged.'}]};const response={id:'resp_fixture',status:'completed',model:'gpt-6-astra',output:[item],usage:{input_tokens:100,output_tokens:10,total_tokens:110}};res.writeHead(200,{'content-type':'text/event-stream'});res.end([{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));});
await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));const fixtureURL=`http://127.0.0.1:${(fixture.address() as any).port}/v1`;
await writeFile(join(home,'config.toml'),stringify({model:'gpt-6-astra',model_provider:'openai',openai_base_url:fixtureURL,model_catalog_json:catalog,cli_auth_credentials_store:'file',features:{apps:false},analytics:{enabled:false},model_providers:{token_flow:{name:'Probe only',base_url:'http://127.0.0.1:1/v1',wire_api:'responses',experimental_bearer_token:'fixture',requires_openai_auth:false}}}));
const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as any).port;await new Promise<void>(r=>allocator.close(()=>r()));
const binary='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const proc=spawn(binary,['app-server','--listen',`ws://127.0.0.1:${port}`],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,OPENAI_BASE_URL:fixtureURL},stdio:['ignore','ignore','pipe']});
let stderr='';proc.stderr!.on('data',c=>{stderr+=String(c);});
const sockets:WebSocket[]=[],rounds:any[]=[];let error:string|undefined;
const client=async(name:string)=>{
 let socket:WebSocket|undefined;
 for(let n=0;n<100;n++){
  const next=new WebSocket(`ws://127.0.0.1:${port}`);
  const opened=await new Promise<boolean>(r=>{next.addEventListener('open',()=>r(true),{once:true});next.addEventListener('error',()=>r(false),{once:true});});
  if(opened){socket=next;break;}next.close();if(proc.exitCode!==null)throw Error('Probe server exited: '+stderr.slice(-1000));await new Promise(r=>setTimeout(r,100));
 }
 assert.ok(socket,'Server did not accept a probe connection');const ws=socket;sockets.push(ws);let seq=0;const events:any[]=[];const pending=new Map<number,any>();
 ws.addEventListener('message',event=>{const m=JSON.parse(String(event.data)),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method)events.push(m);});
 const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('Timeout '+method));},20000);pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v)},reject:(e:any)=>{clearTimeout(t);reject(e)}});ws.send(JSON.stringify({id,method,params}));});
 await rpc('initialize',{clientInfo:{name,version:'1'},capabilities:{experimentalApi:true}});ws.send('{"method":"initialized"}');return Object.assign(rpc,{events});
};
const record=(value:any)=>{rounds.push(value);console.log(JSON.stringify(value));};
try{
 const desktop=await client('desktop_fixture'),manager=await client('tokenflow_fixture');
 const started=await desktop('thread/start',{cwd:root,model:'gpt-6-astra',modelProvider:'openai',approvalPolicy:'never',sandbox:'read-only'}),threadId=started.thread.id;
 await desktop('turn/start',{threadId,input:[{type:'text',text:'Fixture seed; no tools.'}]});
 for(let n=0;!desktop.events.some(e=>e.method==='turn/completed');n++){assert.ok(n<500,'Fixture seed timeout');await new Promise(r=>setTimeout(r,20));}
 assert.equal(desktop.events.find(e=>e.method==='turn/completed').params.turn.status,'completed');assert.ok(fixtureCalls>0);
 const resume=async(phase:string)=>{const value=await manager('thread/resume',{threadId,model:'fixture-gateway',modelProvider:'token_flow',approvalPolicy:'never',sandbox:'read-only'});const actual=value.modelProvider??value.thread.modelProvider;record({phase,actual,pid:proc.pid});return actual;};
 record({phase:'manager-unsubscribe-without-ownership',...await manager('thread/unsubscribe',{threadId})});
 assert.equal(await resume('desktop-still-subscribed'),'openai');
 record({phase:'manager-unsubscribe-own-connection',...await manager('thread/unsubscribe',{threadId})});
 assert.equal(await resume('desktop-still-subscribed-after-manager-unsubscribe'),'openai');
 await manager('thread/unsubscribe',{threadId});
 record({phase:'desktop-unsubscribe',...await desktop('thread/unsubscribe',{threadId})});
 assert.equal(await resume('all-subscribers-released'),'token_flow');
 assert.equal(proc.exitCode,null);
}catch(e){error=e instanceof Error?e.message:'Failed';process.exitCode=1;}
finally{for(const socket of sockets)socket.close();if(proc.exitCode===null&&proc.signalCode===null)await new Promise<void>(r=>{proc.once('exit',()=>r());proc.kill();});fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));await rm(root,{recursive:true,force:true});}
const report={passed:!error,fixtureCalls,scope:'Isolated two WebSocket clients, synthetic credentials, one loopback fixture turn; no external inference',...(error?{error}:{}),rounds};console.log(JSON.stringify(report));const out=process.argv.indexOf('--out');if(out>=0)await writeFile(resolve(process.argv[out+1]),JSON.stringify(report,null,2)+'\n');
