// Installed Codex runtime with an isolated, genuinely large uncompacted history.
// --client-only disables only gateway takeover in this test, not client compaction.
// --live sends synthetic history to the selected local source; --model defaults to codex/gpt-6-luna.
// --large-history seeds twelve 1 MiB assistant batches, not merely a large rollout file.
// --known-usage seeds prior usage metadata (150k), NOT a measurement of those batches.
// --total-scope / --remote-compaction / --normalize-context-error are test-only variants.
// --single-attempt disables stream reconnects in diagnostic variants, not compaction.
// RESULT_PATH saves metadata only; no credentials or original conversation content.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {zstdDecompressSync} from 'node:zlib';
import {mkdtemp,writeFile,readFile,rm,realpath,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import YAML from 'yaml';
import {compactionModelWindow} from '../packages/core/src/initial-compaction.ts';
import {upstreamRequest,finishUpstream,inferenceFetch} from '../packages/core/src/upstream-request.ts';
import {codexWebSearch} from '../packages/core/src/codex-web-search.ts';
import {GatewayContext} from '../packages/core/src/gateway-context.ts';
import {CodexContext,codexContextScope,portableCodexItem} from '../packages/core/src/codex-context.ts';
import {AgentConnections} from '../packages/core/src/agent-connections.ts';
assert.ok(!process.argv.includes('--migration-bootstrap'),'Switch-time compaction was removed; run without --migration-bootstrap to test lazy first continuation.');
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-first-long-history-'));
const binary=process.argv[2]??'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const clientOnly=process.argv.includes('--client-only'),live=process.argv.includes('--live');
const largeHistory=process.argv.includes('--large-history');
const diagnosticDelayMs=Number(process.argv.find(value=>value.startsWith('--summary-delay-ms='))?.split('=')[1]??0);
const clientIdleMs=Number(process.argv.find(value=>value.startsWith('--client-idle-ms='))?.split('=')[1]??0);
const normalizeContextError=process.argv.includes('--normalize-context-error');
const abort=new AbortController();
const model=process.argv.find(value=>value.startsWith('--model='))?.slice(8)??'codex/gpt-6-luna';const marker='LONG_HISTORY_ANCHOR_'+randomUUID().replaceAll('-','');
const runStarted=performance.now();
const calls=[],upstream=[],progress=[],reports=[],clientUsage=[];let phase=0,child,responseID=0,turnResult,reply='',seedTools=0;
const context=await GatewayContext.open(root),migration=new CodexContext(root,join(root,'config.toml'),context);
let endpoint,key;const contextWindowTokens=live?await compactionModelWindow(model,[],join(homedir(),'.codex/config.toml')):undefined;
console.log(JSON.stringify({modelContextWindow:contextWindowTokens??null}));
let seedAnswer='';
if(largeHistory){const lines=[];let bytes=0;while(bytes<1024*1024){const line=`archive/component.ts record ${lines.length}: build=${randomUUID()} dependency=${randomUUID()} validation=passed; archived synthetic fixture only.\n`;lines.push(line);bytes+=Buffer.byteLength(line);}seedAnswer=lines.join('');}
if(live){const config=YAML.parse(await readFile(join(homedir(),'Library/Application Support/desktop-browser-agent/cliproxy/config.yaml'),'utf8'));endpoint=`http://127.0.0.1:${config.port}/v1/responses`;key=config['api-keys'][0];}
function synthetic(body,answer,tool=false){
 const id=++responseID,item=tool?{id:`fc_${id}`,type:'function_call',call_id:`seed_${id}`,name:'exec_command',arguments:JSON.stringify({cmd:"python3 -c \"print('archive/component.ts: export const value = 42;\\n' * 800)\"",max_output_tokens:16000})}:{id:`msg_${id}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
 const inputTokens=phase>0&&body.instructions?.startsWith('Summarize the supplied')&&process.argv.includes('--expensive-summary')?1000000:phase===0&&!tool&&process.argv.includes('--known-usage')?150000:100;
 const usage={input_tokens:inputTokens,output_tokens:20,total_tokens:inputTokens+20};
 const response={id:`resp_${id}`,object:'response',created_at:Math.floor(Date.now()/1000),model:body.model,status:'completed',output:[item],usage};
 if(!body.stream)return Response.json(response);
 const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
 return new Response(events.map((event,sequence_number)=>`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);let bytes=Buffer.concat(chunks);if(req.headers['content-encoding']==='zstd')bytes=zstdDecompressSync(bytes);const raw=bytes.toString();
 const body=JSON.parse(raw||'{}'),trigger=body.input?.some(item=>item.type==='compaction_trigger'),localCompact=JSON.stringify(body.input?.at(-1)).includes('CONTEXT CHECKPOINT COMPACTION');
 const request={phase,path:req.url,bytes:Buffer.byteLength(raw),items:body.input?.length,trigger:!!trigger,localCompact,model:body.model};calls.push(request);
 if(phase>0||calls.length===1)console.log(JSON.stringify({clientRequest:request}));
 const lifetime=upstreamRequest();let initial=false;const cancel=()=>lifetime.abort();abort.signal.addEventListener('abort',cancel,{once:true});res.on('close',()=>{if(!res.writableFinished)cancel();});
 const rawSend=async(_path,forward,clock)=>{
  forward=codexWebSearch(forward);
  const summary=forward.instructions?.startsWith('Summarize the supplied'),bytes=Buffer.byteLength(JSON.stringify(forward)),hasAnchor=JSON.stringify(forward.input).includes(marker);
  const upstreamStarted=performance.now();const entry={phase,summary:!!summary,bytes,hasAnchor,model:forward.model};upstream.push(entry);
  if(phase===0)return largeHistory?synthetic(forward,seedAnswer):synthetic(forward,'Archived directory checks completed.',seedTools++<48);
  if(live){
   assert.equal(forward.model,model,'live requests must use only the authorized selected model');
   const result=await inferenceFetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(forward),signal:clock.signal});
   entry.status=result.status;if(!result.ok){const error=await result.clone().json().catch(()=>null);entry.errorCode=error?.error?.code??error?.code;entry.errorType=error?.error?.type;entry.errorMessage=String(error?.error?.message??error?.message??'').slice(0,500); }console.log(JSON.stringify({upstream:entry}));
   if(!result.body||(result.headers.get('content-type')??'').indexOf('text/event-stream')<0)return result;
   const decoder=new TextDecoder();let pending='';entry.events={};
   const inspect=line=>{
    if(!line.startsWith('data:'))return line;
    let event;try{event=JSON.parse(line.slice(5));}catch{return line;}
    if(['response.completed','response.failed','response.incomplete'].includes(event.type))entry.durationMs=Math.round(performance.now()-upstreamStarted);
    const type=event.type??'untyped';entry.events[type]=(entry.events[type]??0)+1;
    const error=event.error??event.response?.error??(event.type==='error'?event:undefined);
    if(error){
     entry.streamError={code:error.code,type:error.type,message:String(error.message??'').slice(0,500)};
     console.log(JSON.stringify({upstreamStreamError:entry.streamError}));
    }
    if(event.response?.usage){
     const {input_tokens,output_tokens,total_tokens,input_tokens_details,output_tokens_details}=event.response.usage;
     entry.usage={input_tokens,output_tokens,total_tokens,input_tokens_details,output_tokens_details};
    }
    // Preserve the real error by default. This adapter is an explicit experiment,
    // not a production gateway repair or a manufactured capacity rejection.
    if(normalizeContextError&&event.type==='error'&&error?.code==='context_too_large'){
     entry.normalizedContextError=true;
     return 'data: '+JSON.stringify({type:'response.failed',response:{id:'resp_context_fixture',object:'response',status:'failed',error:{code:'context_length_exceeded',message:error.message}}});
    }
    if(entry.durationMs!==undefined&&['response.completed','response.failed','response.incomplete'].includes(event.type))console.log(JSON.stringify({upstreamTerminal:entry}));
    return line;
   };
   const stream=result.body.pipeThrough(new TransformStream({transform(chunk,controller){pending+=decoder.decode(chunk,{stream:true});let end;while((end=pending.indexOf('\n'))>=0){const line=inspect(pending.slice(0,end));pending=pending.slice(end+1);controller.enqueue(new TextEncoder().encode(line+'\n'));}},flush(controller){if(pending)controller.enqueue(new TextEncoder().encode(inspect(pending)));console.log(JSON.stringify({upstreamEnd:entry}));}}));
   return clock.watch(new Response(stream,{status:result.status,headers:result.headers}));
  }
  if(summary&&diagnosticDelayMs)await delay(diagnosticDelayMs,undefined,{signal:clock.signal});
  // Fixture capacity models a source smaller than the inherited raw history.
  // This is test data, not a production gateway request limit.
  if(bytes>256*1024){entry.status=400;return Response.json({error:{message:'Your input exceeds the context window of this model. Please adjust your input and try again.',type:'invalid_request_error',code:'context_length_exceeded',param:'input'}},{status:400});}
  entry.status=200;return synthetic(forward,summary||localCompact?`Goal: preserve ${hasAnchor?marker:'ANCHOR_MISSING'}. Archived directory checks are complete. Continue with the latest user instruction.`:hasAnchor?marker:'ANCHOR_MISSING');
 };
 const send=async(path,forward)=>{
  const clock=initial?upstreamRequest():lifetime;const stop=()=>clock.abort();if(initial)lifetime.signal.addEventListener('abort',stop,{once:true});if(lifetime.signal.aborted)clock.abort();
  const detach=()=>lifetime.signal.removeEventListener('abort',stop);
  try{const result=await rawSend(path,forward,clock);return initial?finishUpstream(result,detach):result;}catch(error){if(initial){detach();}throw error;}
 };
 try{
  const response=phase===0||req.url.startsWith('/original/')?await send('responses',body):await context.response(req.url.endsWith('/compact')?'responses/compact':'responses',body,'fixture-key','fixture-source',send,{rebuildsInstructions:true,bootstrapHistory:'official-history-import',contextWindowTokens,scope:codexContextScope,...(clientOnly?{}:{threadId:req.headers.session_id??req.headers['session-id']}),recover:item=>migration.recover(item,[]),normalize:portableCodexItem},{signal:lifetime.signal,onCancel:cancel,onInitialCompaction:active=>{initial=active;},onCompaction:report=>{reports.push(report);console.log(JSON.stringify({compactionReport:report}));}});
  res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)for await(const chunk of response.body)res.write(chunk);res.end();
 }catch(error){console.log(JSON.stringify({gatewayError:{code:error.code,status:error.statusCode}}));res.writeHead(error.statusCode??500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message,code:error.code}}));}finally{abort.signal.removeEventListener('abort',cancel);}
});
async function start(){
 const args=['app-server','--listen','stdio://'];
 if(phase>0){
  if(clientIdleMs)args.push('-c','model_providers.token_flow.stream_idle_timeout_ms='+clientIdleMs);
  if(process.argv.includes('--single-attempt'))args.push('-c','model_providers.token_flow.stream_max_retries=0');
  if(process.argv.includes('--total-scope'))args.push('-c','model_auto_compact_token_limit_scope="total"');
  // Codex gates its remote compaction protocol on this provider identity.
  // The destination and authorized model remain the same local Luna source.
  if(process.argv.includes('--remote-compaction'))args.push('-c','model_providers.token_flow.name="OpenAI"');
 }
 const proc=child=spawn(binary,args,{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:root},stdio:['pipe','pipe','pipe']});
 let buffer='',sequence=0,complete;const pending=new Map();
 proc.stderr.on('data',()=>{});
 proc.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let message;try{message=JSON.parse(line);}catch{continue;}const waiting=pending.get(message.id);if(waiting){pending.delete(message.id);message.error?waiting.reject(Error(JSON.stringify(message.error))):waiting.resolve(message.result);}if(message.params?.item?.type==='contextCompaction'){progress.push({phase,method:message.method});console.log(JSON.stringify({clientCompaction:progress.at(-1)}));}if(phase>0&&message.method==='thread/tokenUsage/updated'){clientUsage.push(message.params.tokenUsage);console.log(JSON.stringify({clientTokenUsage:message.params.tokenUsage}));}if(message.method==='error')console.log(JSON.stringify({clientError:message.params}));if(message.method==='item/completed'&&message.params.item.type==='agentMessage')reply+=message.params.item.text??'';if(message.method==='turn/completed')complete?.(message.params.turn);}});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(Error('RPC timeout '+method)),30000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});proc.stdin.write(JSON.stringify({id,method,params})+'\n');});
 await rpc('initialize',{clientInfo:{name:'first_long_history_fixture',version:'1.0'},capabilities:{experimentalApi:true}});proc.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 return {rpc,turn:async(threadId,text)=>{reply='';let timer;const done=new Promise((resolve,reject)=>{complete=resolve;timer=setTimeout(()=>reject(Error('Turn timed out')),live?900000:60000);});try{await rpc('turn/start',{threadId,input:[{type:'text',text}]});return await done;}finally{clearTimeout(timer);}},stop:()=>new Promise(resolve=>{proc.once('exit',resolve);proc.kill();})};
}
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 await writeFile(join(root,'config.toml'),`model = "native-fixture"\nmodel_provider = "original"\nmodel_auto_compact_token_limit = 100000000\n[model_providers.original]\nname = "Original fixture"\nbase_url = "${origin}/original/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nexperimental_bearer_token = "fixture-key"\n`);
 let client=await start();const first=await client.rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'}),threadId=first.thread.id;
 assert.equal((await client.turn(threadId,`Remember the exact audit marker ${marker} for the final answer. Run the synthetic archived directory checks.`)).status,'completed');
 if(largeHistory)for(let round=1;round<12;round++){assert.equal((await client.turn(threadId,`Archive synthetic validation batch ${round}; retain the original audit requirement.`)).status,'completed');console.log(JSON.stringify({seedRound:round+1}));}
 await client.stop();
 const rollouts=[];async function find(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await find(path);else if(entry.name.endsWith('.jsonl'))rollouts.push(path);}}await find(join(root,'sessions'));
 const saved=await readFile(rollouts[0],'utf8');assert.ok(!saved.includes('"type":"compacted"')&&!saved.includes('"type":"compaction"'),'fixture must have no summary');assert.ok(saved.includes('archive/component.ts'));
 const history=saved.split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(event=>event.type==='response_item').map(event=>event.payload);
 if(largeHistory)assert.ok(Buffer.byteLength(JSON.stringify(history))>10*1024*1024,'effective history must exceed 10 MiB');
 console.log(JSON.stringify({history:{items:history.length,bytes:Buffer.byteLength(JSON.stringify(history)),rolloutBytes:Buffer.byteLength(saved),hasSummary:false}}));
 // The high threshold belongs only to fixture seeding. Do not carry it into the actual Codex test.
 await writeFile(join(root,'config.toml'),(await readFile(join(root,'config.toml'),'utf8')).replace(/^model_auto_compact_token_limit = 100000000\n/m,''));
 const connections=new AgentConnections(root,{codex:join(root,'config.toml')},async()=>[]);
 const connection=await connections.apply({target:'codex',revision:(await connections.status()).find(item=>item.id==='codex').revision,origin,model,sourceId:'a'.repeat(24),keyId:randomUUID(),key:'fixture-key'});
 const appliedConfig=await readFile(join(root,'config.toml'),'utf8');assert.ok(!/^model_auto_compact_token_limit\s*=/m.test(appliedConfig),'seed-only threshold leaked into the gateway test');
 assert.equal(reports.length,0,'switching must not start compaction');
 phase=1;const bootstrapCompactions=0;
 client=await start();await client.rpc('thread/resume',{threadId,model,modelProvider:'token_flow',approvalPolicy:'never',sandbox:'read-only'});
 const continuation='Continue the archived task. Reply only with the exact audit marker from the earliest task requirement. Do not call tools or read files.';
 const firstStarted=performance.now();turnResult=await client.turn(threadId,continuation);const firstTurnMs=Math.round(performance.now()-firstStarted);const firstTurnStatus=turnResult.status;const firstError=turnResult.error;
 if(process.argv.includes('--retry-turn')){console.log(JSON.stringify({firstTurnStatus,firstError}));turnResult=await client.turn(threadId,continuation);}
 const resumed=[];if(process.argv.includes('--resume-after')&&turnResult.status==='completed'){await client.stop();client=await start();await client.rpc('thread/resume',{threadId,model,modelProvider:'token_flow',approvalPolicy:'never',sandbox:'read-only'});const reuseStarted=performance.now();turnResult=await client.turn(threadId,continuation);resumed.push({durationMs:Math.round(performance.now()-reuseStarted),status:turnResult.status,earliestRequirementPreserved:reply.includes(marker)});}
 let followupTiming;
 if(process.argv.includes('--measure-followup')){
 const followup=[...history,{role:'user',content:'Continue the same synthetic audit; preserve the earliest marker.'},...Array.from({length:32},(_,index)=>({role:'assistant',content:('Synthetic followup batch '+index+': verified package build and retained routing rules. ').repeat(120)})),{role:'user',content:'Continue with the latest synthetic audit results.'},{type:'compaction_trigger'}];
 const summariesBefore=upstream.filter(item=>item.summary).length;const followupStarted=performance.now();
 const followupResponse=await fetch(origin+'/v1/responses',{method:'POST',headers:{'content-type':'application/json',session_id:threadId},body:JSON.stringify({model,input:followup,store:false,stream:false})});
 const followupResult=await followupResponse.json();assert.equal(followupResponse.status,200,JSON.stringify(followupResult));
 followupTiming={durationMs:Math.round(performance.now()-followupStarted),rawHistoryBytes:Buffer.byteLength(JSON.stringify(followup)),newSummaryCalls:upstream.filter(item=>item.summary).length-summariesBefore,report:reports.at(-1)};
 }
 const latestSaved=await readFile(rollouts[0],'utf8');const persistedCompactions=latestSaved.split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(event=>event.type==='compacted'||event.type==='response_item'&&event.payload?.type==='compaction').length;
 let officialReturn;
 if(process.argv.includes('--return-official')){
  assert.ok(!live,'Official-return fixture uses a synthetic official provider');
  await client.stop();const summaries=reports.length;
  const materialized=await migration.prepareOfficial([],async()=>[]);assert.ok(materialized.migrated>0,'Initial inline checkpoint must be restored to text');
  await connections.restore(connection.id);phase=2;client=await start();
  await client.rpc('thread/resume',{threadId,model:'native-fixture',modelProvider:'original',approvalPolicy:'never',sandbox:'read-only'});
  turnResult=await client.turn(threadId,continuation);assert.equal(turnResult.status,'completed');assert.ok(reply.includes(marker));
  assert.equal(reports.length,summaries,'Returning to official must not run another gateway summary');
  const request=calls.filter(call=>call.phase===2).at(-1);assert.ok(request.path.startsWith('/original/'));assert.ok(request.bytes<200000,'Official must receive the saved summary, not replay the 12 MB original');
  officialReturn={passed:true,requestBytes:request.bytes,earliestRequirementPreserved:true};
 }
 const preserved=reply.includes(marker),clientCompactions=progress.filter(item=>item.phase===1&&item.method==='item/started').length;
 if(!live&&process.argv.includes('--expensive-summary')){assert.ok(reports[0].inputTokens>=1000000);assert.equal(clientUsage.at(-1)?.last.inputTokens,100,'Summary charges contaminated the live Codex context');}
 const result={reports,progress,clientUsage,timing:{firstTurnMs,firstCompaction:reports[0],reuse:resumed,followup:followupTiming},passed:turnResult.status==='completed'&&preserved,clientOnly,live,largeHistory,bootstrapCompactions,normalizeContextError,remoteCompaction:process.argv.includes('--remote-compaction'),seedThresholdCleared:true,seedReportedInputTokens:process.argv.includes('--known-usage')?150000:100,totalScope:process.argv.includes('--total-scope'),persistedCompactions,resumed,firstTurnStatus,firstError,retryTurn:process.argv.includes('--retry-turn'),singleAttempt:process.argv.includes('--single-attempt'),knownUsage:process.argv.includes('--known-usage'),model,turnStatus:turnResult.status,errorCode:turnResult.error?.codexErrorInfo??null,historyBytes:Buffer.byteLength(JSON.stringify(history)),clientCompactions,gatewayCompactions:reports.length,summaryCalls:upstream.filter(item=>item.summary).length,sourceContextErrors:upstream.filter(item=>item.errorCode==='context_length_exceeded'||item.streamError?.code==='context_too_large'||item.streamError?.code==='context_length_exceeded').length,earliestRequirementPreserved:preserved,requests:calls.filter(item=>item.phase===1),upstream:upstream.filter(item=>item.phase===1)};
 result.officialReturn=officialReturn;
 console.log(JSON.stringify(result));if(process.env.RESULT_PATH)await writeFile(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');await client.stop();
 assert.ok(result.passed,'long uncompacted history did not continue with the earliest requirement');
}catch(error){
 if(process.env.RESULT_PATH)await writeFile(process.env.RESULT_PATH,JSON.stringify({passed:false,error:String(error),elapsedMs:Math.round(performance.now()-runStarted),model,live,largeHistory,requests:calls.filter(item=>item.phase>0),upstream:upstream.filter(item=>item.phase>0),reports},null,2)+'\n');
 throw error;
}finally{abort.abort();if(child&&child.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(process.env.KEEP_FIXTURE)console.log(JSON.stringify({fixture:root}));else await rm(root,{recursive:true,force:true});}
