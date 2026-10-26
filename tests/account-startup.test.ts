import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {createDesktopService} from '../packages/core/src/service.js';

it('reports account discovery as pending even after the gateway is running, then publishes saved accounts',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tokenflow-account-startup-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'qoder.json',provider:'qoder',status:'active',models:['fixture-model']}]));
 const paths=Object.fromEntries(['codex','claude','qoder','workbuddy','pi','deepseek'].map(name=>[name,join(root,name,'config.json')]));
 const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'fixture-admin',localKey:'fixture-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:paths,claudeCredentialStore:null,antigravityPath:join(root,'antigravity')});
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),reading=new Promise<void>(r=>{entered=r;});
 const refresh=service.proxy.refreshAccounts.bind(service.proxy);
 vi.spyOn(service.proxy,'refreshAccounts').mockImplementation(async(...args)=>{entered();await gate;return refresh(...args);});
 const started=service.proxy.start();
 const snapshot=async()=>{const r=await service.app.inject({url:'/api/local-agent',headers:{host:'127.0.0.1:9527',authorization:'Bearer fixture-admin'}});expect(r.statusCode).toBe(200);return r.json();};
 try{
  await reading;
  const pending=await snapshot();expect(pending.state).toBe('running');expect(pending.accountsLoading).toBe(true);expect(pending.accounts).toHaveLength(0);
  release();await started;
  const ready=await snapshot();expect(ready.accountsLoading).toBe(false);expect(ready.accounts.some((a:{provider:string})=>a.provider==='qoder')).toBe(true);
 }finally{release();await started.catch(()=>{});await service.app.close();await rm(root,{recursive:true,force:true});}
});
