import type {CleanupEntry} from './file-cleanup.js';

export type CleanupGroup={id:string;name:string;entries:CleanupEntry[];bytes:number;older:number;sameVersion:number;duplicates:number};
/** Group only by scanner evidence; a shared display name alone is not application identity. */
export function cleanupGroups(entries:CleanupEntry[]):CleanupGroup[]{
 const groups=new Map<string,CleanupGroup>();
 for(const entry of entries){
  const id=entry.artifact?.groupKey??`entry:${entry.id}`;
  let group=groups.get(id);
  if(!group){group={id,name:entry.artifact?.groupName??entry.name,entries:[],bytes:0,older:0,sameVersion:0,duplicates:0};groups.set(id,group);}
  group.entries.push(entry);group.bytes+=entry.bytes;
  if(entry.artifact?.newerPath)group.older++;
  if(entry.artifact?.sameVersionPath)group.sameVersion++;
  if(entry.artifact?.duplicateOf)group.duplicates++;
 }
 for(const group of groups.values())group.entries.sort((a,b)=>(b.artifact?.version??'').localeCompare(a.artifact?.version??'',undefined,{numeric:true})||(b.artifact?.build??'').localeCompare(a.artifact?.build??'',undefined,{numeric:true})||a.path.localeCompare(b.path));
 return [...groups.values()];
}
