import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { detectProtocol, sourceNameFromURL, validateQuickSource } from '../packages/core/src/api-protocol.js';

const servers:Server[]=[];
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(servers.splice(0).map(s=>new Promise(r=>s.close(()=>r(null)))));});
type Handler=(path:string,headers:Record<string,unknown>,body:Record<string,unknown>)=>{status:number;json:unknown};
async function upstream(handler:Handler){
 const calls:string[]=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  calls.push(req.url!);const result=handler(req.url!,req.headers,raw?JSON.parse(raw):{});
  res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.json));
 });
 servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 return {origin:`http://127.0.0.1:${(server.address() as {port:number}).port}`,calls};
}
const notFound={status:404,json:{error:{message:'not found'}}};

describe('API source protocol detection',()=>{
 it('validates the three fields locally before any request',()=>{
  expect(()=>validateQuickSource({baseURL:'nope',apiKey:'k',model:'m'})).toThrow('API 地址');
  expect(()=>validateQuickSource({baseURL:'http://example.com/v1',apiKey:'k',model:'m'})).toThrow('HTTPS');
  expect(validateQuickSource({baseURL:'http://10.2.6.48:9555/v1',apiKey:'k',model:'m'})).toEqual({baseURL:'http://10.2.6.48:9555/v1',models:['m']});
  expect(()=>validateQuickSource({baseURL:'https://example.com/v1',apiKey:'bad key',model:'m'})).toThrow('API Key');
  expect(()=>validateQuickSource({baseURL:'https://example.com/v1',apiKey:'k',model:' , '})).toThrow('模型名称');
  expect(validateQuickSource({baseURL:'https://example.com/v1/chat/completions/',apiKey:'k',model:'a, b\na'})).toEqual({baseURL:'https://example.com/v1',models:['a','b']});
 });
 it('finds Chat Completions on a chat-only relay and does not need a protocol from the user',async()=>{
  const {origin,calls}=await upstream((path,headers,body)=>path==='/v1/chat/completions'&&headers.authorization==='Bearer sk-test'&&body.model==='m'
   ?{status:200,json:{choices:[{message:{content:'OK'}}]}}:notFound);
  await expect(detectProtocol({baseURL:`${origin}/v1`,apiKey:'sk-test',model:'m'})).resolves.toEqual({protocol:'chat',baseURL:`${origin}/v1`});
  expect(calls).toEqual(['/v1/responses','/v1/chat/completions']);
 });
 it('detects Anthropic Messages using x-api-key and tries it first for Claude models',async()=>{
  const {origin,calls}=await upstream((path,headers)=>path==='/v1/messages'&&headers['x-api-key']==='sk-ant'
   ?{status:200,json:{type:'message',content:[{type:'text',text:'OK'}]}}:notFound);
  await expect(detectProtocol({baseURL:`${origin}/v1`,apiKey:'sk-ant',model:'claude-sonnet'})).resolves.toMatchObject({protocol:'messages'});
  expect(calls).toEqual(['/v1/messages']);
 });
 it('retries Chat with max_completion_tokens for models that reject max_tokens',async()=>{
  const {origin}=await upstream((path,_headers,body)=>path!=='/v1/chat/completions'?notFound:'max_tokens' in body
   ?{status:400,json:{error:{message:"Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'."}}}:{status:200,json:{choices:[]}});
  await expect(detectProtocol({baseURL:`${origin}/v1`,apiKey:'k',model:'o-series'})).resolves.toMatchObject({protocol:'chat'});
 });
 it('adds /v1 to a bare host',async()=>{
  const {origin}=await upstream(path=>path==='/v1/responses'?{status:200,json:{object:'response',output:[]}}:notFound);
  await expect(detectProtocol({baseURL:origin,apiKey:'k',model:'m'})).resolves.toEqual({protocol:'responses',baseURL:`${origin}/v1`});
 });
 it('reports a bad key without echoing it, and a wrong URL separately',async()=>{
  const {origin}=await upstream(()=>({status:401,json:{error:{message:'Invalid key sk-secret'}}}));
  const error=await detectProtocol({baseURL:`${origin}/v1`,apiKey:'sk-secret',model:'m'}).catch(e=>e);
  expect(error.code).toBe('api_source_auth');expect(error.message).toContain('API Key');expect(error.message).not.toContain('sk-secret');
  const missing=await upstream(()=>notFound);
  await expect(detectProtocol({baseURL:`${missing.origin}/v1`,apiKey:'k',model:'m'})).rejects.toMatchObject({code:'api_source_not_found'});
 });
 it('reports an unreachable host after exhausting protocol candidates',async()=>{
  const {origin}=await upstream(()=>notFound);const dead=origin.replace(/:\d+$/,':1');
  await expect(detectProtocol({baseURL:`${dead}/v1`,apiKey:'k',model:'m'})).rejects.toMatchObject({code:'api_source_unreachable'});
 });
 it('stops instead of changing protocols after a network failure',async()=>{
  const calls:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
   calls.push(url);
   if(url.endsWith('/responses'))throw new TypeError('socket closed');
   return new Response(JSON.stringify(url.endsWith('/messages')?{type:'message',content:[]}:{error:'missing'}),{status:url.endsWith('/messages')?200:404});
  }));
  await expect(detectProtocol({baseURL:'https://relay.test/custom',apiKey:'k',model:'m'})).rejects.toMatchObject({code:'api_source_unreachable'});
  expect(calls).toEqual(['https://relay.test/custom/responses']);
 });
 it('keeps a corporate prefix when probing the versioned Messages endpoint',async()=>{
  const {origin,calls}=await upstream(path=>path==='/company/anthropic/v1/messages'?{status:200,json:{type:'message',content:[]}}:notFound);
  await expect(detectProtocol({baseURL:`${origin}/company/anthropic`,apiKey:'k',model:'claude'})).resolves.toEqual({protocol:'messages',baseURL:`${origin}/company/anthropic/v1`});
  expect(calls.slice(0,3)).toEqual(['/company/anthropic/messages','/company/anthropic/chat/completions','/company/anthropic/responses']);
 });
 it('prioritizes an explicit Chat endpoint even for a Claude model name',async()=>{
  const {origin,calls}=await upstream(path=>path==='/company/v1/chat/completions'?{status:200,json:{choices:[]}}:notFound);
  await expect(detectProtocol({baseURL:`${origin}/company/v1/chat/completions/`,apiKey:'k',model:'claude'})).resolves.toEqual({protocol:'chat',baseURL:`${origin}/company/v1`});
  expect(calls).toEqual(['/company/v1/chat/completions']);
 });
 it('reports all three attempted endpoints only after all fail',async()=>{
  const {origin,calls}=await upstream(()=>notFound);
  const error=await detectProtocol({baseURL:`${origin}/v1`,apiKey:'k',model:'m'}).catch(e=>e);
  expect(calls).toEqual(['/v1/responses','/v1/chat/completions','/v1/messages','/responses','/chat/completions','/messages']);
  for(const path of calls)expect(error.message).toContain(`${origin}${path}：HTTP 404`);
 });
 it('does not send more requests after cancellation',async()=>{
  const controller=new AbortController();
  const fetcher=vi.fn(async()=>{controller.abort();throw new TypeError('aborted');});vi.stubGlobal('fetch',fetcher);
  await expect(detectProtocol({baseURL:'https://relay.test/v1',apiKey:'k',model:'m'},controller.signal)).rejects.toMatchObject({code:'api_source_cancelled'});
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('does not cache a protocol merely because an endpoint returned a rate limit',async()=>{
  const {origin}=await upstream(path=>path==='/v1/chat/completions'?{status:200,json:{choices:[]}}:{status:429,json:{error:{message:'rate limited'}}});
  await expect(detectProtocol({baseURL:`${origin}/v1/responses`,apiKey:'k',model:'m'})).rejects.toMatchObject({code:'api_source_rate_limited'});
  const limited=await upstream(()=>({status:429,json:{error:{message:'rate limited'}}}));
  await expect(detectProtocol({baseURL:`${limited.origin}/v1`,apiKey:'k',model:'m'})).rejects.toMatchObject({code:'api_source_rate_limited'});
 });
 it('prefers the supplied root and can remove v1 without leaving a tenant prefix',async()=>{
  const {origin,calls}=await upstream(path=>path==='/tenant/responses'?{status:200,json:{object:'response',output:[]}}:notFound);
  await expect(detectProtocol({baseURL:`${origin}/tenant/v1`,apiKey:'k',model:'m'})).resolves.toEqual({protocol:'responses',baseURL:`${origin}/tenant`});
  expect(calls.every(path=>path.startsWith('/tenant/'))).toBe(true);
  calls.length=0;
  await detectProtocol({baseURL:`${origin}/tenant`,apiKey:'k',model:'m'});expect(calls).toEqual(['/tenant/responses']);
 });
 it('tries anthropic suffixes only when hinted and retains the tenant path',async()=>{
  const {origin,calls}=await upstream(path=>path==='/tenant/anthropic/v1/messages'?{status:200,json:{type:'message',content:[]}}:notFound);
  await expect(detectProtocol({baseURL:`${origin}/tenant/v1`,apiKey:'k',model:'claude'})).resolves.toEqual({protocol:'messages',baseURL:`${origin}/tenant/anthropic/v1`});
  expect(calls.every(path=>path.startsWith('/tenant/'))).toBe(true);
 });
 it.each([401,403,402,429,503])('stops on actionable HTTP %s without probing other endpoints',async status=>{
  const {origin,calls}=await upstream(()=>({status,json:{error:{message:'failed'}}}));
  await expect(detectProtocol({baseURL:origin,apiKey:'k',model:'m'})).rejects.toBeDefined();expect(calls).toEqual(['/responses']);
 });
 it('names a source after its host',()=>{
  expect(sourceNameFromURL('https://api.openai.com/v1')).toBe('openai.com');
  expect(sourceNameFromURL('http://127.0.0.1:8080/v1')).toBe('本机 8080');
 });
 it('observes actual probe usage without retaining the response text, and preserves unknown usage',async()=>{
  const {origin}=await upstream((_path,_headers,body)=>({status:200,json:{choices:[{message:{content:'private answer'}}],...(body.model==='measured'?{usage:{prompt_tokens:20,prompt_cache_hit_tokens:12,completion_tokens:3}}:{})}}));
  const measured:any[]=[],unknown:any[]=[];
  await detectProtocol({baseURL:`${origin}/v1/chat/completions`,apiKey:'private-key',model:'measured'},undefined,usage=>measured.push(usage));
  await detectProtocol({baseURL:`${origin}/v1/chat/completions`,apiKey:'private-key',model:'unknown'},undefined,usage=>unknown.push(usage));
  expect(measured).toHaveLength(1);expect(measured[0]).toMatchObject({inputTokens:20,cachedTokens:12,outputTokens:3,protocol:'chat',model:'measured',status:200});
  expect(unknown).toHaveLength(1);expect(unknown[0]).toMatchObject({inputTokens:null,outputTokens:null,cachedTokens:null});
  expect(JSON.stringify(measured)).not.toMatch(/private answer|private-key/);
 });
});
