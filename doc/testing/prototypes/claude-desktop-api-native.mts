// Installed Desktop's embedded engine + synthetic Messages upstream.
// This checks transport/auth/model IDs; it does not automate the real Desktop UI.
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';import {spawn} from 'node:child_process';
import {ClaudeDesktopConnections} from '../../../packages/core/src/claude-desktop.js';
const binary=process.argv[2];if(!binary)throw Error('Pass the installed Desktop embedded Claude binary');
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-desktop-native-')),configDir=join(root,'cli');await mkdir(configDir);
const calls:{path:string;model:string;keyMatches:boolean}[]=[];
const server=createServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}'),path=new URL(req.url!,'http://localhost').pathname;
 calls.push({path,model:body.model,keyMatches:req.headers['x-api-key']==='fixture-desktop-key'});
 if(path.endsWith('/count_tokens')){res.end('{"input_tokens":10}');return;}
 if(path!=='/tenant/anthropic/v1/messages'){res.writeHead(404);res.end('{}');return;}
 const events=[{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}},
 {type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'DIRECT_OK'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}},{type:'message_stop'}];
 res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
try{
 const vault=new Map<string,string>(),directory=join(root,'Claude-3p'),manager=new ClaudeDesktopConnections({get:async n=>vault.get(n)??'',set:async(n,v)=>{vault.set(n,v);}},{directory,processes:async()=>[],policy:async()=>{}});
 await manager.connectApi({revision:(await manager.status()).revision,selection:{sourceId:'a'.repeat(24),name:'Fixture',model:'claude-sonnet-4-6',apiKey:'fixture-desktop-key',baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}/tenant/anthropic/v1`}});
 const j=JSON.parse(vault.get('native-login-claude-desktop')!),p=JSON.parse(await readFile(join(directory,'configLibrary',j.id+'.json'),'utf8'));
 // Native Desktop gateway profile semantics: x-api-key selects API_KEY; apiHostOverride supplies BASE_URL.
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^ANTHROPIC_|^CLAUDE_|^CLAUDECODE$/.test(key)));
 Object.assign(env,{CLAUDE_CONFIG_DIR:configDir,CLAUDE_CODE_ENTRYPOINT:'claude-desktop-3p',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ANTHROPIC_BASE_URL:p.inferenceGatewayBaseUrl,ANTHROPIC_API_KEY:p.inferenceGatewayAuthScheme==='x-api-key'?p.inferenceGatewayApiKey:'',ANTHROPIC_AUTH_TOKEN:p.inferenceGatewayAuthScheme==='bearer'?p.inferenceGatewayApiKey:''});
 const run=await new Promise<{code:number|null;output:string}>(done=>{const child=spawn(binary,['--bare','--model',p.inferenceModels[0].name,'-p','Reply DIRECT_OK','--output-format','json','--max-turns','1','--no-session-persistence','--tools',''],{cwd:root,env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),35000);child.on('close',code=>{clearTimeout(timer);done({code,output});});});
 const result={passed:run.code===0&&run.output.includes('DIRECT_OK')&&calls.some(c=>c.keyMatches&&c.model==='claude-sonnet-4-6'&&c.path==='/tenant/anthropic/v1/messages'),desktopUI:false,embeddedEngine:true,tokenflowRelay:false,productionRequests:0,calls,exitCode:run.code};
 await manager.restore((await manager.status()).revision,'native');
 await writeFile('doc/testing/results/claude-desktop-api-native-2026-11-01.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(!result.passed){console.error(run.output.slice(-1000));process.exitCode=1;}
}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
