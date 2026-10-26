import type {FastifyInstance} from 'fastify';
import {Transform,pipeline} from 'node:stream';
import {createZstdDecompress} from 'node:zlib';

/** Codex can keep using compressed HTTP uploads after switching providers.
 * Decode before JSON parsing; Content-Length describes encoded bytes. */
export function gatewayDecoding(app:FastifyInstance){
 app.addHook('preParsing',async(request,_reply,payload)=>{
  if(!/^\/(?:codex\/)?v1\//.test(request.routeOptions.url??'')||request.headers['content-encoding']?.trim().toLowerCase()!=='zstd')return payload;
  const decoded=createZstdDecompress() as ReturnType<typeof createZstdDecompress>&{receivedEncodedLength:number};
  decoded.receivedEncodedLength=0;
  const encoded=new Transform({transform(chunk,_encoding,next){decoded.receivedEncodedLength+=chunk.length;next(null,chunk);}});
  decoded.prependListener('error',(error:Error&{statusCode?:number})=>{error.statusCode=400;});
  pipeline(payload,encoded,decoded,()=>{});
  return decoded;
 });
}
