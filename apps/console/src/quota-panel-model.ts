import type {AccountQuotaSnapshot} from '../../../packages/core/src/account-quota-snapshot';
import type {QuotaWindow} from '../../../packages/core/src/quota/types';
import {quotaPresentation} from './QuotaDetails';
import {isProviderVisible} from './provider-visibility';
import {quotaPanelLabel} from './quota-panel-label';

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const amount=(value:number)=>value.toLocaleString(undefined,{maximumFractionDigits:2});

export function panelQuotaWindow(window:QuotaWindow){
 const credits=/^(?:credits?|点|积分)$/i.test(window.unit??'')||/\bcredits?\b/i.test(window.label);
 const remaining=finite(window.remaining)?Math.max(0,window.remaining):finite(window.limit)&&finite(window.used)?Math.max(0,window.limit-window.used):undefined;
 const usedPercent=finite(window.usedPercent)?window.usedPercent:finite(window.limit)&&window.limit>0&&remaining!==undefined?100*(1-remaining/window.limit):undefined;
 if(usedPercent===undefined)return;
 const unit=credits?'积分':window.unit;
 const money=unit==='USD';
 const quantity=(value:number)=>money?`$${amount(value)}`:`${amount(value)}${unit?` ${unit}`:''}`;
 return {...window,remainingPercent:Math.max(0,Math.min(100,100-usedPercent)),credits,
  label:quotaPanelLabel(window.label).replace(/\bcredits?\b/gi,'积分'),
  // Percent-only reports cannot supply an exact balance.
  balance:remaining!==undefined&&!!unit?`剩余 ${quantity(remaining)}`:undefined,
  total:finite(window.limit)&&!!unit?`共 ${quantity(window.limit)}`:undefined};
}

export function panelQuotaAccounts(snapshot?:AccountQuotaSnapshot){
 if(!snapshot)return [];
 return snapshot.accounts.flatMap(account=>{
  const quota=snapshot.quotas[account.id];
  if(account.disabled||account.authenticationRequired||!isProviderVisible(account.provider)||!quota||quota.status!=='ok')return [];
  const windows=quotaPresentation(quota).overview.flatMap(window=>{const item=panelQuotaWindow(window);return item?[item]:[];});
  if(!windows.length)return [];
  return [{account,quota,windows,provider:snapshot.providers.find(item=>item.id===account.provider)?.label??account.provider}];
 });
}
