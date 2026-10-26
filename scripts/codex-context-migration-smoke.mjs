// Real installed Codex, synthetic loopback Responses service, isolated history.
// Verifies model switching and persisted thread resume without paid calls.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {zstdDecompressSync} from 'node:zlib';
import {mkdtemp,writeFile,readFile,rm,realpath,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import YAML from 'yaml';
import {randomUUID,createHash} from 'node:crypto';
import {GatewayContext} from '../packages/core/src/gateway-context.ts';
import {CodexContext,codexContextScope} from '../packages/core/src/codex-context.ts';
import {AgentConnections} from '../packages/core/src/agent-connections.ts';
const localCompaction=!process.argv.includes('--remote-compaction');
const projectionPages=process.argv.includes('--projection-pages');const priorProjectionDamage=process.argv.includes('--prior-projection-damage'),alreadyRewrittenDamage=process.argv.includes('--already-rewritten-before-damage');let projectedTurns=0,projectedItems=0,forkVerified=false,ancestorFile,ancestorHash,durableThreadsBefore;
const root=await mkdtemp(join(await realpath(tmpdir()),'codex-continuation-'));
const calls=[];let child;let responseNumber=0;let phase=0;let tools=0;let compactions=0;const upstream=[],compactionProgress=[];
const liveOfficial=process.argv.includes('--live-official');let officialEndpoint,officialKey,officialReply='';let officialDurationMs=0;
if(liveOfficial){const config=YAML.parse(await readFile(join(homedir(),'Library/Application Support/desktop-browser-agent/cliproxy/config.yaml'),'utf8'));officialEndpoint=`http://127.0.0.1:${config.port}/v1/responses`;officialKey=config['api-keys'][0];}
const context=await GatewayContext.open(root);
const migration=new CodexContext(root,join(root,'config.toml'),context);
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);let raw=Buffer.concat(chunks);if(req.headers['content-encoding']==='zstd')raw=zstdDecompressSync(raw);
 const body=JSON.parse(raw.toString()||'{}');
 if(!req.url.endsWith('/responses')){res.writeHead(404);res.end('{}');return;}
 const threadId=req.headers.session_id??req.headers['session-id'];
 calls.push({path:req.url,body,threadId});
 const previousCalls=upstream.length;
 try {
 const send=async(_path,request)=>{
 upstream.push({phase,body:request});
 if(projectionPages&&phase===3&&JSON.stringify(request.input?.at(-1)).includes('FAILED_SOURCE_TURN_MARKER'))return Response.json({error:{type:'invalid_request_error',code:'fixture_failure',message:'Synthetic source failure'}},{status:400});
 if(liveOfficial&&phase===3){
  assert.ok(!request.input.some(item=>item.type==='compaction'),'gateway ciphertext must be materialized before native resume');
  assert.ok(JSON.stringify(request.input).includes('CHECKPOINT: Directory checks completed; preserve TURN_ONE_MARKER.'));
  const started=performance.now();const response=await fetch(officialEndpoint,{method:'POST',headers:{Authorization:'Bearer '+officialKey,'Content-Type':'application/json'},body:JSON.stringify({...request,model:'codex/gpt-6-luna'}),signal:AbortSignal.timeout(600000)});
  assert.ok(response.ok,'Official Luna source rejected restored plaintext');
  const data=await response.text();officialDurationMs=Math.round(performance.now()-started);
  return new Response(data,{status:response.status,headers:response.headers});
 }

 const summary=request.instructions?.startsWith('Summarize the supplied');
 const trigger=request.input?.some(i=>i.type==='compaction_trigger');
 const localCompact=JSON.stringify(request.input?.at(-1)).includes('CONTEXT CHECKPOINT COMPACTION');
 // The original synthetic provider uses Codex's built-in tool-output policy.
 // Seed enough retained tool results to exceed the 256 KiB migration target.
 const toolLimit=phase===1&&process.argv.includes('--auto-only')?0:phase===0&&process.argv.includes('--long-recovery')?32:6;
 const tool=!summary&&!trigger&&!localCompact&&(phase===0||phase===1)&&tools++<toolLimit;
 const n=++responseNumber,answer=summary||localCompact?'CHECKPOINT: Directory checks completed; preserve TURN_ONE_MARKER. '+[...new Set(JSON.stringify(request.input).match(/GATEWAY_REPEAT_\d+_MARKER|KEPT_BRANCH_MARKER/g)??[])].join(' '):`REPLY_${phase}_MARKER`;
 const item=trigger?{type:'compaction',encrypted_content:'official-fixture-checkpoint-'+n}:tool?{id:`fc_${n}`,type:'function_call',call_id:`call_${n}`,name:'exec_command',arguments:JSON.stringify({cmd:phase===0&&process.argv.includes('--long-recovery')?"python3 -c \"print('fixture-long-output ' * 2000)\"":'pwd',max_output_tokens:phase===0&&process.argv.includes('--long-recovery')?16000:64})}:{id:`msg_${n}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
 if(trigger)compactions++;
 const output=phase===1&&!summary&&!trigger&&!tool?[{id:`rs_chatcmpl_fixture_${n}`,type:'reasoning',encrypted_content:'',summary:[{type:'summary_text',text:'GATEWAY_REASONING_MARKER'}]},item]:[item];
 const response={id:`resp_${n}`,object:'response',created_at:Math.floor(Date.now()/1000),model:request.model,status:'completed',output,usage:{input_tokens:tool&&tools===toolLimit?(phase===1?300000:12000):100,output_tokens:1,total_tokens:tool&&tools===toolLimit?(phase===1?300001:12001):101}};
 if(!request.stream)return Response.json(response);
 const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},...output.flatMap((item,output_index)=>[{type:'response.output_item.added',output_index,item},{type:'response.output_item.done',output_index,item}]),{type:'response.completed',response}];
 return new Response(events.map((e,i)=>`event: ${e.type}\ndata: ${JSON.stringify({...e,sequence_number:i})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const response=req.url.startsWith('/original')?await send('responses',body):await context.response('responses',body,'fixture-key','fixture-source',send,{scope:codexContextScope,threadId,bootstrapHistory:phase>=4?'official-return-history':'official-first-history',recover:item=>migration.recover(item,[])});
 if(!req.url.startsWith('/original')&&calls.filter(call=>!call.path.startsWith('/original')&&call.threadId===threadId).length>1&&phase<4&&!body.input?.some(item=>item.type==='compaction_trigger'))assert.equal(upstream.slice(previousCalls).filter(call=>call.body.instructions?.startsWith('Summarize the supplied')).length,0,'ordinary continuation must wait for Codex to request compaction');
 res.writeHead(response.status,Object.fromEntries(response.headers));for await(const chunk of response.body)res.write(chunk);res.end();
 }catch(error){console.error(error);res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message}}));}

});
async function start(){
 child=spawn(process.argv[2]??'codex',['app-server','--listen','stdio://',...(!localCompaction?['-c','model_providers.token_flow.name="OpenAI"']:[])],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:root},stdio:['pipe','pipe','pipe']});
 const proc=child;let buffer='',id=0,turnResolve;const pending=new Map();
 proc.stderr.on('data',chunk=>{if(process.env.DEBUG_FIXTURE)process.stderr.write(chunk);});
 proc.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let msg;try{msg=JSON.parse(line);}catch{continue;}if(pending.has(msg.id)){const wait=pending.get(msg.id);pending.delete(msg.id);msg.error?wait.reject(Error(JSON.stringify(msg.error))):wait.resolve(msg.result);}if(msg.method&&(/compact/i.test(msg.method)||/compact/i.test(msg.params?.item?.type??'')))compactionProgress.push({phase,method:msg.method,itemType:msg.params?.item?.type});if(phase===3&&msg.method==='item/completed'&&msg.params.item?.type==='agentMessage')officialReply+=msg.params.item.text??'';if(msg.method==='turn/completed')turnResolve?.(msg.params.turn);}});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>reject(Error('RPC timeout: '+method)),30000);pending.set(key,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});proc.stdin.write(JSON.stringify({id:key,method,params})+'\n');});
 await rpc('initialize',{clientInfo:{name:'continuation_fixture',version:'1.0'},...(projectionPages?{capabilities:{experimentalApi:true}}:{})});proc.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 return {rpc,turn:async(threadId,model,text,expectedStatus='completed')=>{let timer;const done=new Promise((resolve,reject)=>{turnResolve=resolve;timer=setTimeout(()=>reject(Error('Turn timeout')),45000)});try{await rpc('turn/start',{threadId,model,input:[{type:'text',text}]});const result=await done;assert.equal(result.status,expectedStatus,JSON.stringify({phase,error:result.error}));return result;}finally{clearTimeout(timer);}},stop:()=>new Promise(r=>{proc.once('exit',r);proc.kill();})};
}
async function page(client,method,params){
 const values=[];let cursor;
 for(let count=0;count<1000;count++){
  const result=await client.rpc(method,{...params,limit:2,sortDirection:'asc',...(cursor?{cursor}:{})});
  assert.ok(Array.isArray(result.data));values.push(...result.data);
  if(!result.nextCursor)return values;
  assert.notEqual(result.nextCursor,cursor,'pagination failed to advance');cursor=result.nextCursor;
 }
 throw Error('pagination did not finish');
}
async function inspectProjection(client,thread){
 const turns=await page(client,'thread/turns/list',{threadId:thread,itemsView:'full'});
 const items=await page(client,'thread/items/list',{threadId:thread});
 assert.equal(new Set(turns.map(turn=>turn.id)).size,turns.length);
 const text=JSON.stringify(items);if(process.env.DEBUG_PROJECTION)console.log(JSON.stringify({projectionPhase:phase,turnCount:turns.length,itemCount:items.length,markers:['TURN_ONE_MARKER','KEPT_BRANCH_MARKER','REMOVED_BRANCH_MARKER','TURN_THREE_MARKER','TURN_FOUR_MARKER'].map(marker=>[marker,text.includes(marker)])}));assert.ok(text.includes('TURN_ONE_MARKER'));assert.ok(text.includes('KEPT_BRANCH_MARKER'));assert.ok(!text.includes('REMOVED_BRANCH_MARKER'));
 assert.ok(turns.length>=3);assert.ok(items.length>4);projectedTurns=turns.length;projectedItems=items.length;
}
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const paths={codex:join(root,'config.toml'),claude:join(root,'claude.json'),qoder:join(root,'qoder.json'),workbuddy:join(root,'workbuddy.json')};
 const original=`model = "native-fixture"\nmodel_provider = "original_fixture"\nmodel_context_window = 32000\nmodel_auto_compact_token_limit = 10000\n[model_providers.original_fixture]\nname = "OpenAI"\nbase_url = "${origin}/original/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nexperimental_bearer_token = "original-synthetic-key"\n`;
 await writeFile(paths.codex,original);
 const connections=new AgentConnections(root,paths,async()=>[]);
 let client=await start();const first=await client.rpc('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only'});const thread=first.thread.id;
 await client.turn(thread,'native-fixture','TURN_ONE_MARKER');
 if(process.argv.includes('--rollback-history')){
  tools=0;const removed=await client.turn(thread,'native-fixture','REMOVED_BRANCH_MARKER');
  await client.rpc('thread/revert',{threadId:thread,beforeTurnId:removed.id});
  tools=0;await client.turn(thread,'native-fixture','KEPT_BRANCH_MARKER');
 }
 await client.stop();
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin,model:'qoder/kmodel_latest',sourceId:'a'.repeat(24),selections:[{model:'qoder/kmodel_latest',sourceId:'a'.repeat(24)},{model:'workbuddy/hy4-preview',sourceId:'b'.repeat(24)}],keyId:randomUUID(),key:'gateway-synthetic-key'});
 phase=1;tools=0;client=await start();await client.rpc('thread/resume',{threadId:thread,model:'qoder/kmodel_latest',...(process.argv.includes('--implicit-provider')?{}:{modelProvider:'token_flow'})});
 await client.turn(thread,'qoder/kmodel_latest','TURN_TWO_MARKER');
 if(process.argv.includes('--repeat-gateway'))for(let round=1;round<=2;round++){
  tools=0;await client.turn(thread,'qoder/kmodel_latest',`GATEWAY_REPEAT_${round}_MARKER: preserve API compatibility.`);
 }
 phase=2;await client.turn(thread,'workbuddy/hy4-preview','TURN_THREE_MARKER');if(projectionPages)await inspectProjection(client,thread);await client.stop();
 if(priorProjectionDamage){
  if(alreadyRewrittenDamage)assert.ok((await migration.prepareOfficial([],async()=>[])).migrated>0);
  ancestorFile=(await readdir(join(root,'sessions'),{recursive:true})).find(path=>path.endsWith(`-${thread}.jsonl`));assert.ok(ancestorFile);ancestorFile=join(root,'sessions',ancestorFile);ancestorHash=createHash('sha256').update(await readFile(ancestorFile)).digest('hex');
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(root,'thread_history_1.sqlite'));const state=new DatabaseSync(join(root,'state_5.sqlite'),{readOnly:true});durableThreadsBefore=state.prepare('select count(*) as n from threads').get().n;state.close();
  for(const table of ['thread_turns','thread_items','thread_history_projection_state','thread_realtime_items'])db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(thread);db.close();
 }
 const requestsBeforeRepair=upstream.length;const migrated=await migration.prepareOfficial([],async()=>[]);assert.equal(upstream.length,requestsBeforeRepair,'projection repair must never start a model request');
 if(priorProjectionDamage){assert.equal(createHash('sha256').update(await readFile(ancestorFile)).digest('hex'),ancestorHash,'ancestor durable history changed during projection repair');const {DatabaseSync}=await import('node:sqlite');const state=new DatabaseSync(join(root,'state_5.sqlite'),{readOnly:true});assert.equal(state.prepare('select count(*) as n from threads').get().n,durableThreadsBefore,'ephemeral repair created a durable conversation');state.close();}
 if(!localCompaction&&!alreadyRewrittenDamage)assert.ok(migrated.migrated>0);assert.equal((await migration.prepareOfficial([],async()=>[])).migrated,0);await connections.restore(record.id);phase=3;
 client=await start();await client.rpc('thread/resume',{threadId:thread,model:'native-fixture',...(process.argv.includes('--implicit-provider')?{}:{modelProvider:'original_fixture'})});
 await client.turn(thread,'native-fixture',liveOfficial?'Return the exact text of the latest saved historical task checkpoint. Do not call tools.':'TURN_FOUR_MARKER');if(projectionPages){
  await inspectProjection(client,thread);
  await client.turn(thread,'native-fixture','FAILED_SOURCE_TURN_MARKER','failed');
  const turns=await page(client,'thread/turns/list',{threadId:thread});
  const fork=await client.rpc('thread/fork',{threadId:thread,beforeTurnId:turns.at(-1).id,model:'native-fixture',modelProvider:'original_fixture',excludeTurns:true});
  await client.turn(fork.thread.id,'native-fixture','FORK_AFTER_REPAIR_MARKER');
  const items=await page(client,'thread/items/list',{threadId:fork.thread.id});const text=JSON.stringify(items);assert.ok(text.includes('FORK_AFTER_REPAIR_MARKER'));assert.ok(!text.includes('FAILED_SOURCE_TURN_MARKER'));assert.ok(text.includes('TURN_FOUR_MARKER'));forkVerified=true;
 }if(liveOfficial)assert.ok(officialReply.includes('TURN_ONE_MARKER'),'Official Luna failed to recover the original marker from the saved summary');await client.stop();
 const target=(await connections.status())[0];
 const again=await connections.apply({target:'codex',revision:target.revision,origin,model:'qoder/kmodel_latest',sourceId:'a'.repeat(24),keyId:randomUUID(),key:'rotated-synthetic-key'});
 phase=4;client=await start();await client.rpc('thread/resume',{threadId:thread,model:'qoder/kmodel_latest',modelProvider:'token_flow'});await client.turn(thread,'qoder/kmodel_latest','TURN_FIVE_MARKER');await client.stop();
 await migration.prepareOfficial([],async()=>[]);await connections.restore(again.id);
 phase=5;client=await start();await client.rpc('thread/resume',{threadId:thread,model:'native-fixture',modelProvider:'original_fixture'});await client.turn(thread,'native-fixture','TURN_SIX_MARKER');await client.stop();
 assert.ok(compactions>0,'original fixture never compacted');
 assert.ok(calls.some(call=>!call.path.startsWith('/original')&&call.threadId===thread),'Codex must provide a stable thread session header');
 assert.ok(upstream.filter(c=>c.phase===3).every(c=>!c.body.input.some(i=>i.type==='reasoning'&&String(i.id).startsWith('rs_chatcmpl'))),'foreign reasoning leaked back to official provider');
 assert.ok(JSON.stringify(upstream.filter(c=>c.phase===3)).includes('GATEWAY_REASONING_MARKER'),'readable gateway reasoning summary was lost');
 for(const p of [1,2,3,4,5]){
 const requests=upstream.filter(c=>c.phase===p&&!c.body.instructions?.startsWith('Summarize the supplied'));
 assert.ok(requests.length);
 for(const {body} of requests){assert.ok(JSON.stringify(body.input).includes('TURN_ONE_MARKER'));assert.ok(!body.previous_response_id);assert.ok(!body.input.some(i=>i.type==='compaction'),'opaque state leaked to new upstream');}
 }
 for(const [p,marker] of [[3,'REPLY_2_MARKER'],[4,'TURN_FOUR_MARKER'],[5,'REPLY_4_MARKER']])assert.ok(JSON.stringify(upstream.filter(c=>c.phase===p)).includes(marker),'Latest cross-provider progress lost: '+marker);
 assert.ok(upstream.some(c=>c.phase===1&&c.body.input.some(i=>i.type==='function_call_output')),'tool results lost');
 assert.ok(JSON.stringify(upstream.filter(c=>c.phase===3)).includes(localCompaction?'REPLY_1_MARKER':'CHECKPOINT'),'gateway summary lost on native resume');
 const migrationSummaries=upstream.filter(c=>c.phase===1&&c.body.instructions?.startsWith('Summarize the supplied'));
 if(process.argv.includes('--rollback-history'))for(const p of [1,3,4,5]){
  const input=JSON.stringify(upstream.filter(c=>c.phase===p).map(c=>c.body.input));
  assert.ok(input.includes('KEPT_BRANCH_MARKER'),'surviving branch was lost');assert.ok(!input.includes('REMOVED_BRANCH_MARKER'),'rolled-back work was resurrected');
 }
 if(process.argv.includes('--repeat-gateway')){
  const requestedCompactions=localCompaction?upstream.filter(call=>call.phase===1&&JSON.stringify(call.body.input?.at(-1)).includes('CONTEXT CHECKPOINT COMPACTION')).length:migrationSummaries.length;
  assert.ok(requestedCompactions>=3,'repeated gateway tool growth did not compact again');
  for(const round of [1,2])assert.ok(JSON.stringify(upstream.filter(c=>c.phase===3)).includes(`GATEWAY_REPEAT_${round}_MARKER`),'repeated gateway user constraint lost on official resume');
  const progress=compactionProgress.filter(item=>item.phase===1&&item.itemType==='contextCompaction');
  const started=progress.filter(item=>item.method==='item/started').length,completed=progress.filter(item=>item.method==='item/completed').length;
  assert.ok(started>=2,'Codex did not publish repeated compaction start events');assert.equal(completed,started,'Codex did not complete every compaction lifecycle');
 }
 if(process.argv.includes('--long-recovery')){
  // The client may compact before sending the first ordinary continuation.
  // In that case requiring another gateway summary would test the wrong policy.
  const firstGateway=upstream.find(call=>call.phase===1);
  const clientPrepared=localCompaction&&JSON.stringify(firstGateway?.body.input?.at(-1)).includes('CONTEXT CHECKPOINT COMPACTION');
  assert.ok(migrationSummaries.length>0||clientPrepared,'neither Codex nor the migration path summarized the inherited history');
  for(const call of migrationSummaries)assert.ok(Buffer.byteLength(call.body.input[0].content)<600*1024,'summary unexpectedly exceeded planned fallback capacity');
 }
 console.log(JSON.stringify({passed:true,scope:liveOfficial?'installed Codex native-provider resume; saved gateway plaintext accepted by real authorized Luna through local credential bridge':'real installed Codex with synthetic providers; no live official login',liveOfficial,officialDurationMs,officialReplyPreservedEarliestMarker:officialReply.includes('TURN_ONE_MARKER'),localCompaction:localCompaction,projectionPages,priorProjectionDamage,alreadyRewrittenDamage,projectedTurns,projectedItems,forkVerified,longRecovery:process.argv.includes('--long-recovery'),repeatedGateway:process.argv.includes('--repeat-gateway'),originalCompactions:compactions,migrationSummaryCalls:migrationSummaries.length,migrated:migrated.migrated,requests:calls.length,toolHistoryPreserved:true,summaryResumed:true,foreignReasoningRepaired:true,compactionProgress}));

}finally{if(child&&child.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});server.closeAllConnections();await new Promise(r=>server.close(r));if(process.env.KEEP_FIXTURE)console.log(root);else await rm(root,{recursive:true,force:true});}
