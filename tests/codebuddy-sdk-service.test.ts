import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {createServer} from 'node:net';
import {createDesktopService} from '../packages/core/src/service.js';
import {WorkBuddySDKProvider} from '../packages/core/src/codebuddy.js';
import type {SDKToolIssue} from '../packages/codebuddy-runtime/index.js';

it('keeps both regional account pins and meters each SDK completion exactly once across all protocols',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'sdk-routing-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const fixtures=['china','international'].map(region=>({name:`${region}.json`,provider:'workbuddy',email:`${region}@example.test`,status:'active',models:['deepseek-v4.1-flash']}));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(fixtures));
 for(const region of ['china','international'])await writeFile(join(root,`cliproxy/auth/${region}.json`),JSON.stringify({type:'workbuddy',access_token:region,domain:region==='china'?'copilot.tencent.com':'www.workbuddy.ai'}));
 const calls:string[]=[];
 const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'sidecar',secrets:{get:async()=>'',set:async()=>{}},workbuddySDKFactory:proxy=>new WorkBuddySDKProvider(root,(id,model)=>proxy.workbuddyCredential(id,model),async input=>{
  expect(input.token).toBe(input.region);calls.push(input.region);
  return {model:input.model,text:'OK',calls:[],failed:false,usage:{input_tokens:1000,cache_read_input_tokens:600,cache_creation_input_tokens:300,output_tokens:20}};
 })});
 const admin={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 try{
  await service.proxy.start();
  for(const account of service.proxy.snapshot().accounts.filter(a=>a.provider==='workbuddy')){
   const credential=await service.proxy.workbuddyCredential(account.id,'workbuddy/deepseek-v4.1-flash');expect(credential).toHaveProperty('access_token');
   const created=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:account.id,sourceId:account.id,models:['workbuddy/deepseek-v4.1-flash']}});
   expect(created.statusCode,created.body).toBe(200);const {apiKey,key}=created.json();
   for(const path of ['responses','messages','chat/completions'])for(const stream of [false,true]){
    const response=await service.app.inject({method:'POST',url:`/v1/${path}`,headers:{...admin,authorization:`Bearer ${apiKey}`},payload:{model:'workbuddy/deepseek-v4.1-flash',stream,...(path==='responses'?{input:'hello'}:{messages:[{role:'user',content:'hello'}]})}});
    expect(response.statusCode,response.body).toBe(200);expect(response.headers['x-token-flow-transport']).toBe('codebuddy-agent-sdk');
   }
   const rows=(await service.app.inject({url:'/api/gateway/usage?days=0',headers:admin})).json().rows.filter((r:any)=>r.keyId===key.id);
   expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({sourceId:account.id,requests:6,inputTokens:6000,cachedTokens:3600,cacheWriteTokens:1800,outputTokens:120,failed:0});
   const keys=(await service.app.inject({url:'/api/gateway-keys',headers:admin})).json().keys;
   expect(keys.find((k:any)=>k.id===key.id).usedTokens).toBe(6120);
   await service.proxy.setAccountEnabled(account.id,false);
   expect((await service.app.inject({method:'POST',url:'/v1/responses',headers:{...admin,authorization:`Bearer ${apiKey}`},payload:{model:'workbuddy/deepseek-v4.1-flash',input:'hello'}})).statusCode).toBe(503);
  }
  expect(calls.filter(r=>r==='china')).toHaveLength(6);expect(calls.filter(r=>r==='international')).toHaveLength(6);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});

it('retains a safe SDK failure reason in gateway responses and traces',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'sdk-diagnostic-routing-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'chosen.json',provider:'workbuddy',status:'active',models:['deepseek-v4.1-flash']}]));
 await writeFile(join(root,'cliproxy/auth/chosen.json'),JSON.stringify({type:'workbuddy',access_token:'PRIVATE_TOKEN'}));
 let toolIssue:SDKToolIssue|undefined;
 const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'sidecar',secrets:{get:async()=>'',set:async()=>{}},workbuddySDKFactory:proxy=>new WorkBuddySDKProvider(root,(id,model)=>proxy.workbuddyCredential(id,model),async input=>{
  input.onDiagnostic?.({event:'failure',elapsedMs:1,reason:toolIssue?'tool_protocol':'missing_result',toolIssue,origin:'result'});
  return {model:input.model,text:'',calls:[],failed:true};
 })});
 const admin={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 try{
  await service.proxy.start();const account=service.proxy.snapshot().accounts.find(a=>a.provider==='workbuddy')!;
  const created=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'diagnostic test',sourceId:account.id,models:['workbuddy/deepseek-v4.1-flash']}});
  expect(created.statusCode).toBe(200);
  for(const stream of [false,true]){
   const response=await service.app.inject({method:'POST',url:'/v1/messages',headers:{...admin,authorization:`Bearer ${created.json().apiKey}`},payload:{model:'workbuddy/deepseek-v4.1-flash',stream,messages:[{role:'user',content:'PRIVATE_PROMPT'}]}});
   expect(response.body).toContain('workbuddy_missing_result');expect(response.body).not.toMatch(/PRIVATE_TOKEN|PRIVATE_PROMPT/);
  }
  const records=(await service.app.inject({url:'/api/gateway/traces?days=0',headers:admin})).json().records;
  expect(records).toHaveLength(2);for(const row of records)expect(row.error.code).toBe('workbuddy_missing_result');
  expect(JSON.stringify(records)).not.toMatch(/PRIVATE_TOKEN|PRIVATE_PROMPT/);
  const issues=['unknown_name','unfinished_block','invalid_json','invalid_args','truncated_turn','parallel_limit','orphan_delta','input_limit'] as const;
  for(const issue of issues){toolIssue=issue;for(const path of ['messages','responses'])for(const stream of [false,true]){
   const response=await service.app.inject({method:'POST',url:`/v1/${path}`,headers:{...admin,authorization:`Bearer ${created.json().apiKey}`},payload:{model:'workbuddy/deepseek-v4.1-flash',stream,...(path==='messages'?{messages:[{role:'user',content:'PRIVATE_PROMPT'}]}:{input:'PRIVATE_PROMPT'})}});
   expect(response.body).toContain('workbuddy_tool_protocol');expect(response.body).toContain(issue);expect(response.body).not.toMatch(/PRIVATE_TOKEN|PRIVATE_PROMPT/);
  }}
  const toolRecords=(await service.app.inject({url:'/api/gateway/traces?days=0',headers:admin})).json().records.filter((row:any)=>row.error?.code==='workbuddy_tool_protocol');
  expect(toolRecords).toHaveLength(32);for(const issue of issues)expect(toolRecords.filter((row:any)=>row.error.message.includes(issue))).toHaveLength(4);expect(JSON.stringify(toolRecords)).not.toMatch(/PRIVATE_TOKEN|PRIVATE_PROMPT/);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});
