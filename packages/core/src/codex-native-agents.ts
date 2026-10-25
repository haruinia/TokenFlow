import {createHash,randomUUID} from 'node:crypto';
import {access,chmod,copyFile,lstat,mkdir,readFile,rename,rm,symlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';

const exec=promisify(execFile);
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const manifestSchema=z.object({format:z.literal(1),revision:z.string().regex(/^[a-f0-9]{64}$/),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),patchSha256:z.string().regex(/^[a-f0-9]{64}$/),sha256:z.string().regex(/^[a-f0-9]{64}$/),clientVersion:z.string().min(1).max(120),platform:z.literal('darwin'),arch:z.enum(['arm64','x64'])}).strict();
export type NativeAgentRuntime=z.infer<typeof manifestSchema>&{binary:string};
const fail=(message:string)=>Object.assign(new Error(message),{statusCode:409});
export async function verifyNativeAgentRuntime(runtime:NativeAgentRuntime,officialBinary:string){
 const {binary,...manifest}=runtime;manifestSchema.parse(manifest);
 if(manifest.platform!==process.platform||manifest.arch!==process.arch)throw fail('子代理兼容引擎与当前系统不匹配，未修改 Codex。');
 const info=await lstat(binary);if(!info.isFile()||info.isSymbolicLink()||digest(await readFile(binary))!==manifest.sha256)throw fail('子代理兼容引擎校验失败，请重新安装 TokenFlow。');
 await access(binary,constants.X_OK);
 const {stdout}=await exec(officialBinary,['--version'],{timeout:10000,maxBuffer:4096});
 if(stdout.trim()!==manifest.clientVersion)throw fail('Codex 已更新，当前子代理兼容引擎尚未验证此版本。请更新 TokenFlow，或切回官方直连。');
}

/** Versioned copies remain outside the application bundle; running Codex survives app updates. */
export class CodexNativeAgents {
 constructor(private assets:string,private directory:string){}
 async inspect(officialBinary:string){
  let manifest:z.infer<typeof manifestSchema>;
  try{manifest=manifestSchema.parse(JSON.parse(await readFile(join(this.assets,'manifest.json'),'utf8')));}catch{throw fail('此安装包缺少子代理兼容引擎，未修改 Codex。');}
  const runtime={...manifest,binary:join(this.assets,'codex-app-server')};await verifyNativeAgentRuntime(runtime,officialBinary);return runtime;
 }
 async install(officialBinary:string){
  const source=await this.inspect(officialBinary),target=join(this.directory,'engines',source.revision),binary=join(target,'codex-app-server');
  try{await lstat(target);const saved={...source,binary};await verifyNativeAgentRuntime(saved,officialBinary);return saved;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await mkdir(join(this.directory,'engines'),{recursive:true,mode:0o700});
  const staging=target+'.'+randomUUID()+'.tmp';await mkdir(staging,{mode:0o700});
  try{
   await copyFile(source.binary,join(staging,'codex-app-server'));await chmod(join(staging,'codex-app-server'),0o700);
   // Keep the matching official Code Mode component, without replacing or modifying it.
   const host=join(officialBinary,'..','codex-code-mode-host');await access(host,constants.X_OK);await symlink(host,join(staging,'codex-code-mode-host'));
   await rename(staging,target);
  }finally{await rm(staging,{recursive:true,force:true});}
  return {...source,binary};
 }
}
