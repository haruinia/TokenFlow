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
