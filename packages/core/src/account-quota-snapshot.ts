import type {LocalAgentSnapshot,LocalAccount} from './cliproxy.js';
import type {AccountQuota} from './quota/types.js';

export type AccountQuotaSnapshot={
 loading:boolean;refreshing:boolean;
 accounts:Pick<LocalAccount,'id'|'provider'|'label'|'disabled'|'authenticationRequired'>[];
 providers:{id:string;label:string}[];
 quotas:Record<string,AccountQuota>;
};
/** The menu bar needs quota state only, never models, logs or login payloads. */
export function accountQuotaSnapshot(snapshot:LocalAgentSnapshot):AccountQuotaSnapshot{
 const accounts=snapshot.accounts.filter(account=>!account.isDuplicate).map(({id,provider,label,disabled,authenticationRequired})=>({id,provider,label,disabled,authenticationRequired}));
 return {loading:!!snapshot.accountsLoading||snapshot.state==='starting',refreshing:snapshot.quotaBusy,accounts,
  providers:snapshot.providers.map(({id,label})=>({id,label})),
  quotas:Object.fromEntries(accounts.filter(account=>snapshot.quotas[account.id]).map(account=>[account.id,snapshot.quotas[account.id]]))};
}
