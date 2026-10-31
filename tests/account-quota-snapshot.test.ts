import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDesktopService} from '../packages/core/src/service.js';
import {accountQuotaSnapshot} from '../packages/core/src/account-quota-snapshot.js';
import type {LocalAgentSnapshot} from '../packages/core/src/cliproxy.js';

const snapshot:LocalAgentSnapshot={state:'running',loginState:'idle',port:8317,logs:['private diagnostic'],models:[{id:'private-model'}],quotaBusy:false,accountError:undefined,lastError:undefined,login:undefined,
 accounts:[{id:'a',provider:'codex',label:'Personal',status:'active',disabled:false,unavailable:false},{id:'alias',provider:'codex',label:'Personal',status:'active',disabled:false,unavailable:false,isDuplicate:true},{id:'b',provider:'claude',label:'Work',status:'active',disabled:true,unavailable:false}],
 providers:[],quotas:{a:{accountId:'a',provider:'codex',status:'ok',observedAt:'2026-10-31T12:00:00Z',windows:[{id:'empty',label:'5 小时',usedPercent:100},{id:'unknown',label:'每周',usedPercent:null}]},orphan:{accountId:'orphan',provider:'claude',status:'ok',observedAt:'2026-10-31T12:00:00Z',windows:[]}}};
afterEach(()=>vi.restoreAllMocks());
it('exposes only display metadata and preserves zero/unknown quota without duplicate credentials or orphan accounts',()=>{
 const result=accountQuotaSnapshot({...snapshot,accountsLoading:true});
 expect(result.loading).toBe(true);expect(result.accounts.map(a=>a.id)).toEqual(['a','b']);expect(result.accounts[1].disabled).toBe(true);
 expect(Object.keys(result.quotas)).toEqual(['a']);expect(result.quotas.a.windows.map(w=>w.usedPercent)).toEqual([100,null]);
 expect(result).not.toHaveProperty('logs');expect(result).not.toHaveProperty('models');expect(result.accounts[0]).not.toHaveProperty('status');
});
it('reads cached quotas without discovery or credential reads; only explicit refresh queries quotas',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tokenflow-quota-panel-'));
 const get=vi.fn(async()=>''),set=vi.fn(async()=>{});
 const service=await createDesktopService({root,binary:'/missing',token:'fixture-admin',localKey:'fixture-key',secrets:{get,set},nativeCredentialsOnDemand:true,agentPaths:{codex:join(root,'codex/config.toml')},claudeCredentialStore:null});
 const discovery=vi.spyOn(service.proxy,'refreshAccounts');
 const quotas=vi.spyOn(service.proxy,'refreshQuota').mockResolvedValue(snapshot);
 vi.spyOn(service.proxy,'snapshot').mockReturnValue(snapshot);
 get.mockClear();set.mockClear();
 const headers={host:'127.0.0.1:9527',authorization:'Bearer fixture-admin'};
 try{
  expect((await service.app.inject({url:'/api/account-quotas',headers:{host:headers.host}})).statusCode).toBe(401);
  const response=await service.app.inject({url:'/api/account-quotas',headers});
  expect(response.statusCode).toBe(200);expect(response.json().accounts).toHaveLength(2);
  expect(quotas).not.toHaveBeenCalled();expect(discovery).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();expect(set).not.toHaveBeenCalled();
  expect((await service.app.inject({method:'POST',url:'/api/account-quotas/refresh',headers})).statusCode).toBe(200);
  expect(quotas).toHaveBeenCalledTimes(1);expect(discovery).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});
