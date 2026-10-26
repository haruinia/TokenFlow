import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { AgentConnections } from '../packages/core/src/agent-connections.js';
import { codexModelCatalog, codexCompactionLimit, codexContextMetadata } from '../packages/core/src/codex-model-catalog.js';
import * as catalogModule from '../packages/core/src/codex-model-catalog.js';
import { modelLabel } from '../packages/core/src/model-label.js';
import { compactionModelWindow } from '../packages/core/src/initial-compaction.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const sourceId='a'.repeat(24),model=`api-${sourceId}/company/gpt`;
it('migrates only the gateway unlimited sentinel, preserving official and custom tool budgets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-tool-policy-'));roots.push(root);
 const dir=join(root,'agent-backups');await mkdir(dir);
 const file=join(dir,'codex-models-abcd.json');
 const models=[{slug:'official',context_window:272000,truncation_policy:{mode:'bytes',limit:Number.MAX_SAFE_INTEGER}},{slug:'gateway',context_window:272000,truncation_policy:{mode:'bytes',limit:Number.MAX_SAFE_INTEGER}},{slug:'custom',context_window:272000,truncation_policy:{mode:'bytes',limit:23456}}];
 await writeFile(file,JSON.stringify({models,tokenflow_gateway_models:['gateway','custom'],tokenflow_context_windows:{gateway:272000,custom:272000}}));
 const connections=new AgentConnections(root,{codex:join(root,'config.toml')},async()=>[]);
 expect(await connections.refreshCodexCompactionLimits(async()=>undefined)).toEqual({updated:1,failed:0});
 const next=JSON.parse(await readFile(file,'utf8')).models;
 expect(next[0]).toEqual(models[0]);expect(next[1].truncation_policy.limit).toBe(10000);expect(next[2]).toEqual(models[2]);
 expect(await connections.refreshCodexCompactionLimits(async()=>undefined)).toEqual({updated:0,failed:0});
});
it('reapplies unchanged selections to replace the legacy downshift window and keeps the original config restorable',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'codex-catalog-upgrade-'));roots.push(root);
 const configPath=join(root,'config.toml'),original='model = "gpt-6-astra"\nmodel_provider = "openai"\n';
 await writeFile(configPath,original);
 const connections=new AgentConnections(root,{codex:configPath},async()=>[]);
 const apply=async(replaceId?:string)=>connections.apply({target:'codex',revision:(await connections.status()).find(t=>t.id==='codex')!.revision,origin:'http://127.0.0.1:9527',model,sourceId,keyId:randomUUID(),key:'fixture-key',...(replaceId?{replaceId}:{})});
 const legacy=catalogModule.codexModelCatalog;
 const mock=vi.spyOn(catalogModule,'codexModelCatalog').mockImplementation((...args)=>({...legacy(...args),models:legacy(...args).models.map(m=>({...m,context_window:131072,auto_compact_token_limit:65536}))}));
 let first;try{first=await apply();}finally{mock.mockRestore();}
 const before=parse(await readFile(configPath,'utf8'));
 const second=await apply(first.id),after=parse(await readFile(configPath,'utf8'));
 expect(after.model_catalog_json).not.toBe(before.model_catalog_json);
 const entry=JSON.parse(await readFile(String(after.model_catalog_json),'utf8')).models[0];
 expect(entry.slug).toBe(model);expect(entry.context_window).toBe(272000);expect(entry.auto_compact_token_limit).toBeUndefined();
 await connections.restore(second.id);expect(await readFile(configPath,'utf8')).toBe(original);
});
it('lets Codex derive native triggers from capacity, retaining the tested small-window switch workaround',()=>{
 const catalog=codexModelCatalog(['codex/gpt-6-luna','api-example/custom','unknown/model','large/model'],{}, {'codex/gpt-6-luna':272000,'api-example/custom':64000,'large/model':1000000});
 expect(catalog.models.map(model=>model.context_window)).toEqual([272000,undefined,272000,1000000]);
 expect(catalog.models.map(model=>model.auto_compact_token_limit)).toEqual([undefined,57600,undefined,undefined]);
 expect(codexCompactionLimit(272000)).toBe(244800);expect(codexCompactionLimit(64000)).toBe(57600);
 for(const invalid of [undefined,NaN,Infinity,-1,0,1.5]){
  expect(codexCompactionLimit(invalid)).toBe(244800);expect(codexContextMetadata(invalid)).toEqual({context_window:272000});
 }
});
it('retains advertised capacities through startup before discovery and later unavailable catalogs',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'codex-capacity-restart-'));roots.push(root);
 const configPath=join(root,'config.toml');await writeFile(configPath,'model="native"\n');
 const connections=new AgentConnections(root,{codex:configPath},async()=>[]);
 const selected=['qoder/256k','qoder/1m','qoder/unknown'];
 await connections.apply({target:'codex',revision:(await connections.status()).find(t=>t.id==='codex')!.revision,origin:'http://127.0.0.1:9527',model:selected[0]!,selections:selected.map(model=>({sourceId,model})),sourceId,keyId:randomUUID(),key:'fixture-key',modelContextWindows:{[selected[0]!]:256000,[selected[1]!]:1000000}});
 const config=await readFile(configPath,'utf8'),path=String(parse(config).model_catalog_json),before=await readFile(path,'utf8');
 const refresh=async(models:{id:string;contextWindow?:number}[])=>connections.refreshCodexCompactionLimits(model=>compactionModelWindow(model,models,configPath));
 expect(await refresh([])).toEqual({updated:0,failed:0});expect(await readFile(path,'utf8')).toBe(before);
 expect(await refresh([{id:selected[2]!,contextWindow:1000000}])).toEqual({updated:1,failed:0});
 const discovered=await readFile(path,'utf8');
 const restarted=new AgentConnections(root,{codex:configPath},async()=>[]);
 expect(await restarted.refreshCodexCompactionLimits(async()=>undefined)).toEqual({updated:0,failed:0});
 expect(await readFile(path,'utf8')).toBe(discovered);expect(await readFile(configPath,'utf8')).toBe(config);
 expect(JSON.parse(discovered).models.map((m:any)=>[m.context_window,m.auto_compact_token_limit])).toEqual([[undefined,230400],[1000000,undefined],[1000000,undefined]]);
});
it('preserves pre-upgrade capacity data and upgrades only legacy unknown defaults without discovery',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'codex-capacity-legacy-'));roots.push(root);
 await mkdir(join(root,'agent-backups'));
 const path=join(root,'agent-backups','codex-models-'+'a'.repeat(64)+'.json');
 const original={models:[{slug:'qoder/1m',context_window:1000000},{slug:'qoder/256k',auto_compact_token_limit:230400},{slug:'qoder/unknown',auto_compact_token_limit:128000}]};
 await writeFile(path,JSON.stringify(original));
 const connections=new AgentConnections(root,{codex:join(root,'config.toml')},async()=>[]);
 await connections.refreshCodexCompactionLimits(async()=>undefined);
 const models=JSON.parse(await readFile(path,'utf8')).models;
 expect(models[0]).toMatchObject(original.models[0]!);expect(models[1]).toMatchObject(original.models[1]!);
 expect(models[2]).toEqual({slug:'qoder/unknown',context_window:272000});
 expect(await connections.refreshCodexCompactionLimits(async()=>undefined)).toEqual({updated:0,failed:0});
});
it('updates existing generated catalogs while preserving routing, original backups and history',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'codex-compaction-metadata-'));roots.push(root);
 const configPath=join(root,'config.toml'),original='model = "original"\n';await writeFile(configPath,original);
 const connections=new AgentConnections(root,{codex:configPath},async()=>[]);
 const record=await connections.apply({target:'codex',revision:(await connections.status()).find(t=>t.id==='codex')!.revision,origin:'http://127.0.0.1:9527',model,sourceId,keyId:randomUUID(),key:'fixture-key'});
 const before=await readFile(configPath,'utf8'),catalogPath=String(parse(before).model_catalog_json),catalog=JSON.parse(await readFile(catalogPath,'utf8'));
 catalog.models[0].truncation_policy.limit=Number.MAX_SAFE_INTEGER;catalog.models[0].auto_compact_token_limit=65536;catalog.models[0].max_context_window=999999;await writeFile(catalogPath,JSON.stringify(catalog));
 expect(await connections.refreshCodexCompactionLimits(async()=>272000)).toEqual({updated:1,failed:0});
 const refreshed=JSON.parse(await readFile(catalogPath,'utf8'));
 expect(refreshed.models[0].context_window).toBe(272000);expect(refreshed.models[0].auto_compact_token_limit).toBeUndefined();expect(refreshed.models[0].max_context_window).toBeUndefined();
 expect(refreshed.models[0].truncation_policy.limit).toBe(10000);
 expect(await readFile(configPath,'utf8')).toBe(before);
 expect((await connections.review(record.id)).checks.every(check=>check.ok)).toBe(true);
 expect(await connections.refreshCodexCompactionLimits(async()=>64000)).toEqual({updated:1,failed:0});
 const smaller=JSON.parse(await readFile(catalogPath,'utf8')).models[0];expect(smaller.auto_compact_token_limit).toBe(57600);expect(smaller.context_window).toBeUndefined();
 expect(await connections.refreshCodexCompactionLimits(async()=>64000)).toEqual({updated:0,failed:0});
 expect(await readFile(configPath,'utf8')).toBe(before);
 await connections.restore(record.id);expect(await readFile(configPath,'utf8')).toBe(original);
});
it('replaces the Codex catalog when managing unchanged models with updated names, preserving history and original settings',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'codex-catalog-refresh-'));roots.push(root);
 const configPath=join(root,'codex/config.toml'),historyPath=join(root,'codex/sessions/existing.json');await mkdir(join(root,'codex/sessions'),{recursive:true});
 const original='model = "native"\nprofile = "work"\n[profiles.work]\nmodel = "old"\napproval_policy = "untrusted"\n';
 await writeFile(configPath,original);await writeFile(historyPath,'existing conversation');
 const connections=new AgentConnections(root,{codex:configPath},async()=>[]);
 const apply=async(replaceId?:string,label=model)=>{
  const current=(await connections.status()).find(t=>t.id==='codex')!;
  return connections.apply({target:'codex',revision:current.revision,origin:'http://127.0.0.1:9527',model,sourceId,keyId:randomUUID(),key:'fixture-key',selections:[{model,sourceId}],modelLabels:{[model]:label},...(replaceId?{replaceId}:{})});
 };
 const first=await apply();const before=parse(await readFile(configPath,'utf8'));
 const second=await apply(first.id,'公司 GPT');const after=parse(await readFile(configPath,'utf8'));
 expect(after.model_catalog_json).not.toBe(before.model_catalog_json);
 const catalog=JSON.parse(await readFile(String(after.model_catalog_json),'utf8'));
 expect(catalog.models).toHaveLength(1);expect(catalog.models[0]).toMatchObject({slug:model,display_name:'公司 GPT'});
 expect(after).toMatchObject({model,profile:'work',profiles:{work:{model,model_catalog_json:after.model_catalog_json,approval_policy:'untrusted'}}});
 expect(await readFile(historyPath,'utf8')).toBe('existing conversation');
 expect((await connections.review(second.id)).checks.every(check=>check.ok)).toBe(true);
 await connections.restore(second.id);expect(await readFile(configPath,'utf8')).toBe(original);expect(await readFile(historyPath,'utf8')).toBe('existing conversation');
});
it('uses readable API names when older or temporarily unavailable models have no display metadata',()=>{
 expect(modelLabel([],model)).toBe('company/gpt');
 for(const labels of [{},{[model]:model},{[model]:'  '}])expect(codexModelCatalog([model],labels).models[0]).toMatchObject({slug:model,display_name:'company/gpt'});
 expect(codexModelCatalog([model],{[model]:'自定义名称'}).models[0].display_name).toBe('自定义名称');
 expect(modelLabel([],'qoder/kmodel_latest')).toBe('qoder/kmodel_latest');
});
