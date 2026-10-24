import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexProviderBridge,type CodexBridgeRouting} from './codex-provider-bridge.js';

type Settings=CodexBridgeRouting&{binary:string};
const directory=dirname(fileURLToPath(import.meta.url));
const settings=()=>JSON.parse(readFileSync(join(directory,'settings.json'),'utf8')) as Settings;
const initial=settings(),args=process.argv.slice(2),index=args.indexOf('app-server');
const protocol=index>=0&&!['daemon','proxy','generate-ts','generate-json-schema','help'].includes(args[index+1])&&!args.some(a=>a.startsWith('ws://')||a.startsWith('unix://'));
const env:NodeJS.ProcessEnv={...process.env,CODEX_APP_RUNTIME_CLI_PATH:initial.binary};delete env.CODEX_CLI_PATH;
const child=spawn(initial.binary,args,{env,stdio:protocol?['pipe','pipe','inherit']:'inherit'});
let bridge:CodexProviderBridge|undefined;
if(protocol){
 const send=(stream:NodeJS.WritableStream,message:unknown)=>stream.write(JSON.stringify(message)+'\n');
 const report=(event:{stage:string;provider?:string})=>{try{const path=join(directory,`status-${process.pid}.json`);writeFileSync(path+'.tmp',JSON.stringify({...event,pid:process.pid,enginePid:child.pid,updatedAt:new Date().toISOString()}),{mode:0o600});renameSync(path+'.tmp',path);}catch{}};
 bridge=new CodexProviderBridge(settings,m=>send(child.stdin!,m),m=>send(process.stdout,m),report);
 const lines=(stream:NodeJS.ReadableStream,receive:(message:any)=>void)=>{let buffer='';stream.on('data',chunk=>{buffer+=String(chunk);if(buffer.length>128*1024*1024){child.kill();return;}let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;try{receive(JSON.parse(line));}catch{process.stderr.write('TokenFlow bridge: invalid protocol message\n');child.kill();}}});};
 child.stdout!.setEncoding('utf8');process.stdin.setEncoding('utf8');
 lines(child.stdout!,m=>bridge!.receiveEngine(m));lines(process.stdin,m=>bridge!.receiveClient(m));
 process.stdin.on('end',()=>child.stdin!.end());report({stage:'connected'});
}
child.on('error',()=>{process.stderr.write('TokenFlow bridge could not start the installed Codex engine.\n');process.exit(1);});
child.on('exit',code=>{bridge?.close();process.exit(code??1);});
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>child.kill(signal));
