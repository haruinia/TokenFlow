import {z} from 'zod';
import {dayOf,type UsageRow} from './usage-ledger.js';
import type {MaintenanceContext} from './maintenance-conversations.js';

export const maintenanceUsageQuery=z.object({range:z.enum(['today','7d','30d','all']).optional(),model:z.string().max(300).optional(),sourceId:z.string().max(100).optional(),keyId:z.string().max(80).optional()}).strict();
export type MaintenanceUsageQuery=z.infer<typeof maintenanceUsageQuery>;
type Row=UsageRow&{origin?:string;provider?:string};
/** Use the same ledger/native rows as the UI; missing stream timing is never treated as zero speed. */
export function maintenanceUsage(rows:readonly Row[],context:MaintenanceContext,query:MaintenanceUsageQuery={},now=new Date()){
 const range=query.range??context.range??'all';let from='',to=dayOf(now);
 if(query.range===undefined&&context.day){
  to=context.day;
  if(context.mode==='day')from=to;
  if(context.mode==='week'){const date=new Date(`${to}T12:00:00`);date.setDate(date.getDate()-date.getDay());from=dayOf(date);date.setDate(date.getDate()+6);to=dayOf(date)>dayOf(now)?dayOf(now):dayOf(date);}
 }else if(range!=='all'){const date=new Date(now);date.setDate(date.getDate()-({today:1,'7d':7,'30d':30}[range]-1));from=dayOf(date);}
 const sourceId=query.sourceId??context.sourceId,model=query.model??context.model,keyId=query.keyId??context.keyId;
 const selected=rows.filter(row=>(!from||row.day>=from)&&row.day<=to&&(!sourceId||row.sourceId===sourceId)&&(!model||row.model===model)&&(!keyId||row.keyId===keyId)&&(!context.target||row.target===context.target)&&(!context.provider||row.provider===context.provider)&&(!context.origin||context.origin==='all'||row.origin===context.origin));
 const groups=new Map<string,{model:string;credits:number;requests:number;failed:number;unmeasured:number;unclassifiedTokens:number;cacheBaseTokens:number;inputTokens:number;cachedTokens:number;cacheWriteTokens:number;outputTokens:number;timedOutputTokens:number;generationMs:number;timedRows:number;untimedRows:number}>();
 for(const row of selected){const group=groups.get(row.model)??{model:row.model,credits:0,requests:0,failed:0,unmeasured:0,unclassifiedTokens:0,cacheBaseTokens:0,inputTokens:0,cachedTokens:0,cacheWriteTokens:0,outputTokens:0,timedOutputTokens:0,generationMs:0,timedRows:0,untimedRows:0};
  for(const field of ['unclassifiedTokens','credits','requests','failed','unmeasured','cacheBaseTokens','inputTokens','cachedTokens','cacheWriteTokens','outputTokens'] as const)group[field]+=row[field]??0;
  if((row.generationMs??0)>0&&row.timedOutputTokens!==undefined){group.generationMs+=row.generationMs!;group.timedOutputTokens+=row.timedOutputTokens;group.timedRows++;}else group.untimedRows++;
  groups.set(row.model,group);
 }
 const models=[...groups.values()].sort((a,b)=>(b.inputTokens+b.outputTokens+b.unclassifiedTokens)-(a.inputTokens+a.outputTokens+a.unclassifiedTokens)).map(group=>({...group,totalTokens:group.inputTokens+group.outputTokens+group.unclassifiedTokens,uncachedTokens:Math.max(0,group.inputTokens-group.cachedTokens-group.cacheWriteTokens),cacheHitRate:group.cacheBaseTokens>0?group.cachedTokens/group.cacheBaseTokens:null,tokensPerSecond:group.generationMs>0?group.timedOutputTokens/(group.generationMs/1000):null}));
 return {scope:{from:from||null,to,sourceId,model,keyId,target:context.target,origin:context.origin??'all'},credits:selected.reduce((n,r)=>n+(r.credits??0),0),requests:selected.reduce((n,r)=>n+r.requests,0),totalTokens:selected.reduce((n,r)=>n+r.inputTokens+r.outputTokens+(r.unclassifiedTokens??0),0),modelCount:models.length,models:models.slice(0,80),truncated:models.length>80,
  measurement:'Credits 为 Qoder 积分，单独累计，不换算为 Token。inputTokens 已包含缓存读取与写入，totalTokens = inputTokens + outputTokens + unclassifiedTokens（未拆分或冲突总量）；uncachedTokens 为未缓存输入，不要重复累计缓存。unmeasured 为计量不完整或冲突的请求数，已知部分仍计入，不能据此断言总量完整。生成速度 = 有流式计时的输出 Token 总量 ÷ 对应生成时长（秒）；不是请求总耗时，也不是主动测速。null 表示没有计时证据。timedRows/untimedRows 是统计行数，不是请求数；同一统计行也可能包含未计时请求。'};
}
