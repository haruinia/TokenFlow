// Isolated installed-client protocol check. The upstream is a local fixture, never a supplier API.
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {ClaudeApiDirect} from '../../../packages/core/src/claude-api-direct.js';
import {directConfigRevision} from '../../../packages/core/src/api-direct-config.js';
const root=await realpath(await mkdtemp(join(tmpdir(),'tf-claude-native-'))),configDir=join(root,'config');await mkdir(configDir);const config=join(configDir,'settings.json');
const calls:{path:string;model:string;keyMatches:boolean}[]=[];
const server=createServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}'),path=new URL(req.url!,'http://localhost').pathname;
 calls.push({path,model:body.model,keyMatches:req.headers['x-api-key']==='fixture-direct-key'});
 if(path.endsWith('/count_tokens')){res.setHeader('content-type','application/json');res.end('{"input_tokens":10}');return;}
 if(path!=='/tenant/anthropic/v1/messages'){res.writeHead(404);res.end('{}');return;}
 const events=[{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'DIRECT_OK'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}},{type:'message_stop'}];
 res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
});await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
try{
 const manager=new ClaudeApiDirect(root,config,async()=>[]),baseURL=`http://127.0.0.1:${(server.address() as {port:number}).port}/tenant/anthropic/v1`;
 await manager.apply({sourceId:'a'.repeat(24),model:'fixture-direct-model',baseURL,apiKey:'fixture-direct-key',name:'Fixture'},directConfigRevision(null));
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^ANTHROPIC_|^CLAUDE_|^CLAUDECODE$/.test(key)));
 const run=await new Promise<{code:number|null;output:string}>(done=>{
  const child=spawn(process.argv[2]??'/Users/why/.npm-global/bin/claude',['--bare','--settings',config,'-p','Reply DIRECT_OK','--output-format','json','--max-turns','1','--no-session-persistence','--tools',''],{cwd:root,env:{...env,CLAUDE_CONFIG_DIR:configDir,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const timeout=setTimeout(()=>child.kill('SIGKILL'),35000);child.on('close',code=>{clearTimeout(timeout);done({code,output})});
 });
 const result={passed:run.code===0&&run.output.includes('DIRECT_OK')&&calls.some(c=>c.path==='/tenant/anthropic/v1/messages'&&c.model==='fixture-direct-model'&&c.keyMatches),exitCode:run.code,calls,tokenflowRelay:false,providerRequests:0};
 await writeFile(resolve('doc/testing/results/claude-api-direct-native-2026-10-29.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 if(!result.passed){console.error(run.output.slice(-1400));process.exitCode=1;}
 await manager.restore((await manager.status())!.revision);
}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
