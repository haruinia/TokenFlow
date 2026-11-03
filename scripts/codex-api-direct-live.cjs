// Explicit live check of one saved DeepSeek API source. Key travels over stdin only.
const {app,safeStorage,session}=require('electron');
const {readFile,mkdtemp,rm}=require('node:fs/promises');
const {join,resolve}=require('node:path');
const {homedir,tmpdir}=require('node:os');
const {spawn}=require('node:child_process');
if(!process.argv.includes('--live'))app.exit(1);else void main();
async function main(){let child,temporary;try{
 app.setName('token-flow');temporary=await mkdtemp(join(tmpdir(),'tf-api-helper-'));app.setPath('userData',temporary);await app.whenReady();app.dock?.hide();
 let source,profile;
 for(const name of ['token-flow','token-flowb','desktop-browser-agent','Browser Agent'])try{const root=join(homedir(),'Library/Application Support',name),store=JSON.parse(await readFile(join(root,'api-sources.json'),'utf8'));const found=store.sources.find(s=>s.enabled&&new URL(s.baseURL).hostname==='api.deepseek.com'&&s.models.includes('deepseek-flash'));if(found){source=found;profile=root;break;}}catch{}
 if(!source||!safeStorage.isEncryptionAvailable())throw Error('Saved source unavailable');
 const apiKey=safeStorage.decryptString(await readFile(join(profile,'secrets',source.credentialRef+'.bin'))),route=source.modelRoutes?.['deepseek-flash']??source;
 if(new URL(route.baseURL).hostname!=='api.deepseek.com'||new URL(route.baseURL).protocol!=='https:')throw Error('Unexpected destination');
 const network=session.fromPartition('codex-api-live-check',{cache:false});await network.setProxy({mode:'system'});
 child=spawn('node',['--import','tsx',resolve(__dirname,'codex-api-direct-live.mts'),'--live'],{cwd:resolve(__dirname,'..'),stdio:['pipe','pipe','pipe','ipc'],env:process.env});
 child.on('message',async message=>{if(message?.type!=='resolve-proxy')return;try{const url=new URL(message.url);if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com')throw Error();const result=await network.resolveProxy(url.href);if(child.connected)child.send({id:message.id,result});}catch{if(child.connected)child.send({id:message.id,result:'UNAVAILABLE'});}});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();child.stdin.end(JSON.stringify({sourceId:source.id,model:'deepseek-flash',name:source.name,baseURL:route.baseURL,apiKey}));
 const timer=setTimeout(()=>child.kill('SIGTERM'),240000);const code=await new Promise(r=>{child.on('error',()=>r(1));child.on('exit',r);});clearTimeout(timer);
 for(const line of output.split('\n'))try{const report=JSON.parse(line);if(report.check==='codex-api-direct-live')console.log(JSON.stringify(report));}catch{}
 await rm(temporary,{recursive:true,force:true});app.exit(code??1);
 }catch{console.log(JSON.stringify({check:'codex-api-direct-live',passed:false,phase:'credential-access',message:'已保存的 DeepSeek 密钥暂不可读取，未创建新授权。'}));child?.kill('SIGTERM');if(temporary)await rm(temporary,{recursive:true,force:true});app.exit(1);}}
