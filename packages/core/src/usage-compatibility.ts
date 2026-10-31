import type {UsageRow} from './usage-ledger.js';
export const compatibilityKey=(r:UsageRow)=>[r.day,r.target,r.keyId,r.sourceId,r.model].join('\n');
const counters=['requests','failed','unmeasured','inputTokens','cachedTokens','cacheBaseTokens','outputTokens','durationMs','cacheWriteTokens','reasoningTokens','toolCalls','toolResults','generationMs','timedOutputTokens','credits'] as const;
/** Older versions overwrite duplicate five-dimensional keys. Export exactly one row per key. */
export function compatibilityRows(rows:readonly UsageRow[]):UsageRow[]{
 const groups=new Map<string,UsageRow>();
 for(const row of rows){const key=compatibilityKey(row),old=groups.get(key);if(!old){const {billingAccountHash,taskKind,...copy}=row;groups.set(key,{...copy});continue;}
  for(const field of counters)if(row[field]!==undefined)old[field]=(old[field]??0)+row[field]!;
  for(const field of ['unclassifiedTokens','completeRequests','partialRequests','unknownRequests','conflictRequests','legacyRequests','cancelledRequests','truncatedRequests'] as const)if(row[field]!==undefined)old[field]=(old[field]??0)+row[field]!;
  if(row.last>old.last){old.last=row.last;old.keyName=row.keyName;}
 }
 return [...groups.values()];
}
/** Only monotone increments over our last export are accepted as legacy-version consumption. */
export function compatibilityIncrements(before:UsageRow[],after:UsageRow[]):UsageRow[]{
 const baseline=new Map(compatibilityRows(before).map(r=>[compatibilityKey(r),r])),result:UsageRow[]=[];
 for(const row of compatibilityRows(after)){
  const old=baseline.get(compatibilityKey(row));if(!old){result.push(row);continue;}
  const next={...row};let changed=false;
  for(const field of counters){const difference=(row[field]??0)-(old[field]??0);if(difference<0)throw Error('Legacy usage counters decreased');if(difference>0)changed=true;next[field]=difference;}
  if(!changed)continue;if(next.requests<=0)throw Error('Legacy usage changed without a request identity');
  // Legacy writers do not retain the new quality/account/task dimensions.
  for(const field of ['unclassifiedTokens','completeRequests','partialRequests','unknownRequests','conflictRequests','legacyRequests','cancelledRequests','truncatedRequests'] as const)delete next[field];
  result.push(next);
 }
 return result;
}
