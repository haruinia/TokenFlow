import {expect,it} from 'vitest';
import {panelQuotaAccounts,panelQuotaWindow} from '../apps/console/src/quota-panel-model';
import type {AccountQuotaSnapshot} from '../packages/core/src/account-quota-snapshot';

it('hides disabled, unauthenticated, failed and non-numeric quotas while keeping a real 0% balance',()=>{
 const ids=['zero','unknown','disabled','auth','error'];
 const snapshot:AccountQuotaSnapshot={loading:false,refreshing:false,providers:[],
  accounts:ids.map(id=>({id,provider:'codex',label:id,disabled:id==='disabled',authenticationRequired:id==='auth'})),
  quotas:Object.fromEntries(ids.map(id=>[id,{accountId:id,provider:'codex',status:id==='error'?'error':'ok',observedAt:'2026-10-31T12:00:00Z',resetCredits:2,windows:[{id:'primary',label:'5 小时',usedPercent:id==='unknown'?null:100}]}]))};
 const rows=panelQuotaAccounts(snapshot);
 expect(rows.map(row=>row.account.id)).toEqual(['zero']);
 expect(rows[0].windows[0].remainingPercent).toBe(0);expect(rows[0].quota.resetCredits).toBe(2);
});
it('displays actual fractional credits and total independently from time windows',()=>{
 const row=panelQuotaWindow({id:'pack',label:'加购 Credits',unit:'Credits',usedPercent:92.7,used:463.5,limit:500,remaining:36.5});
 expect(row).toMatchObject({credits:true,label:'加购 积分',balance:'剩余 36.5 积分',total:'共 500 积分'});
 expect(row?.resetsAt).toBeUndefined();
 expect(panelQuotaWindow({id:'a',label:'套餐',unit:'点',usedPercent:null,used:150,limit:1000})).toMatchObject({remainingPercent:85,balance:'剩余 850 积分'});
});
it('does not manufacture a credit balance from a percentage or show an unallocated quota',()=>{
 expect(panelQuotaWindow({id:'credits',label:'本周 credits',usedPercent:20})).toMatchObject({remainingPercent:80,credits:true,balance:undefined});
 expect(panelQuotaWindow({id:'empty',label:'组织',unit:'Credits',used:0,limit:0,usedPercent:null})).toBeUndefined();
 expect(panelQuotaWindow({id:'bad',label:'窗口',usedPercent:NaN})).toBeUndefined();
});
