import {isDeepStrictEqual} from 'node:util';
import {codexInactiveProvider} from './codex-inactive-provider.js';
import {join} from 'node:path';
import {parse,stringify} from 'smol-toml';
import {agentProcesses,type Target} from './agent-connections.js';
import {codexModelCatalog} from './codex-model-catalog.js';
import {withoutNativeAgentDirectory} from './codex-unified-agent-catalog.js';
import {combineModelCapabilities,modelCapabilityPreset,codexReasoningMetadata} from './model-capabilities.js';
import {ApiDirectConfig,directConfigRevision,type DirectApiSelection} from './api-direct-config.js';
export type {DirectApiSelection} from './api-direct-config.js';
export const codexConfigRevision=directConfigRevision;
export const codexApiProvider=(_sourceId?:string)=>'custom';

export class CodexApiDirect extends ApiDirectConfig {
 constructor(root:string,configPath:string,processes:(target:Target)=>Promise<number[]>=agentProcesses){super(root,configPath,'codex',{parse,stringify},processes);}
 protected restorationState(current:Record<string,any>,before:Record<string,any>,after:Record<string,any>){
  const provider=after.model_provider,table=after.model_providers?.[provider];
  if(typeof provider!=='string'||!table||!isDeepStrictEqual(current.model_providers?.[provider],codexInactiveProvider(table.name)))return current;
  // A crash may leave the completed configuration with its journal still applied.
  // Normalize only our inactive identity; independent user settings remain part of the merge.
  const providers={...current.model_providers};
  if(before.model_providers?.[provider]!==undefined)providers[provider]=before.model_providers[provider];else delete providers[provider];
  const result={...current};if(Object.keys(providers).length)result.model_providers=providers;else delete result.model_providers;return result;
 }
 protected restoredConfig(restored:string|null,applied:string){
  const doc=parse(restored??'') as any,previous=parse(applied) as any;
  const provider=previous.model_provider;
  if(typeof provider!=='string'||!(provider==='custom'||/^api_direct_[a-f0-9]{24}$/.test(provider)))throw this.fail('API 直连来源记录无效，原配置保留。');
  // Restore an existing custom route exactly; otherwise keep a credential-free
  // definition so Codex can still open API chats after leaving API direct.
  if(!doc.model_providers?.[provider])doc.model_providers={...doc.model_providers,[provider]:codexInactiveProvider(previous.model_providers[provider].name)};
  return stringify(doc);
 }
 protected async configure(current:string|null,selection:DirectApiSelection,id:string){
  const doc=parse(current??'') as any;
  if(doc.profile!==undefined)throw this.fail('当前 Codex 使用配置档案，请先切回默认配置再应用 API 直连。');
  const provider=codexApiProvider(selection.sourceId),catalogPath=join(this.directory,`models-${id}.json`);
  const models=(selection.models??[{id:selection.model,capabilities:selection.capabilities}]).map(item=>{
   const capability=combineModelCapabilities(modelCapabilityPreset(selection.baseURL,'responses',item.id),item.capabilities);
   const window=capability.contextWindow??capability.maxInputTokens??32768;
   const model:any=codexModelCatalog(item.id,{[item.id]:item.id},{[item.id]:window},{},{[item.id]:capability}).models[0];
   model.context_window=window;model.max_context_window=window;Object.assign(model,codexReasoningMetadata(capability,false));model.input_modalities=capability.inputModalities??['text'];
   if(capability.autoCompactTokenLimit===null)model.auto_compact_token_limit=null;
   delete model.apply_patch_tool_type;model.multi_agent_version='v1';return model;
  });
  const model=models.find(item=>item.slug===selection.model)!;await this.write(catalogPath,{models});
  for(const key of ['review_model','model_reasoning_effort','model_reasoning_summary','service_tier','model_context_window','model_auto_compact_token_limit','model_auto_compact_token_limit_scope','forced_chatgpt_workspace_id','forced_login_method'])delete doc[key];
  if(typeof doc.developer_instructions==='string'){
   const instructions=withoutNativeAgentDirectory(doc.developer_instructions);
   if(instructions)doc.developer_instructions=instructions;else delete doc.developer_instructions;
  }
  doc.features={...doc.features,multi_agent_v2:false};
  doc.model=selection.model;doc.model_provider=provider;doc.model_catalog_json=catalogPath;doc.preferred_auth_method='apikey';doc.web_search='disabled';
  if(model.default_reasoning_level)doc.model_reasoning_effort=model.default_reasoning_level;
  doc.model_providers={...doc.model_providers,[provider]:{name:selection.name,base_url:selection.baseURL,wire_api:'responses',experimental_bearer_token:selection.apiKey,requires_openai_auth:false,supports_websockets:false,capabilities:{remote_compaction:'unsupported'}}};
  if(doc.agents){doc.agents={...doc.agents};delete doc.agents.default_subagent_model;delete doc.agents.default_subagent_reasoning_effort;}
  return stringify(doc);
 }
}
