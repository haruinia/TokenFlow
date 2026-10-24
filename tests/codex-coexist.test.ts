import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import {zstdCompressSync} from 'node:zlib';
import { loadOfficialCodexCatalog, mergeCodexCatalog, officialCodexHeaders } from '../packages/core/src/codex-coexist.js';
import { createDesktopService } from '../packages/core/src/service.js';
const clean:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of clean.splice(0).reverse())await fn();});
const official={models:[{slug:'official-test',display_name:'Official test',visibility:'list',truncation_policy:{mode:'bytes',limit:10000},context_window:400000,base_instructions:'Official instructions',supported_reasoning_levels:[{effort:'high',description:'Reason'}]}]};
async function profile(){const root=await realpath(await mkdtemp(join(tmpdir(),'codex-coexist-')));clean.push(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'codex'));const config=join(root,'codex/config.toml');await writeFile(config,'');await writeFile(join(root,'codex/auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'local-oauth-secret',account_id:'fixture-account'}}));return {root,config};}
it('reads a complete fresh official catalog with native authorization and keeps original model metadata',async()=>{
 const {config}=await profile();const calls:unknown[]=[];
 const result=await loadOfficialCodexCatalog(config,async(url,init)=>{calls.push({url,init});return Response.json(official);});
 expect(result).toEqual(official);expect(calls[0]).toMatchObject({url:expect.stringContaining('https://chatgpt.com/backend-api/codex/models?'),init:{headers:{authorization:'Bearer local-oauth-secret','chatgpt-account-id':'fixture-account'},redirect:'error'}});
 const merged=mergeCodexCatalog({models:[{slug:'qoder/custom'}]},result);expect(merged.models[0]).toEqual(official.models[0]);expect(merged.tokenflow_gateway_models).toEqual(['qoder/custom']);
 expect(()=>mergeCodexCatalog({models:[{slug:'official-test'}]},result)).toThrow('重复');
 await expect(loadOfficialCodexCatalog(config,async()=>Response.json({error:{message:'secret-auth'}},{status:401}))).rejects.toMatchObject({code:'codex_coexist_unavailable'});
});
it('separates official identity from the managed gateway key and browser credentials',()=>{
 expect(officialCodexHeaders({authorization:'Bearer official','x-tokenflow-client-key':'local-secret',cookie:'browser-secret','x-api-key':'wrong','chatgpt-account-id':'account'})).toEqual({authorization:'Bearer official','content-type':'application/json','chatgpt-account-id':'account'});
 expect(()=>officialCodexHeaders({'x-tokenflow-client-key':'local'})).toThrow('登录');
});
it.each([
 ['timeout',()=>Promise.reject(new DOMException('PRIVATE_NETWORK_DETAIL','TimeoutError')),'读取官方模型列表超时'],
 ['network',()=>Promise.reject(new TypeError('PRIVATE_NETWORK_DETAIL')),'无法连接官方模型目录'],
 ['json',async()=>new Response('<html>PRIVATE_NETWORK_DETAIL</html>'),'官方模型目录格式暂不兼容'],
] as const)('distinguishes %s discovery failures without exposing transport details or blaming login',async(_kind,fetcher,message)=>{
 const {config}=await profile();
 await expect(loadOfficialCodexCatalog(config,fetcher)).rejects.toMatchObject({code:'codex_coexist_unavailable',message:expect.stringContaining(message)});
 try{await loadOfficialCodexCatalog(config,fetcher);}catch(error){expect(String(error)).not.toContain('PRIVATE_NETWORK_DETAIL');expect(String(error)).toContain('未改动配置');}
});
it('routes official and gateway models independently, rejects unknown IDs, and survives a service restart',async()=>{
 const {root,config}=await profile(),officialCalls:Array<{url:string;headers:Record<string,string>;body:any}>=[],gatewayCalls:Array<{headers:typeof reqHeaders;body:any}>=[];const reqHeaders:Record<string,unknown>={};
 const response=(model:string,text:string)=>({id:'resp_test',status:'completed',model,output:[{type:'message',id:'msg_test',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:10,output_tokens:1,total_tokens:11}});
 const upstream=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);gatewayCalls.push({headers:req.headers,body});res.setHeader('content-type','application/json');res.end(JSON.stringify(response(body.model,'gateway')));});
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));clean.push(()=>new Promise<void>(r=>upstream.close(()=>r())));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const secretsMap=new Map<string,string>(),options={root,token:'admin',localKey:'private-relay',proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),agentProcesses:async()=>[],agentPaths:{codex:config,claude:join(root,'claude.json'),pi:join(root,'pi.json'),qoder:join(root,'qoder.json'),deepseek:join(root,'deepseek.json'),workbuddy:join(root,'workbuddy.json'),'workbuddy-ai':join(root,'workbuddy-ai.json')},secrets:{persistent:true,get:async(k:string)=>secretsMap.get(k)??'',set:async(k:string,v:string)=>{secretsMap.set(k,v);},remove:async(k:string)=>{secretsMap.delete(k);}},codexOfficialFetch:async(url:string,init:RequestInit)=>{if(url.includes('/models?'))return Response.json(official);const body=JSON.parse(String(init.body));officialCalls.push({url,headers:init.headers as Record<string,string>,body});return Response.json(response(body.model,'official'));}};
 let service=await createDesktopService(options);clean.push(()=>service.app.close());const admin={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 await service.proxy.start();const added=await service.app.inject({method:'POST',url:'/api/sources',headers:admin,payload:{name:'Fixture',baseURL:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`,protocol:'responses',models:['third-party'],apiKey:'third-party-secret'}});expect(added.statusCode,added.body).toBe(200);const source=added.json(),model=`api-${source.id}/third-party`;
 const listed=await service.app.inject({url:'/api/a2a',headers:admin});expect(listed.statusCode,listed.body).toBe(200);const status=listed.json().targets.find((t:any)=>t.id==='codex');
 const applied=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers:admin,payload:{target:'codex',sourceId:source.id,model,selections:[{sourceId:source.id,model}],revision:status.revision,allowRunning:true,codexCoexist:true}});expect(applied.statusCode,applied.body).toBe(200);expect(applied.json().codexCoexist).toBe(true);
 const written=parse(await readFile(config,'utf8')) as any,key=written.model_providers.token_flow.http_headers['x-tokenflow-client-key'];expect(written.model_providers.token_flow.experimental_bearer_token).toBeUndefined();
 const headers={host:admin.host,authorization:'Bearer current-client-oauth','x-tokenflow-client-key':key,'chatgpt-account-id':'client-account'};
 const ask=(value:string)=>service.app.inject({method:'POST',url:'/codex/v1/responses',headers,payload:{model:value,input:'fixture'}});
 expect((await ask('official-test')).statusCode).toBe(200);expect(officialCalls[0]).toMatchObject({url:'https://chatgpt.com/backend-api/codex/responses',headers:{authorization:'Bearer current-client-oauth','chatgpt-account-id':'client-account'}});expect(JSON.stringify(officialCalls)).not.toContain(key);
 const zipped=await service.app.inject({method:'POST',url:'/codex/v1/responses',headers:{...headers,'content-type':'application/json','content-encoding':'zstd'},payload:zstdCompressSync(Buffer.from(JSON.stringify({model:'official-test',input:'compressed fixture'})))});expect(zipped.statusCode,zipped.body).toBe(200);expect(officialCalls[1].body.input).toBe('compressed fixture');
 expect((await ask(model)).statusCode).toBe(200);expect(gatewayCalls[0].headers.authorization).toBe('Bearer third-party-secret');expect(gatewayCalls[0].headers['chatgpt-account-id']).toBeUndefined();expect(JSON.stringify(gatewayCalls)).not.toContain('current-client-oauth');
 expect((await ask('unknown-official')).statusCode).toBe(403);expect(gatewayCalls).toHaveLength(1);expect(officialCalls).toHaveLength(2);
 // Exercise the actual service boundary, including opaque native history and
 // both native compaction protocols. No gateway summary may rewrite these.
 const officialBodies=[
  {path:'responses',body:{model:'official-test',input:[{role:'user',content:'fixture'}],reasoning:{effort:'low',summary:'auto'},service_tier:'default'}},
  {path:'responses',body:{model:'official-test',input:[{type:'compaction',encrypted_content:'opaque-official-state'},{role:'user',content:'continue'}],reasoning:{effort:'xhigh'},service_tier:'priority',store:false,stream:false}},
  {path:'responses',body:{model:'official-test',input:[{role:'user',content:'fixture'},{type:'compaction_trigger'}],reasoning:{effort:'high'},service_tier:'priority'}},
  {path:'responses/compact',body:{model:'official-test',input:[{role:'user',content:'fixture'}],instructions:'Preserve task state'}}
 ];
 for(const {path,body} of officialBodies){
  const result=await service.app.inject({method:'POST',url:`/codex/v1/${path}`,headers,payload:body});
  expect(result.statusCode,result.body).toBe(200);
  expect(officialCalls.at(-1)?.url).toBe(`https://chatgpt.com/backend-api/codex/${path}`);
  expect(officialCalls.at(-1)?.body).toEqual(body);
 }
 expect(gatewayCalls).toHaveLength(1);
 expect((await service.app.inject({method:'POST',url:'/codex/v1/responses',headers:{...headers,'x-tokenflow-client-key':'bad'},payload:{model:'official-test',input:'x'}})).statusCode).toBe(401);
 await service.app.close();service=await createDesktopService(options);expect((await ask('official-test')).statusCode).toBe(200);expect(officialCalls).toHaveLength(7);
});
