import {expect,it} from 'vitest';
import {orderApiSources} from '../apps/console/src/api-source-order';
import type {UsageRow} from '../apps/console/src/usage-model';
const day='2026-10-25';
const source=(id:string,enabled=true,createdAt='2026-10-20T00:00:00Z')=>({id,enabled,createdAt});
const row=(sourceId:string,inputTokens:number,outputTokens=0,extra:Partial<UsageRow>={}):UsageRow=>({day,target:'codex',keyId:'key',keyName:'key',sourceId,model:'model',requests:1,failed:0,unmeasured:0,inputTokens,outputTokens,cachedTokens:0,cacheBaseTokens:0,durationMs:1,last:day+'T12:00:00Z',...extra});
it('prioritizes today tokens over enabled state, then enabled over newest creation',()=>{
 const sources=[source('new-off',false,'2026-10-25'),source('old-on'),source('used-off',false),source('new-on',true,'2026-10-24')];
 const before=structuredClone(sources);
 const rows=[row('used-off',20,30),row('used-off',40),row('old-on',5000,0,{day:'2026-10-24'}),row('new-off',9000,0,{origin:'native'})];
 expect(orderApiSources(sources,rows,day).map(s=>s.id)).toEqual(['used-off','new-on','old-on','new-off']);
 expect(sources).toEqual(before);
});
it('uses enabled and newest order before usage arrives and reorders with daily totals',()=>{
 const sources=[source('old'),source('new',true,'2026-10-24')];
 expect(orderApiSources(sources,[],day).map(s=>s.id)).toEqual(['new','old']);
 expect(orderApiSources(sources,[row('old',1)],day).map(s=>s.id)).toEqual(['old','new']);
});
