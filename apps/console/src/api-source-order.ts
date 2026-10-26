import {localDay,totalsOf,type UsageRow} from './usage-model';

/** Same daily Token total as the card; ties use enabled state, then newest creation. */
export function orderApiSources<T extends {id:string;enabled:boolean;createdAt:string}>(sources:readonly T[],rows:readonly UsageRow[],day=localDay(new Date())):T[]{
 const grouped=new Map<string,UsageRow[]>();
 for(const row of rows){if(row.day!==day||row.origin==='native'||!row.sourceId)continue;const group=grouped.get(row.sourceId)??[];group.push(row);grouped.set(row.sourceId,group);}
 const tokens=new Map([...grouped].map(([id,group])=>[id,totalsOf(group).totalTokens]));
 return [...sources].sort((a,b)=>(tokens.get(b.id)??0)-(tokens.get(a.id)??0)||Number(b.enabled)-Number(a.enabled)||b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
}
