import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AgentModelPicker} from '../apps/console/src/AgentModelPicker';
import {QuotaDetails} from '../apps/console/src/QuotaDetails';
import type {LocalAgentSnapshot} from '../packages/core/src/cliproxy';
import type {AccountQuota} from '../packages/core/src/quota/types';
const quota:AccountQuota={accountId:'fixture',provider:'antigravity',status:'ok',observedAt:'2026-10-24T12:00:00Z',windows:[
 {id:'gemini-weekly',label:'Gemini Models · Weekly Limit Remaining',usedPercent:2},
 {id:'gemini-5h',label:'Gemini Models · Five Hour Limit Remaining',usedPercent:6},
 {id:'3p-weekly',label:'Claude and GPT models · Weekly Limit Remaining',usedPercent:58},
 {id:'3p-5h',label:'Claude and GPT models · Five Hour Limit Remaining',usedPercent:1},
 ...Array.from({length:17},(_,i)=>({id:`model:gemini-${i}`,label:`Gemini ${i} · 模型额度`,usedPercent:6}))
]};
function picker(value=quota){
 const local:LocalAgentSnapshot={state:'running',loginState:'idle',port:8317,logs:[],accountError:undefined,lastError:undefined,login:undefined,accounts:[{id:'fixture',label:'Fixture',provider:'antigravity',status:'active',disabled:false,unavailable:false,models:['antigravity/gemini']}],models:[{id:'antigravity/gemini',provider:'antigravity'}],quotas:{fixture:value},quotaBusy:false,providers:[]};
 return renderToStaticMarkup(createElement(AgentModelPicker,{open:true,embedded:true,title:'管理模型',local,selected:[],onConfirm:()=>{},onClose:()=>{}}));
}
const rings=(html:string)=>html.match(/class="tfAgentPickerRings"[\s\S]*?<\/div>/)?.[0]??'';
it('shows the same four summary windows as account authorization, with model reports in details',()=>{
 const html=picker(),overview=rings(html);
 expect((overview.match(/role="img"/g)??[])).toHaveLength(4);
 expect(overview).toContain('Gemini · 周额度');expect(overview).toContain('Claude / GPT · 5 小时');
 const account=renderToStaticMarkup(createElement(QuotaDetails,{quota,label:'Fixture'}));
 for(const remaining of [98,94,42,99]){expect(overview).toContain(`剩余 ${remaining}%`);expect(account).toContain(`剩余 ${remaining}%`);}
 expect(html).toContain('额度详情');expect(account).toContain('按模型查看（17）');
});
it('renders refreshed quota values and marks stale values instead of keeping a separate snapshot',()=>{
 const updated={...quota,windows:quota.windows.map(w=>w.id==='gemini-weekly'?{...w,usedPercent:20}:w)};
 expect(rings(picker(updated))).toContain('剩余 80%');expect(rings(picker(updated))).not.toContain('剩余 98%');
 expect(picker({...updated,status:'error',error:'timeout',lastSuccessfulAt:quota.observedAt})).toContain('上次额度');
});
