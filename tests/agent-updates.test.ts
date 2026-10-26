import {expect,it,vi} from 'vitest';
import {AgentUpdates,newerVersion} from '../packages/core/src/agent-updates';
import type {AgentInstallation} from '../packages/core/src/agent-installation';
const installed:AgentInstallation={installed:true,channel:'npm',version:'1.1.0',automatic:true,download:'https://pi.dev/docs/latest/quickstart'};
it.each([
 ['1.2.0','1.1.0',true],['1.1.0','1.1.0',false],['1.0.9','1.1.0',false],
 ['0.2.0','0.2.0-rc.2',true],['0.2.0-rc.2','0.2.0',false],['0.2.0-rc.11','0.2.0-rc.2',true],
 ['0.2.0-rc.2','0.2.0-rc.11',false],['unknown','1.1.0',false],['1.2.0','unknown',false],
])('compares %s against %s without inventing updates', (latest,current,result)=>expect(newerVersion(latest,current)).toBe(result));
it('coalesces and caches official metadata checks but rechecks when the installed version changes',async()=>{
 const fetcher=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({version:'1.2.0'}));const updates=new AgentUpdates(fetcher,'darwin','arm64');
 const results=await Promise.all([updates.check('pi',installed),updates.check('pi',installed)]);
 expect(results[0]).toEqual({status:'available',currentVersion:'1.1.0',latestVersion:'1.2.0'});expect(fetcher).toHaveBeenCalledTimes(1);
 expect(String(fetcher.mock.calls[0][0])).toContain('registry.npmjs.org');
 expect(await updates.check('pi',{...installed,version:'1.2.0'})).toMatchObject({status:'current'});expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not show an update dot for failed checks, malformed metadata or unknown local versions',async()=>{
 for(const fetcher of [vi.fn(async()=>{throw Error('offline');}),vi.fn(async()=>new Response('not-json')),vi.fn(async()=>Response.json({version:'not-a-version'}))]){
  expect(await new AgentUpdates(fetcher).check('pi',installed)).toEqual({status:'unknown',currentVersion:'1.1.0'});
 }
 const fetcher=vi.fn(async()=>Response.json({version:'1.2.0'}));
 expect(await new AgentUpdates(fetcher).check('pi',{...installed,version:undefined})).toMatchObject({status:'unknown'});expect(fetcher).not.toHaveBeenCalled();
});
it('does not report an ARM-only feed as an Intel-compatible update',async()=>{
 const fetcher=vi.fn(async()=>new Response('version: 0.4.4\nfiles:\n  - url: Qoder-mac-arm64.zip\n'));
 expect(await new AgentUpdates(fetcher,'darwin','x64').check('qoder',{...installed,channel:'application',version:'0.3.4'})).toMatchObject({status:'unknown'});
 expect(await new AgentUpdates(fetcher,'darwin','arm64').check('qoder',{...installed,channel:'application',version:'0.3.4'})).toMatchObject({status:'available'});
});
it('honors an unavailable official platform and the vendor no-update response',async()=>{
 const fetcher=vi.fn(async()=>new Response(null,{status:204}));const updates=new AgentUpdates(fetcher,'win32','x64');
 expect(await updates.check('deepseek',{...installed,supported:false})).toMatchObject({status:'unsupported'});expect(fetcher).not.toHaveBeenCalled();
 expect(await updates.check('workbuddy',{...installed,channel:'application'})).toMatchObject({status:'current'});
});
it('does not compare native and extension clients against unrelated npm releases',async()=>{
 const fetcher=vi.fn(async()=>Response.json({version:'9.0.0'}));
 for(const target of ['codex','claude'] as const)expect(await new AgentUpdates(fetcher).check(target,{...installed,channel:'other'})).toMatchObject({status:'unknown'});
 expect(fetcher).not.toHaveBeenCalled();
});
