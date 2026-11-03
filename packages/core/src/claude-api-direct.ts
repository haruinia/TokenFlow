import {z} from 'zod';
import {ApiDirectConfig,type DirectApiSelection} from './api-direct-config.js';
import {agentProcesses,type Target} from './agent-connections.js';

const parse=(raw:string)=>z.record(z.unknown()).parse(JSON.parse(raw||'{}'));
const stringify=(doc:Record<string,unknown>)=>JSON.stringify(doc,null,2)+'\n';
/** Anthropic clients append /v1/messages; retain any tenant/Anthropic prefix. */
export const claudeApiBaseURL=(baseURL:string)=>baseURL.replace(/\/+$/,'').replace(/\/v1$/,'');
export class ClaudeApiDirect extends ApiDirectConfig {
 constructor(root:string,configPath:string,processes:(target:Target)=>Promise<number[]>=agentProcesses){super(root,configPath,'claude',{parse,stringify},processes);}
 protected async configure(current:string|null,selection:DirectApiSelection){
  const doc=parse(current??''),env=z.record(z.unknown()).parse(doc.env??{});
  for(const key of ['apiKeyHelper','forceLoginMethod','forceLoginOrgUUID','forceLoginGatewayUrl'])delete doc[key];
  for(const key of ['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY','CLAUDE_CODE_EFFORT_LEVEL','MAX_THINKING_TOKENS'])delete env[key];
  const model=selection.model;
  const models=selection.models?.map(item=>item.id)??[model];
  return stringify({...doc,model,availableModels:models,modelPicker:{replaceBuiltInOptions:true,options:models.map(model=>({model,label:model}))},env:{...env,
   ANTHROPIC_BASE_URL:claudeApiBaseURL(selection.baseURL),ANTHROPIC_API_KEY:selection.apiKey,ANTHROPIC_AUTH_TOKEN:'',CLAUDE_CODE_OAUTH_TOKEN:'',ANTHROPIC_PROFILE:'',
   CLAUDE_CODE_USE_BEDROCK:'0',CLAUDE_CODE_USE_VERTEX:'0',CLAUDE_CODE_USE_FOUNDRY:'0',ANTHROPIC_MODEL:model,
   ANTHROPIC_DEFAULT_OPUS_MODEL:model,ANTHROPIC_DEFAULT_SONNET_MODEL:model,ANTHROPIC_DEFAULT_FABLE_MODEL:model,ANTHROPIC_DEFAULT_HAIKU_MODEL:model,
   ANTHROPIC_SMALL_FAST_MODEL:model,CLAUDE_CODE_BG_CLASSIFIER_MODEL:model,CLAUDE_CODE_AUTO_MODE_MODEL:model,CLAUDE_CODE_SUBAGENT_MODEL:'',
  }});
 }
}
