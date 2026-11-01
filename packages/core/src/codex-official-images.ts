import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {officialCodexHeaders,officialCodexURL,type CodexOfficialFetch} from './codex-coexist.js';
import {observeUsage,type GatewayCall} from './gateway-activity.js';
import {providerUsage} from './gateway-observation.js';
import {usageHash,usageRequestMetadata} from './usage-request-metadata.js';
import {upstreamRequest} from './upstream-request.js';
import {readUpstreamError,upstreamError} from './upstream-errors.js';
import {RunnerCoreError} from './errors.js';

type Options={
 fetcher:CodexOfficialFetch;
 authorize:(headers:FastifyRequest['headers'])=>string|undefined;
 record:(call:Omit<GatewayCall,'id'>)=>void;
};

/** Native image_gen uses separate JSON Images endpoints, including JSON edit
 * references. Keep them outside Responses history/compaction and API adapters.
 * Authorization still belongs to the current Codex login, never an API source. */
export function registerCodexOfficialImages(app:FastifyInstance,options:Options){
 for(const operation of ['generations','edits'] as const){
  const path=`images/${operation}` as const;
  app.post(`/codex/v1/${path}`,{bodyLimit:Number.MAX_SAFE_INTEGER},async(req,reply)=>{
   const keyId=options.authorize(req.headers);
   if(!keyId)return reply.code(401).send({error:{message:'Codex coexist connection is unavailable',type:'authentication_error'}});
   if(typeof req.headers.authorization!=='string'||!/^Bearer [^\r\n]+$/.test(req.headers.authorization))return reply.code(401).send({error:{message:'图片生成需要 Codex 当前的 ChatGPT 登录。',type:'authentication_error'}});
   const body=z.object({model:z.string().min(1).max(300)}).passthrough().parse(req.body);
   const headers=officialCodexHeaders(req.headers);
   if(typeof req.headers['x-codex-image-turn-id']==='string')headers['x-codex-image-turn-id']=req.headers['x-codex-image-turn-id'];
   const started=Date.now(),abort=upstreamRequest(),eventId=randomUUID();
   let recorded=false,complete=false,requestId:string|undefined;
   const record=(status:number,usage:ReturnType<typeof providerUsage>,error?:{code:string;message:string})=>{
    if(recorded)return;recorded=true;
    options.record({eventId,...usageRequestMetadata(req.headers,path,undefined,true),...(requestId?{responseHash:usageHash('image',requestId)}:{}),
     keyId,agent:'Codex 官方账号',target:'codex',sourceId:'codex-official',model:body.model,protocol:path,
     startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,status,...usage,
     outcome:status===499?'cancelled':error?.code==='incomplete_stream'?'truncated':status>=400?'failed':'completed',...(error?{error}:{})});
   };
   const cancel=()=>{if(!reply.raw.writableFinished)abort.abort();};
   reply.raw.once('close',cancel);
   try{
    // Fixed destination and no redirects: neither prompts nor a body URL can reroute ChatGPT credentials.
    const response=await options.fetcher(officialCodexURL(path),{method:'POST',headers,body:JSON.stringify(body),signal:abort.signal,redirect:'error'});
    requestId=response.headers.get('x-codex-imagegen-request-id')??response.headers.get('x-request-id')??undefined;
    for(const name of ['x-codex-imagegen-request-id','x-request-id','retry-after']){const value=response.headers.get(name);if(value)reply.header(name,value);}
    reply.header('cache-control','no-store');
    if(!response.ok){const error=upstreamError(response.status,await readUpstreamError(response));record(response.status,providerUsage(undefined),{code:error.code??error.type,message:error.message});return reply.code(response.status).send({error});}
    if(!response.body){const error={code:'incomplete_stream',message:'官方图片接口未返回完整响应。'};record(502,providerUsage(undefined),error);return reply.code(502).send({error});}
    reply.code(response.status).header('content-type',response.headers.get('content-type')??'application/json');
    const source=Readable.fromWeb(response.body as never);
    // Bounded, prompt-free usage observation never rewrites or truncates image bytes.
    // If a response exceeds the observer's budget, tokens remain unmeasured, not zero.
    const observer=observeUsage(false,usage=>{
     const status=complete?response.status:abort.signal.aborted?499:502;
     const error=complete?undefined:{code:status===499?'request_cancelled':'incomplete_stream',message:status===499?'客户端已取消图片请求。':'官方图片响应未完整结束。'};
     record(status,{...usage,cacheWriteTokens:usage.cacheWriteTokens??null,reasoningTokens:usage.reasoningTokens??null},error);
    });
    source.once('end',()=>{complete=true;});source.once('error',()=>observer.destroy(new RunnerCoreError('官方图片响应未完整结束。',{statusCode:502,code:'incomplete_stream'})));
    observer.once('close',()=>source.destroy());reply.raw.once('close',()=>{source.destroy();observer.destroy();});
    source.pipe(observer);return reply.send(observer);
   }catch{
    const status=abort.signal.aborted?499:502,error={code:status===499?'request_cancelled':'upstream_connection_error',message:status===499?'客户端已取消图片请求。':'无法连接 Codex 官方图片服务。'};
    record(status,providerUsage(undefined),error);return reply.code(status).send({error:{...error,type:'provider_error'}});
   }
  });
 }
}
