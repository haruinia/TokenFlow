import type {LocalAgentSnapshot} from './cliproxy.js';

/** Explain the evidence we have; an empty catalog or quota-query rejection does not prove expired login. */
export function sourceFailure(local:LocalAgentSnapshot,id:string,model:string){
 const account=local.accounts.find(a=>a.id===id);
 if(local.state!=='running')return {status:503,type:'gateway_unavailable',message:'TokenFlow 网关尚未运行，请启动后重试。'};
 if(account?.authenticationRequired)return {status:401,type:'source_auth_expired',message:'所选来源的登录授权已失效。请在 TokenFlow「账号授权」中重新授权，或确认移除失效授权后选择其他来源。'};
 if(account?.disabled)return {status:503,type:'source_disabled',message:'所选来源账号已停用，请在 TokenFlow「账号授权」中启用，或选择其他来源。'};
 const quota=local.quotas[id];
 const applies=(window:{id:string})=>{
  if(quota?.provider!=='antigravity')return true;
  const selected=model.replace(/^antigravity\//,'');
  if(window.id.startsWith('model:'))return window.id.slice(6)===selected;
  if(window.id.startsWith('3p-'))return /^(?:claude|gpt)[-_]/i.test(selected);
  return true;
 };
 if(quota?.status==='ok'&&quota.windows.some(w=>applies(w)&&(w.usedPercent!==null&&w.usedPercent>=100||w.remaining!==undefined&&w.remaining<=0)&&(!w.resetsAt||Date.parse(w.resetsAt)>Date.now())))return {status:429,type:'source_quota_exhausted',message:'所选来源账号的额度已用尽，请等待额度恢复，或选择其他来源。'};
 if(account?.modelError||account&&!account.models?.length)return {status:503,type:'source_catalog_unavailable',message:'所选来源的模型目录尚未加载成功，请在 TokenFlow 刷新该来源后重试，或选择其他模型。'};
 if(!account&&!local.accountsLoading&&!local.accountError&&!id.startsWith('api-'))return {status:503,type:'source_unavailable',message:'所选来源暂不可用，请在 TokenFlow 检查账号或 API 接口，或选择其他来源。'};
 return {status:503,type:'source_unavailable',message:'所选来源暂不可用，请在 TokenFlow 刷新来源状态后重试。'};
}
