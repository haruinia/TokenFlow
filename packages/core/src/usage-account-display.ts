import {nativeIdentity} from './local-usage.js';
import type {NativeUsageAccount} from './native-usage-logins.js';

/** Read-time display aliases only. Never replace the request's billing identity
 * or rewrite its ledger source, counters, task kind or reconciliation evidence. */
export type UsageAccountDisplay={usageSourceId?:string;usageAccountLabel?:string};
type Account={id:string;provider?:string;accountId:string|null;email:string|null;label?:string};
export function codexUsageAccountAliases(accounts:readonly Account[],local:readonly NativeUsageAccount[],sources:readonly {id:string;provider:string;preferredCredentialId?:string}[]=[]){
 const candidates=new Map<string,Account[]>();
 for(const account of accounts){
  if(account.provider!=='codex'||!account.accountId)continue;
  const hash=nativeIdentity('codex',account.accountId),list=candidates.get(hash)??[];list.push(account);candidates.set(hash,list);
 }
 const aliases=new Map<string,UsageAccountDisplay>();
 for(const hash of new Set([...candidates.keys(),...local.filter(a=>a.provider==='codex').map(a=>a.account)])){
  const matches=candidates.get(hash)??[],known=local.filter(a=>a.provider==='codex'&&a.account===hash);
  // A workspace/account ID can be shared by different login identities. A hash
  // alone must not assign that historical usage to whichever login is current.
  const emails=new Set([...matches.flatMap(a=>a.email?[nativeIdentity('email',a.email.trim().toLowerCase())]:[]),...known.flatMap(a=>a.email?[a.email]:[])]);
  if(matches.length>1||emails.size>1)continue;
  const labels=[...new Set(known.map(a=>a.label))];
  const label=matches[0]?.label||matches[0]?.email||(labels.length===1?labels[0]:undefined);
  if(matches.length===1||label)aliases.set(hash,{...(matches[0]?{usageSourceId:matches[0].id}:{}),...(label?{usageAccountLabel:label}:{})});
 }
 // The existing credential pool already verifies duplicate grants. Reuse its
 // preferred identity so older source IDs do not create another account card.
 for(const source of sources){
  if(source.provider!=='codex'||!source.preferredCredentialId)continue;
  const match=accounts.find(a=>a.provider==='codex'&&a.id===source.preferredCredentialId);
  if(match)aliases.set(`source:${source.id}`,{usageSourceId:match.id,...(match.label||match.email?{usageAccountLabel:match.label||match.email!}:{})});
 }
 return aliases;
}
export function displayCodexUsageAccount<T extends {sourceId:string;billingAccountHash?:string}>(row:T,aliases:ReadonlyMap<string,UsageAccountDisplay>):T&UsageAccountDisplay{
 const alias=row.sourceId==='codex-official'&&row.billingAccountHash?aliases.get(row.billingAccountHash):aliases.get(`source:${row.sourceId}`);
 return alias?{...row,...alias}:row;
}
