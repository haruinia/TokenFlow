import {z} from 'zod';
import {findModelPreset} from './model-presets.js';

const count=z.number().int().positive().safe();
export const DEFAULT_GATEWAY_CONTEXT_WINDOW=200000;
export const reasoningEfforts=['none','minimal','low','medium','high','xhigh','max'] as const;
const effort=z.enum(reasoningEfforts);
export const modelCapabilitiesSchema=z.object({
 contextWindow:count.optional(),maxInputTokens:count.optional(),maxOutputTokens:count.optional(),
 contextWindows:z.array(count).optional(),
 autoCompactTokenLimit:count.nullable().optional(),effectiveContextPercent:z.number().int().min(1).max(100).optional(),
 inputModalities:z.array(z.enum(['text','image'])).optional(),
 reasoning:z.object({levels:z.array(effort).optional(),default:effort.optional(),minBudget:z.number().int().nonnegative().optional(),maxBudget:count.optional(),allowDisable:z.boolean().optional(),allowAuto:z.boolean().optional()}).optional(),
}).strict();
export type ModelCapabilities=z.infer<typeof modelCapabilitiesSchema>;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const number=(raw:Record<string,unknown>,...keys:string[])=>keys.map(key=>raw[key]).find(value=>count.safeParse(value).success) as number|undefined;

/** Whitelist metadata only. A catalog is data, not permission or executable policy. */
export function readModelCapabilities(value:unknown):ModelCapabilities{
 const raw=object(value),thinking=object(raw.thinking),result:ModelCapabilities={};
 const context=number(raw,'context_window','context_length','contextWindow')??number(object(raw.contextWindow),'defaultLength');
 const input=number(raw,'max_input_tokens','maxInputTokens','inputTokenLimit','input_token_limit');
 const output=number(raw,'max_output_tokens','maxOutputTokens','outputTokenLimit','max_completion_tokens');
 if(context)result.contextWindow=context;if(input)result.maxInputTokens=input;if(output)result.maxOutputTokens=output;
 const qoder=object(raw.qoder_runtime);
 if(Array.isArray(qoder.context_windows))result.contextWindows=[...new Set(qoder.context_windows.filter((n):n is number=>count.safeParse(n).success))];
 if(number(qoder,'default_context')&&result.contextWindows?.includes(qoder.default_context as number))result.contextWindow=qoder.default_context as number;
 if(raw.auto_compact_token_limit===null)result.autoCompactTokenLimit=null;
 else if(number(raw,'auto_compact_token_limit'))result.autoCompactTokenLimit=number(raw,'auto_compact_token_limit');
 const percent=raw.effective_context_window_percent;
 if(typeof percent==='number'&&Number.isInteger(percent)&&percent>0&&percent<=100)result.effectiveContextPercent=percent;
 const modalities=raw.input_modalities??raw.supportedInputModalities;
 if(Array.isArray(modalities))result.inputModalities=[...new Set(modalities.filter((v):v is 'text'|'image'=>v==='text'||v==='image'))];
 const declared=raw.supported_reasoning_levels??thinking.levels;
 if(Array.isArray(declared)||number(thinking,'max')){
  const levels=Array.isArray(declared)?[...new Set(declared.map(v=>typeof v==='string'?v:object(v).effort).filter((v):v is z.infer<typeof effort>=>effort.safeParse(v).success))]:undefined;
  const preferred=raw.default_reasoning_level;
  result.reasoning={...(levels?{levels}:{}),...(levels?.includes(preferred as z.infer<typeof effort>)?{default:preferred as z.infer<typeof effort>}:{}),
   ...(typeof thinking.zero_allowed==='boolean'?{allowDisable:thinking.zero_allowed}:{}),...(typeof thinking.dynamic_allowed==='boolean'?{allowAuto:thinking.dynamic_allowed}:{}),
   ...(typeof thinking.min==='number'&&thinking.min>=0&&Number.isInteger(thinking.min)?{minBudget:thinking.min}:{}),...(number(thinking,'max')?{maxBudget:number(thinking,'max')}: {})};
 }
 return result;
}

/** No cross-vendor semantic aliases: max and xhigh are different wire values. */
export function codexReasoningMetadata(capability?:ModelCapabilities,budgetMapping=true){
 const reasoning=capability?.reasoning;
 // Keep in sync with CLIProxyAPI internal/thinking/convert.go. These are
 // gateway scheduling choices, not equivalent vendor-native effort labels.
 const budgets={low:1024,medium:8192,high:24576,xhigh:32768,max:128000};
 const budgetEntries=budgetMapping&&reasoning?.levels===undefined&&reasoning?.maxBudget?Object.entries(budgets).filter(([,n])=>n>=(reasoning.minBudget??0)&&n<=reasoning.maxBudget!&&(!capability?.maxOutputTokens||n<capability.maxOutputTokens)):[];
 const levels=reasoning?.levels??budgetEntries.map(([level])=>level as z.infer<typeof effort>);
 const preferred=capability?.reasoning?.default;
 return {supported_reasoning_levels:levels.map(effort=>({effort,description:budgetEntries.length?`思考预算 ${budgets[effort as keyof typeof budgets]} tokens`:effort})),default_reasoning_level:preferred&&levels.includes(preferred)?preferred:null};
}

/** Reviewed presets are a fallback, never an inference access grant. */
export function modelCapabilityPreset(baseURL:string,protocol:string,model:string):ModelCapabilities|undefined{
 const preset=findModelPreset(baseURL,protocol,model);return preset?structuredClone(preset.capabilities):undefined;
}

export function combineModelCapabilities(preset:ModelCapabilities|undefined,live:ModelCapabilities|undefined):ModelCapabilities{
 const result={...preset,...live};
 // A live input limit supersedes a preset window, but never its own explicit
 // default/selected window. Input capacity is used conservatively, not added to output.
 if(live?.maxInputTokens&&live.contextWindow===undefined)result.contextWindow=live.maxInputTokens;
 return result;
}
