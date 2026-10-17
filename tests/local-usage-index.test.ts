import {expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {agentPaths} from '../packages/core/src/agent-connections.js';
import {LocalUsageIndex} from '../packages/core/src/local-usage-index.js';
import {NativeUsageLogins} from '../packages/core/src/native-usage-logins.js';
import {nativeIdentity} from '../packages/core/src/local-usage.js';

it.each(['cordis.patch.yml','profiles/desktop/cordis.patch.yml'])('indexes shared DeepSeek sessions with settings at %s',async config=>{
 const root=await mkdtemp(join(tmpdir(),'tf-deepseek-usage-')),home=join(root,'.dsh');
 const index=new LocalUsageIndex(root,{...agentPaths(root),deepseek:join(home,config)});
 try{
  await mkdir(join(home,'sessions'),{recursive:true});
  await writeFile(join(home,'sessions','fixture.jsonl'),[
   {type:'model/selection',data:{provider:'deepseek',model:'native-model'}},
   {type:'assistant/message',seq:1,time:Date.now(),data:{usage:{inputTokens:10,outputTokens:5}}},
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  index.snapshot();
  await vi.waitFor(()=>{
   const state=index.snapshot();expect(state.scanning).toBe(false);expect(state.warning).toBeUndefined();
   expect(state.coverage.find(item=>item.target==='deepseek')).toMatchObject({files:1,indexed:1,status:'ready'});
   expect(state.rows).toHaveLength(1);expect(state.rows[0]).toMatchObject({target:'deepseek',inputTokens:10,outputTokens:5});
  },{timeout:5000,interval:25});
 }finally{await index.close();await rm(root,{recursive:true,force:true});}
});

it('retains Claude account and official classification when a log grows after restart and older observations expire',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-claude-usage-')),paths=agentPaths(root),directory=join(root,'.claude','projects');let index=new LocalUsageIndex(root,paths);
 try{
  const store=await NativeUsageLogins.open(root),now=Date.parse('2026-10-16T10:00:00Z'),a={provider:'claude' as const,accountId:'a',email:'a@example.test'},b={...a,accountId:'b',email:'b@example.test'};
  await store.observe({codex:null,claude:a},now);await store.observe({codex:null,claude:a},now+5000);
  await mkdir(directory,{recursive:true});const entry=(time:number)=>JSON.stringify({type:'assistant',timestamp:new Date(time).toISOString(),message:{id:`response-${time}`,model:'claude-sonnet-4-6',usage:{input_tokens:100,output_tokens:20}}});const file=join(directory,'session.jsonl'),original=entry(now+1000);
  await writeFile(file,original);index.snapshot();await vi.waitFor(()=>{const state=index.snapshot();expect(state.scanning).toBe(false);expect(state.recent?.[0]).toMatchObject({nativeAccountId:nativeIdentity('claude','a'),channel:'official'});},{timeout:5000,interval:25});await index.close();
  await store.observe({codex:null,claude:b},now+10000);await store.observe({codex:null,claude:b},now+15000);
  const saved=JSON.parse(await readFile(join(root,'native-usage-logins.json'),'utf8'));saved.intervals=saved.intervals.filter((i:{account:string})=>i.account===nativeIdentity('claude','b'));await writeFile(join(root,'native-usage-logins.json'),JSON.stringify(saved));
  await writeFile(file,original+'\n'+entry(now+12000));index=new LocalUsageIndex(root,paths);index.snapshot();
  await vi.waitFor(()=>{const state=index.snapshot();expect(state.scanning).toBe(false);expect(state.rows.map(r=>[r.nativeAccountId,r.channel,r.requests]).sort()).toEqual([['a','official',1],['b','official',1]].map(([id,channel,requests])=>[nativeIdentity('claude',String(id)),channel,requests]).sort());expect(state.recent).toHaveLength(2);},{timeout:5000,interval:25});
 }finally{await index.close();await rm(root,{recursive:true,force:true});}
});

it('rebuilds v12 Codex cache so an unchanged parent log uses request-level child identity',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-codex-reindex-')),paths=agentPaths(root),directory=join(root,'.codex','sessions');let index=new LocalUsageIndex(root,paths);
 try{
  await mkdir(directory,{recursive:true});const timestamp='2026-10-16T10:00:00Z';
  await writeFile(join(directory,'parent.jsonl'),[
   {type:'session_meta',payload:{id:'parent',creator_account_id:'not-payer',model_provider:'openai'}},
   {type:'turn_context',payload:{model:'fixture-model'}},
   {type:'token_usage_record',timestamp,payload:{response_id:'response',thread_id:'child',usage:{input_tokens:100,cached_input_tokens:60,output_tokens:20}}},
  ].map(r=>JSON.stringify(r)).join('\n'));
  await writeFile(join(root,'usage-account-evidence.json'),JSON.stringify({version:1,records:[{thread:nativeIdentity('thread','child'),time:Date.parse(timestamp),model:'fixture-model',input:100,read:60,write:0,output:20,account:nativeIdentity('codex','payer')}]}));
  index.snapshot();await vi.waitFor(()=>{expect(index.snapshot().scanning).toBe(false);expect(index.snapshot().rows).toHaveLength(1);},{timeout:5000,interval:25});await index.close();
  const path=join(root,'local-usage-index.json'),saved=JSON.parse(await readFile(path,'utf8'));saved.version=12;
  for(const e of Object.values(saved.files) as Array<{target:string;rows:any[]}>){if(e.target==='codex')for(const r of e.rows){r.nativeThreadId=nativeIdentity('thread','parent');delete r.nativeAccountId;delete r.nativeAccountEvidence;}}
  await writeFile(path,JSON.stringify(saved));index=new LocalUsageIndex(root,paths);index.snapshot();
  await vi.waitFor(()=>{const s=index.snapshot();expect(s.scanning).toBe(false);expect(s.rows[0]).toMatchObject({nativeAccountId:nativeIdentity('codex','payer'),nativeAccountEvidence:'otel',requests:1,inputTokens:100,outputTokens:20});},{timeout:5000,interval:25});
  expect(JSON.parse(await readFile(path,'utf8')).version).toBe(15);
  await index.close();await writeFile(join(root,'usage-account-evidence.json'),JSON.stringify({version:1,records:[]}));
  const log=join(directory,'parent.jsonl');await writeFile(log,(await readFile(log,'utf8'))+'\n'+JSON.stringify({type:'token_usage_record',timestamp,payload:{response_id:'new-unconfirmed-response',thread_id:'child',usage:{input_tokens:10,output_tokens:2}}}));
  index=new LocalUsageIndex(root,paths);index.snapshot();
  await vi.waitFor(()=>{const s=index.snapshot();expect(s.scanning).toBe(false);expect(s.recent).toHaveLength(2);expect(s.recent?.find(r=>r.inputTokens===100)).toMatchObject({model:'fixture-model',nativeAccountEvidence:'otel',nativeAccountId:nativeIdentity('codex','payer')});expect(s.recent?.find(r=>r.inputTokens===10)).toMatchObject({model:'未标注模型',nativeModelUnconfirmed:true});expect(s.recent?.find(r=>r.inputTokens===10)?.nativeAccountId).toBeUndefined();},{timeout:5000,interval:25});
 }finally{await index.close();await rm(root,{recursive:true,force:true});}
});
