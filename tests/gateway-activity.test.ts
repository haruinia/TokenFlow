import { it,expect } from 'vitest';
import { observeUsage } from '../packages/core/src/gateway-activity.js';
import { agentConfig } from '../apps/console/src/agent-config.js';
async function inspect(payload:string,sse:boolean|'auto',chunkSize=7){
 let usage:unknown;const output:Buffer[]=[];const observer=observeUsage(sse,u=>{usage=u;});observer.on('data',chunk=>output.push(chunk));
 const finished=new Promise<void>((r,j)=>{observer.once('end',r);observer.once('error',j);});
 const bytes=Buffer.from(payload);for(let i=0;i<bytes.length;i+=chunkSize)observer.write(bytes.subarray(i,i+chunkSize));observer.end();await finished;
 expect(Buffer.concat(output).toString()).toBe(payload);return usage;
}
it('detects official response framing independently of MIME, preserving split bytes and terminal checks',async()=>{
 const response={id:'resp-meter',object:'response',usage:{input_tokens:100,input_tokens_details:{cached_tokens:80},output_tokens:7}};
 for(const prefix of ['',': keepalive\n\n','event: response.completed\n','\uFEFF']){
  expect(await inspect(prefix+'data: '+JSON.stringify({type:'response.completed',response})+'\n\n','auto',1)).toMatchObject({inputTokens:100,cachedTokens:80,outputTokens:7,failed:false});
 }
 expect(await inspect('\n '+JSON.stringify(response),'auto',1)).toMatchObject({inputTokens:100,outputTokens:7,failed:false});
 expect(await inspect('data: '+JSON.stringify({type:'response.created',response})+'\n\n','auto',1)).toMatchObject({failed:true});
});
it('settles large Responses completion frames with echoed tools without changing the stream',async()=>{
 const response={status:'completed',tools:[{type:'function',name:'read',description:'工具'.repeat(300_000)}],usage:{input_tokens:140_000,input_tokens_details:{cached_tokens:120_000},output_tokens:42}};
 const frame=`data: ${JSON.stringify({type:'response.completed',response})}\n\n`;
 expect(Buffer.byteLength(frame)).toBeGreaterThan(524288);
 expect(await inspect(frame,true,4093)).toMatchObject({failed:false,inputTokens:140_000,cachedTokens:120_000,outputTokens:42});
 expect(await inspect(JSON.stringify(response),false,4093)).toMatchObject({failed:false,inputTokens:140_000,outputTokens:42});
 expect(await inspect(frame.trimEnd(),true,4093)).toMatchObject({failed:false,outputTokens:42});
});
it('still detects large failure frames and truncated completions',async()=>{
 const padding='x'.repeat(600_000);
 expect(await inspect(`data: ${JSON.stringify({type:'response.failed',response:{error:{message:padding}}})}\n\ndata: [DONE]\n\n`,true,4093)).toMatchObject({failed:true});
 expect(await inspect(`data: ${JSON.stringify({type:'response.completed',response:{tools:[padding]}}).slice(0,-2)}`,true,4093)).toMatchObject({failed:true,inputTokens:null});
});
it('bounds observation of oversized lines and resumes at the next event',async()=>{
 const oversized=`data: ${JSON.stringify({ignored:'x'.repeat(16*1024*1024)})}\n\n`;
 expect(await inspect(oversized+'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n',true,65537)).toMatchObject({failed:false,inputTokens:3,outputTokens:2});
 expect(await inspect(oversized,true,65537)).toMatchObject({failed:true,inputTokens:null,outputTokens:null});
});
it('preserves byte-split UTF-8 streaming, accumulates Messages usage without double counting and handles SSE errors',async()=>{
 expect(await inspect('data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\ndata: {"type":"content_block_delta","delta":{"text":"你好"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\ndata: {"type":"message_stop"}\n\n',true)).toEqual({inputTokens:11,cachedTokens:null,outputTokens:9,failed:false});
 expect(await inspect('data: {"type":"error","error":{"message":"private"}}\n\n',true)).toMatchObject({failed:true,inputTokens:null,outputTokens:null});
});
it('keeps unreported token usage unknown and handles regular JSON',async()=>{
 expect(await inspect('{"output":["private"]}',false)).toMatchObject({inputTokens:null,outputTokens:null});
 expect(await inspect('{"usage":{"prompt_tokens":4,"completion_tokens":2}}',false)).toMatchObject({inputTokens:4,outputTokens:2});
});
it('generates scoped custom-provider configs with protocol-correct URLs and safe quoting',()=>{
 const codex=agentConfig('codex','http://127.0.0.1:9527','codex/gpt-5.6-sol');
 expect(codex).toContain('wire_api="responses"');expect(codex).toContain('env_key="TOKEN_FLOW_KEY"');expect(codex).toContain('supports_websockets=false');
 const claude=agentConfig('claude','http://127.0.0.1:9527','codex/gpt-5.6-sol');
 expect(claude).toContain("ANTHROPIC_BASE_URL='http://127.0.0.1:9527'");expect(claude).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL');
 expect(agentConfig('claude','http://127.0.0.1:9527',"codex/a'b",true)).toContain("codex/a''b");
 expect(()=>agentConfig('codex','https://example.com','model')).toThrow();
 expect(JSON.parse(agentConfig('openai','http://127.0.0.1:9527','claude/shared')).baseURL).toBe('http://127.0.0.1:9527/v1');
});

it('counts Anthropic cached input alongside normal input without counting OpenAI cached details twice',async()=>{
 expect(await inspect('{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":3}}',false)).toMatchObject({inputTokens:35,outputTokens:3});
 expect(await inspect('{"usage":{"input_tokens":30,"input_tokens_details":{"cached_tokens":20},"output_tokens":3}}',false)).toMatchObject({inputTokens:30,outputTokens:3});
});

it('keeps Chat Completions prompt totals inclusive when a provider also returns Anthropic cache aliases',async()=>{
 const usage={prompt_tokens:100,completion_tokens:10,total_tokens:110,prompt_tokens_details:{cached_tokens:60},cache_read_input_tokens:60,cache_creation_input_tokens:5};
 expect(await inspect(JSON.stringify({usage}),false)).toMatchObject({inputTokens:100,cachedTokens:60,cacheWriteTokens:5,outputTokens:10});
 expect(await inspect(JSON.stringify({usage:{...usage,input_tokens:null}}),false)).toMatchObject({inputTokens:100,outputTokens:10});
 expect(await inspect(`data: ${JSON.stringify({choices:[],usage})}\n\ndata: [DONE]\n\n`,true)).toMatchObject({inputTokens:100,cachedTokens:60,cacheWriteTokens:5,outputTokens:10,failed:false});
});

it('does not treat a clean EOF with initial Messages usage as final settlement',async()=>{
 const broken='data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\ndata: {"type":"content_block_delta","delta":{"text":"generated but unmetered"}}\n\n';
 expect(await inspect(broken,true)).toEqual({inputTokens:7,cachedTokens:null,outputTokens:0,failed:true});
 expect(await inspect(broken+'data: {"type":"message_stop"}\n\n',true)).toMatchObject({failed:true});
});

it('reports prompt-cache reads from Anthropic, Responses, Chat Completions and DeepSeek usage shapes',async()=>{
 expect(await inspect('{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":3}}',false)).toMatchObject({inputTokens:35,cachedTokens:20});
 expect(await inspect('{"usage":{"input_tokens":30,"input_tokens_details":{"cached_tokens":20},"output_tokens":3}}',false)).toMatchObject({inputTokens:30,cachedTokens:20});
 expect(await inspect('{"usage":{"prompt_tokens":30,"prompt_tokens_details":{"cached_tokens":8},"completion_tokens":3}}',false)).toMatchObject({inputTokens:30,cachedTokens:8});
 expect(await inspect('{"usage":{"prompt_tokens":30,"prompt_cache_hit_tokens":12,"prompt_cache_miss_tokens":18,"completion_tokens":3}}',false)).toMatchObject({inputTokens:30,cachedTokens:12});
 expect(await inspect('data: {"type":"response.completed","response":{"usage":{"input_tokens":9,"input_tokens_details":{"cached_tokens":4},"output_tokens":2}}}\n\n',true)).toMatchObject({inputTokens:9,cachedTokens:4,outputTokens:2,failed:false});
 expect(await inspect('{"usage":{"prompt_tokens":4,"completion_tokens":2}}',false)).toMatchObject({cachedTokens:null});
});

it('retains final usage once, preserves Anthropic cache fields through partial updates, and observes tool identities separately',async()=>{
 const payload='data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":0}}}\n\ndata: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":8,"output_tokens_details":{"reasoning_tokens":3}}}\n\ndata: {"type":"message_stop"}\n\n';
 expect(await inspect(payload,true)).toMatchObject({inputTokens:35,cachedTokens:20,cacheWriteTokens:5,outputTokens:8,reasoningTokens:3,failed:false});
});
