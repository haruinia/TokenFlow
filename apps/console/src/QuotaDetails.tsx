import { QuotaRing } from './QuotaRing';
import { Icon } from './Icons';
import type { AccountQuota, QuotaWindow } from '../../../packages/core/src/quota/types';

type DisplayWindow=QuotaWindow&{displayValue?:string};
/** Compact model reports for display, without treating equal readings as independent pools. */
export function quotaPresentation(quota:AccountQuota):{overview:DisplayWindow[];details:QuotaWindow[]}{
 if(quota.provider!=='antigravity')return {overview:quota.windows,details:[]};
 const details=quota.windows.filter(window=>window.id.startsWith('model:'));
 const overview:DisplayWindow[]=quota.windows.filter(window=>!window.id.startsWith('model:'));
 const summarize=(id:string,label:string,models:QuotaWindow[])=>{
  if(!models.length)return;
  const values=models.map(window=>window.usedPercent).filter((value):value is number=>value!==null);
  const same=values.length===models.length&&values.every(value=>value===values[0]);
  const sameReset=models.every(window=>window.resetsAt===models[0].resetsAt);
  overview.push({id,label,usedPercent:same?values[0]:null,resetsAt:sameReset?models[0].resetsAt:undefined,
   ...(!same&&values.length?{displayValue:`剩余 ${Math.round(100-Math.max(...values))}%–${Math.round(100-Math.min(...values))}% · 各模型不同`}:{})});
 };
 if(!overview.some(window=>/gemini/i.test(window.label)))summarize('gemini-overview','Gemini',details.filter(window=>/^model:gemini[-/]/i.test(window.id)));
 if(!overview.some(window=>window.id.startsWith('3p-')||/claude|gpt/i.test(window.label)))summarize('third-party-overview','Claude / GPT 模型',details.filter(window=>/^model:(?:claude|gpt)[-/]/i.test(window.id)));
 // Completion-only models stay accessible in details; unknown future agent models get an overview.
 summarize('other-models-overview','其他模型',details.filter(window=>!/^model:(?:gemini[-/]|claude[-/]|gpt[-/]|tab_)/i.test(window.id)));
 return {overview,details};
}

const formatAmount = (value: number, unit?: string) => unit === 'USD' ? `$${value.toFixed(2)}` : `${Math.round(value).toLocaleString()}${unit ?? ''}`;
const resetLabel = (iso: string,concise=false) => {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return '已重置';
  const minutes = Math.round(ms / 60000);
  const span = minutes < 60 ? `${minutes} 分钟` : minutes < 60 * 48 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
  return concise?`${span}后重置`:`${span}后重置（${new Date(iso).toLocaleString()}）`;
};

export function quotaErrorMessage(error='') {
 if(/invalid_grant|refresh_token_(?:revoked|reused|expired)|授权.*(?:失效|过期)|登录.*(?:失效|过期)/i.test(error))return '登录授权已失效，请重新授权。';
 if(/\b401\b/.test(error))return '额度查询未通过认证，可刷新或重新授权。';
 if(/\b403\b/.test(error))return '额度查询权限受限，请检查账号权限。';
 if(/\b429\b|请求过于频繁/i.test(error))return '查询太频繁，请稍后刷新额度。';
 if(/\b5\d\d\b|网络|连接|超时|timeout|fetch failed|ECONN|ENOTFOUND/i.test(error))return '网络暂时不稳定，额度更新失败，请稍后刷新。';
 return '暂时无法更新额度，请稍后刷新。';
}

export function QuotaDetails({quota,label,compact=false,concise=false}:{quota:AccountQuota;label:string;compact?:boolean;concise?:boolean}) {
 const {overview,details}=quotaPresentation(quota);
 const renderWindow=(window:DisplayWindow,modelDetail=false)=><span className="quotaWindow quotaWindowRing" key={window.id}>
   <QuotaRing compact={compact} remaining={window.usedPercent===null?null:100-window.usedPercent} label={window.label}/>
   <span className="quotaWindowDetails"><span className="quotaMeta"><span title={window.label}>{window.label}</span></span>
    <b>{window.displayValue??(window.usedPercent===null?(window.remaining!==undefined?`余额 ${formatAmount(window.remaining,window.unit)}`:'额度暂未提供'):`已用 ${Math.round(Math.max(0,Math.min(100,window.usedPercent)))}% · 剩余 ${Math.round(Math.max(0,Math.min(100,100-window.usedPercent)))}%`)}{window.note&&!modelDetail?` · ${window.note}`:''}</b>
    <small title={window.resetsAt?new Date(window.resetsAt).toLocaleString():undefined}>{window.used!==undefined&&window.limit!==undefined?`已用 ${formatAmount(window.used,window.unit)} / ${formatAmount(window.limit,window.unit)}`:window.used!==undefined?`已用 ${formatAmount(window.used,window.unit)}`:''}{window.resetsAt?`${window.used!==undefined?' · ':''}${resetLabel(window.resetsAt,concise)}`:''}</small>
   </span>
  </span>;
 return <span className={`quota quota-${quota.status}${compact?' compactQuota':''}`} aria-label={`${label} 额度`}>
  {quota.status==='error'&&<span className="quotaStatus" role="status"><Icon name="alertCircle" size={16}/><span>{quotaErrorMessage(quota.error)}</span></span>}
  {quota.status==='error'&&quota.lastSuccessfulAt&&quota.windows.length>0&&<span className="quotaStale">上次更新：{new Date(quota.lastSuccessfulAt).toLocaleString()} · 非实时额度</span>}
  {quota.status==='ok'&&!quota.windows.length&&!quota.note&&<span className="hint">额度暂未提供</span>}
  {overview.map(window=>renderWindow(window))}
  {!!details.length&&<details className="tfQuotaModelDetails"><summary>按模型查看（{details.length}）</summary><span className="hint">模型可能共享额度，不能累加。</span><span className="tfQuotaModelRows">{details.map(window=>renderWindow(window,true))}</span></details>}
  {quota.note&&<span className="hint">{quota.note}</span>}
  <small className="quotaObserved">查询于 {new Date(quota.observedAt).toLocaleTimeString()}</small>
 </span>;
}
