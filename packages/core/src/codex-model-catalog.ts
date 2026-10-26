import { apiModelDisplayName } from '../../../apps/shared/api-endpoint.js';
/** Match the installed Codex client's unknown-model fallback. This is client
 * scheduling metadata, not a gateway request limit or a claim about the source. */
export const CODEX_DEFAULT_CONTEXT_WINDOW=272000;
export const CODEX_TOOL_OUTPUT_LIMIT=10000;
export const CODEX_DEFAULT_COMPACT_TOKEN_LIMIT=244800;
const validWindow=(value?:number)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:undefined;
export function codexCompactionLimit(contextWindow?:number){
 return Math.max(1,Math.floor((validWindow(contextWindow)??CODEX_DEFAULT_CONTEXT_WINDOW)*0.9));
}
export function codexContextMetadata(contextWindow?:number):{context_window?:number;auto_compact_token_limit?:number}{
 const capacity=validWindow(contextWindow)??CODEX_DEFAULT_CONTEXT_WINDOW;
 // Codex 0.163 pre-compacts with the old model when the new window is smaller.
 // Across providers that model may not be authorized by the current key. For
 // these windows publish the same native 90% trigger without old-model pre-compaction.
 // Other models expose their window and let Codex derive the trigger itself.
 return capacity<CODEX_DEFAULT_CONTEXT_WINDOW?{auto_compact_token_limit:codexCompactionLimit(capacity)}:{context_window:capacity};
}
/** Codex reads this catalog at startup instead of its bundled OpenAI picker entries.
 * Keep it scoped to the models authorized by this connection's client key. */
export function codexModelCatalog(selection:string|string[],labels:Record<string,string>={},contextWindows:Record<string,number>={}){
 const models=typeof selection==='string'?[selection]:selection;
 // Local provenance for future refreshes. Codex reads only `models`; missing
 // provider metadata after a restart must not erase a previously known window.
 return {tokenflow_context_windows:Object.fromEntries(models.filter(model=>validWindow(contextWindows[model])!==undefined).map(model=>[model,contextWindows[model]])),models:models.map((model,priority)=>({
  slug:model,display_name:apiModelDisplayName(labels[model]?.trim()||model),description:'通过 TokenFlow 使用此模型',
  visibility:'list',supported_in_api:true,priority,
  default_reasoning_level:'medium',supported_reasoning_levels:[{effort:'medium',description:'默认'}],
  shell_type:'shell_command',base_instructions:'You are a coding assistant. Help the user complete their coding tasks.',
  supports_reasoning_summaries:false,support_verbosity:false,
  ...codexContextMetadata(contextWindows[model]),
  // Match native Codex unknown-model tool-output handling. Disabling this
  // bound lets large completed logs refill the context immediately after compact.
  apply_patch_tool_type:'freeform',truncation_policy:{mode:'bytes',limit:CODEX_TOOL_OUTPUT_LIMIT},
  // Allow attachments through image-capable transports without maintaining a
  // per-model vision allowlist. The selected upstream decides model support.
  // Cursor's current text-prompt adapter cannot carry image blocks.
  input_modalities:['text','image'],experimental_supported_tools:[],
 }))};
}
