import type {SDKModel} from '@cursor/sdk';
import {readModelCapabilities} from './model-capabilities.js';

// Discovery and dispatch must use the same advertised SDK parameter.
export function cursorReasoningParameter(model:SDKModel){
 return model.parameters?.find(p=>p.id==='reasoning_effort')??model.parameters?.find(p=>p.id==='effort');
}
export function cursorModelCapabilities(model:SDKModel){
 const parameter=cursorReasoningParameter(model);
 const preferred=model.variants?.find(v=>v.isDefault)?.params.find(p=>p.id===parameter?.id)?.value;
 return readModelCapabilities({supported_reasoning_levels:parameter?.values.map(v=>v.value),default_reasoning_level:preferred});
}
