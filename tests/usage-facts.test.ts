import {it,expect,afterEach} from 'vitest';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UsageLedger,type UsageEvent} from '../packages/core/src/usage-ledger.js';
import {accountTokens} from '../packages/core/src/usage-accounting.js';
import {LocalUsageParser,mergeLocalUsageRows} from '../packages/core/src/local-usage.js';
import {usageHash,usageRequestMetadata} from '../packages/core/src/usage-request-metadata.js';
import {DatabaseSync} from 'node:sqlite';
import {GatewayActivity} from '../packages/core/src/gateway-activity.js';
const roots:string[]=[],ledgers:UsageLedger[]=[];
afterEach(async()=>{for(const ledger of ledgers.splice(0))await ledger.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function open(){const root=await mkdtemp(join(tmpdir(),'usage-facts-'));roots.push(root);const ledger=await UsageLedger.open(root);ledgers.push(ledger);return {root,ledger};}
const time=new Date().toISOString();
const event=(overrides:Partial<UsageEvent>={}):UsageEvent=>({eventId:'one',target:'codex',keyId:'fixture',keyName:'fixture',sourceId:'codex-official',model:'gpt-test',startedAt:time,durationMs:10,status:200,inputTokens:null,outputTokens:null,cachedTokens:null,...overrides});
it('preserves total-only, partial and contradictory counters with explicit quality',()=>{
 expect(accountTokens({inputTokens:null,outputTokens:null,reportedTotalTokens:42})).toMatchObject({quality:'partial',unclassifiedTokens:42});
 expect(accountTokens({inputTokens:10,outputTokens:null,reportedTotalTokens:42})).toMatchObject({quality:'partial',inputTokens:10,unclassifiedTokens:32});
 expect(accountTokens({inputTokens:10,outputTokens:3,reportedTotalTokens:20})).toMatchObject({quality:'conflict',inputTokens:0,outputTokens:0,unclassifiedTokens:20});
 expect(accountTokens({inputTokens:100,outputTokens:30,cachedTokens:50,cacheWriteTokens:20,reasoningTokens:10,reportedTotalTokens:130})).toMatchObject({quality:'complete',inputTokens:100,outputTokens:30,unclassifiedTokens:0});
 expect(accountTokens({inputTokens:0,outputTokens:0})).toMatchObject({quality:'complete'});
});
it('persists facts immediately and updates one request without adding another consumption',async()=>{
 const {root,ledger}=await open();ledger.add(event());ledger.add(event({inputTokens:100,outputTokens:20}));ledger.add(event({inputTokens:100,outputTokens:20}));
 expect(ledger.list()[0]).toMatchObject({requests:1,inputTokens:100,outputTokens:20,completeRequests:1,unknownRequests:0});
 const reopened=await UsageLedger.open(root);ledgers.push(reopened);expect(reopened.list()).toEqual(ledger.list());
 expect(reopened.recent()).toHaveLength(1);
 expect(()=>ledger.add(event({model:'changed'}))).toThrow('identity');
});
it('keeps imported day totals once and never creates fake request identities for history',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usage-migrate-'));roots.push(root);
 const legacy={day:time.slice(0,10),target:'codex',keyId:'old',keyName:'old',sourceId:'old',model:'old',requests:4,failed:0,unmeasured:0,inputTokens:100,cachedTokens:0,cacheBaseTokens:0,outputTokens:20,durationMs:0,last:time};
 await writeFile(join(root,'usage-ledger.json'),JSON.stringify({version:1,rows:[legacy]}));const first=await UsageLedger.open(root);ledgers.push(first);first.add(event({inputTokens:5,outputTokens:2}));await first.close();
 const second=await UsageLedger.open(root);ledgers.push(second);expect(second.list().reduce((n,r)=>n+r.requests,0)).toBe(5);expect(second.list().find(r=>r.model==='old')).toMatchObject({legacyRequests:4,inputTokens:100});expect(second.recent()).toHaveLength(1);
});
it('reconciles exact child response evidence once, retains outcome and ignores ambiguous identities',async()=>{
 const {ledger}=await open(),responseHash=usageHash('response','child-response');ledger.add(event({responseHash,status:499,outcome:'cancelled'}));
 const parser=new LocalUsageParser('codex','child',{captureGatewayCandidates:true,matchesResponse:()=>true});
 parser.accept({type:'session_meta',payload:{id:'child',model_provider:'token_flow',source:{subagent:{thread_spawn:{parent_thread_id:'parent'}}}}});
 parser.accept({type:'turn_context',payload:{model:'gpt-test'}});
 parser.accept({type:'token_usage_record',timestamp:time,payload:{thread_id:'child',response_id:'child-response',usage:{input_tokens:100,output_tokens:10,cached_input_tokens:70}}});
 const rows=parser.rows();expect(rows[0]).toMatchObject({gatewayCandidate:true,taskKind:'subagent'});
 expect(ledger.reconcile(rows)).toBe(1);expect(ledger.reconcile(rows)).toBe(0);
 expect(ledger.list()[0]).toMatchObject({requests:1,failed:1,cancelledRequests:1,inputTokens:100,outputTokens:10,taskKind:'subagent',completeRequests:1});
 ledger.add(event({eventId:'second',responseHash,inputTokens:null,outputTokens:null}));expect(ledger.reconcile(rows)).toBe(0);
});
it('partitions authenticated official accounts and strips arbitrary content before storing',async()=>{
 const {root,ledger}=await open();for(const account of ['a','b'])ledger.add({...event({eventId:account,inputTokens:10,outputTokens:1}),...usageRequestMetadata({'chatgpt-account-id':account,session_id:'thread'},'responses',{},true),prompt:'never store this'} as UsageEvent);
 expect(ledger.list()).toHaveLength(2);expect(ledger.list().map(r=>r.billingAccountHash)).toEqual([usageHash('codex','a'),usageHash('codex','b')]);
 expect(JSON.stringify(ledger.recent())).not.toContain('never store');await ledger.close();expect((await readFile(join(root,'usage-facts.sqlite'))).includes(Buffer.from('never store'))).toBe(false);
});
it('preserves known metadata and cache counters when delayed evidence omits them',async()=>{
 const {ledger}=await open(),responseHash=usageHash('response','partial');
 ledger.add(event({responseHash,inputTokens:100,cachedTokens:30,billingAccountHash:usageHash('codex','a')}));
 ledger.add(event({inputTokens:100,outputTokens:null,cachedTokens:null}));
 expect(ledger.recent()[0]).toMatchObject({responseHash,cachedTokens:30,billingAccountHash:usageHash('codex','a')});
 expect(ledger.reconcile([{responseHash,inputTokens:100,outputTokens:10,cachedTokens:0}])).toBe(1);
 expect(ledger.list()[0]).toMatchObject({cachedTokens:30,inputTokens:100,outputTokens:10,requests:1});
});
it('does not use local evidence to conceal an inconsistent reported total',async()=>{
 const {ledger}=await open(),responseHash=usageHash('response','conflict');
 ledger.add(event({responseHash,inputTokens:100,reportedTotalTokens:90}));
 expect(ledger.reconcile([{responseHash,inputTokens:100,outputTokens:10,cachedTokens:0}])).toBe(0);
 expect(ledger.list()[0]).toMatchObject({conflictRequests:1,unclassifiedTokens:90});
});
it('buffers a locked database without breaking inference and retries idempotently',async()=>{
 const {root,ledger}=await open(),lock=new DatabaseSync(join(root,'usage-facts.sqlite'));
 lock.exec('BEGIN IMMEDIATE');
 try{expect(()=>ledger.add(event({inputTokens:10,outputTokens:1}))).not.toThrow();expect(ledger.warning).toContain('尚未写入');expect(ledger.list()[0]).toMatchObject({requests:1,inputTokens:10});}
 finally{lock.exec('ROLLBACK');lock.close();}
 await ledger.flush();expect(ledger.warning).toBe('');
 const reopened=await UsageLedger.open(root);ledgers.push(reopened);expect(reopened.recent()).toHaveLength(1);
});
it('keeps unreadable facts untouched and exposes degraded storage without preventing startup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usage-unavailable-'));roots.push(root);
 await writeFile(join(root,'usage-facts.sqlite'),'broken sqlite');
 const ledger=await UsageLedger.open(root);ledgers.push(ledger);ledger.add(event());await ledger.flush();
 expect(ledger.warning).toContain('无法打开');expect(ledger.recent()).toHaveLength(1);
 expect(await readFile(join(root,'usage-facts.sqlite'),'utf8')).toBe('broken sqlite');
});
it('invalid provider accounting cannot turn a successful response into a stream failure',async()=>{
 const {ledger}=await open(),activity=new GatewayActivity(ledger);
 expect(()=>activity.record({keyId:'k',agent:'fixture',model:'model',protocol:'responses',startedAt:time,durationMs:10,status:200,inputTokens:-1,outputTokens:10})).not.toThrow();
 expect(ledger.warning).toContain('元数据无效');expect(ledger.list()).toHaveLength(0);
});
it('keeps measured zero and does not turn null or invalid cache fields into known zero',async()=>{
 const {ledger}=await open();
 for(const cached of [null,-1,1.5,undefined]){
  const responseId=String(cached),responseHash=usageHash('response',responseId);
  ledger.add(event({eventId:responseId,responseHash}));
  const parser=new LocalUsageParser('codex','zero',{captureGatewayCandidates:true,matchesResponse:()=>true});
  parser.accept({type:'token_usage_record',timestamp:time,payload:{response_id:responseId,usage:{input_tokens:0,output_tokens:0,cached_input_tokens:cached,cache_write_input_tokens:cached,reasoning_output_tokens:cached}}});
  expect(parser.rows()[0]).toMatchObject({nativeCacheKnown:false,nativeCacheWriteKnown:false,nativeReasoningKnown:false,cacheBaseTokens:0});
  expect(ledger.reconcile(parser.rows())).toBe(1);
 }
 expect(ledger.list()[0]).toMatchObject({requests:4,completeRequests:4,inputTokens:0,outputTokens:0});
 expect(ledger.recent().every(r=>r.cachedTokens===null)).toBe(true);
});
it('merges child relationship evidence independently of copied sample order',()=>{
 const make=(child:boolean,parent='parent')=>{
  const p=new LocalUsageParser('codex',child?'child':'mirror');
  p.accept({type:'session_meta',payload:{id:child?'child':'parent',model_provider:'openai',source:child?{subagent:{thread_spawn:{parent_thread_id:parent}}}:'cli'}});
  p.accept({type:'token_usage_record',timestamp:time,payload:{thread_id:'child',response_id:'child',usage:{input_tokens:10,output_tokens:1}}});return p.rows();
 };
 for(const input of [[...make(true),...make(false)],[...make(false),...make(true)]])expect(mergeLocalUsageRows(input)[0]).toMatchObject({requests:1,taskKind:'subagent',nativeParentThreadId:usageHash('thread','parent')});
 expect(mergeLocalUsageRows([...make(true),...make(true,'different-parent')])[0]).toMatchObject({requests:1,taskKind:'unknown',nativeParentThreadId:undefined});
});

it('exports one legacy key across main/child accounts and imports rollback consumption exactly once',async()=>{
 const {root,ledger}=await open();
 ledger.add(event({eventId:'main',taskKind:'main',inputTokens:100,outputTokens:10}));
 ledger.add(event({eventId:'child',taskKind:'subagent',billingAccountHash:usageHash('codex','other'),inputTokens:100,outputTokens:10}));
 await ledger.close();
 const file=join(root,'usage-ledger.json'),saved=JSON.parse(await readFile(file,'utf8'));
 expect(saved.rows).toHaveLength(1);expect(saved.rows[0]).toMatchObject({requests:2,inputTokens:200,outputTokens:20});
 const row=saved.rows[0];row.requests++;row.inputTokens+=100;row.outputTokens+=10;row.durationMs+=10;
 // Old writers drop both the producer marker and fields they do not understand.
 await writeFile(file,JSON.stringify({version:1,rows:[row]}));
 const newer=await UsageLedger.open(root);ledgers.push(newer);
 expect(newer.list().reduce((n,r)=>n+r.inputTokens+r.outputTokens,0)).toBe(330);
 expect(newer.list().reduce((n,r)=>n+r.requests,0)).toBe(3);
 await newer.close();const again=await UsageLedger.open(root);ledgers.push(again);
 expect(again.list().reduce((n,r)=>n+r.inputTokens+r.outputTokens,0)).toBe(330);
});
it('never upgrades contradictory local counters to complete by clamping them',async()=>{
 const {ledger}=await open(),responseHash=usageHash('response','bad-native');ledger.add(event({responseHash}));
 for(const usage of [{input_tokens:100,output_tokens:10,cached_input_tokens:200},{input_tokens:100,output_tokens:10,total_tokens:120}]){
  const p=new LocalUsageParser('codex','fixture',{captureGatewayCandidates:true,matchesResponse:()=>true});
  p.accept({type:'token_usage_record',timestamp:time,payload:{response_id:'bad-native',usage}});
  expect(ledger.reconcile(p.rows())).toBe(0);
 }
 expect(ledger.list()[0]).toMatchObject({unknownRequests:1,completeRequests:0});
});
it('does not block startup after an interrupted export with a missing or corrupt JSON summary',async()=>{
 for(const corrupt of [false,true]){
  const root=await mkdtemp(join(tmpdir(),'usage-interrupt-'));roots.push(root);
  const {UsageFacts}=await import('../packages/core/src/usage-facts.js');const facts=await UsageFacts.open(root,[]);facts.exportCheckpoint([],false);facts.close();
  if(corrupt)await writeFile(join(root,'usage-ledger.json'),'{broken');
  const ledger=await UsageLedger.open(root);ledgers.push(ledger);expect(ledger.list()).toEqual([]);
 }
});
it('records the initial migration baseline in the import transaction, before the first export',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usage-migration-gap-'));roots.push(root);
 const row={day:time.slice(0,10),target:'codex',keyId:'old',keyName:'old',sourceId:'old',model:'old',requests:1,failed:0,unmeasured:0,inputTokens:100,cachedTokens:0,cacheBaseTokens:0,outputTokens:10,durationMs:10,last:time};
 const {UsageFacts}=await import('../packages/core/src/usage-facts.js');const facts=await UsageFacts.open(root,[row]);facts.close();
 await writeFile(join(root,'usage-ledger.json'),JSON.stringify({version:1,rows:[{...row,requests:2,inputTokens:200,outputTokens:20,durationMs:20}]}));
 const ledger=await UsageLedger.open(root);ledgers.push(ledger);expect(ledger.list()[0]).toMatchObject({requests:2,inputTokens:200,outputTokens:20});expect(ledger.warning).toBe('');
});
