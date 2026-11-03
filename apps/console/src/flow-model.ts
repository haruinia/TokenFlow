import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import type { GatewayUsage } from '../../../packages/core/src/gateway-activity';
import { isSourceSelectionAvailable, sourceOptions, type AvailableSourceModels } from './source-options';
import { qualifiedModelLabel as modelLabel } from './model-label';
import {formatTokens} from './usage-model';

export type ModelGroup={id:string;label:string;models:{id:string;label:string}[]};
export type ModelSourceGroup=ModelGroup&{provider:string;providerLabel:string;accountLabel:string;remaining:number|null;quota?:LocalAgentSnapshot['quotas'][string]};
export type Choice={sourceId:string;model:string;contextWindow?:number};

/** Models an Agent has used through token-flow, current first, newest next, limited to what is still served. */
export function usedModels(target:{connection:(Choice&{selections?:Choice[]})|null;backups:(Choice&{selections?:Choice[]})[]},available:AvailableSourceModels,limit=8):Choice[]{
 const seen=new Set<string>();const result:Choice[]=[];
 for(const item of [target.connection,...target.backups].flatMap(record=>record?.selections??[record])){
  if(!item||!isSourceSelectionAvailable(available,item))continue;
  const key=`${item.sourceId}\n${item.model}`;if(seen.has(key))continue;
  seen.add(key);result.push({sourceId:item.sourceId,model:item.model});
 }
 return result.slice(0,limit);
}

/** Every model a user can send to an Agent, grouped by the account or API that provides it. */
export function modelGroups(local:LocalAgentSnapshot):ModelSourceGroup[]{
 return sourceOptions(local).map(source=>({
  id:source.id,
  label:source.provider==='api'?source.label:`${local.providers.find(p=>p.id===source.provider)?.label??source.provider} · ${source.label}`,
  provider:source.provider,
  providerLabel:source.provider==='api'?'API 接口':local.providers.find(p=>p.id===source.provider)?.label??source.provider,
  accountLabel:source.label,
  remaining:source.remaining,
  quota:local.quotas[source.id],
  models:source.models.map(id=>({id,label:modelLabel(local,id)})),
 })).filter(group=>group.models.length);
}

/** Models grouped by provider (or API source) for scoping an exported Key. */
export function keyScopes(local:LocalAgentSnapshot):ModelGroup[]{
 const groups=new Map<string,ModelGroup>();
 for(const model of local.models){
  const source=model.provider==='api'?local.apiSources?.find(s=>model.id.startsWith(`api-${s.id}/`)):undefined;
  const id=source?`api-${source.id}`:model.provider??model.id.split('/')[0];
  const label=source?source.name:local.providers.find(p=>p.id===id)?.label??id;
  const group=groups.get(id)??{id,label,models:[]};
  group.models.push({id:model.id,label:modelLabel(local,model.id)});groups.set(id,group);
 }
 return [...groups.values()].sort((a,b)=>a.label.localeCompare(b.label));
}

export type Usage={requests:number;failed:number;inputTokens:number;outputTokens:number;last?:string};
/** Token totals for the per-key, per-model rows that match, from this run of the gateway. */
export function usageOf(rows:readonly GatewayUsage[],match:(row:{model:string;keyId:string})=>boolean):Usage{
 const usage:Usage={requests:0,failed:0,inputTokens:0,outputTokens:0};
 for(const row of rows){
  if(!match(row))continue;
  usage.requests+=row.requests;usage.failed+=row.failed;
  usage.inputTokens+=row.inputTokens;usage.outputTokens+=row.outputTokens;
  if(!usage.last||row.last>usage.last)usage.last=row.last;
 }
 return usage;
}
export const usageText=(usage:Usage)=>usage.requests?`${formatTokens(usage.requests)} 次请求${usage.failed?`（${formatTokens(usage.failed)} 次失败）`:''} · ${formatTokens(usage.inputTokens+usage.outputTokens)} tokens`:'本次运行还没有请求';

/** Tightest remaining percentage across an account's quota windows, or null when none is reported. */
export function quotaRemaining(quota:LocalAgentSnapshot['quotas'][string]|undefined):number|null{
 if(quota?.status!=='ok')return null;
 const values=quota.windows.flatMap(w=>typeof w.usedPercent==='number'&&Number.isFinite(w.usedPercent)?[Math.max(0,Math.min(100,100-w.usedPercent))]:[]);
 return values.length?Math.min(...values):null;
}

/** Tightest remaining quota across a provider's enabled accounts, or '' when the upstream reports none. */
export function providerQuotaText(local:LocalAgentSnapshot,accountIds:string[]):string{
 const remaining=accountIds.flatMap(id=>{const quota=local.quotas[id];return quota?.status==='ok'?quota.windows.flatMap(w=>typeof w.usedPercent==='number'&&Number.isFinite(w.usedPercent)?[Math.max(0,Math.min(100,100-w.usedPercent))]:[]):[];});
 return remaining.length?`剩余 ${Math.round(Math.min(...remaining))}%`:'';
}
