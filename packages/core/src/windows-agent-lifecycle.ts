import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open,readFile,lstat,access} from 'node:fs/promises';
import {win32,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {desktopCandidates,desktopNames,windowsRegistryApp,storePackageFor} from './agent-installation.js';
import {qoderIdeUserDataPath} from './qoder-ide-login.js';

export type WindowsTarget='claude-desktop'|'qoder'|'qoder-ide'|'codex'|'workbuddy'|'workbuddy-ai'|'deepseek';
export type WindowsRun=(file:string,args:string[])=>Promise<{stdout:string}>;
export type WindowsProcess={pid:number;parent:number;path:string;started:string;profile?:string;crashReporter?:boolean};
const exec=promisify(execFile);
const runDefault:WindowsRun=(file,args)=>exec(file,args,{timeout:15000,maxBuffer:2*1024*1024,windowsHide:true});
const failure=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const quote=(text:string)=>`'${text.replaceAll("'","''")}'`;
const canonical=(path:string)=>win32.normalize(path).toLowerCase();
const apps={
 'claude-desktop':{name:'Claude',images:['Claude.exe'],package:'@ant/desktop'},
 qoder:{name:'Qoder',images:['Qoder.exe'],package:'qoder'},
 // Qoder IDE 1.106+ names its executable "Qoder IDE.exe"; earlier builds used "Qoder.exe".
 'qoder-ide':{name:'Qoder IDE',images:['Qoder IDE.exe','Qoder.exe'],package:'qoder-ide'},
 codex:{name:'Codex',images:['Codex.exe','ChatGPT.exe','CodexCLI.exe'],package:'openai-codex-electron'},
 workbuddy:{name:'WorkBuddy',images:['WorkBuddy.exe'],package:'@genie/workbuddy-desktop'},
 'workbuddy-ai':{name:'WorkBuddyAI 国际版',images:['WorkBuddyAI.exe','WorkBuddy AI.exe'],package:'@genie/workbuddy-desktop:international'},
 deepseek:{name:'DeepSeek Harness',images:['DeepSeek Harness.exe','dsh.exe'],package:'@deepseek-ai/dsh-desktop'},
};
async function powershell(run:WindowsRun,script:string){return (await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(`$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n${script}`,'utf16le').toString('base64')])).stdout;}

/** Read only the bounded package.json entry from Electron's ASAR; never execute app code. */
async function electronPackageMetadata(archive:string):Promise<{name?:string;productName?:string}>{
 const wasNoAsar=(process as {noAsar?:boolean}).noAsar;
 (process as {noAsar?:boolean}).noAsar=true;
 try{
  const file=await open(archive,'r');
  try{
   const size=(await file.stat()).size;
   const read=async(length:number,position:number)=>{if(position+length>size)throw Error('Truncated ASAR');const buffer=Buffer.alloc(length);if((await file.read(buffer,0,length,position)).bytesRead!==length)throw Error('Truncated ASAR');return buffer;};
   const prefix=await read(8,0),headerSize=prefix.readUInt32LE(4);
   if(prefix.readUInt32LE(0)!==4||headerSize<8||headerSize>16*1024*1024)throw Error('Invalid ASAR header');
   const header=await read(headerSize,8),jsonSize=header.readUInt32LE(4);
   if(jsonSize>headerSize-8)throw Error('Invalid ASAR header');
   const entry=JSON.parse(header.subarray(8,8+jsonSize).toString()).files?.['package.json'];
   if(!entry||entry.link||entry.unpacked||!Number.isSafeInteger(entry.size)||entry.size<=0||entry.size>1024*1024||!/^\d+$/.test(entry.offset))throw Error('Invalid ASAR package');
   const offset=Number(entry.offset);if(!Number.isSafeInteger(offset))throw Error('Invalid ASAR offset');
   const data=JSON.parse((await read(entry.size,8+headerSize+offset)).toString());
   return {name:typeof data.name==='string'?data.name:undefined,productName:typeof data.productName==='string'?data.productName:undefined};
  }finally{await file.close();}
 }finally{(process as {noAsar?:boolean}).noAsar=wasNoAsar;}
}
export async function electronPackageName(archive:string){return (await electronPackageMetadata(archive)).name;}
export async function electronDesktopIdentity(archive:string){
 const meta=await electronPackageMetadata(archive);
 if(meta.name==='@genie/workbuddy-desktop'&&meta.productName){
  if(['WorkBuddy AI','WorkBuddyAI'].includes(meta.productName))return '@genie/workbuddy-desktop:international';
  if(meta.productName!=='WorkBuddy')return;
 }
 return meta.name;
}
/** VS Code-derived IDEs ship resources/app, not app.asar. Require both package and product identity. */
export async function qoderIdeWindowsIdentity(directory:string){
 const read=async(name:string)=>{const path=join(directory,name),info=await lstat(path);if(!info.isFile()||info.size>1024*1024)throw Error();return JSON.parse(await readFile(path,'utf8'));};
 const [pkg,product]=await Promise.all([read('package.json'),read('product.json')]);
 // product.json carries the identity; the package name varies between builds ("Qoder", "Qoder IDE", "qoder-ide").
 if(!/^qoder(?:[ -]ide)?$/i.test(String(pkg.name??''))||product.win32AppUserModelId!=='AlibabaCloud.Qoder'||product.applicationName!=='qoder'||product.dataFolderName!=='.qoder')return;
 return 'qoder-ide';
}
export function codexCliWindowsIdentity(path:string):string|undefined{
 const normalized=win32.normalize(path);
 if(/[\\/](?:OpenAI[\\/]Codex[\\/]|WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]|node_modules[\\/]@openai[\\/])/i.test(normalized))return 'openai-codex-cli';
}
export async function windowsAppIdentity(path:string):Promise<string|undefined>{
 if(!win32.isAbsolute(path)||!path.toLowerCase().endsWith('.exe'))return;
 const base=win32.basename(path).toLowerCase();
 // Claude Desktop spawns its managed Claude Code build from the integration data directory; it is not a standalone install.
 const claudeHelper=process.env.LOCALAPPDATA?win32.join(process.env.LOCALAPPDATA,'Claude-3p','claude-code'):undefined;
 if(base==='claude.exe'&&claudeHelper&&win32.normalize(path).toLowerCase().startsWith(canonical(claudeHelper)+win32.sep))return 'claude-desktop-helper';
 try{const identity=await electronDesktopIdentity(win32.join(win32.dirname(path),'resources','app.asar'));if(identity)return identity;}catch{}
 if(base==='qoder.exe'||base==='qoder ide.exe'){
  try{return await qoderIdeWindowsIdentity(win32.join(win32.dirname(path),'resources','app'));}catch{}
  // Qoder IDE bundles its own Qoder.exe helper (resources/app/resources/bin). It shares the
  // standalone app's file name but belongs to a different, known application: report it as
  // such so it can be ignored instead of blocking the standalone app as an unknown process.
  if(/[\\/]qoder ide[\\/]resources[\\/]/i.test(win32.normalize(path)))return 'qoder-ide-helper';
 }
 if(base==='codex.exe'||base==='codexcli.exe')try{return codexCliWindowsIdentity(path);}catch{}
}

/** Unknown processes block automation. A known different app (for example Qoder IDE) is ignored. */
export class WindowsAgentLifecycle {
 private selected?:{target:WindowsTarget;path:string;appId?:string};
 constructor(private run:WindowsRun=runDefault,private wait:()=>Promise<unknown>=()=>delay(250),private identity=windowsAppIdentity){}
 async processes(target:WindowsTarget):Promise<WindowsProcess[]>{
  const filter=apps[target].images.map(name=>`Name='${name}'`).join(' OR ');
  let rows:unknown;
  try{rows=JSON.parse(await powershell(this.run,`# tokenflow:inspect\n$rows=@(Get-CimInstance Win32_Process -Filter ${quote(filter)} | ForEach-Object {
$p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
if($p){try{$profile='';if($_.CommandLine -match '(?i)--(?:user-data-dir|profile)=("?)([^"\\s]+)\\1'){$profile=$matches[2]};[pscustomobject]@{pid=$p.Id;parent=$_.ParentProcessId;path=$p.Path;started=$p.StartTime.ToUniversalTime().Ticks.ToString();profile=$profile;crashReporter=[bool]($_.CommandLine -match '(?i)--type=crashpad-handler')}}catch{[pscustomobject]@{pid=$p.Id}}}
})\nConvertTo-Json -Compress -InputObject @($rows)`));}catch{throw failure('无法可靠检查 Windows Agent 进程，请手动退出并重新打开。');}
  if(!Array.isArray(rows))throw failure('Windows 进程信息不完整，已停止自动重启。');
  const found:WindowsProcess[]=[];
  for(const row of rows){
   const p=row as WindowsProcess;
   if(!p||!Number.isSafeInteger(p.pid)||p.pid<=1||p.pid===process.pid||!Number.isSafeInteger(p.parent)||typeof p.path!=='string'||!win32.isAbsolute(p.path)||typeof p.started!=='string'||!/^\d+$/.test(p.started))throw failure('无法确认同名进程的路径或启动时间，请手动退出目标 Agent。');
   const name=await this.identity(p.path);
   if(!name)throw failure(`无法确认 ${apps[target].name} 同名进程的应用身份，请手动退出目标 Agent（包括 CLI）。`);
   // A crash reporter outlives the app it belongs to and never re-reads configuration.
   if(name===apps[target].package&&!p.crashReporter){
    // Every Electron child process carries --user-data-dir, so only a value that differs from
    // the default profile roots the login outside the store this feature can safely rewrite.
    if(target==='qoder-ide'&&p.profile&&canonical(win32.resolve(p.profile))!==canonical(win32.resolve(qoderIdeUserDataPath())))throw failure('Qoder IDE 正在使用自定义配置目录或个人资料，请在 IDE 内切换账号。');
    found.push(p);
   }
  }
  return found;
 }
 private async candidates(target:WindowsTarget){
  const choices:{path:string;appId?:string}[]=desktopCandidates(target,'win32').map(path=>({path}));
  // Uninstall registration covers custom install directories that the fixed roots miss.
  const registered=await windowsRegistryApp(desktopNames[target]??[]).catch(()=>undefined);
  if(registered?.path&&win32.isAbsolute(registered.path))choices.push({path:registered.path});
  const storePackage=storePackageFor(target);
  if(storePackage){
   // Resolve the Store package's manifest, never a display-name match in the Start menu.
   const text=await powershell(this.run,`# tokenflow:store\n$rows=@(Get-AppxPackage -Name '${storePackage}' | ForEach-Object {
$p=$_;$manifest=Get-AppxPackageManifest -Package $p.PackageFullName
foreach($a in $manifest.Package.Applications.Application){if([IO.Path]::GetFileName([string]$a.Executable) -in @('${apps[target].images.join("','")}')){[pscustomobject]@{path=(Join-Path $p.InstallLocation $a.Executable);appId=($p.PackageFamilyName+'!'+$a.Id)}}}
})\nConvertTo-Json -Compress -InputObject @($rows)`);
   const rows=JSON.parse(text);if(!Array.isArray(rows))throw failure(`无法确认 ${apps[target].name} 的商店安装身份。`);
   const appIds=new RegExp(`^${storePackage.replaceAll('.','\\.')}_\\w+![\\w.-]+$`);
   for(const row of rows)if(typeof row.path==='string'&&win32.isAbsolute(row.path)&&typeof row.appId==='string'&&appIds.test(row.appId))choices.push(row);
  }
  const verified=new Map<string,{path:string;appId?:string}>();
  for(const candidate of choices)if(await this.identity(candidate.path)===apps[target].package)verified.set(canonical(candidate.path),candidate);
  return [...verified.values()];
 }
 async stop(target:WindowsTarget){
  this.selected=undefined;
  const processes=await this.processes(target);
  const paths=new Set(processes.map(p=>canonical(p.path)));
  const roots=processes.filter(p=>!processes.some(parent=>parent.pid===p.parent&&canonical(parent.path)===canonical(p.path)));
  if(paths.size>1||processes.length&&roots.length!==1)throw failure(`检测到多个 ${apps[target].name} 安装或实例，请先手动退出多余实例。未关闭任何程序。`);
  if(processes.length){
   this.selected={target,path:processes[0].path};
   await this.checkIdeProfile(target,this.selected.path);
   // Preflight the launch destination before closing anything, including Store registration.
   if(/\\WindowsApps\\/i.test(this.selected.path)){
    const match=(await this.candidates(target)).find(c=>canonical(c.path)===canonical(this.selected!.path)&&c.appId);
    if(!match)throw failure('无法确认商店应用的启动入口，请手动重启。');
    this.selected={target,...match};
   }
   const current=await this.processes(target);
   if(current.length!==processes.length||current.some(p=>!processes.some(old=>old.pid===p.pid&&old.started===p.started&&canonical(old.path)===canonical(p.path))))throw failure('Agent 进程已变化，请重试。未关闭任何程序。');
   const payload=Buffer.from(JSON.stringify(current),'utf8').toString('base64');
   try{await powershell(this.run,`# tokenflow:close\n$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
$checked=@()
try {
foreach($e in $expected){
$p=Get-Process -Id $e.pid -ErrorAction SilentlyContinue
if(!$p){throw 'Process changed'}
[void]$p.Handle
$checked+= $p
if($p.HasExited -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $e.started -or ![String]::Equals($p.Path,$e.path,[StringComparison]::OrdinalIgnoreCase)){throw 'Process changed'}
}
foreach($p in $checked){if(!$p.HasExited -and $p.MainWindowHandle -ne 0){[void]$p.CloseMainWindow()}}
$alive=@($checked|Where-Object{!$_.HasExited})
if($alive.Count -gt 0){
if(-not ([System.Management.Automation.PSTypeName]'TokenFlowCloser').Type){
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class TokenFlowCloser {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lp);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc proc, IntPtr lp);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr res);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
    public static void Close(int[] pids) {
        var set = new HashSet<int>(pids);
        EnumWindowsProc proc = (hWnd, lp) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (set.Contains((int)pid)) {
                IntPtr res;
                SendMessageTimeout(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero, 2, 1000, out res);
                SendMessageTimeout(hWnd, 0x0011, IntPtr.Zero, IntPtr.Zero, 2, 1000, out res);
                SendMessageTimeout(hWnd, 0x0016, (IntPtr)1, IntPtr.Zero, 2, 1000, out res);
            }
            return true;
        };
        try { EnumWindows(proc, IntPtr.Zero); } catch {}
        try {
            IntPtr hDesk = OpenDesktop("Default", 0, false, 0x0040 | 0x0001);
            if (hDesk != IntPtr.Zero) {
                EnumDesktopWindows(hDesk, proc, IntPtr.Zero);
                CloseDesktop(hDesk);
            }
        } catch {}
    }
}
'@
}
[TokenFlowCloser]::Close(@($alive|ForEach-Object{$_.Id}))
}
} finally {foreach($p in $checked){$p.Dispose()}}`);}catch{throw failure('进程身份已变化或无法请求退出，请手动退出目标 Agent 后重试。未强制结束进程。');}
   for(let tick=0;tick<40;tick++){if(!(await this.processes(target)).length)return;await this.wait();}
   throw failure(`${apps[target].name} 尚未退出，请处理保存提示，或从系统托盘退出后重试。未强制结束进程。`);
  }
  const candidates=await this.candidates(target);
  if(candidates.length!==1)throw failure('无法唯一确认 Agent 的安装位置，请手动打开目标应用后重试。');
  this.selected={target,...candidates[0]};
  await this.checkIdeProfile(target,this.selected.path);
 }
 private async checkIdeProfile(target:WindowsTarget,path:string){
  if(target!=='qoder-ide')return;
  try{await access(win32.join(win32.dirname(path),'data'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw failure('无法确认 Qoder IDE 的配置目录，请手动检查。');}
  throw failure('检测到 Qoder IDE 便携配置，请在 IDE 内切换账号；默认登录目录未修改。');
 }
 async open(target:WindowsTarget,env:Record<string,string>={}){
  const selected=this.selected;
  if(!selected||selected.target!==target)throw failure('缺少已确认的启动位置，请手动打开 Agent。');
  if((await this.processes(target)).length)throw failure('Agent 已重新运行，未重复打开，请检查当前模型。');
  if(await this.identity(selected.path)!==apps[target].package)throw failure('应用身份已变化，未启动任何程序。');
  if(selected.appId){
   const match=(await this.candidates(target)).some(c=>canonical(c.path)===canonical(selected.path)&&c.appId===selected.appId);
   if(!match)throw failure('商店应用注册已变化，请手动打开 Agent。');
  }
  const launchEnvironment=Object.entries(env).map(([key,value])=>{if(!/^CODEX_(HOME|ELECTRON_USER_DATA_PATH)$/.test(key))throw failure('无效的启动环境');return `$env:${key}=${quote(value)}`;}).join('\n');
  try{await powershell(this.run,launchEnvironment?`${launchEnvironment}\n# tokenflow:open\nStart-Process -FilePath ${quote(selected.path)}`:selected.appId?`# tokenflow:open\nStart-Process -FilePath 'explorer.exe' -ArgumentList ${quote('shell:AppsFolder\\'+selected.appId)}`:`# tokenflow:open\nStart-Process -FilePath ${quote(selected.path)}`);}catch{throw failure('无法打开已确认的 Agent，请手动打开。未尝试其他同名程序。');}
  // Launch exactly once. A delayed startup is not a reason to spawn another instance.
  for(let tick=0;tick<40;tick++){
   const found=await this.processes(target);
   if(found.some(p=>canonical(p.path)===canonical(selected.path)))return;
   await this.wait();
  }
  throw failure(`${apps[target].name} 启动尚未确认，请手动检查。未重复启动。`);
 }
 async restart(target:WindowsTarget){await this.stop(target);await this.open(target);return {message:`${apps[target].name} 已重新打开，请确认模型选择。`};}
}
