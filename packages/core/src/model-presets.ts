import type {ModelCapabilities} from './model-capabilities.js';

/** Metadata fallback, not a model allowlist or proof of live API compatibility.
 * Source: farion1231/cc-switch b76426741ef93069e2f374ac01ca7ef5760e1d0e,
 * src/config/codexProviderPresets.ts (reviewed 2026-10-29).
 * DeepSeek also checked against its official Codex integration document. */
export type ModelPreset={baseURLs:string[];protocol:'responses'|'chat';model:string;capabilities:ModelCapabilities;thinkingParameter?:'enable_thinking'};
export const modelPresets:readonly ModelPreset[]=[
 ...['deepseek-flash','deepseek-v4-pro'].map(model=>({baseURLs:['https://api.deepseek.com','https://api.deepseek.com/v1'],protocol:'responses' as const,model,
  capabilities:{contextWindow:1048576,autoCompactTokenLimit:null,effectiveContextPercent:95,inputModalities:model==='deepseek-flash'?['text','image'] as Array<'text'|'image'>:['text'] as Array<'text'>,reasoning:{levels:['low','high','max'] as Array<'low'|'high'|'max'>,default:'high' as const}}})),
 {baseURLs:['https://api.moonshot.cn/v1'],protocol:'responses',model:'kimi-k3',capabilities:{contextWindow:1048576,reasoning:{levels:['low','high','max']}}},
 {baseURLs:['https://open.bigmodel.cn/api/v1'],protocol:'responses',model:'glm-5.3',capabilities:{contextWindow:1048576,inputModalities:['text'],reasoning:{levels:['low','high','max'],default:'max'}}},
 {baseURLs:['https://api.minimax.cn/v1'],protocol:'responses',model:'MiniMax-M3.1-Flash',capabilities:{contextWindow:1000000,inputModalities:['text','image'],reasoning:{levels:['low','medium','high','xhigh','max']}}},
 {baseURLs:['https://api.siliconflow.cn/v1'],protocol:'chat',model:'deepseek-ai/DeepSeek-V4-Flash',capabilities:{contextWindow:1048576,inputModalities:['text'],reasoning:{levels:['high','max'],default:'high'}},thinkingParameter:'enable_thinking'},
];
export function findModelPreset(baseURL:string,protocol:string,model:string){
 let url:URL;try{url=new URL(baseURL);}catch{return;}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)return;
 const exact=url.href.replace(/\/+$/,'');
 return modelPresets.find(p=>p.model===model&&p.protocol===protocol&&p.baseURLs.includes(exact));
}
/** The protocol translator already preserves reasoning_effort. A declared
 * vendor switch may additionally be needed to enable that effort. Never
 * translate high/max into other effort names or apply this to lookalike hosts. */
export function apiReasoningBody(body:Record<string,unknown>,baseURL:string,protocol:string):Record<string,unknown>{
 const preset=findModelPreset(baseURL,protocol,String(body.model)),parameter=preset?.thinkingParameter;
 if(!parameter||body[parameter]!==undefined)return body;
 const effort=body.reasoning_effort;
 if(preset.capabilities.reasoning?.levels?.includes(effort as never))return {...body,[parameter]:true};
 return body;
}
