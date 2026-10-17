import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,rm,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {claudeDesktopViaGateway,codexRouteEvidence,gatewayResponseEvidence,routeChannel} from '../packages/core/src/local-usage-evidence.js';
import {LocalUsageParser} from '../packages/core/src/local-usage.js';
const time='2026-10-13T08:00:00Z',ms=Date.parse(time);
describe('historical usage evidence',()=>{
 it('requires the same thread and nearby unambiguous inference route',()=>{
  const routes=[{threadId:'one',time:ms-20_000,channel:'official' as const}];
  expect(routeChannel(routes,'one',time)).toBe('official');expect(routeChannel(routes,'other',time)).toBe('unknown');expect(routeChannel(routes,'one',new Date(ms+121_000).toISOString())).toBe('unknown');
  expect(routeChannel([...routes,{threadId:'one',time:ms,channel:'api'}],'one',time)).toBe('unknown');
 });
 it('reads only inference endpoint evidence and recognizes the known local gateway without changing the database',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tf-route-'));try{
   const path=join(root,'logs_2.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,thread_id TEXT,target TEXT,feedback_log_body TEXT)');
   const add=db.prepare('INSERT INTO logs(ts,thread_id,target,feedback_log_body) VALUES(?,?,?,?)');
   add.run(ms/1000,'official','codex_http_client::client','POST https://chatgpt.com/backend-api/codex/responses');
   add.run(ms/1000,'models','codex_http_client::client','GET https://chatgpt.com/backend-api/codex/models');
   add.run(ms/1000,'api','codex_http_client::client','POST https://api.openai.com/v1/responses');
   add.run(ms/1000,'proxy','codex_http_client::client','POST http://127.0.0.1:9527/v1/responses');
   add.run(ms/1000,'other-proxy','codex_http_client::client','POST http://127.0.0.1:9999/v1/responses');
   add.run(ms/1000,'mcp','codex_mcp::rmcp_client','https://chatgpt.com/backend-api/codex/responses');db.close();const before=await stat(path);
   const routes=await codexRouteEvidence(root,[9527]);expect(routes).toHaveLength(4);expect(routeChannel(routes,'official',time)).toBe('official');expect(routeChannel(routes,'api',time)).toBe('api');expect(routeChannel(routes,'proxy',time)).toBe('gateway');expect(routeChannel(routes,'other-proxy',time)).toBe('unknown');expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
   const parser=new LocalUsageParser('codex','proxy',{channelFor:(id,stamp)=>routeChannel(routes,id,stamp)});parser.accept({type:'session_meta',payload:{id:'proxy',model_provider:'openai'}});parser.accept({type:'token_usage_record',timestamp:time,payload:{response_id:'plain-response',usage:{input_tokens:10,output_tokens:5}}});expect(parser.rows()).toEqual([]);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('treats Claude Desktop third-party logs as gateway usage only while its applied profile targets this gateway',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tf-desktop-route-'));try{
   const id='11111111-2222-3333-4444-555555555555',library=join(root,'configLibrary');await mkdir(library,{recursive:true});
   const write=async(mode:string,url:string,extra:object={})=>{await writeFile(join(root,'claude_desktop_config.json'),JSON.stringify({deploymentMode:mode}));await writeFile(join(library,'_meta.json'),JSON.stringify({appliedId:id,...extra}));await writeFile(join(library,`${id}.json`),JSON.stringify({inferenceProvider:'gateway',inferenceGatewayBaseUrl:url}));};
   await write('3p','http://127.0.0.1:9527');expect(await claudeDesktopViaGateway(root,[9527])).toBe(true);expect(await claudeDesktopViaGateway(root,[8317])).toBe(false);
   await write('1p','http://127.0.0.1:9527');expect(await claudeDesktopViaGateway(root,[9527])).toBe(false);
   await write('3p','https://gateway.example.test');expect(await claudeDesktopViaGateway(root,[9527])).toBe(false);
   await write('3p','http://127.0.0.1:9527',{hybridPointer:{bootstrapUrl:'https://example.test'}});expect(await claudeDesktopViaGateway(root,[9527])).toBe(false);
   expect(await claudeDesktopViaGateway(join(root,'missing'),[9527])).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('matches the salted response identity in old gateway traces, independently of model aliases',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tf-response-'));try{
   const salt='a'.repeat(64),keyId='gateway-key',responseId='msg-test';await writeFile(join(root,'gateway-traces.json'),JSON.stringify({salt,records:[{keyId,responseRef:createHmac('sha256',salt).update(`${keyId}\n${responseId}`).digest('hex')}]}));
   const evidence=await gatewayResponseEvidence(root);expect(evidence.matches(responseId)).toBe(true);expect(evidence.matches('msg-other')).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
