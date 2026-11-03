import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {zstdDecompressSync,gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';

// Research-only: installed Codex with a synthetic local Responses server.
// No real supplier, credentials, user history, or TokenFlow service is used.
const [binary,catalogPath]=process.argv.slice(2);
assert.ok(binary&&catalogPath,'Usage: node codex-direct-api-probe.mjs <codex binary> <DeepSeek catalog JSON>');
const root=await mkdtemp(join(tmpdir(),'tokenflow-direct-probe-'));
const runhome=join(root,'home'),work=join(root,'work');
await mkdir(runhome);await mkdir(work);
const catalog=JSON.parse(await readFile(catalogPath,'utf8'));
catalog.models=catalog.models.filter(m=>m.slug==='deepseek-flash');
assert.equal(catalog.models.length,1);
catalog.models[0].base_instructions='Reply with the requested text. Do not call tools.';
await writeFile(join(root,'models.json'),JSON.stringify(catalog));
const requests=[];
const server=createServer(async(req,res)=>{
 try{
  let bytes=Buffer.concat(await Array.fromAsync(req));
  if(req.headers['content-encoding']==='zstd')bytes=zstdDecompressSync(bytes);
  if(req.headers['content-encoding']==='gzip')bytes=gunzipSync(bytes);
  const body=JSON.parse(bytes.toString());
  requests.push({path:req.url,model:body.model,effort:body.reasoning?.effort,stream:body.stream,authIsSynthetic:req.headers.authorization==='Bearer synthetic-direct-probe-key',inputTypes:[...new Set(body.input.map(i=>i.type))]});
  const item={id:'msg_synthetic_direct',type:'message',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:'DIRECT_PROBE_OK',annotations:[]}]};
  const response={id:'resp_synthetic_direct',object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'deepseek-flash',output:[item],usage:{input_tokens:10,output_tokens:3,total_tokens:13}};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  for(const event of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'DIRECT_PROBE_OK'},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
 }catch(e){res.writeHead(500);res.end('synthetic probe failed');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`model="deepseek-flash"\nmodel_provider="deepseek_probe"\nmodel_catalog_json=${JSON.stringify(join(root,'models.json'))}\nmodel_reasoning_effort="high"\nweb_search="disabled"\n[analytics]\nenabled=false\n[model_providers.deepseek_probe]\nname="Synthetic direct endpoint"\nbase_url="http://127.0.0.1:${server.address().port}"\nwire_api="responses"\nenv_key="DEEPSEEK_PROBE_KEY"\nrequires_openai_auth=false\nsupports_websockets=false\n[model_providers.deepseek_probe.capabilities]\nremote_compaction="unsupported"\n`;
await writeFile(join(runhome,'config.toml'),base);
const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:runhome,CODEX_HOME:runhome,TMPDIR:root,DEEPSEEK_PROBE_KEY:'synthetic-direct-probe-key',RUST_LOG:'error'};
const run=async(extra=[])=>{
 const child=spawn(binary,['exec','--skip-git-repo-check','--sandbox','read-only','--json',...extra,'Reply DIRECT_PROBE_OK without using any tools.'],{cwd:work,env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const timeout=setTimeout(()=>child.kill('SIGKILL'),30000);
 const status=await new Promise(r=>child.on('exit',(code,signal)=>r({code,signal})));clearTimeout(timeout);
 return {...status,stdout,stderr};
};
try{
 const result=await run();assert.equal(result.code,0,result.stderr.slice(-1000));assert.ok(result.stdout.includes('DIRECT_PROBE_OK'));
 const goodRequests=requests.slice();assert.equal(goodRequests.length,1);assert.equal(goodRequests[0].path,'/responses');assert.equal(goodRequests[0].model,'deepseek-flash');assert.equal(goodRequests[0].authIsSynthetic,true);
 const bad=await run(['-c','model_providers.deepseek_probe.wire_api="chat"']);assert.notEqual(bad.code,0);assert.equal(requests.length,goodRequests.length);assert.match(bad.stderr,/chat.*no longer supported|only.*responses|unknown variant/i);
 const report={realSupplierInvoked:false,tokenFlowInvoked:false,isolatedHome:true,directResponses:{passed:true,requests:goodRequests},chatWireRejectedBeforeRequest:true,rejection:bad.stderr.split('\n').filter(x=>/chat|responses|wire_api/i.test(x)).join(' ').slice(0,600)};
 console.log(JSON.stringify(report,null,2));
}finally{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
