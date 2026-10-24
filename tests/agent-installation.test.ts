import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({files:new Map<string,string>(),links:new Map<string,string>(),commands:[] as {file:string;args:string[];env?:{[key:string]:string}}[],fail:false}));
vi.mock('node:fs/promises',()=>({
 access:async(path:string)=>{if(!fixture.links.has(path)&&!fixture.files.has(path))throw Error('missing');},
 realpath:async(path:string)=>fixture.links.get(path)??path,
 readFile:async(path:string)=>{if(!fixture.files.has(path))throw Error('missing');return fixture.files.get(path);},
}));
vi.mock('node:child_process',()=>({execFile:(file:string,args:string[],options:{env?:{[key:string]:string}},callback:(error:Error|null,value:unknown)=>void)=>{fixture.commands.push({file,args,env:options?.env});if(fixture.fail){callback(Error('private install output must not escape'),undefined);return;}if(args.includes('install')&&args.includes('@anthropic-ai/claude-code')){fixture.links.set('/fixture/bin/claude','/fixture/lib/node_modules/@anthropic-ai/claude-code/cli.js');fixture.files.set('/fixture/lib/node_modules/@anthropic-ai/claude-code/package.json',JSON.stringify({name:'@anthropic-ai/claude-code',version:'2.1.0'}));}if(args.includes('install'))fixture.links.set('/fixture/bin/codex','/fixture/lib/node_modules/@openai/codex/bin/codex.js');callback(null,{stdout:args.includes('--version')?'2.1.0 (Claude Code)':''});}}));
import {detectAgent,AgentInstallationManager,desktopCandidates,agentCompatibility} from '../packages/core/src/agent-installation';
afterEach(()=>vi.unstubAllEnvs());
beforeEach(()=>{fixture.files.clear();fixture.links.clear();fixture.commands=[];fixture.fail=false;vi.stubEnv('PATH','/fixture/bin');fixture.links.set('/fixture/bin/npm','/fixture/node_modules/npm/bin/npm-cli.js');fixture.files.set('/fixture/lib/node_modules/@openai/codex/package.json',JSON.stringify({name:'@openai/codex',version:'1.1.0'}));});
it('does not confuse config files with installation, and verifies installation after its fixed npm recipe',async()=>{
 expect(await detectAgent('codex')).toMatchObject({installed:false,channel:'missing',automatic:true});
 const manager=new AgentInstallationManager(async()=>[]);
 const result=await manager.manage('codex','install');expect(result.installation).toMatchObject({installed:true,channel:'npm',version:'1.1.0'});
 expect(fixture.commands[0].args).toEqual(['/fixture/node_modules/npm/bin/npm-cli.js','install','--global','@openai/codex','--registry=https://registry.npmjs.org/','--ignore-scripts','--no-audit','--no-fund']);
 // Electron-as-node would otherwise default npm's global prefix to the app bundle.
 expect(fixture.commands[0].env?.PREFIX).toBe('/fixture');
 await manager.manage('codex','install');expect(fixture.commands).toHaveLength(1);
});
it('refuses updates during a task and returns a generic failure without raw installer output',async()=>{
 fixture.links.set('/fixture/bin/codex','/fixture/lib/node_modules/@openai/codex/bin/codex.js');
 await expect(new AgentInstallationManager(async()=>[123]).manage('codex','update')).rejects.toThrow('退出');expect(fixture.commands).toHaveLength(0);
 fixture.fail=true;await expect(new AgentInstallationManager(async()=>[]).manage('codex','update')).rejects.toThrow('安装或更新未完成');
});
it('uses the official download page when it cannot safely update the discovered installation',async()=>{
 fixture.links.set('/fixture/bin/codex','/fixture/native/pi');const open=vi.fn(async()=>{});
 await new AgentInstallationManager(async()=>[],open).manage('codex','update');expect(open).toHaveBeenCalledWith('https://developers.openai.com/codex/app/');expect(fixture.commands.every(call=>call.args.length===1&&call.args[0]==='--version')).toBe(true);
});
it('recognizes official Pi and does not mistake DeepSeek CLI or community Pi for official desktop clients',async()=>{
 fixture.links.set('/fixture/bin/pi','/fixture/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
 fixture.files.set('/fixture/lib/node_modules/@earendil-works/pi-coding-agent/package.json',JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.1.0'}));
 fixture.links.set('/fixture/bin/dsh','/fixture/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
 fixture.files.set('/Applications/Pi Agent Desktop.app/Contents/Info.plist','<plist><key>CFBundleShortVersionString</key><string>0.4.0</string></plist>');
 expect(await detectAgent('pi')).toMatchObject({installed:true,channel:'npm',version:'1.1.0',automatic:true});
 expect(await detectAgent('deepseek')).toMatchObject({installed:false,channel:'missing',automatic:false});
 expect(desktopCandidates('pi')).toEqual([]);
 const open=vi.fn(async()=>{});await new AgentInstallationManager(async()=>[],open).manage('deepseek','install');
 expect(open).toHaveBeenCalledWith('https://www.deepseek.com/zh/download/');expect(fixture.commands).toHaveLength(0);
});
it.skipIf(process.platform!=='darwin')('detects official DeepSeek desktop and reads its version independently of npm',async()=>{
 fixture.files.set('/Applications/DeepSeek Harness.app/Contents/Info.plist','<plist><key>CFBundleShortVersionString</key><string>0.2.0-rc.2</string></plist>');
 expect(await detectAgent('deepseek')).toMatchObject({installed:true,channel:'application',version:'0.2.0-rc.2',path:'/Applications/DeepSeek Harness.app',automatic:false});
});
it('uses Windows application roots and clearly marks Intel Mac compatibility',()=>{
 const candidates=desktopCandidates('deepseek','win32','C:\\Users\\test',{LOCALAPPDATA:'C:\\Users\\test\\AppData\\Local',ProgramFiles:'C:\\Program Files'});
 expect(candidates).toContain('C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe');
 expect(candidates).toContain('C:\\Users\\test\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe');
 expect(agentCompatibility('deepseek','darwin','x64')).toMatchObject({supported:false,reason:expect.stringContaining('Intel Mac')});
 expect(agentCompatibility('deepseek','darwin','arm64')).toEqual({supported:true});
 expect(agentCompatibility('pi','darwin','x64')).toEqual({supported:true});
 expect(agentCompatibility('pi','win32','x64')).toEqual({supported:true});
});
it('finds the Microsoft Store Codex by its fixed package identity and tolerates absent or malformed output',async()=>{
 const {windowsStoreApp}=await import('../packages/core/src/agent-installation');
 const scripts:string[]=[];
 const found=await windowsStoreApp('codex',{cli:true,run:async script=>{scripts.push(script);return JSON.stringify({version:'26.304.1234.0',location:'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26',appId:'OpenAI.Codex_abc!App',cli:'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26\\app\\resources\\codex.exe'})+'\r\n';}});
 expect(found).toEqual({version:'26.304.1234',location:'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26',appId:'OpenAI.Codex_abc!App',cli:'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26\\app\\resources\\codex.exe'});
 expect(scripts[0]).toContain("Get-AppxPackage -Name 'OpenAI.Codex'");expect(scripts[0]).toContain('-Filter codex.exe');
 expect(await windowsStoreApp('codex',{run:async()=>''})).toBeUndefined();
 expect(await windowsStoreApp('codex',{run:async()=>{throw Error('no powershell');}})).toBeUndefined();
 // Only packages with a known identity are queried.
 expect(await windowsStoreApp('qoder',{run:async()=>{throw Error('must not run');}})).toBeUndefined();
});

it('runs the required Claude installer and verifies the executable, not just package metadata',async()=>{
 const result=await new AgentInstallationManager(async()=>[]).manage('claude','install');
 expect(result.installation.installed).toBe(true);
 const install=fixture.commands.find(c=>c.args.includes('install'))!;
 expect(install.args).toContain('--ignore-scripts=false');
 expect(fixture.commands.some(c=>c.args.some(a=>a.endsWith('/claude-code/cli.js'))&&c.args.includes('--version'))).toBe(true);
});
it('offers repair when Claude package exists but its native binary cannot start',async()=>{
 fixture.links.set('/fixture/bin/claude','/fixture/lib/node_modules/@anthropic-ai/claude-code/cli.js');
 fixture.files.set('/fixture/lib/node_modules/@anthropic-ai/claude-code/package.json',JSON.stringify({name:'@anthropic-ai/claude-code',version:'2.1.0'}));fixture.fail=true;
 expect(await detectAgent('claude')).toMatchObject({installed:false,automatic:true});
});

it.runIf(process.platform==='darwin')('reads the international WorkBuddy version independently from the domestic client',async()=>{
 fixture.files.set('/Applications/WorkBuddy.app/Contents/Info.plist','<key>CFBundleShortVersionString</key><string>5.8.2</string>');
 expect(await detectAgent('workbuddy-ai')).toMatchObject({installed:false,channel:'missing',automatic:false});
 fixture.files.set('/Applications/WorkBuddy AI.app/Contents/Info.plist','<key>CFBundleShortVersionString</key><string>5.5.2</string>');
 expect(await detectAgent('workbuddy-ai')).toMatchObject({installed:true,channel:'application',version:'5.5.2',path:'/Applications/WorkBuddy AI.app'});
 expect(await detectAgent('workbuddy')).toMatchObject({installed:true,version:'5.8.2'});
 expect(fixture.commands).toHaveLength(0);
});

it('updates npm clients from a custom node_modules prefix using the same fixed recipe',async()=>{
 fixture.links.set('/fixture/bin/codex','/custom/npm/lib/node_modules/@openai/codex/bin/codex.js');
 fixture.files.set('/custom/npm/lib/node_modules/@openai/codex/package.json',JSON.stringify({name:'@openai/codex',version:'1.1.0'}));
 expect(await detectAgent('codex')).toMatchObject({installed:true,channel:'npm',automatic:true});
 await new AgentInstallationManager(async()=>[]).manage('codex','update');
 const install=fixture.commands.find(command=>command.args.includes('install'))!;
 expect(install.args).toEqual(['/fixture/node_modules/npm/bin/npm-cli.js','install','--global','--prefix','/custom/npm','@openai/codex','--registry=https://registry.npmjs.org/','--ignore-scripts','--no-audit','--no-fund']);
});
it('allows shared Claude configuration without treating the extension runtime as a standalone CLI',async()=>{
 const claude=await detectAgent('claude');expect(claude.installed).toBe(false);
 expect(claude.configurationSupported).toBe(true);
 expect((await detectAgent('codex')).configurationSupported).toBe(false);
});

it.runIf(process.platform!=='win32')('does not treat a local project dependency as a global npm prefix',async()=>{
 fixture.links.set('/fixture/bin/codex','/project/node_modules/@openai/codex/bin/codex.js');
 fixture.files.set('/project/node_modules/@openai/codex/package.json',JSON.stringify({name:'@openai/codex',version:'1.1.0'}));
 expect(await detectAgent('codex')).toMatchObject({installed:true,channel:'npm',automatic:false});
 const open=vi.fn(async()=>{});await new AgentInstallationManager(async()=>[],open).manage('codex','update');expect(open).toHaveBeenCalled();expect(fixture.commands.some(command=>command.args.includes('install'))).toBe(false);
});
