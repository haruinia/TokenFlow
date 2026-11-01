import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parse} from 'smol-toml';
import {zstdCompressSync} from 'node:zlib';
import {createDesktopService} from '../packages/core/src/service.js';
import type {CodexOfficialFetch} from '../packages/core/src/codex-coexist.js';

const clean:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of clean.splice(0).reverse())await fn();});
const catalog={models:[{slug:'official-test',display_name:'Official',visibility:'list',truncation_policy:{mode:'bytes',limit:10000}}]};
async function fixture(fetcher:CodexOfficialFetch){
 const root=await realpath(await mkdtemp(join(tmpdir(),'tf-official-images-')));clean.push(()=>rm(root,{recursive:true,force:true}));
 const config=join(root,'codex/config.toml');await mkdir(join(root,'codex'));await writeFile(config,'');
 await writeFile(join(root,'codex/auth.json'),JSON.stringify({tokens:{access_token:'fixture-login',account_id:'fixture-account'}}));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const secrets=new Map<string,string>();
 const service=await createDesktopService({root,token:'admin',localKey:'fixture-relay',proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),agentProcesses:async()=>[],
  agentPaths:{codex:config,claude:join(root,'claude.json'),pi:join(root,'pi.json'),qoder:join(root,'qoder.json'),deepseek:join(root,'deepseek.json'),workbuddy:join(root,'workbuddy.json'),'workbuddy-ai':join(root,'workbuddy-ai.json')},
  secrets:{persistent:true,get:async k=>secrets.get(k)??'',set:async(k,v)=>{secrets.set(k,v);},remove:async k=>{secrets.delete(k);}},
  codexOfficialFetch:(url,init)=>url.includes('/models?')?Promise.resolve(Response.json(catalog)):fetcher(url,init)});
 clean.push(()=>service.app.close());await service.proxy.start();
 const admin={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 const added=await service.app.inject({method:'POST',url:'/api/sources',headers:admin,payload:{name:'Fixture',baseURL:'http://127.0.0.1:1/v1',protocol:'responses',models:['gateway-model'],apiKey:'unused-api-key'}});
 expect(added.statusCode,added.body).toBe(200);const source=added.json(),model=`api-${source.id}/gateway-model`;
 const target=(await service.app.inject({url:'/api/a2a',headers:admin})).json().targets.find((t:{id:string})=>t.id==='codex');
 const applied=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers:admin,payload:{target:'codex',sourceId:source.id,model,selections:[{sourceId:source.id,model}],revision:target.revision,allowRunning:true,codexCoexist:true}});
 expect(applied.statusCode,applied.body).toBe(200);
 const providers=parse(await readFile(config,'utf8')).model_providers as Record<string,{http_headers:Record<string,string>}>;
 return {...service,root,admin,headers:{...admin,authorization:'Bearer client-chatgpt-token',...providers.token_flow.http_headers,'chatgpt-account-id':'client-account','x-codex-image-turn-id':'image-turn','x-codex-turn-metadata':'fixture-metadata',originator:'codex-fixture'}};
}

it.each(['generations','edits'])('forwards native image %s independently of Responses history and the chat model catalog',async operation=>{
 const calls:Array<{url:string;init:RequestInit}>=[];
 const result={created:1,data:[{b64_json:'fixture-image-bytes',generation_id:'fixture-generation'}],usage:{input_tokens:25,output_tokens:100,total_tokens:125}};
 const raw=JSON.stringify(result);
 const {app,headers,admin}=await fixture(async(url,init)=>{calls.push({url,init});return new Response(raw,{headers:{'content-type':'application/json','x-codex-imagegen-request-id':'image-request-id','x-request-id':'outer-request-id'}});});
 // Native edits use JSON image references, not multipart. Exercise a body above Fastify's default 1 MiB and zstd decoding.
 const payload={model:'gpt-image-2',prompt:'synthetic fixture',background:'transparent',quality:'auto',...(operation==='edits'?{images:[{image_url:'data:image/png;base64,'+'a'.repeat(1100000)},{file_id:'file-fixture'}]}:{})};
 const reply=await app.inject({method:'POST',url:`/codex/v1/images/${operation}`,headers:{...headers,'content-type':'application/json','content-encoding':'zstd',cookie:'browser-credential','x-api-key':'wrong-api-key'},payload:zstdCompressSync(Buffer.from(JSON.stringify(payload)))});
 expect(reply.statusCode,reply.body).toBe(200);expect(reply.body).toBe(raw);
 expect(reply.headers['x-codex-imagegen-request-id']).toBe('image-request-id');expect(reply.headers['x-request-id']).toBe('outer-request-id');
 expect(calls).toHaveLength(1);expect(calls[0].url).toBe(`https://chatgpt.com/backend-api/codex/images/${operation}`);
 expect(JSON.parse(String(calls[0].init.body))).toEqual(payload);expect(calls[0].init.redirect).toBe('error');
 const forwarded=new Headers(calls[0].init.headers);
 expect(forwarded.get('authorization')).toBe(headers.authorization);expect(forwarded.get('chatgpt-account-id')).toBe('client-account');
 expect(forwarded.get('x-codex-image-turn-id')).toBe('image-turn');expect(forwarded.get('x-codex-turn-metadata')).toBe('fixture-metadata');
 for(const name of ['cookie','x-api-key','x-tokenflow-client-key','content-encoding'])expect(forwarded.has(name)).toBe(false);
 const records=(await app.inject({url:'/api/gateway/usage/requests',headers:admin})).json().records;
 expect(records).toHaveLength(1);expect(records[0]).toMatchObject({sourceId:'codex-official',model:'gpt-image-2',inputTokens:25,outputTokens:100,status:200});
 expect(JSON.stringify(records)).not.toMatch(/fixture-image-bytes|synthetic fixture|client-chatgpt-token/);
});

it('requires coexist authorization and current ChatGPT authentication before forwarding images',async()=>{
 let calls=0;const {app,headers,admin}=await fixture(async()=>{calls++;return Response.json({data:[]});});
 for(const extra of [{'x-tokenflow-client-key':'bad'},{authorization:''}]){
  const reply=await app.inject({method:'POST',url:'/codex/v1/images/generations',headers:{...headers,...extra},payload:{model:'gpt-image-2',prompt:'fixture'}});
  expect(reply.statusCode,reply.body).toBe(401);
 }
 expect((await app.inject({method:'POST',url:'/v1/images/generations',headers:admin,payload:{model:'gpt-image-2'}})).statusCode).toBe(404);
 expect(calls).toBe(0);
});

it('preserves image request IDs and upstream error status without leaking private response text',async()=>{
 const {app,headers}=await fixture(async()=>Response.json({error:{message:'PRIVATE_PROMPT_AND_CREDENTIAL'}},{status:429,headers:{'x-codex-imagegen-request-id':'failed-image-id','retry-after':'30'}}));
 const reply=await app.inject({method:'POST',url:'/codex/v1/images/edits',headers,payload:{model:'gpt-image-2',prompt:'fixture',images:[]}});
 expect(reply.statusCode,reply.body).toBe(429);expect(reply.headers['retry-after']).toBe('30');expect(reply.headers['x-codex-imagegen-request-id']).toBe('failed-image-id');expect(reply.body).not.toContain('PRIVATE_');
});

it('records image transport failures without exposing credentials',async()=>{
 const {app,headers,admin}=await fixture(async()=>{throw new Error('PRIVATE_CREDENTIAL');});
 const reply=await app.inject({method:'POST',url:'/codex/v1/images/generations',headers,payload:{model:'gpt-image-2',prompt:'fixture'}});
 expect(reply.statusCode,reply.body).toBe(502);expect(reply.body).not.toContain('PRIVATE_');
 const records=(await app.inject({url:'/api/gateway/usage/requests',headers:admin})).json().records;
 expect(records).toHaveLength(1);expect(records[0]).toMatchObject({status:502,outcome:'failed',inputTokens:null,outputTokens:null});
});

it('cancels upstream image generation when Codex disconnects and records it only once',async()=>{
 let started!:()=>void,cancelled!:()=>void;const start=new Promise<void>(r=>{started=r;}),cancel=new Promise<void>(r=>{cancelled=r;});
 const {app,headers,admin}=await fixture(async(_url,init)=>new Promise<Response>((_resolve,reject)=>{
  init.signal!.addEventListener('abort',()=>{cancelled();reject(new Error('aborted'));},{once:true});started();
 }));
 const origin=await app.listen({port:0,host:'127.0.0.1'}),abort=new AbortController();
 const pending=fetch(origin+'/codex/v1/images/generations',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model:'gpt-image-2',prompt:'fixture'}),signal:abort.signal}).catch(()=>undefined);
 await start;abort.abort();await pending;await cancel;
 await expect.poll(async()=>(await app.inject({url:'/api/gateway/usage/requests',headers:admin})).json().records).toMatchObject([{status:499,outcome:'cancelled',inputTokens:null,outputTokens:null}]);
});

it('closes a broken upstream image body instead of reporting a completed generation',async()=>{
 let interrupt!:()=>void;const interrupted=new Promise<void>(r=>{interrupt=r;});
 const {app,headers,admin}=await fixture(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"data":['));},async pull(controller){await interrupted;controller.error(new Error('PRIVATE_UPSTREAM_ERROR'));}}),{headers:{'content-type':'application/json'}}));
 const origin=await app.listen({port:0,host:'127.0.0.1'});
 const response=await fetch(origin+'/codex/v1/images/generations',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model:'gpt-image-2',prompt:'fixture'})});
 expect(response.status).toBe(200);interrupt();await expect(response.text()).rejects.toThrow();
 await expect.poll(async()=>(await app.inject({url:'/api/gateway/usage/requests',headers:admin})).json().records).toMatchObject([{status:502,outcome:'truncated',inputTokens:null,outputTokens:null}]);
});
