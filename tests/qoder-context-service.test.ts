import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createServer} from 'node:net';import {parse} from 'smol-toml';
import {createDesktopService} from '../packages/core/src/service.js';
it('persists the selected Qoder window and sends it again after restart while exposing only account-scoped choices',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'qoder-context-service-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const paths={codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')};
 await mkdir(join(root,'cliproxy'));await mkdir(join(root,'codex'));await writeFile(paths.codex,'model="original"\n');
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'qoder.json',provider:'qoder',status:'active',expectedContextLength:1000000,models:[{id:'dfmodel',context_length:200000,inputTokenLimit:1000000,thinking:{levels:['none','low','high','max']},default_reasoning_level:'high',qoder_runtime:{context_windows:[200000,400000,1000000],default_context:200000}}]}]));
 const options={root,proxyPort:port,nativeCredentialsOnDemand:true,antigravityPath:join(root,'no-antigravity.db'),binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:paths,agentProcesses:async()=>[]};
 let service=await createDesktopService(options);const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 try{
  await service.proxy.start();const account=service.proxy.snapshot().accounts[0],model='qoder/dfmodel';
  expect(account.modelCapabilities?.[model]?.contextWindows).toEqual([200000,400000,1000000]);
  const state=(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='codex');
  const payload={target:'codex',sourceId:account.id,model,revision:state.revision,selections:[{sourceId:account.id,model,contextWindow:1000000}]};
  const invalid=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{...payload,selections:[{sourceId:account.id,model,contextWindow:4000000}]}});expect(invalid.statusCode).toBeGreaterThanOrEqual(400);expect(await readFile(paths.codex,'utf8')).toBe('model="original"\n');
  const result=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload});expect(result.statusCode,result.body).toBe(200);expect(result.json().selections[0].contextWindow).toBe(1000000);
  const config=parse(await readFile(paths.codex,'utf8')) as any;const catalog=JSON.parse(await readFile(config.model_catalog_json,'utf8'));
  expect(catalog.models[0]).toMatchObject({context_window:1000000,auto_compact_token_limit:900000,default_reasoning_level:'high'});
  const send=()=>service.app.inject({method:'POST',url:'/v1/responses',headers:{host:headers.host,authorization:`Bearer ${config.model_providers.token_flow.experimental_bearer_token}`},payload:{model,input:'Reply OK',reasoning:{effort:'low'}}});
  let response=await send();expect(response.statusCode,response.body).toBe(200);
  await service.app.close();service=await createDesktopService(options);await service.proxy.start();response=await send();expect(response.statusCode,response.body).toBe(200);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});
