import {expect,it} from 'vitest';
import {quotaErrorMessage} from '../apps/console/src/QuotaDetails';
import {sourceFailure} from '../packages/core/src/source-failure';
import type {LocalAgentSnapshot} from '../packages/core/src/cliproxy';

it('does not call a rejected quota query an expired login',()=>{
 expect(quotaErrorMessage('HTTP 401')).not.toContain('失效');
 expect(quotaErrorMessage('HTTP 403')).not.toContain('失效');
 expect(quotaErrorMessage('refresh_token_revoked')).toContain('失效');
 expect(quotaErrorMessage('连接超时')).toContain('网络');
});

it('uses account and quota evidence rather than zero recorded Tokens to explain source failures',()=>{
 const local={state:'running',accounts:[{id:'a',disabled:false,modelError:'catalog failed',models:[]}],quotas:{}} as unknown as LocalAgentSnapshot;
 expect(sourceFailure(local,'a','m').type).toBe('source_catalog_unavailable');
 local.quotas.a={accountId:'a',provider:'codex',status:'error',observedAt:new Date().toISOString(),windows:[],error:'HTTP 401'};
 expect(sourceFailure(local,'a','m').type).toBe('source_catalog_unavailable');
 local.quotas.a={...local.quotas.a,status:'ok',windows:[{id:'monthly',label:'月度',usedPercent:100}]};
 expect(sourceFailure(local,'a','m')).toMatchObject({type:'source_quota_exhausted',status:429});
 local.accounts[0].authenticationRequired=true;
 expect(sourceFailure(local,'a','m')).toMatchObject({type:'source_auth_expired',status:401});
});

it('does not apply exhausted Antigravity model or third-party pools to unrelated Gemini models',()=>{
 const local={state:'running',accounts:[{id:'a',disabled:false,models:['antigravity/gemini-new']}],quotas:{a:{provider:'antigravity',status:'ok',windows:[{id:'model:other',usedPercent:100},{id:'3p-weekly',usedPercent:100}]}}} as unknown as LocalAgentSnapshot;
 expect(sourceFailure(local,'a','antigravity/gemini-new').type).not.toBe('source_quota_exhausted');
 expect(sourceFailure(local,'a','antigravity/claude-sonnet').type).toBe('source_quota_exhausted');
 expect(sourceFailure(local,'a','antigravity/other').type).toBe('source_quota_exhausted');
});
