/** Inclusive input/output counters. Cache and reasoning are subsets, not extra consumption. */
export type TokenMeasurement={inputTokens:number|null;outputTokens:number|null;cachedTokens?:number|null;cacheWriteTokens?:number|null;reasoningTokens?:number|null;reportedTotalTokens?:number|null};
export type MeasurementQuality='complete'|'partial'|'unknown'|'conflict';
const known=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
export function accountTokens(value:TokenMeasurement){
 const input=known(value.inputTokens)?value.inputTokens:null,output=known(value.outputTokens)?value.outputTokens:null;
 const read=known(value.cachedTokens)?value.cachedTokens:null,write=known(value.cacheWriteTokens)?value.cacheWriteTokens:null;
 const reasoning=known(value.reasoningTokens)?value.reasoningTokens:null,total=known(value.reportedTotalTokens)?value.reportedTotalTokens:null;
 const parts=(input??0)+(output??0);
 const conflict=input!==null&&(read??0)+(write??0)>input||output!==null&&(reasoning??0)>output||total!==null&&(total<parts||input!==null&&output!==null&&total!==parts);
 const quality:MeasurementQuality=conflict?'conflict':input!==null&&output!==null?'complete':input!==null||output!==null||total!==null?'partial':'unknown';
 // Preserve contradictory reported totals, but do not pretend their components reconcile.
 if(conflict)return {quality,inputTokens:0,outputTokens:0,cachedTokens:0,cacheWriteTokens:0,reasoningTokens:0,cacheBaseTokens:0,unclassifiedTokens:total??parts};
 return {quality,inputTokens:input??0,outputTokens:output??0,cachedTokens:input!==null?read??0:0,cacheWriteTokens:input!==null?write??0:0,reasoningTokens:output!==null?reasoning??0:0,cacheBaseTokens:input!==null&&read!==null?input:0,unclassifiedTokens:total===null?0:Math.max(0,total-parts)};
}
