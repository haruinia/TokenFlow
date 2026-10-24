/** Isolated real-engine protocol validation; synthetic auth and loopback responses only. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {stringify} from 'smol-toml';
const root=await mkdtemp(join(tmpdir(),'tf-bridge-tools-')),home=join(root,'codex');await mkdir(home);
await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-no-inference'}),{mode:0o600});
const cached=JSON.parse(await readFile(join(homedir(),'.codex/models_cache.json'),'utf8'));const catalog=join(root,'models.json');await writeFile(catalog,JSON.stringify({models:cached.models}));
let phase='setup',called=false;const requests:any[]=[],toolCalls:any[]=[],events:any[]=[];
const fixture=createServer(async(req,res)=>{
 if(req.method!=='POST'){res.writeHead(404);res.end();return;}
 let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw),tools=body.tools??[];requests.push({phase,effort:body.reasoning?.effort,tier:body.service_tier});
 const call=phase.endsWith('-tool')&&!called;called=true;
 const item=call?{type:'function_call',id:'fc_'+phase,call_id:'call_'+phase,name:'bridge_echo',arguments:JSON.stringify({text:phase})}:{type:'message',id:'msg_'+requests.length,role:'assistant',content:[{type:'output_text',text:'Fixture acknowledged '+phase}]};
 const response={id:'resp_'+requests.length,status:'completed',model:body.model,output:[item],usage:{input_tokens:100,output_tokens:10,total_tokens:110}};
 res.writeHead(200,{'content-type':'text/event-stream'});res.end([{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
});
await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));const fixtureURL=`http://127.0.0.1:${(fixture.address() as any).port}/v1`;
await writeFile(join(home,'config.toml'),stringify({model:'gpt-6-astra',model_provider:'openai',openai_base_url:fixtureURL,model_catalog_json:catalog,cli_auth_credentials_store:'file',features:{apps:false},analytics:{enabled:false},model_providers:{token_flow:{name:'Probe only',base_url:fixtureURL,wire_api:'responses',experimental_bearer_token:'fixture',requires_openai_auth:false,capabilities:{remote_compaction:'unsupported'}}}}));
const bridge=join(root,'bridge.mjs');await copyFile('/tmp/tokenflow-bridge-build/codex-provider-bridge-entry.js',bridge);await writeFile(join(root,'settings.json'),JSON.stringify({binary:'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',officialModels:['gpt-6-astra'],gatewayModels:['fixture-gateway']}));
const proc=spawn('/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node',[bridge,'app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,OPENAI_BASE_URL:fixtureURL},stdio:['pipe','pipe','pipe']});proc.stderr!.resume();
let buffer='',seq=0,error:string|undefined;const pending=new Map<number,any>();
const send=(m:any)=>proc.stdin!.write(JSON.stringify(m)+'\n');
proc.stdout!.on('data',c=>{buffer+=c;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='item/tool/call'){toolCalls.push({phase,tool:m.params.tool,arguments:m.params.arguments});send({id:m.id,result:{contentItems:[{type:'inputText',text:JSON.stringify(m.params.arguments)}],success:true}});}else if(m.method)events.push(m);}});
const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('Timeout '+method));},30000);pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v)},reject:(e:any)=>{clearTimeout(t);reject(e)}});send({id,method,params});});
try{
 await rpc('initialize',{clientInfo:{name:'bridge_tool_fixture',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
 const result=await rpc('thread/start',{cwd:root,model:'gpt-6-astra',modelProvider:'openai',approvalPolicy:'never',sandbox:'read-only',dynamicTools:[{type:'function',deferLoading:false,name:'bridge_echo',description:'Echo fixture',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]});const threadId=result.thread.id;
 const turn=async(name:string,model:string)=>{
  phase=name;called=false;const from=events.length,before=toolCalls.length;
  const value=await rpc('turn/start',{threadId,model,effort:'high',serviceTier:'priority',input:[{type:'text',text:'Call bridge_echo once, then acknowledge.'}]});
  for(let n=0;!events.slice(from).some(e=>e.method==='turn/completed'&&e.params.turn.id===value.turn.id);n++){assert.ok(n<1000,'turn timeout');await new Promise(r=>setTimeout(r,10));}
  assert.equal(events.slice(from).find(e=>e.method==='turn/completed'&&e.params.turn.id===value.turn.id).params.turn.status,'completed');assert.equal(toolCalls.length,before+1,'Dynamic tool did not survive '+name);assert.ok(requests.filter(r=>r.phase===name).every(r=>r.effort==='high'&&(model==='fixture-gateway'||r.tier==='priority')),'Reasoning/fast tier changed '+name);
 };
 await turn('official-tool','gpt-6-astra');phase='switch-gateway';await rpc('thread/settings/update',{threadId,model:'fixture-gateway'});await turn('gateway-tool','fixture-gateway');
 phase='switch-official';await rpc('thread/settings/update',{threadId,model:'gpt-6-astra'});await turn('official-again-tool','gpt-6-astra');
 assert.equal(proc.exitCode,null);
}catch(e){error=e instanceof Error?e.message:'Failed';process.exitCode=1;}
finally{if(proc.exitCode===null&&proc.signalCode===null)await new Promise<void>(r=>{proc.once('exit',()=>r());proc.kill();});fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));await rm(root,{recursive:true,force:true});}
const report={passed:!error,scope:'Actual installed engine + stdio bridge, synthetic credentials + loopback Responses fixture, dynamic tools across provider roundtrip',...(error?{error}:{}),toolCalls,requests};console.log(JSON.stringify(report));const out=process.argv.indexOf('--out');if(out>=0)await writeFile(resolve(process.argv[out+1]),JSON.stringify(report,null,2)+'\n');
