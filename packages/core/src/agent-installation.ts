import {access,readFile,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,delimiter,dirname,isAbsolute,join,posix,win32} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Target} from './agent-connections.js';
const exec=promisify(execFile);
const recipes={
 codex:{bin:'codex',package:'@openai/codex',download:'https://developers.openai.com/codex/app/'},
 'claude-desktop':{bin:'Claude',package:'',download:'https://claude.ai/download'},
 claude:{bin:'claude',package:'@anthropic-ai/claude-code',download:'https://code.claude.com/docs/en/setup'},
 pi:{bin:'pi',package:'@earendil-works/pi-coding-agent',download:'https://pi.dev/docs/latest/quickstart'},
 deepseek:{bin:'dsh',package:'',download:'https://www.deepseek.com/zh/download/'},
 qoder:{bin:'qoder',package:'',download:'https://qoder.com/download'},
 workbuddy:{bin:'workbuddy',package:'',download:'https://www.codebuddy.cn/work/'},
 'workbuddy-ai':{bin:'workbuddyai',package:'',download:'https://www.workbuddy.ai/'},
} as const;
export type AgentInstallation={installed:boolean;channel:'npm'|'application'|'other'|'missing';version?:string;path?:string;download:string;automatic:boolean;supported?:boolean;reason?:string;configurationSupported?:boolean;npmPrefix?:string};
const failure=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const dirs=()=>[...(process.env.PATH??'').split(delimiter),join(homedir(),'.npm-global','bin'),join(homedir(),'.local','bin'),...(process.platform==='win32'?[join(homedir(),'.npm-global'),...(process.env.APPDATA?[join(process.env.APPDATA,'npm')]:[])]:['/opt/homebrew/bin','/usr/local/bin'])].filter(isAbsolute);
async function executable(name:string,unresolved=false){
 for(const dir of dirs())for(const suffix of process.platform==='win32'?['.exe','.cmd','']:['']){
  const path=join(dir,name+suffix);try{await access(path,constants.X_OK);return unresolved?path:await realpath(path);}catch{/* Next installation location. */}
 }
}
async function packageOf(path:string,name:string){
 const metadata=async(dir:string)=>{
  const data=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
  if(data.name!==name||typeof data.version!=='string')return;
  const modules=name.startsWith('@')?dirname(dirname(dir)):dirname(dir);
  if(basename(modules)!=='node_modules')return;
  const parent=dirname(modules),prefix=process.platform==='win32'?parent:basename(parent)==='lib'?dirname(parent):undefined;
  return {version:data.version as string,prefix};
 };
 try{const data=await metadata(join(dirname(path),'node_modules',name));if(data)return data;}catch{/* Windows npm shims use a sibling node_modules directory. */}
 let dir=dirname(path);
 for(let i=0;i<6;i++,dir=dirname(dir))try{const data=await metadata(dir);if(data)return data;}catch{/* Executables need not be npm packages. */}
}
export const desktopNames:Partial<Record<Target|'claude-desktop'|'workbuddy-ai'|'qoder-ide',string[]>>={'claude-desktop':['Claude'],codex:['Codex','ChatGPT'],qoder:['Qoder'],'qoder-ide':['Qoder IDE','Qoder'],workbuddy:['WorkBuddy'],'workbuddy-ai':['WorkBuddy AI','WorkBuddyAI'],deepseek:['DeepSeek Harness']};
// AGENT_INSTALL_DIRS lists extra roots (PATH-style separators); portable or non-standard installs live there.
// The separator follows the target platform, not the host, so a win32 probe splits on ';' when tested from macOS.
const envRoots=(env:NodeJS.ProcessEnv,platform=process.platform)=>{
 const path=platform==='win32'?win32:posix;
 return (env.AGENT_INSTALL_DIRS??'').split(platform==='win32'?';':delimiter).map(root=>root.trim()).filter(root=>root&&path.isAbsolute(root));
};
export function desktopCandidates(target:Target|'claude-desktop'|'workbuddy-ai'|'qoder-ide',platform=process.platform,home=homedir(),env:NodeJS.ProcessEnv=process.env){
 const names=desktopNames[target]??[];
 if(platform==='darwin')return [...envRoots(env,platform).flatMap(root=>names.map(name=>join(root,`${name}.app`))),...names.flatMap(name=>['/Applications',join(home,'Applications')].map(base=>join(base,`${name}.app`)))];
 if(platform==='win32'&&target==='claude-desktop'&&env.LOCALAPPDATA)return [win32.join(env.LOCALAPPDATA,'AnthropicClaude','Claude.exe'),win32.join(env.LOCALAPPDATA,'Programs','Claude','Claude.exe'),win32.join(env.LOCALAPPDATA,'Claude','Claude.exe')];
 if(platform==='win32')return names.flatMap(name=>{
  // Qoder IDE renamed its executable from "Qoder.exe" to "Qoder IDE.exe" in 1.106.
  const executables=target==='workbuddy-ai'?['WorkBuddyAI']:target==='qoder-ide'?['Qoder IDE','Qoder']:[name];
  const standard=[env.LOCALAPPDATA&&win32.join(env.LOCALAPPDATA,'Programs'),env.LOCALAPPDATA,env.ProgramFiles,env['ProgramFiles(x86)']].filter((base):base is string=>!!base&&win32.isAbsolute(base));
  // User-configured roots are searched first and accept either a per-app folder or the executable directly.
  return [...envRoots(env,platform).flatMap(root=>executables.flatMap(exe=>[win32.join(root,name,`${exe}.exe`),win32.join(root,`${exe}.exe`)])),...standard.flatMap(base=>executables.map(exe=>win32.join(base,name,`${exe}.exe`)))];
 });
 return [];
}
export function agentCompatibility(target:Target|'claude-desktop'|'workbuddy-ai',platform=process.platform,arch=process.arch){
 return target==='deepseek'&&platform==='darwin'&&arch!=='arm64'?{supported:false,reason:'DeepSeek 官方暂未提供 Intel Mac 桌面安装包。'}:{supported:true};
}
const versionOf=(text:string)=>text.match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/)?.[1];
// Microsoft Store desktop clients install under a protected WindowsApps directory, so they are found by package identity.
// Claude's Store build (MSIX) also never appears in the classic Uninstall registry keys the fallback searches.
const storePackages:Partial<Record<Target|'claude-desktop'|'workbuddy-ai'|'qoder-ide',string>>={codex:'OpenAI.Codex','claude-desktop':'AnthropicPBC.Claude',workbuddy:'WorkBuddy.WorkBuddy',qoder:'com.qodercn.app'};
export const storePackageFor=(target:Target|'claude-desktop'|'workbuddy-ai'|'qoder-ide')=>storePackages[target];
export type StoreApp={version?:string;location?:string;appId?:string;cli?:string};
type PowerShell=(script:string)=>Promise<string>;
const runPowerShell:PowerShell=async script=>(await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:8000,maxBuffer:64*1024,windowsHide:true})).stdout;
/** Fixed package name only; the optional CLI search reads the package directory and never executes anything. */
export async function windowsStoreApp(target:Target|'claude-desktop'|'workbuddy-ai',options:{cli?:boolean;run?:PowerShell}={}):Promise<StoreApp|undefined>{
 const name=storePackages[target];if(!name)return;
 const script=`$p=Get-AppxPackage -Name '${name}' -ErrorAction SilentlyContinue|Select-Object -First 1
if($p){
$a=Get-StartApps|Where-Object{$_.AppID -like ($p.PackageFamilyName+'!*')}|Select-Object -First 1
$c=${options.cli?"Get-ChildItem -LiteralPath $p.InstallLocation -Filter codex.exe -Recurse -Depth 6 -File -ErrorAction SilentlyContinue|Sort-Object -Property Length -Descending|Select-Object -First 1 -ExpandProperty FullName":'$null'}
[pscustomobject]@{version=[string]$p.Version;location=$p.InstallLocation;appId=$a.AppID;cli=$c}|ConvertTo-Json -Compress
}`;
 try{
  const value=JSON.parse((await (options.run??runPowerShell)(script)).trim()||'null');
  if(!value||typeof value!=='object')return;
  const text=(item:unknown)=>typeof item==='string'&&item?item:undefined;
  return {version:versionOf(text(value.version)??''),location:text(value.location),appId:text(value.appId),cli:text(value.cli)};
 }catch{return;}
}
const storeCache=new Map<Target|'claude-desktop'|'workbuddy-ai',{expires:number;value:Promise<StoreApp|undefined>}>();
// Status polling asks repeatedly; avoid starting PowerShell for every refresh.
const cachedStoreApp=(target:Target|'claude-desktop'|'workbuddy-ai')=>{
 const cached=storeCache.get(target);if(cached&&cached.expires>Date.now())return cached.value;
 const value=windowsStoreApp(target);storeCache.set(target,{expires:Date.now()+15000,value});return value;
};
export type RegistryApp={path?:string;version?:string};
/**
 * Finds a desktop app through its Windows uninstall registration, so any install
 * directory (custom drive, per-user layout) is discovered without fixed paths.
 * Only known display names are matched and the script only reads registry values.
 */
export async function windowsRegistryApp(names:string[],options:{run?:PowerShell}={}):Promise<RegistryApp|undefined>{
 if(!names.length)return;
 const list=names.map(name=>`'${name.replaceAll("'","''")}'`).join(',');
 const script=`$names=@(${list})
$hits=@()
foreach($root in 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'){
 foreach($entry in @(Get-ItemProperty -Path $root -ErrorAction SilentlyContinue)){
  if(-not $entry.DisplayName){continue}
  $name=$null
  foreach($candidate in ($names|Sort-Object -Property Length -Descending)){
   if($entry.DisplayName.StartsWith($candidate,[System.StringComparison]::OrdinalIgnoreCase)){
    $rest=$entry.DisplayName.Substring($candidate.Length)
    if($rest -match '^(|\\s+v?\\d)'){$name=$candidate;break}
   }
  }
  if(-not $name){continue}
  $dirs=@()
  if($entry.InstallLocation){$dirs+=$entry.InstallLocation.Trim('"')}
  if($entry.DisplayIcon){
   $icon=$entry.DisplayIcon.Split(',')[0].Trim('"')
   if($icon -and (Test-Path -LiteralPath $icon -PathType Leaf)){$dirs+=(Split-Path -Parent $icon)}
   elseif($icon -and (Test-Path -LiteralPath $icon -PathType Container)){$dirs+=$icon}
  }
  foreach($dir in $dirs){
   $exe=$null
   if($dir.EndsWith('.exe',[System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $dir -PathType Leaf)){$exe=$dir}
   elseif(Test-Path -LiteralPath $dir -PathType Container){
    $guess=Join-Path $dir ($name+'.exe')
    if(Test-Path -LiteralPath $guess -PathType Leaf){$exe=$guess}
   }
   if($exe){$hits+=[pscustomobject]@{path=$exe;display=[string]$entry.DisplayName;version=[string]$entry.DisplayVersion};break}
  }
 }
}
if($hits.Count){$hits[0]|ConvertTo-Json -Compress}else{''}
`;
 try{
  const value=JSON.parse((await (options.run??runPowerShell)(script)).trim()||'null');
  if(!value||typeof value!=='object')return;
  const text=(item:unknown)=>typeof item==='string'&&item?item:undefined;
  return {path:text(value.path),version:versionOf(text(value.version)??'')??versionOf(text(value.display)??'')};
 }catch{return;}
}
const registryCache=new Map<string,{expires:number;value:Promise<RegistryApp|undefined>}>();
const cachedRegistryApp=(names:string[])=>{
 const key=names.join('|');const cached=registryCache.get(key);if(cached&&cached.expires>Date.now())return cached.value;
 const value=windowsRegistryApp(names);registryCache.set(key,{expires:Date.now()+60000,value});return value;
};
async function desktopInstallation(target:Target|'claude-desktop'|'workbuddy-ai'):Promise<AgentInstallation|undefined>{
 for(const path of desktopCandidates(target))try{
  let version:string|undefined;
  if(process.platform==='darwin'){
   const info=join(path,'Contents/Info.plist');const plist=await readFile(info,'utf8');
   version=plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
   if(!version&&plist.startsWith('bplist'))version=versionOf((await exec('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',info],{timeout:3000,maxBuffer:4096})).stdout);
  }else{
   await access(path,constants.F_OK);
   // Encode a literal path; never interpolate it into an executable shell command.
   const script=`(Get-Item -LiteralPath '${path.replaceAll("'","''")}').VersionInfo.ProductVersion`;
   try{version=versionOf((await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:3000,maxBuffer:4096,windowsHide:true})).stdout);}catch{/* Installation remains valid when metadata is unavailable. */}
  }
  return {installed:true,channel:'application',path,version,download:recipes[target].download,automatic:false,...agentCompatibility(target)};
 }catch{/* Next installation location. */}
 if(process.platform==='win32'){
  const names=desktopNames[target]??[];
  // Uninstall registration covers custom install directories that fixed roots miss.
  const registered=names.length?await cachedRegistryApp(names):undefined;
  if(registered?.path)return {installed:true,channel:'application',path:registered.path,version:registered.version,download:recipes[target].download,automatic:false,...agentCompatibility(target)};
 }
 if(process.platform==='win32'&&storePackages[target]){
  const store=await cachedStoreApp(target);
  if(store?.location)return {installed:true,channel:'application',path:store.location,version:store.version,download:recipes[target].download,automatic:false,...agentCompatibility(target)};
 }
}
async function detectInstallation(target:Target|'claude-desktop'|'workbuddy-ai'):Promise<AgentInstallation>{
 const recipe=recipes[target];
 const desktop=await desktopInstallation(target);if(desktop&&(target!=='codex'))return desktop;
 // DeepSeek is the official desktop app; Pi is the official coding-agent package.
 if(target==='deepseek'||target==='claude-desktop'||target==='workbuddy-ai')return {installed:false,channel:'missing',download:recipe.download,automatic:false,...agentCompatibility(target)};
 let path=await executable(recipe.bin);
 if(target==='claude'&&path&&/\.cmd$/i.test(path)){
  for(const name of ['bin/claude.exe','cli.js']){const native=join(dirname(path),'node_modules','@anthropic-ai','claude-code',name);try{await access(native,constants.F_OK);path=native;break;}catch{}}
 }
 if(path){const npmPackage=recipe.package?await packageOf(path,recipe.package):undefined;const npmVersion=npmPackage?.version;let version=npmVersion;
  // Recent Claude npm packages are launchers; metadata alone does not prove the native payload works.
  if(target==='claude')try{version=versionOf((await exec(path.endsWith('.js')?process.execPath:path,path.endsWith('.js')?[path,'--version']:['--version'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},timeout:10000,maxBuffer:4096,windowsHide:true})).stdout);if(!version)throw Error('missing version');}catch{return {installed:false,channel:'missing',path,download:recipe.download,automatic:!!npmPackage?.prefix,npmPrefix:npmPackage?.prefix,reason:'Claude Code 程序不完整，请重新安装修复。'};}
  if(!version&&['pi','claude','codex'].includes(target)&&process.platform!=='win32')try{version=versionOf((await exec(path,['--version'],{timeout:3000,maxBuffer:4096})).stdout);}catch{/* Unknown version never implies an update. */}
  return {installed:true,channel:npmVersion?'npm':'other',path,version,download:recipe.download,automatic:!!npmPackage?.prefix,npmPrefix:npmPackage?.prefix};
 }
 if(desktop)return desktop;
 return {installed:false,channel:'missing',download:recipe.download,automatic:!!recipe.package};
}
export async function detectAgent(target:Target|'claude-desktop'|'workbuddy-ai'):Promise<AgentInstallation>{
 const installation=await detectInstallation(target);
 return {...installation,configurationSupported:target==='claude'||installation.installed};
}
export class AgentInstallationManager {
 private busy=false;
 constructor(private processes:(target:Target)=>Promise<number[]>,private openExternal?:(url:string)=>Promise<void>){}
 async manage(target:Target,action:'install'|'update'){
  if(this.busy)throw failure('正在安装或更新 Agent，请稍候。');
  this.busy=true;
  try{
   const installed=await detectAgent(target),recipe=recipes[target];
   if(!installed.automatic){
    if(!this.openExternal)throw failure(`请通过官方下载页面${action==='install'?'安装':'更新'}：${recipe.download}`);
    await this.openExternal(recipe.download);return {message:'已打开官方页面，安装完成后会自动识别。',installation:installed};
   }
   if(action==='update'&&!installed.installed)throw failure('程序尚未安装，请先安装。');
   if(action==='install'&&installed.installed)return {message:'已经检测到此 Agent，无需重复安装。',installation:installed};
   if((await this.processes(target)).length)throw failure('请先保存工作并退出此 Agent，再安装或更新。');
   let npm=await executable('npm');
   if(npm&&!/[\\/]npm[\\/]bin[\\/]npm-cli\.js$/.test(npm)){const cli=join(dirname(npm),'node_modules','npm','bin','npm-cli.js');try{await access(cli,constants.F_OK);npm=cli;}catch{npm=undefined;}}
   if(!npm)throw failure('没有找到可用的 Node.js/npm，请先安装 Node.js 后重试。');
   // Fixed package names only; no shell or caller-controlled install arguments.
   const env:{[key:string]:string}=Object.fromEntries(['HOME','USERPROFILE','PATH','TMPDIR','TEMP','TMP','SystemRoot','APPDATA'].flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[]));
   // Running npm through Electron makes npm derive its default global prefix from the app bundle.
   // PREFIX is only a default: the user's .npmrc prefix still wins, and updates pass their own --prefix.
   if(action==='install'){const shim=await executable('npm',true);if(shim)env.PREFIX=process.platform==='win32'?dirname(shim):dirname(dirname(shim));}
   try{await exec(process.execPath,[npm,'install','--global',...(installed.npmPrefix?['--prefix',installed.npmPrefix]:[]),recipe.package,'--registry=https://registry.npmjs.org/',...(target==='claude'?['--ignore-scripts=false','--allow-scripts=@anthropic-ai/claude-code']:['--ignore-scripts']),'--no-audit','--no-fund'],{env:{...env,ELECTRON_RUN_AS_NODE:'1'},timeout:180000,maxBuffer:1024*1024,windowsHide:true});}
   catch{throw failure('安装或更新未完成，请检查网络和安装目录权限后重试。已有配置已保留。');}
   const next=await detectAgent(target);if(!next.installed)throw failure('安装命令已结束，但还未检测到程序，请检查 Node.js 安装目录。');
   return {message:`${action==='install'?'安装':'更新'}完成${next.version?` · ${next.version}`:''}，请重新打开 Agent。`,installation:next};
  }finally{this.busy=false;}
 }
}
