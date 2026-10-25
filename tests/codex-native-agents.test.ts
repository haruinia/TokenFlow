import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {CodexNativeAgents,verifyNativeAgentRuntime} from '../packages/core/src/codex-native-agents';
import {codexBridgeLaunch} from '../packages/core/src/codex-bridge-launch';
import {CodexBridgeInstallation} from '../packages/core/src/codex-bridge-installation';
const roots:string[]=[];afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'tf native 中文-'));roots.push(root);const assets=join(root,'assets'),bin=join(root,'official');await mkdir(assets);await mkdir(bin);
 const official=join(bin,'codex'),source='#!/bin/sh\nexit 0\n';await writeFile(official,'#!/bin/sh\nprintf "codex-fixture 1\\n"\n',{mode:0o700});await writeFile(join(bin,'codex-code-mode-host'),source,{mode:0o700});await writeFile(join(assets,'codex-app-server'),source,{mode:0o700});
 const manifest={format:1,revision:hash('revision'),sourceCommit:'a'.repeat(40),patchSha256:hash('patch'),sha256:hash(source),clientVersion:'codex-fixture 1',platform:process.platform,arch:process.arch};await writeFile(join(assets,'manifest.json'),JSON.stringify(manifest));
 return {root,assets,official,source,manager:new CodexNativeAgents(assets,join(root,'bridge'))};
}
it('copies a verified immutable runtime and leaves the official executable unchanged',async()=>{
 const f=await fixture(),before=await readFile(f.official),runtime=await f.manager.install(f.official);expect(await readFile(f.official)).toEqual(before);expect(runtime.binary).toContain(runtime.revision);expect((await stat(runtime.binary)).mode&0o777).toBe(0o700);expect(await f.manager.install(f.official)).toEqual(runtime);
 await writeFile(runtime.binary,'corrupted');await expect(f.manager.install(f.official)).rejects.toThrow('校验失败');expect(await readFile(f.official)).toEqual(before);
});
it('refuses incompatible Codex versions before selecting the compatibility runtime',async()=>{
 const f=await fixture(),runtime=await f.manager.install(f.official);await writeFile(f.official,'#!/bin/sh\nprintf "codex-fixture 2\\n"\n');await expect(verifyNativeAgentRuntime(runtime,f.official)).rejects.toThrow('Codex 已更新');
});
it('uses the native agent runtime only for bridged stdio app-server and scopes settings to that process',async()=>{
 const f=await fixture(),nativeAgents=await f.manager.install(f.official),settings={binary:f.official,nativeAgents,officialModels:['official'],gatewayModels:['gateway']};
 const launch=await codexBridgeLaunch(settings,['-c','model="official"','app-server','--listen','stdio://'],join(f.root,'bridge'),{CODEX_CLI_PATH:'old',TOKENFLOW_CODEX_AGENT_ROUTES_FILE:'old'});
 expect(launch.binary).toBe(nativeAgents.binary);expect(launch.args).not.toContain('app-server');expect(launch.args).toContain('features.multi_agent_v2.tool_namespace="collaboration"');expect(launch.env.TOKENFLOW_CODEX_AGENT_ROUTES_FILE).toBe(join(f.root,'bridge','settings.json'));expect(launch.env.CODEX_CLI_PATH).toBeUndefined();expect(launch.env.CODEX_APP_RUNTIME_CLI_PATH).toBe(f.official);
 for(const args of [['--version'],['app-server','generate-json-schema'],['app-server','--listen','ws://localhost:9999']]){const result=await codexBridgeLaunch(settings,args,f.root,{TOKENFLOW_CODEX_AGENT_ROUTES_FILE:'inherited'});expect(result.binary).toBe(f.official);expect(result.args).toEqual(args);expect(result.env.TOKENFLOW_CODEX_AGENT_ROUTES_FILE).toBeUndefined();}
});
it('backs up exact previous launcher files before change, skips identical reapplication, and backs up routing refreshes',async()=>{
 const f=await fixture(),runtime=join(f.root,'bridge-source.mjs');await writeFile(runtime,'// bridge v1\n');const installation=new CodexBridgeInstallation(f.root,runtime);
 vi.spyOn(installation,'preflight').mockResolvedValue({app:'/fixture/Codex.app',binary:f.official,node:'/fixture/node'});
 await installation.install({officialModels:['official'],gatewayModels:['one']});const backupDir=join(installation.directory,'backups');expect((await readdir(backupDir)).length).toBe(1);
 const before=await readFile(join(installation.directory,'settings.json'),'utf8');await installation.install({officialModels:['official'],gatewayModels:['one']});expect((await readdir(backupDir)).length).toBe(1);
 const update=await installation.prepareRouting({officialModels:['official'],gatewayModels:['two']});await update.apply();const backups=await Promise.all((await readdir(backupDir)).map(async name=>JSON.parse(await readFile(join(backupDir,name),'utf8'))));expect(backups.some(b=>b.before['settings.json']===before)).toBe(true);await update.rollback();expect(await readFile(join(installation.directory,'settings.json'),'utf8')).toBe(before);
});
it('does not replace the launcher or routes if the backup cannot be created',async()=>{
 const f=await fixture(),runtime=join(f.root,'bridge-source.mjs');await writeFile(runtime,'// original\n');const installation=new CodexBridgeInstallation(f.root,runtime);vi.spyOn(installation,'preflight').mockResolvedValue({app:'/fixture/Codex.app',binary:f.official,node:'/fixture/node'});
 await installation.install({officialModels:['official'],gatewayModels:['one']});const before=await readFile(join(installation.directory,'settings.json'),'utf8');await rm(join(installation.directory,'backups'),{recursive:true});await writeFile(join(installation.directory,'backups'),'blocked');await writeFile(runtime,'// new\n');
 await expect(installation.install({officialModels:['official'],gatewayModels:['two']})).rejects.toThrow();expect(await readFile(join(installation.directory,'settings.json'),'utf8')).toBe(before);expect(await readFile(join(installation.directory,'bridge.mjs'),'utf8')).toBe('// original\n');
});

it('keeps the desktop organization-settings startup check and recovery on the official one-shot CLI',async()=>{
 const f=await fixture(),nativeAgents=await f.manager.install(f.official),settings={binary:f.official,nativeAgents,officialModels:['official'],gatewayModels:['gateway']};
 for(const suffix of [[],['--startup-sign-out']]){
  const args=['app-server','--print-startup-config','--startup-client-info',JSON.stringify({name:'codex_desktop',title:'Codex Desktop',version:'fixture'}),...suffix];
  const launch=await codexBridgeLaunch(settings,args,f.root,{TOKENFLOW_CODEX_AGENT_ROUTES_FILE:'inherited'});
  expect(launch.binary).toBe(f.official);expect(launch.args).toEqual(args);expect(launch.protocol).toBe(false);expect(launch.env.TOKENFLOW_CODEX_AGENT_ROUTES_FILE).toBeUndefined();
 }
});
