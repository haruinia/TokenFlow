import type {ModelCapabilities} from './model-capabilities.js';
import {codexCompactionLimit} from './codex-model-catalog.js';

export function qoderSelectedCapabilities(model:string,capability:ModelCapabilities|undefined,contextWindow?:number):ModelCapabilities|undefined{
 if(contextWindow===undefined){
  if(model.startsWith('qoder/')&&capability?.contextWindow&&capability.contextWindows?.includes(capability.contextWindow))return {...capability,autoCompactTokenLimit:codexCompactionLimit(capability.contextWindow)};
  return capability;
 }
 if(!model.startsWith('qoder/')||!capability?.contextWindows?.includes(contextWindow))throw Object.assign(new Error('此模型未提供所选上下文窗口，请刷新模型列表后重新选择。'),{statusCode:409});
 return {...capability,contextWindow,autoCompactTokenLimit:codexCompactionLimit(contextWindow)};
}

/** One resolved window feeds both compaction scheduling and the native request. */
export function qoderRuntimeRequest(body:unknown,capability?:ModelCapabilities){
 if(!body||typeof body!=='object'||!String((body as {model?:string}).model??'').startsWith('qoder/'))return body;
 const window=capability?.contextWindow;
 if(!window||!capability?.contextWindows?.includes(window))return body;
 return {...body,context_length:window};
}
