import {expect,it} from 'vitest';
import {quotaPresentation} from '../apps/console/src/QuotaDetails';
import type {AccountQuota,QuotaWindow} from '../packages/core/src/quota/types';
const quota=(windows:QuotaWindow[]):AccountQuota=>({accountId:'fixture',provider:'antigravity',status:'ok',observedAt:'2026-10-24T10:00:00Z',windows});
const window=(id:string,usedPercent:number,resetsAt='2026-10-25T10:00:00Z'):QuotaWindow=>({id,label:id,usedPercent,resetsAt});
it('keeps the original two windows plus one Gemini overview while retaining every model detail',()=>{
 const windows=[window('3p-weekly',58),window('3p-5h',1),...Array.from({length:12},(_,i)=>window(`model:gemini-${i}`,0)),window('model:claude-example',58),window('model:tab_example',0)];
 const result=quotaPresentation(quota(windows));expect(result.overview.map(w=>w.id)).toEqual(['3p-weekly','3p-5h','gemini-overview']);expect(result.overview[2].usedPercent).toBe(0);expect(result.details).toHaveLength(14);expect(windows).toHaveLength(16);
});
it('shows differing model quotas as a range without inventing a shared reset or hiding future models',()=>{
 const result=quotaPresentation(quota([window('model:gemini-a',20),window('model:gemini-b',90,'2026-10-26T10:00:00Z'),window('model:future-model',75)]));
 expect(result.overview[0]).toMatchObject({usedPercent:null,displayValue:'剩余 10%–80% · 各模型不同',resetsAt:undefined});expect(result.overview[1]).toMatchObject({label:'其他模型',usedPercent:75});expect(result.details).toHaveLength(3);
});
it('prefers an upstream Gemini summary and leaves other providers unchanged',()=>{
 const windows=[{...window('gemini-shared',30),label:'Gemini Models · weekly'},window('model:gemini-a',30)];expect(quotaPresentation(quota(windows)).overview).toHaveLength(1);
 expect(quotaPresentation({...quota(windows),provider:'codex'})).toEqual({overview:windows,details:[]});
});
