import {CodexHistoryBackups} from '../packages/core/src/codex-history-backups.js';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {it,expect,afterEach} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CodexContext,codexContextScope,portableCodexItem} from '../packages/core/src/codex-context.js';
import {parseCodeBuddyInput} from '../packages/core/src/codebuddy.js';
import {GatewayContext} from '../packages/core/src/gateway-context.js';
import {CODEX_SUMMARY_PREFIX,codexUserTurnBoundary,replayCodexHistory} from '../packages/core/src/codex-rollout-history.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(await realpath(tmpdir()),'codex-context-test-'));roots.push(root);const home=join(root,'codex'),file=join(home,'sessions/2026/10/12/rollout-fixture.jsonl');await mkdir(join(home,'sessions/2026/10/12'),{recursive:true});const context=await GatewayContext.open(root);return {root,file,context,migration:new CodexContext(root,join(home,'config.toml'),context)};}
const history=[{type:'message',role:'user',content:[{type:'input_text',text:'Preserve requirements'}]},{type:'function_call',call_id:'one',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'one',output:'original tool result'}];
const checkpoint=(token:string)=>({type:'compacted',payload:{message:'',replacement_history:[history[0],{type:'compaction',encrypted_content:token}],window_number:2}});
const rollout=(token:string)=>[...history.map(payload=>({type:'response_item',payload})),checkpoint(token),{type:'response_item',payload:{type:'message',role:'user',content:'Future turn must not leak into a fork'}}].map(v=>JSON.stringify(v)).join('\n')+'\n';
it('excludes historical tool declarations and their legacy malformed messages from recovered wire input',async()=>{
 const f=await fixture();const tools=[{type:'function',name:'current_tool',parameters:{type:'object'}}];
 const declarations=[{type:'additional_tools',role:'developer',tools:[{type:'function',name:'old_tool'}]},{type:'message',role:'developer',tools:[{type:'function',name:'legacy_tool'}]}];
 const encrypted=f.context.encodeCheckpoint([...declarations,...history],codexContextScope);
 let called=false;
 const send=async(_path:string,body:any)=>{
  called=true;expect(body.tools).toEqual(tools);expect(body.input).toEqual(history);
  for(const item of body.input)if(item.type==='message')expect(Array.isArray(item.content)).toBe(true);
  return Response.json({id:'wire-safe',status:'completed',output:[]});
 };
 await f.context.response('responses',{model:'codex/test',tools,input:[{type:'compaction',encrypted_content:encrypted}]},'key','source',send,{scope:codexContextScope,normalize:portableCodexItem,recover:item=>f.migration.recover(item,[])});
 expect(called).toBe(true);
});
it('normalizes legacy assistant text from encrypted checkpoints and cached official windows',async()=>{
 const f=await fixture();const legacy=[...history,{type:'message',role:'assistant',content:'saved task summary'}];
 const expected=[...history,{type:'message',role:'assistant',content:[{type:'output_text',text:'saved task summary'}]}];
 const encrypted=f.context.encodeCheckpoint(legacy,codexContextScope);
 expect(await f.migration.recover({type:'compaction',encrypted_content:encrypted},[])).toEqual(expected);
 const token='cached-official-window';await mkdir(join(f.root,'codex-context-cache'),{recursive:true});
 await writeFile(join(f.root,'codex-context-cache',createHash('sha256').update(token).digest('hex')),encrypted);
 expect(await f.migration.recover({type:'compaction',encrypted_content:token},[])).toEqual(expected);
});
it('recovers an official opaque window from exact local history, encrypts its cache and excludes future turns',async()=>{
 const f=await fixture();await writeFile(f.file,rollout('official-ciphertext'));
 const recovered=await f.migration.recover({type:'compaction',encrypted_content:'official-ciphertext'},[]);
 expect(recovered).toEqual(history);
 const names=await readdir(join(f.root,'codex-context-cache'));expect(await readFile(join(f.root,'codex-context-cache',names[0]!),'utf8')).not.toContain('original tool result');
 await expect(f.migration.recover({type:'compaction',encrypted_content:'unknown'},[])).rejects.toThrow('无法恢复');
 expect(await readFile(f.file,'utf8')).toBe(rollout('official-ciphertext'));
});
it('never merges a neighboring conversation when recovering an exact checkpoint',async()=>{
 const f=await fixture();await writeFile(f.file,rollout('wanted'));
 const neighbor=join(f.file.slice(0,f.file.lastIndexOf('/')),'rollout-other.jsonl');
 const other=rollout('other-token').replaceAll('Preserve requirements','UNRELATED_CONVERSATION');
 await writeFile(neighbor,other);
 expect(await f.migration.recover({type:'compaction',encrypted_content:'wanted'},[])).toEqual(history);
 expect(await readFile(neighbor,'utf8')).toBe(other);
});
it('recovers a later official checkpoint from the saved gateway summary plus only the intervening history',async()=>{
 const f=await fixture();
 const saved=[{role:'user',content:'Keep task constraints.'},{type:'message',role:'assistant',content:[{type:'output_text',text:'Historical task checkpoint (summary of earlier work):\nSAVED_GATEWAY_SUMMARY'}]}];
 const token=f.context.encodeCheckpoint(saved,codexContextScope),newWork={type:'message',role:'user',content:[{type:'input_text',text:'OFFICIAL_NEW_WORK'}]};
 await writeFile(f.file,[...history.map(payload=>({type:'response_item',payload})),{type:'response_item',payload:{type:'compaction',encrypted_content:token}},{type:'response_item',payload:newWork},checkpoint('later-official')].map(row=>JSON.stringify(row)).join('\n'));
 const recovered=await f.migration.recover({type:'compaction',encrypted_content:'later-official'},[]);
 expect(JSON.stringify(recovered)).toContain('SAVED_GATEWAY_SUMMARY');expect(recovered).toContainEqual(newWork);expect(JSON.stringify(recovered)).not.toContain('original tool result');
});
it('blocks live rollout rewrites, migrates legacy gateway checkpoints with backups, and is idempotent',async()=>{
 const f=await fixture();const scope={owner:'old-key',source:'qoder-account',model:'qoder/m'};
 const token=f.context.encodeCheckpoint(history,scope);const original=rollout(token);await writeFile(f.file,original);
 await expect(f.migration.prepareOfficial([scope],async()=>[123])).rejects.toThrow('先退出 Codex');expect(await readFile(f.file,'utf8')).toBe(original);
 expect(await f.migration.prepareOfficial([scope],async()=>[])).toEqual({migrated:1});
 const text=await readFile(f.file,'utf8');const row=JSON.parse(text.split('\n')[3]!);expect(row.payload.replacement_history).toEqual(history);expect(row.payload.window_number).toBe(2);expect(text).toContain('Future turn');
 const batch=(await readdir(join(f.root,'codex-context-backups')))[0]!;const manifest=JSON.parse(await readFile(join(f.root,'codex-context-backups',batch,'manifest.json'),'utf8'));expect((await new CodexHistoryBackups(f.root).read(manifest.files[0].historySnapshot)).toString()).toBe(original);
 expect(await f.migration.prepareOfficial([scope],async()=>[])).toEqual({migrated:0});
 expect(await readdir(join(f.root,'codex-context-staging'))).toEqual([]);
});
it('stops before backup when a staged rollout changes after scanning',async()=>{
 const f=await fixture();const scope={owner:'old-key',source:'qoder-account',model:'qoder/m'};
 await writeFile(f.file,rollout(f.context.encodeCheckpoint(history,scope)));
 const edited=rollout('edited-after-scan');
 await expect(f.migration.prepareOfficial([scope],async()=>{await writeFile(f.file,edited);return [];})).rejects.toThrow('会话发生变化');
 expect(await readFile(f.file,'utf8')).toBe(edited);
 expect(await readdir(join(f.root,'codex-context-backups')).catch(()=>[])).toEqual([]);
 expect(await readdir(join(f.root,'codex-context-staging'))).toEqual([]);
});
it('only materializes foreign encrypted checkpoints that this managed connection recovered',async()=>{
 const f=await fixture();await writeFile(f.file,rollout('official-ciphertext'));
 expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:0});
 await f.migration.recover({type:'compaction',encrypted_content:'official-ciphertext'},[]);
 expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:1});
});
it('keeps managed history across source/model/key switches while ordinary exported keys remain isolated',async()=>{
 const f=await fixture();const migration={scope:codexContextScope,recover:(item:Record<string,unknown>)=>f.migration.recover(item,[])};
 let seen:any;const send=async(_p:string,b:Record<string,unknown>)=>{seen=b;return Response.json({id:'source',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'result'}]}]});};
 const first=await(await f.context.response('responses',{model:'qoder/a',input:'first'},'key-a','account-a',send,migration)).json();
 await f.context.response('responses',{model:'workbuddy/b',previous_response_id:first.id,input:'next'},'key-b','account-b',send,migration);expect(JSON.stringify(seen.input)).toContain('first');
 await expect(f.context.response('responses',{model:'workbuddy/b',previous_response_id:first.id,input:'steal'},'exported','account-b',send)).rejects.toThrow('another API key');
 const compact=await(await f.context.response('responses/compact',{model:'qoder/a',input:history},'key-a','account-a',send,migration)).json();
 await f.context.response('responses',{model:'workbuddy/b',input:compact.output},'key-b','account-b',send,migration);expect(seen.input).toEqual(history);
});
it('treats rollback before any user turn as a no-op like Codex',async()=>{
 const f=await fixture();await writeFile(f.file,JSON.stringify({type:'event_msg',payload:{type:'thread_rolled_back',num_turns:1}})+'\n'+rollout('rolled-back'));
 expect(await f.migration.recover({type:'compaction',encrypted_content:'rolled-back'},[])).toEqual(history);
});
it('recovers only surviving turns after rollback, ignoring a checkpoint in the discarded turn',async()=>{
 const f=await fixture(),summary={type:'message',role:'user',content:[{type:'input_text',text:CODEX_SUMMARY_PREFIX+'\nSUMMARY_A'}]};
 const user=(text:string)=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
 const start=(id:string)=>({type:'event_msg',payload:{type:'task_started',turn_id:id}});
 const rows=[start('A'),user('A'),{type:'compacted',payload:{replacement_history:[user('A').payload,summary]}},
  start('B'),user('B_REMOVED'),{type:'compacted',payload:{replacement_history:[user('B_REMOVED').payload,{...summary,content:[{type:'input_text',text:CODEX_SUMMARY_PREFIX+'\nSUMMARY_AB_REMOVED'}]}]}},
  {type:'event_msg',payload:{type:'thread_rolled_back',num_turns:1}},start('D'),user('D_KEPT'),checkpoint('after-rollback')];
 const original=rows.map(row=>JSON.stringify(row)).join('\n');await writeFile(f.file,original);
 const recovered=await f.migration.recover({type:'compaction',encrypted_content:'after-rollback'},[]);
 expect(JSON.stringify(recovered)).toContain('SUMMARY_A');expect(JSON.stringify(recovered)).toContain('D_KEPT');expect(JSON.stringify(recovered)).not.toContain('REMOVED');
 expect(await readFile(f.file,'utf8')).toBe(original);
});
it('loads inherited history only up to the fork boundary before restoring a foreign checkpoint',async()=>{
 const f=await fixture(),parentId='00000000-0000-0000-0000-000000000011',parent=join(f.file,'..',`rollout-2026-10-12T00-00-00-${parentId}.jsonl`);
 const row=(text:string)=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
 const prefix=[{type:'session_meta',payload:{id:parentId}},row('A_SHARED')].map(row=>JSON.stringify(row)+'\n').join('');
 await writeFile(parent,prefix+JSON.stringify(row('B_PARENT_ONLY'))+'\n');
 await writeFile(f.file,[{type:'session_meta',payload:{id:'child',history_base:{thread_id:parentId,end_byte_offset:Buffer.byteLength(prefix),end_ordinal_exclusive:2}}},row('D_CHILD_ONLY'),checkpoint('child-token')].map(row=>JSON.stringify(row)).join('\n'));
 const result=JSON.stringify(await f.migration.recover({type:'compaction',encrypted_content:'child-token'},[]));
 expect(result).toContain('A_SHARED');expect(result).toContain('D_CHILD_ONLY');expect(result).not.toContain('B_PARENT_ONLY');
});
it('follows immutable rollout IDs through repeated reverts of the same logical thread',async()=>{
 const f=await fixture(),id='00000000-0000-0000-0000-000000000012',r1='00000000-0000-0000-0000-000000000013',r2='00000000-0000-0000-0000-000000000014';
 const path=(suffix='')=>join(f.file,'..',`rollout-2026-10-12T00-00-00-${id}${suffix?'_'+suffix:''}.jsonl`);
 const row=(text:string)=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
 const encode=(rows:any[],start=0)=>rows.map((r,i)=>JSON.stringify({...r,ordinal:start+i})+'\n').join('');
 const a=encode([{type:'session_meta',payload:{id}},row('A_SHARED')]);
 await writeFile(path(),a+encode([row('B_REMOVED')],2));
 const d=encode([{type:'session_meta',payload:{id,history_base:{thread_id:id,end_byte_offset:Buffer.byteLength(a),end_ordinal_exclusive:2}}},row('D_KEPT')],2);
 await writeFile(path(r1),d+encode([row('E_REMOVED')],4));
 await writeFile(path(r2),encode([{type:'session_meta',payload:{id,history_base:{thread_id:r1,end_byte_offset:Buffer.byteLength(d),end_ordinal_exclusive:4}}},row('F_KEPT'),checkpoint('twice-reverted')],4));
 // A sibling with the same starting ordinal must never win by recency or length.
 await writeFile(path('00000000-0000-0000-0000-000000000015'),d.replace('D_KEPT','X_WRONG')+encode([row('sibling future')],4));
 const result=JSON.stringify(await f.migration.recover({type:'compaction',encrypted_content:'twice-reverted'},[]));
 for(const text of ['A_SHARED','D_KEPT','F_KEPT'])expect(result).toContain(text);
 for(const text of ['B_REMOVED','E_REMOVED','X_WRONG'])expect(result).not.toContain(text);
});
it('does not count synthetic summaries or contextual user messages as rollback turns',()=>{
 const item=(text:string)=>({type:'message',role:'user',content:[{type:'input_text',text}]});
 for(const text of [CODEX_SUMMARY_PREFIX+'\nsummary','<ENVIRONMENT_CONTEXT>cwd</ENVIRONMENT_CONTEXT>','<skill>instructions</skill>','<external_repo>context</external_repo>','<goal_context>goal</goal_context>'])expect(codexUserTurnBoundary(item(text))).toBe(false);
 expect(codexUserTurnBoundary(item('Actual user task'))).toBe(true);
 expect(codexUserTurnBoundary({type:'agent_message',content:[]})).toBe(true);
 expect(codexUserTurnBoundary({type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({author:'/root/a',recipient:'/root',content:'Task',trigger_turn:true})}]})).toBe(true);
 const rows=[item('A'),item(CODEX_SUMMARY_PREFIX+'\nsummary'),item('<environment_context>cwd</environment_context>'),item('B')].map(payload=>({type:'response_item',payload}));
 rows.push({type:'event_msg',payload:{type:'thread_rolled_back',num_turns:2}} as any);
 expect(replayCodexHistory(rows,()=>undefined)).toEqual([]);
});
it('summarizes a recovered long window in bounded calls while keeping constraints and recent tool pairs',async()=>{
 const f=await fixture();const input:any[]=[{type:'message',role:'user',content:'Keep the original API and user files.'}];
 for(let i=0;i<15;i++)input.push({type:'function_call',call_id:`c${i}`,name:'read',arguments:'{}'},{type:'function_call_output',call_id:`c${i}`,output:i<10?'中'.repeat(10000):'recent result'});
 const requests:any[]=[];const send=async(_p:string,b:any)=>{requests.push(b);return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Earlier reads completed; preserve API; continue current task.'}]}],usage:{input_tokens:10,output_tokens:2,total_tokens:12}});};
 const result=await(await f.context.response('responses',{context_management:[{type:'compaction',compact_threshold:65536}],model:'workbuddy/m',input,store:false},'new-key','new-source',send,{scope:codexContextScope,threadId:'fixture-thread',recover:i=>f.migration.recover(i,[])})).json();
 const summaries=requests.filter(r=>r.instructions?.startsWith('Summarize the supplied'));expect(summaries.length).toBeGreaterThan(1);expect(summaries.map(r=>r.input[0].content).join('')).not.toContain('middle omitted');expect(summaries.map(r=>r.input[0].content).join('')).toContain('中'.repeat(10000));
 for(const r of summaries)expect(Buffer.byteLength(r.input[0].content)).toBeLessThan(50*1024);
 const forwarded=requests.at(-1).input;expect(forwarded[0]).toEqual(input[0]);expect(forwarded.slice(-8)).toEqual(input.slice(-8));expect(JSON.stringify(forwarded).length).toBeLessThan(10000);expect(result.output[0].type).toBe('compaction');
});
it('keeps independent guardian records, removes stale positional metadata, and refuses partial files',async()=>{
 const f=await fixture();const token=f.context.encodeCheckpoint([...history,{role:'assistant',content:'checkpoint summary'}],codexContextScope);
 const row=checkpoint(token) as any;row.payload.replacement_history_metadata=[{client_authored:false}];row.payload.guardian_history=[history[0]];
 const original=JSON.stringify(row)+'\n';await writeFile(f.file,original+'{"partial":');
 await expect(f.migration.prepareOfficial([],async()=>[])).rejects.toThrow('记录不完整');expect(await readFile(f.file,'utf8')).toBe(original+'{"partial":');
 await writeFile(f.file,original);await f.migration.prepareOfficial([],async()=>[]);
 const saved=JSON.parse((await readFile(f.file,'utf8')).trim()).payload;
 expect(saved).not.toHaveProperty('replacement_history_metadata');expect(saved.guardian_history).toEqual(row.payload.guardian_history);expect(saved.replacement_history.at(-1)).toEqual({type:'message',role:'assistant',content:[{type:'output_text',text:'checkpoint summary'}]});
});
it('materializes inline automatic-compaction items before native resume and preserves subsequent turns',async()=>{
 const f=await fixture();const token=f.context.encodeCheckpoint(history,codexContextScope);
 const inline={timestamp:'2026-10-12T00:00:00Z',ordinal:10,type:'response_item',payload:{type:'compaction',encrypted_content:token}};
 const tail={type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'continue after automatic compaction'}]}};
 await writeFile(f.file,[...history.map(payload=>({type:'response_item',payload})),inline,tail].map(v=>JSON.stringify(v)).join('\n'));
 expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:1});
 const rows=(await readFile(f.file,'utf8')).split('\n').map(l=>JSON.parse(l));
 expect(rows.at(-2)).toEqual({timestamp:inline.timestamp,ordinal:10,type:'compacted',payload:{message:'',replacement_history:history}});expect(rows.at(-1)).toEqual(tail);
 expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:0});
});
it('continues across two gateway compactions and materializes the latest checkpoint for official resume',async()=>{
 const f=await fixture();const migration={scope:codexContextScope,normalize:portableCodexItem,recover:(item:Record<string,unknown>)=>f.migration.recover(item,[])};
 const work=(prefix:string)=>Array.from({length:20},(_,i)=>[
  {type:'function_call',call_id:prefix+i,name:'read',arguments:'{}'},
  {type:'function_call_output',call_id:prefix+i,output:'old output '.repeat(500)},
 ]).flat();
 const original=[{role:'developer',content:'Preserve API compatibility.'},{role:'user',content:'GOAL_MARKER'},...work('first-'),{role:'user',content:'Finish first round.'}];
 let round=1;const summaries:string[]=[];
 const send=async(_path:string,body:Record<string,unknown>)=>{
  const summary=typeof body.instructions==='string'&&body.instructions.startsWith('Summarize the supplied');
  if(summary)summaries.push(JSON.stringify(body.input));
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:summary?`ROUND_${round}_SUMMARY: GOAL_MARKER; preserve API; NEW_CONSTRAINT remains active.`:`ROUND_${round}_ANSWER`}]}],usage:{input_tokens:100,output_tokens:10}});
 };
 const first=await(await f.context.response('responses',{model:'qoder/m',input:original,context_management:[{type:'compaction',compact_threshold:100}]},'key','source',send,migration)).json();
 const between=[{role:'user',content:'NEW_CONSTRAINT: never change billing.ts.'},...work('second-'),{role:'user',content:'Continue second round.'}];
 const firstSummaryCount=summaries.length;round=2;const restarted=await GatewayContext.open(f.root);
 const second=await(await restarted.response('responses',{model:'qoder/m',input:[...original,...first.output,...between],context_management:[{type:'compaction',compact_threshold:100}]},'key','source',send,migration)).json();
 expect(firstSummaryCount).toBeGreaterThan(0);const secondSummaries=summaries.slice(firstSummaryCount).join('');expect(secondSummaries).toContain('ROUND_1_SUMMARY');expect(secondSummaries).toContain('NEW_CONSTRAINT');
 const after={type:'message',role:'user',content:[{type:'input_text',text:'AFTER_SECOND_COMPACTION'}]};
 const saved=[{type:'session_meta',payload:{model_provider:'token_flow'}},...[...original,...first.output,...between,...second.output,after].map(payload=>({type:'response_item',payload:payload.type?payload:{type:'message',...payload}}))].map(row=>JSON.stringify(row)).join('\n')+'\n';
 await writeFile(f.file,saved);const restored=new CodexContext(f.root,join(f.root,'codex/config.toml'),restarted);
 await expect(restored.prepareOfficial([],async()=>[1])).rejects.toThrow('先退出 Codex');expect(await readFile(f.file,'utf8')).toBe(saved);
 expect(await restored.prepareOfficial([],async()=>[])).toEqual({migrated:1});
 const rows=(await readFile(f.file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const latest=rows.filter(row=>row.type==='compacted').at(-1).payload.replacement_history;
 expect(JSON.stringify(latest)).toContain('ROUND_2_SUMMARY');expect(JSON.stringify(latest)).not.toContain('ROUND_1_SUMMARY');expect(JSON.stringify(latest)).toContain('NEW_CONSTRAINT');
 expect(latest.some((item:any)=>item.type==='compaction')).toBe(false);expect(rows.at(-1).payload).toEqual(after);
 for(const item of latest.filter((item:any)=>item.type==='function_call_output'))expect(latest.some((call:any)=>call.type==='function_call'&&call.call_id===item.call_id)).toBe(true);
 const batch=(await readdir(join(f.root,'codex-context-backups')))[0]!;const manifest=JSON.parse(await readFile(join(f.root,'codex-context-backups',batch,'manifest.json'),'utf8'));expect((await new CodexHistoryBackups(f.root).read(manifest.files[0].historySnapshot)).toString()).toBe(saved);
 expect(await restored.prepareOfficial([],async()=>[])).toEqual({migrated:0});
});
it('does not reinterpret unrelated official checkpoints while switching the local login',async()=>{
 const f=await fixture();const original=JSON.stringify({type:'compacted',payload:{message:'',replacement_history:[{type:'item_reference',id:'official-item'},{type:'compaction',encrypted_content:'unrelated-official-state'}]}})+'\n';
 await writeFile(f.file,original);expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:0});expect(await readFile(f.file,'utf8')).toBe(original);
});
it('preserves an official conversation through a failed gateway switch, gateway restart, retry and native restore',async()=>{
 const f=await fixture();const original=rollout('official-before-outage');await writeFile(f.file,original);
 const migration={scope:codexContextScope,normalize:undefined,recover:(item:Record<string,unknown>)=>f.migration.recover(item,[])};
 const request={model:'qoder/gmodel',input:[{type:'compaction',encrypted_content:'official-before-outage'},{role:'user',content:'Continue after switching'}]};
 let attempts=0;
 const failed=await f.context.response('responses',request,'gateway-key','qoder-account',async()=>{attempts++;return Response.json({error:{message:'source cooling down'}},{status:503});},migration);
 expect(failed.status).toBe(503);expect(attempts).toBe(1);expect(await readFile(f.file,'utf8')).toBe(original);
 const restarted=await GatewayContext.open(f.root);const recovered=new CodexContext(f.root,join(f.root,'codex/config.toml'),restarted);
 let forwarded:any;
 const resumed=await(await restarted.response('responses',request,'new-gateway-key','new-source',async(_path,body)=>{forwarded=body;return Response.json({id:'upstream',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'GATEWAY_REPLY_AFTER_RETRY'}]}]});},{scope:codexContextScope,recover:item=>recovered.recover(item,[])})).json();
 expect(forwarded.input).toEqual([...history,{role:'user',content:'Continue after switching'}]);expect(forwarded).not.toHaveProperty('previous_response_id');
 const tail=resumed.output.map((payload:any)=>JSON.stringify({type:'response_item',payload})).join('\n')+'\n';
 await writeFile(f.file,original+tail);
 expect(await recovered.prepareOfficial([],async()=>[])).toEqual({migrated:1});
 const saved=await readFile(f.file,'utf8');const rows=saved.trim().split('\n').map(row=>JSON.parse(row));
 expect(rows.find(row=>row.type==='compacted').payload.replacement_history).toEqual(history);
 expect(saved).toContain('Future turn must not leak into a fork');expect(saved).toContain('GATEWAY_REPLY_AFTER_RETRY');
 expect(await recovered.prepareOfficial([],async()=>[])).toEqual({migrated:0});
});

it('repairs gateway reasoning outside compaction and retains native reasoning, messages and tools',async()=>{
 const f=await fixture();
 const native={type:'reasoning',id:'rs_official',encrypted_content:'official-ciphertext',summary:[]};
 const foreign={type:'reasoning',id:'rs_chatcmpl_foreign',encrypted_content:'',summary:[{type:'summary_text',text:'Gateway reasoning summary'}]};
 const rows=[{type:'session_meta',payload:{model_provider:'openai'}},{type:'turn_context',payload:{model:'gpt-native'}},{type:'response_item',payload:native},{type:'turn_context',payload:{model:'qoder/kmodel_latest'}},{type:'response_item',payload:foreign},...history.map(payload=>({type:'response_item',payload}))];
 const original=rows.map(r=>JSON.stringify(r)).join('\n');await writeFile(f.file,original);
 await expect(f.migration.prepareOfficial([],async()=>[123])).rejects.toThrow('先退出 Codex');
 expect(await readFile(f.file,'utf8')).toBe(original);
 expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:1});
 const saved=(await readFile(f.file,'utf8')).split('\n').map(r=>JSON.parse(r));
 expect(saved[2].payload).toEqual(native);expect(saved[4].payload).toEqual({type:'message',role:'assistant',content:[{type:'output_text',text:'Gateway reasoning summary'}]});
 expect(saved.slice(-history.length)).toEqual(rows.slice(-history.length));
 expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:0});
});
it('repairs gateway-born reasoning in checkpoint histories even without a compaction token',async()=>{
 const f=await fixture();const foreign={type:'reasoning',id:'rs_chatcmpl_foreign',encrypted_content:'',summary:[{type:'summary_text',text:'Saved gateway summary'}]};
 const row={type:'compacted',payload:{replacement_history:[history[0],foreign,...history.slice(1)],replacement_history_metadata:[{},{}]}};
 await writeFile(f.file,[{type:'session_meta',payload:{model_provider:'token_flow'}},row].map(r=>JSON.stringify(r)).join('\n'));
 expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:1});
 const saved=JSON.parse((await readFile(f.file,'utf8')).split('\n')[1]!).payload;
 expect(JSON.stringify(saved)).not.toContain('encrypted_content');expect(saved).not.toHaveProperty('replacement_history_metadata');expect(saved.replacement_history.slice(-2)).toEqual(history.slice(1));
});
it('normalizes Codex agent_message items and strips encrypted_content blocks for SDK providers',()=>{
 const normalized=portableCodexItem({
  type:'agent_message',
  id:'amsg_test',
  author:'/root/tool_routing',
  recipient:'/root',
  content:[{type:'input_text',text:'Subagent routing note'},{type:'encrypted_content',encrypted_content:'gAAAAABsecret'}],
 });
 expect(normalized).toEqual([{type:'message',role:'developer',content:[{type:'input_text',text:'Subagent routing note'}]}]);
 const parsed=parseCodeBuddyInput('responses',{model:'workbuddy/deepseek-v4.1-flash',input:normalized});
 expect(parsed.systemPrompt).toContain('Subagent routing note');expect(parsed.prompt).not.toContain('Subagent routing note');
 expect(parsed.prompt).not.toContain('gAAAAABsecret');
});

it('rebases paginated history cutoffs when compatibility rewrites shrink their source',async()=>{
 const f=await fixture();const id='00000000-0000-0000-0000-000000000001';
 const source=join(f.file,'..',`rollout-2026-10-12T00-00-00-${id}.jsonl`);
 const rows=[{ordinal:0,type:'session_meta',payload:{id,model_provider:'token_flow'}},{ordinal:1,type:'response_item',payload:{type:'reasoning',id:'rs_chatcmpl_test',encrypted_content:'',summary:[{type:'summary_text',text:'中文 summary'}]}}];
 const before=rows.map(r=>JSON.stringify(r)+'\n').join('');await writeFile(source,before);
 const child={ordinal:0,type:'session_meta',payload:{id:'fork',history_base:{thread_id:id,end_ordinal_exclusive:2,end_byte_offset:Buffer.byteLength(before)}}};
 await writeFile(f.file,JSON.stringify(child)+'\n');
 await f.migration.prepareOfficial([],async()=>[]);
 const current=await readFile(source,'utf8');expect(Buffer.byteLength(current)).toBeLessThan(Buffer.byteLength(before));
 expect(JSON.parse(await readFile(f.file,'utf8')).payload.history_base.end_byte_offset).toBe(Buffer.byteLength(current));
 expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:0});
});
it('materializes earlier checkpoints referenced by branches and reverts while preserving frozen history',async()=>{
 const f=await fixture(),id='00000000-0000-0000-0000-000000000031';
 const source=join(f.file,'..',`rollout-2026-10-12T00-00-00-${id}.jsonl`);
 const message=(text:string)=>({type:'message',role:'user',content:[{type:'input_text',text}]});
 const first=[message('EARLIER_A'),{type:'message',role:'assistant',content:'SUMMARY_A'}],second=[...first,message('LATER_B')];
 const firstToken=f.context.encodeCheckpoint(first,codexContextScope),secondToken=f.context.encodeCheckpoint(second,codexContextScope);
 const rows=[{type:'session_meta',payload:{id,model_provider:'token_flow'}},{type:'response_item',payload:message('EARLIER_A')},{type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:firstToken}]}},{type:'response_item',payload:message('LATER_B')},{type:'response_item',payload:{type:'compaction',encrypted_content:secondToken}},{type:'compacted',payload:{replacement_history:[message('OFFICIAL_PLAINTEXT_LATER')]}}];
 const original=rows.map((row,ordinal)=>JSON.stringify({...row,ordinal})+'\n').join('');await writeFile(source,original);
 const boundary=Buffer.byteLength(original.split('\n').slice(0,3).join('\n')+'\n');
 await writeFile(f.file,JSON.stringify({type:'session_meta',ordinal:3,payload:{id:'fork',history_base:{thread_id:id,end_ordinal_exclusive:3,end_byte_offset:boundary}}})+'\n');
 await f.migration.prepareOfficial([],async()=>[]);
 const saved=await readFile(source,'utf8'),base=JSON.parse(await readFile(f.file,'utf8')).payload.history_base;
 expect(saved).not.toContain('tfctx1.');
 const branchRows=Buffer.from(saved).subarray(0,base.end_byte_offset).toString().trim().split('\n').map(line=>JSON.parse(line));
 const replay=replayCodexHistory(branchRows,row=>row.type==='compacted'?row.payload.replacement_history:undefined);
 expect(replay).toEqual(first.flatMap(portableCodexItem));expect(JSON.stringify(replay)).not.toContain('LATER_B');
 const updated=saved.trim().split('\n').map(line=>JSON.parse(line));
 expect(updated[4].type).toBe('compacted');expect(updated[4].payload.replacement_history).toEqual(second.flatMap(portableCodexItem));
 expect(updated.at(-1).payload).toEqual(rows.at(-1)!.payload);
 expect(updated.map(row=>row.ordinal)).toEqual(rows.map((_,i)=>i));
 const batch=(await readdir(join(f.root,'codex-context-backups')))[0]!;
 const manifest=JSON.parse(await readFile(join(f.root,'codex-context-backups',batch,'manifest.json'),'utf8'));
 const backedUp=manifest.files.find((entry:any)=>entry.path.endsWith(source.split('/').at(-1)));
 expect((await new CodexHistoryBackups(f.root).read(backedUp.historySnapshot)).toString()).toBe(original);
 expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:0});
});
it('repairs an already stale paginated byte cutoff using explicit persisted ordinals',async()=>{
 const f=await fixture();const id='00000000-0000-0000-0000-000000000002';const source=join(f.file,'..',`rollout-2026-10-12T00-00-00-${id}.jsonl`);
 const text=[{ordinal:0,type:'session_meta',payload:{id}},{ordinal:1,type:'response_item',payload:{type:'message',role:'user',content:'retained'}},{ordinal:2,type:'response_item',payload:{type:'message',role:'user',content:'later turn'}}].map(r=>JSON.stringify(r)+'\n').join('');await writeFile(source,text);
 const bound=Buffer.byteLength(text.split('\n').slice(0,2).join('\n')+'\n');
 await writeFile(f.file,JSON.stringify({ordinal:0,type:'session_meta',payload:{id:'fork',history_base:{thread_id:id,end_ordinal_exclusive:2,end_byte_offset:999999}}})+'\n');
 await f.migration.prepareOfficial([],async()=>[]);expect(JSON.parse(await readFile(f.file,'utf8')).payload.history_base.end_byte_offset).toBe(bound);
});
it('rebases inherited byte cutoffs through same-thread delta rollouts with nonzero ordinals',async()=>{
 const f=await fixture(),id='00000000-0000-0000-0000-000000000021',r1='00000000-0000-0000-0000-000000000022';
 const source=join(f.file,'..',`rollout-2026-10-12T00-00-00-${id}.jsonl`),delta=join(f.file,'..',`rollout-2026-10-12T00-00-00-${id}_${r1}.jsonl`);
 const encode=(rows:any[],start=0)=>rows.map((row,i)=>JSON.stringify({...row,ordinal:start+i})+'\n').join('');
 const reasoning={type:'response_item',payload:{type:'reasoning',id:'rs_chatcmpl_test',encrypted_content:'',summary:[{type:'summary_text',text:'saved details'}]}};
 const original=encode([{type:'session_meta',payload:{id,model_provider:'token_flow'}},reasoning]);await writeFile(source,original);
 const prior=encode([{type:'session_meta',payload:{id,model_provider:'token_flow',history_base:{thread_id:id,end_ordinal_exclusive:2,end_byte_offset:Buffer.byteLength(original)}}},reasoning],2);await writeFile(delta,prior);
 await writeFile(f.file,encode([{type:'session_meta',payload:{id:'child',history_base:{thread_id:r1,end_ordinal_exclusive:4,end_byte_offset:Buffer.byteLength(prior)}}}],4));
 await f.migration.prepareOfficial([],async()=>[]);
 const revisedSource=await readFile(source,'utf8'),revisedDelta=await readFile(delta,'utf8');
 expect(JSON.parse(revisedDelta.split('\n')[0]!).payload.history_base.end_byte_offset).toBe(Buffer.byteLength(revisedSource));
 expect(JSON.parse(await readFile(f.file,'utf8')).payload.history_base.end_byte_offset).toBe(Buffer.byteLength(revisedDelta));
 expect(revisedDelta.trim().split('\n').map(line=>JSON.parse(line).ordinal)).toEqual([2,3]);
 expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:0});
});

it('backs up and invalidates only derived history projections whose rollout bytes changed',async()=>{
 const f=await fixture();const home=join(f.root,'codex');
 const db=new DatabaseSync(join(home,'thread_history_1.sqlite'));
 for(const table of ['thread_turns','thread_items','thread_history_projection_state','thread_realtime_items']){db.exec(`create table ${table}(thread_id text, rollout_byte_offset integer)`);db.prepare(`insert into ${table} values (?,?)`).run('changed',9999);db.prepare(`insert into ${table} values (?,?)`).run('unrelated',123);}
 await writeFile(f.file,[{ordinal:0,type:'session_meta',payload:{id:'changed',model_provider:'token_flow'}},{ordinal:1,type:'response_item',payload:{type:'reasoning',id:'rs_chatcmpl_empty',encrypted_content:'',summary:[]}}].map(r=>JSON.stringify(r)+'\n').join(''));
 try{
 await f.migration.prepareOfficial([],async()=>[]);
 const rows=(await readFile(f.file,'utf8')).trim().split('\n').map(l=>JSON.parse(l));expect(rows.map(r=>r.ordinal)).toEqual([0,1]);
 for(const table of ['thread_turns','thread_items','thread_history_projection_state','thread_realtime_items'])expect(db.prepare(`select * from ${table}`).all()).toEqual([{thread_id:'unrelated',rollout_byte_offset:123}]);
 const batch=(await readdir(join(f.root,'codex-context-backups')))[0]!;
 const saved=new DatabaseSync(join(f.root,'codex-context-backups',batch,'thread_history_1.sqlite'),{readOnly:true});expect(saved.prepare('select count(*) as n from thread_items').get()?.n).toBe(2);saved.close();
 }finally{db.close();}
});

it('removes foreign persisted-item IDs from gateway history while retaining call pairs, subagent content and native IDs',async()=>{
 const f=await fixture();
 const native={type:'function_call',id:'fc_native',call_id:'native',name:'read',arguments:'{}'};
 const foreign=[
  {type:'message',id:'msg_foreign',role:'assistant',content:[{type:'output_text',text:'Subagent Avicenna reported its result.'}]},
  {type:'function_call',id:'fc_call_foreign',call_id:'agent_call',name:'spawn_agent',arguments:'{"task":"investigate"}'},
  {type:'function_call_output',id:'fco_foreign',call_id:'agent_call',output:'Subagent result retained'},
  {type:'custom_tool_call',id:'ct_call_foreign',status:'completed',call_id:'patch_call',name:'apply_patch',input:'*** Begin Patch\n*** End Patch',internal_chat_message_metadata_passthrough:{turn_id:'gateway-turn'}},
  {type:'custom_tool_call_output',id:'ctco_foreign',call_id:'patch_call',output:'Success'},
 ];
 const rows=[{type:'session_meta',payload:{model_provider:'openai'}},{type:'response_item',payload:native},{type:'turn_context',payload:{model:'workbuddy/kimi-k3-1'}},...foreign.map(payload=>({type:'response_item',payload})),{type:'compacted',payload:{replacement_history:foreign,replacement_history_metadata:foreign.map(()=>({client_authored:false}))}},{type:'turn_context',payload:{model:'gpt-native'}},{type:'response_item',payload:native}];
 await writeFile(f.file,rows.map((r,ordinal)=>JSON.stringify({...r,ordinal})).join('\n')+'\n');
 await f.migration.prepareOfficial([],async()=>[]);
 const saved=(await readFile(f.file,'utf8')).trim().split('\n').map(s=>JSON.parse(s));
 const withoutIds=foreign.map(({id,...item})=>item);
 expect(saved.slice(3,8).map(r=>r.payload)).toEqual(withoutIds);
 expect(saved[8].payload.replacement_history).toEqual(withoutIds);
 expect(saved[8].payload).not.toHaveProperty('replacement_history_metadata');
 expect(saved[1].payload).toEqual(native);expect(saved.at(-1).payload).toEqual(native);
 expect(saved.map(r=>r.ordinal)).toEqual(rows.map((_,i)=>i));
 expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:0});
});

it('repairs source item IDs even when optional checkpoint normalization is disabled',async()=>{
 const f=await fixture();const reasoning={type:'reasoning',id:'rs_chatcmpl_keep',encrypted_content:'opaque',summary:[]};
 const rows=[{type:'session_meta',payload:{model_provider:'token_flow'}},{type:'response_item',payload:reasoning},{type:'response_item',payload:{type:'custom_tool_call',id:'ct_call_source',call_id:'pair',name:'apply_patch',input:'patch'}},{type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:'unavailable-opaque-checkpoint'}]}}];
 await writeFile(f.file,rows.map(r=>JSON.stringify(r)).join('\n'));
 await f.migration.repairLineage(async()=>[]);
 const saved=(await readFile(f.file,'utf8')).split('\n').map(r=>JSON.parse(r));
 expect(saved[2].payload).not.toHaveProperty('id');expect(saved[2].payload.call_id).toBe('pair');
 expect(saved[1]).toEqual(rows[1]);expect(saved[3]).toEqual(rows[3]);
});

it('recovers large local rollouts and histories without byte cutoffs',async()=>{
 const f=await fixture();const token='large-official-window';
 const first={type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(17*1024*1024)}]};
 const text=[{type:'response_item',payload:first},{type:'event_msg',payload:{type:'ignored',detail:'y'.repeat(49*1024*1024)}},checkpoint(token)].map(v=>JSON.stringify(v)).join('\n')+'\n';
 await writeFile(f.file,text);
 const recovered=await f.migration.recover({type:'compaction',encrypted_content:token},[]);
 expect(recovered).toHaveLength(1);expect(recovered[0].content[0].text).toHaveLength(17*1024*1024);
 const cached=await f.migration.recover({type:'compaction',encrypted_content:token},[]);
 expect(cached[0].content[0].text).toHaveLength(17*1024*1024);
 expect(createHash('sha256').update(await readFile(f.file)).digest('hex')).toBe(createHash('sha256').update(text).digest('hex'));
});

it.each([false,true])('invalidates immutable rollback IDs and repairs existing stale projections (alreadyRewritten=%s)',async alreadyRewritten=>{
 const f=await fixture(),logical='11111111-1111-4111-8111-111111111111',immutable='22222222-2222-4222-8222-222222222222';
 const path=join(f.file.slice(0,f.file.lastIndexOf('/')),`rollout-2026-10-23T01-00-00-${logical}_${immutable}.jsonl`);
 const original=[{ordinal:0,type:'session_meta',payload:{id:logical,model_provider:'token_flow'}},{ordinal:1,type:'response_item',payload:alreadyRewritten?{type:'message',role:'assistant',content:[]}:{type:'reasoning',id:'rs_chatcmpl_'+ 'x'.repeat(160),summary:[]}}].map(r=>JSON.stringify(r)+'\n').join('');await writeFile(path,original);
 const db=new DatabaseSync(join(f.root,'codex/thread_history_1.sqlite'));db.exec(await readFile(new URL('./fixtures/codex/thread-history-schema.sql',import.meta.url),'utf8'));
 const ids=[logical,immutable,'unrelated'];
 for(const id of ids){
  db.prepare('insert into thread_turns(thread_id,turn_id,rollout_ordinal,status) values (?,?,?,?)').run(id,'turn',0,'completed');
  db.prepare('insert into thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json) values (?,?,?,?,?,?)').run(id,'turn','item',0,0,'{}');
  db.prepare('insert into thread_realtime_items(thread_id,item_id,rollout_ordinal,created_at_ms,item_type,item_json) values (?,?,?,?,?,?)').run(id,'item',0,0,'message','{}');
  db.prepare('insert into thread_history_projection_state values (?,?,?)').run(id,999999,2);
 }
 try{
  await f.migration.prepareOfficial([],async()=>[]);
  for(const table of ['thread_turns','thread_items','thread_history_projection_state','thread_realtime_items'])expect(db.prepare(`select thread_id from ${table}`).all()).toEqual([{thread_id:'unrelated'}]);
  const saved=await readFile(path,'utf8');expect(saved).toContain(logical);expect(saved.trim().split('\n').map(r=>JSON.parse(r).ordinal)).toEqual([0,1]);
  if(alreadyRewritten)expect(saved).toBe(original);
  expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:0});
 }finally{db.close();}
});

it('retains an unchanged ancestor projection when its ID is also the reverted thread logical ID',async()=>{
 const f=await fixture(),logical='11111111-1111-4111-8111-111111111111',immutable='22222222-2222-4222-8222-222222222222',directory=f.file.slice(0,f.file.lastIndexOf('/'));
 const parent=join(directory,`rollout-2026-10-23T00-00-00-${logical}.jsonl`),child=join(directory,`rollout-2026-10-23T01-00-00-${logical}_${immutable}.jsonl`);
 const encode=(rows:any[],start=0)=>rows.map((r,index)=>JSON.stringify({...r,ordinal:start+index})+'\n').join('');
 const original=encode([{type:'session_meta',payload:{id:logical}},{type:'response_item',payload:{type:'message',role:'user',content:'ANCESTOR_KEPT'}}]);await writeFile(parent,original);
 await writeFile(child,encode([{type:'session_meta',payload:{id:logical,model_provider:'token_flow',history_base:{thread_id:logical,end_ordinal_exclusive:2,end_byte_offset:Buffer.byteLength(original)}}},{type:'response_item',payload:{type:'reasoning',id:'rs_chatcmpl_fixture',summary:[]}}],2));
 const db=new DatabaseSync(join(f.root,'codex/thread_history_1.sqlite'));db.exec(await readFile(new URL('./fixtures/codex/thread-history-schema.sql',import.meta.url),'utf8'));
 for(const id of [logical,immutable]){db.prepare('insert into thread_turns(thread_id,turn_id,rollout_ordinal,status) values (?,?,?,?)').run(id,'turn',0,'completed');db.prepare('insert into thread_history_projection_state values (?,?,?)').run(id,id===logical?Buffer.byteLength(original):999999,id===logical?2:4);}
 try{
  await f.migration.prepareOfficial([],async()=>[]);
  expect(db.prepare('select thread_id from thread_turns').all()).toEqual([{thread_id:logical}]);
  expect(await readFile(parent,'utf8')).toBe(original);expect(await f.migration.prepareOfficial([],async()=>[])).toEqual({migrated:0});
 }finally{db.close();}
});

it('treats an absent Codex home as having no history to repair',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'codex-context-empty-'));roots.push(root);
 const context=await GatewayContext.open(root),migration=new CodexContext(root,join(root,'not-created/config.toml'),context);
 expect(await migration.repairLineage(async()=>[])).toEqual({migrated:0});
});

it('materializes only gateway references for an official route, replacing covered users and keeping fresh/native items',async()=>{
 const f=await fixture(),old={role:'user',content:'OLD_COVERED_USER'},latest={role:'user',content:'LATEST_USER'};
 const input=[old,...Array.from({length:20},()=>({role:'assistant',content:'prior work '.repeat(1000)})),latest];
 const compact=await(await f.context.response('responses/compact',{model:'qoder/test',input},'key','source',async()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'SAVED_TASK_SUMMARY'}]}]}),{scope:codexContextScope,recover:item=>f.migration.recover(item,[])})).json();
 const native=[{type:'reasoning',id:'rs_native',encrypted_content:'native-encrypted-reasoning',summary:[]},{type:'message',id:'msg_native',role:'assistant',content:[{type:'output_text',text:'Native continuation'}]},{type:'compaction',id:'cmp_native',encrypted_content:'native-official-checkpoint'}];
 const developer={role:'developer',content:'FRESH_RULE'},fresh={role:'user',content:'FRESH_NEXT_REQUEST'},body={model:'gpt-official',input:[old,developer,...compact.output,...native,fresh],stream:true};
 const converted=await f.migration.forOfficial(body,[]);
 expect(JSON.stringify(converted)).not.toContain('tfctx1.');expect(converted.input).not.toContainEqual(old);
 expect(converted.input.filter(item=>item.role==='user').filter(item=>JSON.stringify(item).includes('LATEST_USER'))).toHaveLength(1);
 expect(converted.input).toContainEqual(developer);expect(converted.input).toContainEqual(fresh);for(const item of native)expect(converted.input).toContainEqual(item);
 expect(JSON.stringify(converted)).toContain('SAVED_TASK_SUMMARY');expect(body.input).toContainEqual(old);
 const untouched={model:'gpt-official',previous_response_id:'resp_native',input:native};expect(await f.migration.forOfficial(untouched,[])).toBe(untouched);
});

it('restores a private previous response before official inference and fails closed for unavailable private context',async()=>{
 const f=await fixture(),native={type:'message',id:'msg_native',role:'assistant',content:[{type:'output_text',text:'native suffix'}]};
 const first=await(await f.context.response('responses',{model:'qoder/test',input:'GATEWAY_FIRST'},'key','source',async()=>Response.json({status:'completed',output:[{type:'message',id:'msg_gateway',role:'assistant',content:[{type:'output_text',text:'GATEWAY_REPLY'}]}]}),{scope:codexContextScope,recover:item=>f.migration.recover(item,[])})).json();
 const converted=await f.migration.forOfficial({model:'gpt-official',previous_response_id:first.id,input:[native,{role:'user',content:'NEXT'}]},[]);
 expect(converted).not.toHaveProperty('previous_response_id');expect(JSON.stringify(converted.input)).toContain('GATEWAY_FIRST');expect(JSON.stringify(converted.input)).toContain('GATEWAY_REPLY');expect(JSON.stringify(converted.input)).not.toContain('msg_gateway');expect(converted.input).toContainEqual(native);
 await expect(f.migration.forOfficial({model:'gpt-official',input:[{type:'compaction',encrypted_content:'tfctx1.invalid'}]},[])).rejects.toThrow('恢复');
 await expect(f.migration.forOfficial({model:'gpt-official',previous_response_id:'resp_tf_'+'0'.repeat(32)},[])).rejects.toThrow();
});

it('expands a stored gateway compaction response ID before an official continuation',async()=>{
 const f=await fixture();
 const compact=await(await f.context.response('responses',{model:'qoder/test',input:[...history,{type:'compaction_trigger'}]},'key','source',async()=>{throw Error('small complete history needs no summary call');},{scope:codexContextScope,recover:item=>f.migration.recover(item,[])})).json();
 const converted=await f.migration.forOfficial({model:'gpt-official',previous_response_id:compact.id,input:[{role:'user',content:'NEXT_AFTER_CHECKPOINT'}]},[]);
 expect(converted).not.toHaveProperty('previous_response_id');expect(JSON.stringify(converted)).not.toContain('tfctx1.');expect(JSON.stringify(converted)).toContain('original tool result');expect(JSON.stringify(converted)).toContain('NEXT_AFTER_CHECKPOINT');
});
