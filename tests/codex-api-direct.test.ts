import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,writeFile,mkdir,rm,stat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parse,stringify} from 'smol-toml';
import {CodexApiDirect,codexConfigRevision,codexApiProvider} from '../packages/core/src/codex-api-direct.js';
import {probeCodexApi} from '../packages/core/src/codex-api-capability.js';
import {LocalUsageParser} from '../packages/core/src/local-usage.js';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const selection={sourceId:'a'.repeat(24),model:'vendor/model',baseURL:'https://api.example.test',apiKey:'synthetic-private-key',name:'Fixture'};
function expectRestored(actual:string,before:string){
 const doc:any=parse(actual),provider=codexApiProvider(selection.sourceId),inactive=doc.model_providers?.[provider];
 expect(inactive).toMatchObject({requires_openai_auth:false,base_url:'http://127.0.0.1:9527/codex/inactive/v1'});
 expect(actual).not.toContain(selection.apiKey);
 delete doc.model_providers[provider];if(!Object.keys(doc.model_providers).length)delete doc.model_providers;
 expect(doc).toEqual(parse(before));
}
it('writes the saved API model catalog, preserving each model capability',async()=>{
 const {config,manager,before}=await setup();
 await manager.apply({...selection,models:[{id:selection.model,capabilities:{contextWindow:65536}},{id:'vendor/large',capabilities:{contextWindow:131072}}]},codexConfigRevision(before));
 const doc:any=parse(await readFile(config,'utf8')),catalog=JSON.parse(await readFile(doc.model_catalog_json,'utf8'));
 expect(catalog.models.map((m:any)=>[m.slug,m.context_window])).toEqual([[selection.model,65536],['vendor/large',131072]]);
 doc.model='vendor/large';doc.model_reasoning_effort='low';await writeFile(config,stringify(doc));
 expect((await manager.status())?.configured).toBe(true);
 await manager.restore(codexConfigRevision(await readFile(config,'utf8')));expectRestored(await readFile(config,'utf8'),before);
});
async function setup(before='model="official-test"\nmodel_provider="openai"\n'){
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-direct-test-'));roots.push(root);const config=join(root,'home','config.toml');await mkdir(join(root,'home'));await writeFile(config,before);await writeFile(join(root,'home','auth.json'),'OFFICIAL LOGIN');
 const manager=new CodexApiDirect(root,config,async()=>[]);return {root,config,manager,before};
}
const assistant=(text:string)=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});
export function compatibleFetch(calls:any[]=[]):typeof fetch{
 return (async(_url:any,init:any)=>{
  const body=JSON.parse(init.body);calls.push(body);
  const nonce=JSON.stringify(body.input).match(/value ([a-f0-9]{12})/)![1];
  const output=body.tools?.length&&!body.input.some((item:any)=>item.type==='function_call_output')?[{type:'function_call',name:'tokenflow_probe',call_id:'call_test',arguments:JSON.stringify({value:nonce})}]:[assistant(nonce)];
  return new Response(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:{status:'completed',output,usage:{input_tokens:20,output_tokens:3,total_tokens:23}}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
 }) as typeof fetch;
}
it('checks native streaming, actual tool call/result, continuation and readable summary',async()=>{
 const calls:any[]=[],usage:any[]=[];const result=await probeCodexApi(selection,new AbortController().signal,u=>usage.push(u),compatibleFetch(calls));
 expect(result).toMatchObject({tools:true,multiTurn:true,localSummary:true,remoteCompaction:'unsupported'});expect(calls).toHaveLength(3);expect(calls[1].input.some((i:any)=>i.type==='function_call_output'&&i.call_id==='call_test')).toBe(true);expect(usage).toHaveLength(3);expect(JSON.stringify(result)).not.toContain(selection.apiKey);
});
it.each(['missing-terminal','incomplete','json','no-tools'])('rejects %s instead of enabling direct mode',async mode=>{
 const fetcher=(async()=>new Response(mode==='json'?'{}':`data: ${JSON.stringify(mode==='missing-terminal'?{type:'response.output_text.delta',delta:'OK'}:mode==='incomplete'?{type:'response.incomplete'}:{type:'response.completed',response:{status:'completed',output:[assistant('OK')]}})}\n\n`,{headers:{'content-type':mode==='json'?'application/json':'text/event-stream'}})) as typeof fetch;
 await expect(probeCodexApi(selection,new AbortController().signal,undefined,fetcher)).rejects.toMatchObject({code:'codex_api_incompatible'});
});
it('cancellation stops the probe and does not publish a capability',async()=>{
 const controller=new AbortController();controller.abort();let count=0;
 const fetcher=(async(_url:any,init:any)=>{count++;init.signal.throwIfAborted();return new Response();}) as typeof fetch;
 await expect(probeCodexApi(selection,controller.signal,undefined,fetcher)).rejects.toThrow('取消');expect(count).toBe(1);
});
it('applies saved configuration without a probe and never exposes keys in status',async()=>{
 const {manager,before,config}=await setup();
 await manager.apply(selection,codexConfigRevision(before));const doc:any=parse(await readFile(config,'utf8'));expect(doc.model_provider).toBe(codexApiProvider(selection.sourceId));expect(doc.model).toBe('vendor/model');expect(doc.model_providers[doc.model_provider].base_url).toBe(selection.baseURL);expect(doc.model_providers[doc.model_provider].capabilities.remote_compaction).toBe('unsupported');expect(doc.model_providers[doc.model_provider].requires_openai_auth).toBe(false);
 expect(JSON.stringify(await manager.status())).not.toContain(selection.apiKey);expect((await stat(config)).mode&0o777).toBe(0o600);expect(await readFile(join(config,'..','auth.json'),'utf8')).toBe('OFFICIAL LOGIN');
});
it('restores original auth/routing and preserves independent edits',async()=>{
 const {manager,before,config}=await setup('model="official-test"\nmodel_provider="openai"\nforced_login_method="chatgpt"\npreferred_auth_method="chatgpt"\nweb_search="cached"\n[features]\nmulti_agent_v2=true\n');await manager.apply(selection,codexConfigRevision(before));
 const applied=parse(await readFile(config,'utf8'));const edited=stringify({...applied,personality:'friendly'});await writeFile(config,edited);
 await manager.restore(codexConfigRevision(edited));const restored=parse(await readFile(config,'utf8'));expectRestored(await readFile(config,'utf8'),stringify({...parse(before),personality:'friendly'}));expect(await manager.status()).toBeNull();
});
it('rejects stale revisions, owned-field drift and running clients without overwriting',async()=>{
 const {manager,before,config,root}=await setup();await expect(manager.apply(selection,'0'.repeat(64))).rejects.toThrow('变化');
 await manager.apply(selection,codexConfigRevision(before));const changed=stringify({...parse(await readFile(config,'utf8')),model:'user-choice'});await writeFile(config,changed);await expect(manager.restore(codexConfigRevision(changed))).rejects.toThrow('其他操作');expect(await readFile(config,'utf8')).toBe(changed);
 const running=new CodexApiDirect(root,config,async()=>[42]);await expect(running.restore(codexConfigRevision(changed))).rejects.toThrow('退出');
});
it('recovers a prepared journal whose config replacement had not started',async()=>{
 const {manager,before,config,root}=await setup();await manager.apply(selection,codexConfigRevision(before));const path=join(root,'codex-api-direct','active.json'),journal=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...journal,state:'prepared'}));await writeFile(config,before);await manager.restore(codexConfigRevision(before));expect(await readFile(config,'utf8')).toBe(before);
});
it('counts API direct usage locally without charging the retained official login',()=>{
 const parser=new LocalUsageParser('codex','fixture');parser.accept({type:'session_meta',payload:{id:'thread',source:'cli',model_provider:codexApiProvider(selection.sourceId),creator_account_id:'retained-official',account_id:'retained-official'}});parser.accept({type:'turn_context',payload:{model:'deepseek-flash'}});parser.accept({type:'token_usage_record',timestamp:'2026-10-29T12:00:00Z',payload:{response_id:'response',usage:{input_tokens:20,output_tokens:3,total_tokens:23}}});
 const result={rows:parser.rows()};expect(JSON.stringify(result)).not.toContain('retained-official');expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({channel:'api',sourceId:'',inputTokens:20,outputTokens:3});expect(result.rows[0].nativeAccountId).toBeUndefined();
});
it('lets recorded official transport evidence override a custom provider name',()=>{
 const parser=new LocalUsageParser('codex','fixture',{channelFor:()=> 'official'});
 parser.accept({type:'session_meta',payload:{id:'thread',source:'cli',model_provider:'custom',account_id:'actual-official'}});
 parser.accept({type:'turn_context',payload:{model:'official-model'}});
 parser.accept({type:'token_usage_record',timestamp:'2026-10-31T12:00:00Z',payload:{response_id:'response',usage:{input_tokens:20,output_tokens:3,total_tokens:23}}});
 expect(parser.rows()[0]).toMatchObject({channel:'official',nativeAccountId:expect.any(String)});
});
it('keeps a credential-free inactive provider so API history can still be opened after restoration',async()=>{
 const {manager,before,config}=await setup();await manager.apply(selection,codexConfigRevision(before));await manager.restore(await manager.revision());
 const restored:any=parse(await readFile(config,'utf8')),inactive=restored.model_providers?.[codexApiProvider(selection.sourceId)];
 expect(restored.model_provider).toBe('openai');expect(inactive).toBeDefined();
 expect(inactive.requires_openai_auth).toBe(false);expect(inactive.base_url).toBe('http://127.0.0.1:9527/codex/inactive/v1');
 expect(JSON.stringify(restored)).not.toContain(selection.apiKey);expect(JSON.stringify(restored)).not.toContain(selection.baseURL);
 await manager.apply(selection,await manager.revision());expect((await manager.status())?.configured).toBe(true);
 await manager.restore(await manager.revision());expect(parse(await readFile(config,'utf8'))).toEqual(restored);
});
it('recovers a completed restore journal while preserving independent configuration edits',async()=>{
 const {manager,before,config,root}=await setup();await manager.apply(selection,codexConfigRevision(before));
 await writeFile(config,stringify({...parse(await readFile(config,'utf8')),personality:'friendly'}));
 await manager.restore(await manager.revision());const restored=await readFile(config,'utf8');
 const path=join(root,'codex-api-direct/active.json'),entry=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...entry,state:'applied'}));
 await manager.restore(await manager.revision());expect(await readFile(config,'utf8')).toBe(restored);expect(await manager.status()).toBeNull();
});
it('shares one custom identity across APIs, replacing only the active route',async()=>{
 const {manager,before,config}=await setup();const other={...selection,sourceId:'b'.repeat(24),name:'Other API',apiKey:'other-synthetic-key'};
 await manager.apply(selection,codexConfigRevision(before));await manager.restore(await manager.revision());
 await manager.apply(other,await manager.revision());await manager.restore(await manager.revision());
 const restored:any=parse(await readFile(config,'utf8'));expect(restored.model_provider).toBe('openai');
 expect(Object.keys(restored.model_providers).sort()).toEqual(['custom']);
 expect(JSON.stringify(restored)).not.toContain(selection.apiKey);expect(JSON.stringify(restored)).not.toContain(other.apiKey);
 await manager.apply(selection,await manager.revision());const selected:any=parse(await readFile(config,'utf8'));
 expect(selected.model_providers[codexApiProvider(selection.sourceId)].experimental_bearer_token).toBe(selection.apiKey);
 expect(selected.model_providers.custom.base_url).toBe(selection.baseURL);
});
