import {it,expect,afterEach} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse} from 'smol-toml';
import {AgentConnections} from '../packages/core/src/agent-connections.js';
import {configureNativeUnifiedAgents,nativeAgentDirectory,nativePlaintextAgentCatalog} from '../packages/core/src/codex-unified-agent-catalog.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const official={models:[{slug:'official-a',display_name:'Official A',multi_agent_version:'v2',base_instructions:'Keep native instructions',context_window:272000}]};
const choices=[{sourceId:'a'.repeat(24),model:'api-qiniu/deepseek/flash'},{sourceId:'b'.repeat(24),model:'api-silicon/deepseek/flash'}];
const labels={'api-qiniu/deepseek/flash':'七牛 · DeepSeek Flash','api-silicon/deepseek/flash':'硅基流动 · DeepSeek Flash'};
it('generates the full directory with exact IDs, source-qualified names and supported reasoning',()=>{
 const catalog={models:[...Array.from({length:8},(_,i)=>({slug:'official-'+i,display_name:'Official '+i})),...choices.map(c=>({slug:c.model,display_name:labels[c.model as keyof typeof labels],supported_reasoning_levels:[{effort:'medium'}]}))],tokenflow_gateway_models:choices.map(c=>c.model)};
 const text=nativeAgentDirectory(catalog);
 expect(text).toContain('official-7');expect(text).toContain('七牛 · DeepSeek Flash');expect(text).toContain('api-qiniu/deepseek/flash');expect(text).toContain('硅基流动');expect(text).toContain('"reasoning":["medium"]');expect(text).toContain('ask which one');
 const updated=nativePlaintextAgentCatalog({...catalog,models:[...catalog.models,{slug:'disabled',multi_agent_version:'disabled'}]});expect(updated.models[0].multi_agent_version).toBe('v1');expect(updated.models.at(-1)).toMatchObject({multi_agent_version:'disabled'});expect(catalog.models[0]).not.toHaveProperty('multi_agent_version');
});
it('refreshes only its owned directory and preserves user instructions/features',()=>{
 const config:any={developer_instructions:'User policy.',features:{apps:false,multi_agent_v2:true}};
 configureNativeUnifiedAgents(config,official);configureNativeUnifiedAgents(config,{models:[{slug:'new-official'}]});
 expect(config.developer_instructions).toContain('User policy.');expect(config.developer_instructions).not.toContain('official-a');expect(config.developer_instructions.match(/tokenflow-native-model-directory:start/g)).toHaveLength(1);expect(config.features).toEqual({apps:false,multi_agent:true,multi_agent_v2:false});
});
it.each([false,true])('journals unified agent configuration and restores the original (hybrid=%s)',async hybrid=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-native-config-'));roots.push(root);const config=join(root,'codex/config.toml');await mkdir(join(root,'codex'));
 const original='model="official-a"\nprofile="work"\ndeveloper_instructions="Keep user policy."\n[features]\nmulti_agent_v2=true\n[profiles.work]\napproval_policy="untrusted"\n';await writeFile(config,original);
 const connections=new AgentConnections(root,{codex:config},async()=>[]);const status=(await connections.status()).find(t=>t.id==='codex')!;
 const record=await connections.apply({target:'codex',revision:status.revision,origin:'http://127.0.0.1:9527',model:choices[0].model,sourceId:choices[0].sourceId,keyId:randomUUID(),key:'fixture',selections:choices,modelLabels:labels,officialCatalog:official,codexDirectHybrid:hybrid});
 const doc:any=parse(await readFile(config,'utf8'));const catalog=JSON.parse(await readFile(doc.model_catalog_json,'utf8'));
 expect(catalog.models[0].base_instructions).toBe('Keep native instructions');
 if(hybrid){expect(catalog.models[0].multi_agent_version).toBe('v2');expect(doc.features.multi_agent_v2).toBe(true);expect(doc.developer_instructions).toBe('Keep user policy.');}
 else{
  expect(catalog.models.every((m:any)=>m.multi_agent_version==='v1')).toBe(true);expect(doc.features.multi_agent_v2).toBe(false);expect(doc.profiles.work.features.multi_agent_v2).toBe(false);
  expect(doc.developer_instructions).toContain('七牛');expect(doc.profiles.work.developer_instructions).toContain('Keep user policy.');expect(doc.profiles.work.approval_policy).toBe('untrusted');
  const plan=await connections.prepareCodexIdentityCatalog(record.id,await readFile(config,'utf8'),{models:[{slug:'official-b',display_name:'Official B',multi_agent_version:'v2'}]});
  await writeFile(config,plan.config);await plan.apply();const refreshed:any=parse(await readFile(config,'utf8'));expect(refreshed.developer_instructions).toContain('official-b');expect(refreshed.developer_instructions).not.toContain('official-a');expect(refreshed.developer_instructions).toContain('api-qiniu/deepseek/flash');
 }
 await connections.restore(record.id);expect(await readFile(config,'utf8')).toBe(original);
});

it('places complete source-qualified discovery at the native tool, including deferred exec descriptions, without changing schemas',async()=>{
 const {nativeAgentDiscovery}=await import('../packages/core/src/codex-unified-agent-catalog.js');
 const catalog={models:[...official.models,{slug:'qoder/gfmodel',display_name:'TF · qoder/GLM-5.3-Flash',tokenflow_source:'Qoder'},{slug:'api-qiniu/flash',display_name:'TF · 七牛 · DeepSeek Flash',tokenflow_source:'七牛'}],tokenflow_gateway_models:['qoder/gfmodel','api-qiniu/flash']};
 const directory=nativeAgentDirectory(catalog);expect(directory).toContain('"source":"Qoder"');expect(directory).toContain('"source":"七牛"');
 const params={type:'object',properties:{model:{type:'string'}},required:['message']};
 const body={input:[{role:'developer',content:[{type:'input_text',text:directory}]}],tools:[{type:'namespace',name:'collaboration',tools:[{type:'function',name:'spawn_agent',description:'Five example models.',parameters:params}]},{type:'function',name:'exec',description:'Call tools.multi_agent_v1__spawn_agent from JS.'}]};
 const result=nativeAgentDiscovery(body);
 expect(result.tools[0].tools?.[0].description).toContain('qoder/gfmodel');expect(result.tools[0].tools?.[0].parameters).toBe(params);
 expect(result.tools[1].description).toContain('api-qiniu/flash');expect(body.tools[1].description).not.toContain('api-qiniu/flash');
 expect(nativeAgentDiscovery(result)).toBe(result);
 const refreshed=nativeAgentDiscovery({...result,input:[{role:'developer',content:[{type:'input_text',text:nativeAgentDirectory({models:[{slug:'new-account-model'}]})}]}]});expect(refreshed.tools[0].tools?.[0].description).toContain('new-account-model');expect(refreshed.tools[0].tools?.[0].description).not.toContain('qoder/gfmodel');
 expect(nativeAgentDiscovery({tools:body.tools,input:[{role:'user',content:directory}]}).tools).toBe(body.tools);
});

it('uses stable source prefixes in the picker across repeated account refreshes without changing dispatch IDs',()=>{
 const original={models:[{slug:'official-a',display_name:'Official A'},{slug:'qoder/gfmodel',display_name:'TF · qoder/GLM-5.3-Flash',tokenflow_source:'qoder'}],tokenflow_gateway_models:['qoder/gfmodel']};
 const once=nativePlaintextAgentCatalog(original),twice=nativePlaintextAgentCatalog(once);
 expect(twice).toEqual(once);expect(once.models.map(m=>m.slug)).toEqual(original.models.map(m=>m.slug));
 expect(once.models.map(m=>m.display_name)).toEqual(['OpenAI 官方 · Official A','TF · qoder · GLM-5.3-Flash']);
});
it('gives the current instruction directory precedence over historical developer directories',async()=>{
 const {nativeAgentDiscovery}=await import('../packages/core/src/codex-unified-agent-catalog.js');
 const current=nativeAgentDirectory({models:[{slug:'current-model'}]}),old=nativeAgentDirectory({models:[{slug:'retired-model'}]});
 const body={instructions:current,input:[{role:'developer',content:old}],tools:[{name:'spawn_agent',description:'Native spawn'}]};
 const result=nativeAgentDiscovery(body);expect(result.tools[0].description).toContain('current-model');expect(result.tools[0].description).not.toContain('retired-model');
});
