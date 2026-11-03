import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,readdir,rm,writeFile,mkdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readModelCapabilities,codexReasoningMetadata,modelCapabilityPreset} from '../packages/core/src/model-capabilities.js';
import {ModelMetadataCache} from '../packages/core/src/model-metadata-cache.js';
import {codexModelCatalog} from '../packages/core/src/codex-model-catalog.js';
import {loadOfficialCodexCatalogForAuth} from '../packages/core/src/codex-coexist.js';
import {CodexApiDirect,codexConfigRevision} from '../packages/core/src/codex-api-direct.js';
import {parse} from 'smol-toml';
import {createServer} from 'node:http';
import {ApiSources} from '../packages/core/src/api-sources.js';
import {defaultProvider} from '../packages/core/src/providers.js';
import {apiReasoningBody} from '../packages/core/src/model-presets.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function directory(){const root=await realpath(await mkdtemp(join(tmpdir(),'tf-model-metadata-')));roots.push(root);return root;}

it('keeps total, input and output limits distinct and whitelists metadata',()=>{
 expect(readModelCapabilities({context_window:100000,max_input_tokens:90000,max_output_tokens:10000,api_key:'SECRET',headers:{authorization:'SECRET'},base_instructions:'NOT METADATA',supported_reasoning_levels:[{effort:'low'},'max','invented'],default_reasoning_level:'max'})).toEqual({contextWindow:100000,maxInputTokens:90000,maxOutputTokens:10000,reasoning:{levels:['low','max'],default:'max'}});
 expect(readModelCapabilities({context_window:-1,max_output_tokens:'4096'})).toEqual({});
});
it('matches DeepSeek by exact host, protocol, path and model; preserves max literally',()=>{
 const cap=modelCapabilityPreset('https://api.deepseek.com/v1','responses','deepseek-flash')!;
 expect(cap.contextWindow).toBe(1048576);expect(cap.autoCompactTokenLimit).toBeNull();
 expect(codexReasoningMetadata(cap,false)).toMatchObject({default_reasoning_level:'high',supported_reasoning_levels:[{effort:'low'},{effort:'high'},{effort:'max'}]});
 for(const url of ['https://api.deepseek.com.evil.test','https://other.test/deepseek.com','https://api.deepseek.com/tenant','https://api.deepseek.com?tenant=x'])expect(modelCapabilityPreset(url,'responses','deepseek-flash')).toBeUndefined();
 expect(modelCapabilityPreset('https://api.deepseek.com','chat','deepseek-flash')).toBeUndefined();
 expect(modelCapabilityPreset('https://api.deepseek.com','responses','deepseek-future')).toBeUndefined();
});
it('offers only budget efforts within both native range and output limit, never for direct mode',()=>{
 const cap=readModelCapabilities({thinking:{min:1024,max:32768},max_output_tokens:16384});
 expect(codexReasoningMetadata(cap).supported_reasoning_levels.map(v=>v.effort)).toEqual(['low','medium']);
 expect(codexReasoningMetadata(cap,false).supported_reasoning_levels).toEqual([]);
 expect(codexModelCatalog('budget',{}, {},{}, {budget:cap}).models[0].supported_reasoning_levels).toEqual([]);
 expect(codexModelCatalog('budget',{}, {},{}, {budget:cap},['budget']).models[0].supported_reasoning_levels.map(v=>v.effort)).toEqual(['low','medium']);
 expect(codexReasoningMetadata(readModelCapabilities({thinking:{min:1024,max:32768,levels:[]}})).supported_reasoning_levels).toEqual([]);
 expect(codexReasoningMetadata().default_reasoning_level).toBeNull();
});
it('uses exact vendor presets and enables the declared Chat thinking switch without renaming efforts',()=>{
 expect(modelCapabilityPreset('https://api.moonshot.cn/v1','responses','kimi-k3')?.reasoning?.levels).toEqual(['low','high','max']);
 expect(modelCapabilityPreset('https://open.bigmodel.cn/api/v1','responses','glm-5.3')?.reasoning?.default).toBe('max');
 const body={model:'deepseek-ai/DeepSeek-V4-Flash',reasoning_effort:'max',messages:[]};
 expect(apiReasoningBody(body,'https://api.siliconflow.cn/v1','chat')).toEqual({...body,enable_thinking:true});
 expect(apiReasoningBody({...body,enable_thinking:false},'https://api.siliconflow.cn/v1','chat').enable_thinking).toBe(false);
 expect(apiReasoningBody(body,'https://other.test/v1','chat')).toBe(body);
 expect(apiReasoningBody(body,'https://api.siliconflow.cn/v1','responses')).toBe(body);
});
it('persists capability snapshots without granting another source the same-named model',async()=>{
 const root=await directory(),cache=new ModelMetadataCache(root),scope=['account','first','revision','model'];
 await cache.remember(scope,{contextWindow:128000,reasoning:{levels:['high']}});
 expect((await new ModelMetadataCache(root).capabilities(scope))?.contextWindow).toBe(128000);
 expect(await cache.capabilities(['account','second','revision','model'])).toBeUndefined();
 expect(await cache.capabilities(['account','first','rotated','model'])).toBeUndefined();
 await cache.remember(scope,{contextWindow:128000},Date.now()-8*86400000);expect(await cache.capabilities(scope)).toBeUndefined();
 const file=(await readdir(join(root,'model-metadata')))[0];await writeFile(join(root,'model-metadata',file),'{bad');expect(await cache.capabilities(scope)).toBeUndefined();
});
it('compiles vendor effort choices and no fictional medium option for unknown models',()=>{
 const catalog=codexModelCatalog(['known','unknown'],{}, {},{}, {known:{contextWindow:1048576,reasoning:{levels:['low','high','max'],default:'high'}}});
 expect(catalog.models[0]).toMatchObject({context_window:1048576,default_reasoning_level:'high',supported_reasoning_levels:[{effort:'low'},{effort:'high'},{effort:'max'}]});
 expect(catalog.models[1].supported_reasoning_levels).toEqual([]);
});
it('API discovery caches actual metadata across reopen and invalidates route and key edits',async()=>{
 const root=await directory(),keys=new Map<string,string>(),secrets={persistent:true,get:async(k:string)=>keys.get(k)??'',set:async(k:string,v:string)=>{keys.set(k,v);},remove:async(k:string)=>{keys.delete(k);}};
 const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'shared',context_window:200000,max_output_tokens:8192,supported_reasoning_levels:['low','high'],default_reasoning_level:'high',api_key:'MUST_NOT_CACHE'}]}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));let store=await ApiSources.open(root,secrets,defaultProvider);
 try{
  const source=await store.save({name:'Source A',baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}`,protocol:'responses',models:['shared'],apiKey:'SOURCE_SECRET'});
  await store.models(source.id);await store.close();store=await ApiSources.open(root,secrets,defaultProvider);
  expect(await store.modelCapabilities(source.id,'shared')).toMatchObject({contextWindow:200000,maxOutputTokens:8192,reasoning:{levels:['low','high'],default:'high'}});
  const other=await store.save({name:'Source B',baseURL:source.baseURL,protocol:'responses',models:['shared'],apiKey:'OTHER_SECRET'});expect(await store.modelCapabilities(other.id,'shared')).toEqual({});
  await store.save({name:source.name,baseURL:source.baseURL,protocol:'responses',models:['shared'],apiKey:'ROTATED'},source.id);expect(await store.modelCapabilities(source.id,'shared')).toEqual({});
  for(const f of await readdir(join(root,'model-metadata'))){const saved=await readFile(join(root,'model-metadata',f),'utf8');expect(saved).not.toContain('SECRET');expect(saved).not.toContain('MUST_NOT_CACHE');}
 }finally{await store.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
const official={models:[{slug:'official-test',display_name:'Original',visibility:'list',truncation_policy:{mode:'tokens',limit:10000},context_window:400000,supported_reasoning_levels:[{effort:'high',description:'original'}]}]};
it('reuses official metadata by identity, revalidates ETag, and invalidates rejected auth',async()=>{
 const root=await directory(),config=join(root,'config.toml'),auth={tokens:{access_token:'PRIVATE_TOKEN',account_id:'first'}};await writeFile(config,'');
 let calls=0;
 const fetcher=async()=>{calls++;return Response.json(official,{headers:{etag:'v1','cache-control':'max-age=3600'}});};
 expect(await loadOfficialCodexCatalogForAuth(config,auth,fetcher)).toEqual(official);
 await loadOfficialCodexCatalogForAuth(config,auth,fetcher);expect(calls).toBe(1);
 await loadOfficialCodexCatalogForAuth(config,{tokens:{...auth.tokens,account_id:'second'}},fetcher);expect(calls).toBe(2);
 await loadOfficialCodexCatalogForAuth(config,auth,async(_url,init)=>{expect((init.headers as any)['if-none-match']).toBe('v1');return new Response(null,{status:304});},true);
 await expect(loadOfficialCodexCatalogForAuth(config,auth,async()=>new Response(null,{status:401}),true)).rejects.toThrow('登录已失效');
 await loadOfficialCodexCatalogForAuth(config,auth,fetcher);expect(calls).toBe(3);
 const files=await readdir(join(root,'.tokenflow-cache/model-metadata'));for(const f of files)expect(await readFile(join(root,'.tokenflow-cache/model-metadata',f),'utf8')).not.toContain('PRIVATE_TOKEN');
});
it('applies the DeepSeek capacity and native default effort, restoring original configuration',async()=>{
 const root=await directory(),config=join(root,'codex/config.toml');await mkdir(join(root,'codex'));const before='model_provider="openai"\n';await writeFile(config,before);
 const manager=new CodexApiDirect(root,config,async()=>[]),selection={sourceId:'fixture',model:'deepseek-flash',name:'DeepSeek',baseURL:'https://api.deepseek.com',apiKey:'synthetic-key'};
 
 await manager.apply(selection,codexConfigRevision(before));const applied=parse(await readFile(config,'utf8'));
 const catalog=JSON.parse(await readFile(String(applied.model_catalog_json),'utf8'));
 expect(catalog.models[0]).toMatchObject({context_window:1048576,max_context_window:1048576,auto_compact_token_limit:null,default_reasoning_level:'high',supported_reasoning_levels:[{effort:'low'},{effort:'high'},{effort:'max'}]});
 expect(applied.model_reasoning_effort).toBe('high');
 await manager.restore(codexConfigRevision(await readFile(config,'utf8')));const restored=parse(await readFile(config,'utf8'));
 expect(restored.model_provider).toBe('openai');expect(restored.model_reasoning_effort).toBeUndefined();expect(restored.model_catalog_json).toBeUndefined();
 // Retain the inactive provider identity so old API threads cannot fall through to OpenAI.
 expect(restored.model_providers).toMatchObject({custom:{base_url:'http://127.0.0.1:9527/codex/inactive/v1',experimental_bearer_token:'tokenflow-inactive-provider'}});
 expect(JSON.stringify(restored)).not.toContain('synthetic-key');
});
it('honors no-store and requires revalidation when official metadata disallows stale reuse',async()=>{
 const root=await directory(),config=join(root,'config.toml'),auth={tokens:{account_id:'a',access_token:'fixture'}};let calls=0;
 const noStore=async()=>{calls++;return Response.json(official,{headers:{'cache-control':'no-store'}});};
 await loadOfficialCodexCatalogForAuth(config,auth,noStore);await loadOfficialCodexCatalogForAuth(config,auth,noStore);expect(calls).toBe(2);
 await loadOfficialCodexCatalogForAuth(config,auth,async()=>Response.json(official,{headers:{'cache-control':'no-cache, must-revalidate'}}));
 await expect(loadOfficialCodexCatalogForAuth(config,auth,async()=>{throw Error('network down');})).rejects.toThrow('无法连接');
});

it('refreshes stale preset capacities from live input limits while preserving explicit source defaults',async()=>{
 const {combineModelCapabilities}=await import('../packages/core/src/model-capabilities.js');
 expect(combineModelCapabilities({contextWindow:128000},{maxInputTokens:1000000})).toEqual({contextWindow:1000000,maxInputTokens:1000000});
 expect(combineModelCapabilities({contextWindow:128000},{contextWindow:200000,maxInputTokens:1000000}).contextWindow).toBe(200000);
 expect(readModelCapabilities({contextWindow:{defaultLength:200000,maxLength:1000000}})).toEqual({contextWindow:200000});
});
