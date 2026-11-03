import {expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {agentPaths} from '../packages/core/src/agent-connections.js';
import {LocalUsageIndex} from '../packages/core/src/local-usage-index.js';
import {NativeUsageLogins} from '../packages/core/src/native-usage-logins.js';
import {nativeIdentity} from '../packages/core/src/local-usage.js';
import {claudeDesktopDirectory} from '../packages/core/src/claude-desktop.js';

it('indexes isolated API histories without traversing their desktop data or counting an imported chat twice',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tf-api-usage-')),paths=agentPaths(root),api=join(root,'codex-api-workspaces','a'.repeat(24)),index=new LocalUsageIndex(root,paths);
 const sample=(id:string)=>[
  {type:'session_meta',payload:{id,model_provider:'api_direct_'+'a'.repeat(24)}},
  {type:'turn_context',payload:{model:'api-model',auth_mode:'api_key'}},
  {type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'token_count',info:{total_token_usage:{total_tokens:15,input_tokens:10,output_tokens:5},last_token_usage:{input_tokens:10,output_tokens:5}}}},
 ].map(row=>JSON.stringify(row)).join('\n');
 const content=sample('owned-api-chat');
 try{
  for(const [directory,text]of [[join(root,'.codex','archived_sessions'),content],[join(api,'home','sessions'),content],[join(api,'desktop','logs'),sample('desktop-noise')]]){
   await mkdir(directory,{recursive:true});await writeFile(join(directory,'fixture.jsonl'),text);
  }
  index.snapshot();await vi.waitFor(()=>{const state=index.snapshot();expect(state.scanning).toBe(false);expect(state.coverage.find(c=>c.target==='codex')).toMatchObject({files:2,indexed:2});expect(state.rows).toHaveLength(1);expect(state.rows[0]).toMatchObject({channel:'api',requests:1,inputTokens:10,outputTokens:5});},{timeout:5000,interval:25});
 }finally{await index.close();await rm(root,{recursive:true,force:true});}
});

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

it('keeps historical Desktop API usage stable when the current profile changes, including after restart',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-desktop-history-')),paths=agentPaths(root),directory=join(root,'.claude','projects'),desktop=claudeDesktopDirectory(process.platform,root,{}),id='11111111-2222-3333-4444-555555555555';let index=new LocalUsageIndex(root,paths,()=>[9527]);
 try{
  await mkdir(directory,{recursive:true});await mkdir(join(desktop,'configLibrary'),{recursive:true});
  const profile=async(url:string)=>{await writeFile(join(desktop,'claude_desktop_config.json'),JSON.stringify({deploymentMode:'3p'}));await writeFile(join(desktop,'configLibrary','_meta.json'),JSON.stringify({appliedId:id}));await writeFile(join(desktop,'configLibrary',`${id}.json`),JSON.stringify({inferenceProvider:'gateway',inferenceGatewayBaseUrl:url}));};
  const entry=(id:string)=>JSON.stringify({type:'assistant',timestamp:'2026-10-17T08:00:00Z',entrypoint:'claude-desktop-3p',accountId:'not-the-payer',requestedModel:'claude-sonnet-4-6',message:{id,model:'claude-sonnet-4-6',usage:{input_tokens:100,output_tokens:10}}});
  await writeFile(join(directory,'history.jsonl'),[entry('external-response'),entry('gateway-response')].join('\n'));
  const settled=async(requests=1)=>{await vi.waitFor(()=>{const state=index.snapshot();expect(state.scanning).toBe(false);expect(state.warning).toBeUndefined();expect(state.rows).toHaveLength(1);expect(state.rows[0]).toMatchObject({target:'claude-desktop',channel:'api',requests,inputTokens:100*requests,outputTokens:10*requests});expect(state.rows[0].nativeAccountId).toBeUndefined();},{timeout:5000,interval:25});};
  await profile('https://external.example.test');index.snapshot();await settled(2);
  await writeFile(join(root,'gateway-traces.json'),JSON.stringify({salt:'a'.repeat(64),records:[{responseHash:nativeIdentity('response','gateway-response')}]}));index.refresh();await settled();
  for(const url of ['http://127.0.0.1:9527','https://external.example.test']){await profile(url);index.refresh();await settled();}
  await index.close();await rm(join(root,'gateway-traces.json'));await profile('http://127.0.0.1:9527');index=new LocalUsageIndex(root,paths,()=>[9527]);index.snapshot();await settled();
  await writeFile(join(directory,'history.jsonl'),[entry('external-response'),entry('gateway-response'),entry('another-external-response')].join('\n'));index.refresh();await settled(2);
  await index.close();await rm(join(root,'local-usage-index.json'));index=new LocalUsageIndex(root,paths,()=>[9527]);index.snapshot();await settled(2);
 }finally{await index.close();await rm(root,{recursive:true,force:true});}
});

it('rebuilds v15 Claude cache to recover third-party history previously hidden by the current profile',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-desktop-reindex-')),paths=agentPaths(root),directory=join(root,'.claude','projects');let index=new LocalUsageIndex(root,paths);
 try{
  await mkdir(directory,{recursive:true});await writeFile(join(directory,'history.jsonl'),JSON.stringify({type:'assistant',timestamp:'2026-10-17T08:00:00Z',entrypoint:'claude-desktop-3p',message:{id:'external-response',model:'claude-test',usage:{input_tokens:100,output_tokens:10}}}));
  index.snapshot();await vi.waitFor(()=>{expect(index.snapshot().scanning).toBe(false);expect(index.snapshot().rows).toHaveLength(1);},{timeout:5000,interval:25});await index.close();
  const path=join(root,'local-usage-index.json'),saved=JSON.parse(await readFile(path,'utf8'));saved.version=15;saved.claudeDesktopGateway=false;for(const entry of Object.values(saved.files) as Array<{target:string;rows:unknown[]}>){if(entry.target==='claude')entry.rows=[];}await writeFile(path,JSON.stringify(saved));
  index=new LocalUsageIndex(root,paths);index.snapshot();await vi.waitFor(()=>{const state=index.snapshot();expect(state.scanning).toBe(false);expect(state.rows[0]).toMatchObject({target:'claude-desktop',channel:'api',inputTokens:100,outputTokens:10});},{timeout:5000,interval:25});
 }finally{await index.close();await rm(root,{recursive:true,force:true});}
});

it('rebuilds v17 Desktop aliases from unchanged logs and keeps gateway responses excluded',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-desktop-alias-')),paths=agentPaths(root),directory=join(root,'.claude','projects');let index=new LocalUsageIndex(root,paths);
 try{
  await mkdir(directory,{recursive:true});
  const entry=(id:string)=>JSON.stringify({type:'assistant',timestamp:'2026-10-20T05:39:03Z',entrypoint:'claude-desktop-3p',requestedModel:'claude-sonnet-4-8',message:{id,model:'claude-opus-5',usage:{input_tokens:100,output_tokens:10}}});
  await writeFile(join(directory,'history.jsonl'),[entry('external'),entry('gateway')].join('\n'));
  await writeFile(join(root,'gateway-response-evidence.jsonl'),JSON.stringify(nativeIdentity('response','gateway'))+'\n');
  index.snapshot();await vi.waitFor(()=>{expect(index.snapshot().scanning).toBe(false);expect(index.snapshot().rows).toHaveLength(1);},{timeout:5000,interval:25});await index.close();
  const path=join(root,'local-usage-index.json'),saved=JSON.parse(await readFile(path,'utf8'));saved.version=17;
  for(const entry of Object.values(saved.files) as Array<{rows:Array<{model:string}>}>)for(const row of entry.rows)row.model='claude-sonnet-4-8';
  await writeFile(path,JSON.stringify(saved));index=new LocalUsageIndex(root,paths);index.snapshot();
  await vi.waitFor(()=>{const state=index.snapshot();expect(state.scanning).toBe(false);expect(state.rows).toEqual([expect.objectContaining({model:'claude-opus-5',requests:1,inputTokens:100})]);expect(state.recent?.[0].model).toBe('claude-opus-5');},{timeout:5000,interval:25});
 }finally{await index.close();await rm(root,{recursive:true,force:true});}
});

it.each([10,11,12,13,14,15,16])('retains confirmed Claude attribution through v%s migration after observations expire',async(version)=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-claude-usage-')),paths=agentPaths(root),directory=join(root,'.claude','projects');let index=new LocalUsageIndex(root,paths);
 try{
  const store=await NativeUsageLogins.open(root),now=Date.parse('2026-10-16T10:00:00Z'),a={provider:'claude' as const,accountId:'a',email:'a@example.test'},b={...a,accountId:'b',email:'b@example.test'};
  await store.observe({codex:null,claude:a},now);await store.observe({codex:null,claude:a},now+5000);
  await mkdir(directory,{recursive:true});const entry=(time:number)=>JSON.stringify({type:'assistant',timestamp:new Date(time).toISOString(),message:{id:`response-${time}`,model:'claude-sonnet-4-6',usage:{input_tokens:100,output_tokens:20}}});const file=join(directory,'session.jsonl'),original=entry(now+1000);
  await writeFile(file,original);index.snapshot();await vi.waitFor(()=>{const state=index.snapshot();expect(state.scanning).toBe(false);expect(state.recent?.[0]).toMatchObject({nativeAccountId:nativeIdentity('claude','a'),channel:'official'});},{timeout:5000,interval:25});await index.close();
  await store.observe({codex:null,claude:b},now+10000);await store.observe({codex:null,claude:b},now+15000);
  const saved=JSON.parse(await readFile(join(root,'native-usage-logins.json'),'utf8'));saved.intervals=saved.intervals.filter((i:{account:string})=>i.account===nativeIdentity('claude','b'));await writeFile(join(root,'native-usage-logins.json'),JSON.stringify(saved));
  const cachePath=join(root,'local-usage-index.json'),cached=JSON.parse(await readFile(cachePath,'utf8'));cached.version=version;await writeFile(cachePath,JSON.stringify(cached));
  index=new LocalUsageIndex(root,paths);index.snapshot();await vi.waitFor(()=>{const state=index.snapshot();expect(state.scanning).toBe(false);expect(state.recent?.[0]).toMatchObject({nativeAccountId:nativeIdentity('claude','a'),channel:'official'});},{timeout:5000,interval:25});
  await writeFile(file,original+'\n'+entry(now+12000));index.refresh();
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
  expect(JSON.parse(await readFile(path,'utf8')).version).toBe(21);
  await index.close();await writeFile(join(root,'usage-account-evidence.json'),JSON.stringify({version:1,records:[]}));
  const log=join(directory,'parent.jsonl');await writeFile(log,(await readFile(log,'utf8'))+'\n'+JSON.stringify({type:'token_usage_record',timestamp,payload:{response_id:'new-unconfirmed-response',thread_id:'child',usage:{input_tokens:10,output_tokens:2}}}));
  index=new LocalUsageIndex(root,paths);index.snapshot();
  await vi.waitFor(()=>{const s=index.snapshot();expect(s.scanning).toBe(false);expect(s.recent).toHaveLength(2);expect(s.recent?.find(r=>r.inputTokens===100)).toMatchObject({model:'fixture-model',nativeAccountEvidence:'otel',nativeAccountId:nativeIdentity('codex','payer')});expect(s.recent?.find(r=>r.inputTokens===10)).toMatchObject({model:'未标注模型',nativeModelUnconfirmed:true});expect(s.recent?.find(r=>r.inputTokens===10)?.nativeAccountId).toBeUndefined();},{timeout:5000,interval:25});
 }finally{await index.close();await rm(root,{recursive:true,force:true});}
});
