import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexProviderBridge} from './codex-provider-bridge.js';
import {codexBridgeLaunch,type CodexBridgeSettings} from './codex-bridge-launch.js';

type Settings=CodexBridgeSettings;
const directory=dirname(fileURLToPath(import.meta.url));
const settings=()=>JSON.parse(readFileSync(join(directory,'settings.json'),'utf8')) as Settings;
const initial=settings();
const launch=await codexBridgeLaunch(initial,process.argv.slice(2),directory).catch(()=>{process.stderr.write('TokenFlow: 子代理兼容引擎校验失败，请更新 TokenFlow 或恢复官方直连。\n');process.exit(1);});
const {protocol}=launch;
const child=spawn(launch.binary,launch.args,{env:launch.env,stdio:protocol?['pipe','pipe','inherit']:'inherit'});
let bridge:CodexProviderBridge|undefined;
if(protocol){
 const send=(stream:NodeJS.WritableStream,message:unknown)=>stream.write(JSON.stringify(message)+'\n');
 const report=(event:{stage:string;provider?:string})=>{try{const path=join(directory,`status-${process.pid}.json`);writeFileSync(path+'.tmp',JSON.stringify({...event,pid:process.pid,enginePid:child.pid,nativeAgentsRevision:launch.nativeAgentsRevision,gatewayWorkers:initial.gatewayWorkers===true&&!launch.nativeAgentsRevision,updatedAt:new Date().toISOString()}),{mode:0o600});renameSync(path+'.tmp',path);}catch{}};
 bridge=new CodexProviderBridge(settings,m=>send(child.stdin!,m),m=>send(process.stdout,m),report,initial.gatewayWorkers===true&&!launch.nativeAgentsRevision);
 const lines=(stream:NodeJS.ReadableStream,receive:(message:any)=>void)=>{let buffer='';stream.on('data',chunk=>{buffer+=String(chunk);if(buffer.length>128*1024*1024){child.kill();return;}let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;try{receive(JSON.parse(line));}catch{process.stderr.write('TokenFlow bridge: invalid protocol message\n');child.kill();}}});};
 child.stdout!.setEncoding('utf8');process.stdin.setEncoding('utf8');
 lines(child.stdout!,m=>bridge!.receiveEngine(m));lines(process.stdin,m=>bridge!.receiveClient(m));
 process.stdin.on('end',()=>child.stdin!.end());report({stage:'connected'});
}
child.on('error',()=>{process.stderr.write('TokenFlow bridge could not start the installed Codex engine.\n');process.exit(1);});
child.on('exit',code=>{bridge?.close();process.exit(code??1);});
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>child.kill(signal));
