/** Installed Codex image_gen -> TokenFlow image routes -> synthetic upstream.
 * No production credentials, inference calls, configuration or history writes.
 * node --import tsx scripts/codex-official-images-smoke.mts
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {stringify} from 'smol-toml';
import {createServer} from '../packages/core/src/server.js';
import {gatewayDecoding} from '../packages/core/src/gateway-decoding.js';
import {registerCodexOfficialImages} from '../packages/core/src/codex-official-images.js';

const binary=process.argv[2]??'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-images-engine-'));
const cache=JSON.parse(await readFile(join(homedir(),'.codex/models_cache.json'),'utf8'));
const model=cache.models.find((m:{slug:string})=>m.slug==='gpt-6-astra');assert.ok(model,'Cached official metadata missing');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const inputPath=join(root,'input.png');await writeFile(inputPath,Buffer.from(png,'base64'));
const app=createServer();gatewayDecoding(app);
const images:Array<{path:string;model:string;referenceCount:number;authenticated:boolean;turnId:boolean}>=[],usage:unknown[]=[];
registerCodexOfficialImages(app,{authorize:headers=>headers['x-tokenflow-client-key']==='fixture-key'?'fixture-client':undefined,record:call=>usage.push(call),fetcher:async(url,init)=>{
 assert.ok(url.startsWith('https://chatgpt.com/backend-api/codex/images/'));
 const body=JSON.parse(String(init.body)),headers=new Headers(init.headers);
 assert.equal(headers.get('x-tokenflow-client-key'),null);assert.equal(headers.get('chatgpt-account-id'),'synthetic-account');
 images.push({path:new URL(url).pathname,model:body.model,referenceCount:body.images?.length??0,authenticated:headers.get('authorization')?.startsWith('Bearer ')===true,turnId:!!headers.get('x-codex-image-turn-id')});
 return Response.json({created:1,data:[{b64_json:png,generation_id:'fixture-generated-image'}],usage:{input_tokens:10,output_tokens:20,total_tokens:30}},{headers:{'x-codex-imagegen-request-id':`fixture-${images.length}`}});
}});
let operation='generate',requested=false,sequence=0;
app.post('/codex/v1/responses',{bodyLimit:Number.MAX_SAFE_INTEGER},async(req,reply)=>{
 const body=req.body as any;
 const n=++sequence;
 const item=requested?{id:`msg_${n}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture done.',annotations:[]}]}:
  {type:'function_call',id:`fc_${n}`,call_id:`image_call_${n}`,namespace:'image_gen',name:'imagegen',arguments:JSON.stringify({prompt:'Synthetic fixture',transparent_background:false,...(operation==='edit'?{referenced_image_paths:[inputPath]}:{})})};
 requested=true;
 const response={id:`resp_${n}`,object:'response',created_at:1,model:body.model,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:1,total_tokens:11}};
 const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
 return reply.header('content-type','text/event-stream').send(events.map((e,i)=>'data: '+JSON.stringify({...e,sequence_number:i})+'\n\n').join(''));
});
await app.listen({port:0,host:'127.0.0.1'});const port=(app.server.address() as {port:number}).port;
const codexHome=join(root,'codex');await mkdir(codexHome);
await writeFile(join(codexHome,'catalog.json'),JSON.stringify({models:[model]}));
await writeFile(join(codexHome,'config.toml'),stringify({model:model.slug,model_provider:'token_flow',model_catalog_json:join(codexHome,'catalog.json'),cli_auth_credentials_store:'file',features:{apps:false},analytics:{enabled:false},model_providers:{token_flow:{name:'Fixture',base_url:`http://127.0.0.1:${port}/codex/v1`,wire_api:'responses',requires_openai_auth:true,supports_websockets:false,http_headers:{'x-tokenflow-client-key':'fixture-key'}}}}));
const now=Math.floor(Date.now()/1000),claims={sub:'synthetic-user',iat:now,exp:now+3600,'https://api.openai.com/auth':{chatgpt_plan_type:'plus',chatgpt_account_id:'synthetic-account',user_id:'synthetic-user'}};
const jwt=Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic-signature';
await writeFile(join(codexHome,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:jwt,access_token:jwt,refresh_token:'synthetic-refresh',account_id:'synthetic-account'},last_refresh:new Date().toISOString()}),{mode:0o600});
const proc=spawn(binary,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,CODEX_HOME:codexHome},stdio:['pipe','pipe','pipe']});
let buffer='',id=0,stderr='';const pending=new Map<number,any>(),events:any[]=[];
proc.stderr.on('data',c=>{stderr=(stderr+c.toString()).slice(-3000);});
proc.stdout.on('data',c=>{buffer+=c;let end;while((end=buffer.indexOf('\n'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);let msg;try{msg=JSON.parse(raw);}catch{continue;}const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);}else if(msg.method)events.push(msg);}});
const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('RPC timeout '+method));},15000);pending.set(key,{resolve:(r:any)=>{clearTimeout(timer);resolve(r);},reject:(e:any)=>{clearTimeout(timer);reject(e);}});proc.stdin.write(JSON.stringify({id:key,method,params})+'\n');});
try{
 await rpc('initialize',{clientInfo:{name:'tokenflow_image_fixture',version:'1'},capabilities:{experimentalApi:true}});proc.stdin.write('{"method":"initialized"}\n');
 const start=await rpc('thread/start',{cwd:root,model:model.slug,approvalPolicy:'never',sandbox:'danger-full-access'});
 for(operation of ['generate','edit']){
  requested=false;const first=events.length;
  await rpc('turn/start',{threadId:start.thread.id,input:[{type:'text',text:'Run the synthetic image fixture.'}]});
  const deadline=Date.now()+20000;let completed;
  while(Date.now()<deadline){completed=events.slice(first).find(e=>e.method==='turn/completed');if(completed)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(completed?.params.turn.status,'completed',JSON.stringify(completed?.params.turn.error));
  const image=events.slice(first).find(e=>e.method==='item/completed'&&e.params.item?.type==='imageGeneration')?.params.item;
  assert.equal(image?.status,'completed',JSON.stringify({operation,image,methods:[...new Set(events.slice(first).map(e=>e.method))],stderr}));
  assert.ok(image.savedPath?.startsWith(root),'Image must be saved inside the isolated fixture');
  assert.ok((await readFile(image.savedPath)).length>0);
 }
 assert.deepEqual(images.map(i=>i.path),['/backend-api/codex/images/generations','/backend-api/codex/images/edits']);
 assert.ok(images.every(i=>i.authenticated&&i.turnId&&i.model==='gpt-image-2'));assert.equal(images[1].referenceCount,1);assert.equal(usage.length,2);
 console.log(JSON.stringify({passed:true,scope:'Installed Codex native image tool; synthetic auth and upstream; no production calls',images,usageRequests:usage.length}));
}finally{
 await new Promise<void>(r=>{if(proc.exitCode!==null||proc.signalCode!==null)return r();proc.once('exit',()=>r());proc.kill();});
 await app.close();await rm(root,{recursive:true,force:true});
}
