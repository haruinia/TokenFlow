// Installed native Codex, isolated home and a synthetic local model. No paid
// inference or user configuration changes. Compare legacy vs native log budget.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {zstdDecompressSync} from 'node:zlib';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {codexRuntimeClient} from '../packages/core/src/codex-runtime.js';
import {codexModelCatalog} from '../packages/core/src/codex-model-catalog.js';
const results:any[]=[];
for(const limit of [Number.MAX_SAFE_INTEGER,10000]){
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-native-output-'));
 let runtime:Awaited<ReturnType<typeof codexRuntimeClient>>|undefined,requests=0;
 let resolve!:(v:any)=>void,reject!:(e:unknown)=>void;const observed=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});
 const server=createServer(async(req,res)=>{try{
  const parts=[];for await(const chunk of req)parts.push(chunk);let bytes=Buffer.concat(parts);if(req.headers['content-encoding']==='zstd')bytes=zstdDecompressSync(bytes);
  const body=JSON.parse(bytes.toString());requests++;
  const output=body.input?.findLast((i:any)=>i.type==='function_call_output');
  if(output){const text=typeof output.output==='string'?output.output:JSON.stringify(output.output);resolve({limit,bytes:Buffer.byteLength(text),hasStart:text.includes('LOG_START'),hasEnd:text.includes('LOG_END'),truncated:/truncat|omitted/i.test(text)});}
  assert.ok(requests<=3,'Native tool failed to return');
  const item=output?{type:'message',id:'msg_done',role:'assistant',content:[{type:'output_text',text:'Done',annotations:[]}]}:{type:'function_call',id:'fc_log',call_id:'log',name:'exec_command',arguments:JSON.stringify({cmd:process.execPath+' -e '+JSON.stringify("process.stdout.write('LOG_START\\n'+'line of synthetic log\\n'.repeat(12000)+'LOG_END\\n')"),max_output_tokens:100000})};
  const response={id:'resp_'+requests,object:'response',created_at:1,model:'fixture',status:'completed',output:[item],usage:{input_tokens:100,output_tokens:10,total_tokens:110}};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
 }catch(e){reject(e);res.writeHead(500);res.end();}});
 try{
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number};
  const catalog=codexModelCatalog('fixture');catalog.models[0]!.truncation_policy.limit=limit;
  await writeFile(join(root,'catalog.json'),JSON.stringify(catalog));
  await writeFile(join(root,'config.toml'),`model="fixture"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(join(root,'catalog.json'))}\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nexperimental_bearer_token="fixture"\n`);
  runtime=await codexRuntimeClient(root);
  const thread=await runtime.rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'});
  await runtime.rpc('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Run the synthetic log check.'}]});
  let timer:ReturnType<typeof setTimeout>|undefined;try{results.push(await Promise.race([observed,new Promise((_,no)=>{timer=setTimeout(()=>no(Error('Native tool observation timed out')),60000);})]));}finally{clearTimeout(timer);}
 }finally{await runtime?.close();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
}
assert.ok(results[0].bytes>200000,'Legacy output must actually be large');
assert.ok(results[1].bytes<15000&&results[1].truncated,'Native bound must be applied visibly');
assert.ok(results[1].hasStart&&results[1].hasEnd,'Native head/tail context must remain');
console.log(JSON.stringify({passed:true,paidRequests:0,results}));
