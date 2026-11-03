import type {SDKModel} from '@cursor/sdk';
import {readModelCapabilities} from './model-capabilities.js';

// Discovery and dispatch must use the same advertised SDK parameter.
export function cursorReasoningParameter(model:SDKModel){
 return model.parameters?.find(p=>p.id==='reasoning_effort')??model.parameters?.find(p=>p.id==='effort');
}
export function cursorModelCapabilities(model:SDKModel){
 const parameter=cursorReasoningParameter(model);
 const preferred=model.variants?.find(v=>v.isDefault)?.params.find(p=>p.id===parameter?.id)?.value;
 const context=model.parameters?.find(p=>p.id==='context');
 const selected=model.variants?.find(v=>v.isDefault)?.params.find(p=>p.id==='context')?.value;
 // Only a declared default option is effective; the largest option is not selected automatically.
 const match=selected&&context?.values.some(v=>v.value===selected)?/^(\d+(?:\.\d+)?)(k|m)?$/i.exec(selected):null;
 const contextWindow=match?Number(match[1])*({k:1000,m:1000000}[match[2]?.toLowerCase() as 'k'|'m']??1):undefined;
 return readModelCapabilities({context_window:contextWindow,supported_reasoning_levels:parameter?.values.map(v=>v.value),default_reasoning_level:preferred});
}
