import {lstat,opendir,realpath} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {cleanupCatalog,type CleanupRule} from './file-cleanup-catalog.js';
import {cleanupPathKey} from './file-cleanup-paths.js';
import {generatedOutputRule} from './file-cleanup-generated.js';
import {packagingFolders} from './file-cleanup-artifacts.js';

/** Enumerate accessible drive roots, never run a shell or request elevation. */
export async function cleanupDiskRoots(platform:NodeJS.Platform=process.platform):Promise<string[]>{
 if(platform==='win32'){
  const paths=Array.from({length:26},(_,index)=>`${String.fromCharCode(65+index)}:\\`);
  const available=await Promise.all(paths.map(async path=>{try{return (await lstat(path)).isDirectory()?path:undefined;}catch{return undefined;}}));
  return available.filter((path):path is string=>!!path);
 }
 // /Volumes, /mnt and /media are reached from /. /run is virtual, but its
 // desktop-managed removable media subtree is a separate scan root on Linux.
 const roots=['/'];
 if(platform==='linux')try{if((await lstat('/run/media')).isDirectory())roots.push('/run/media');}catch{}
 return roots;
}

const inside=(parent:string,path:string)=>{const rel=relative(parent,path);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`));};
const installers=/\.(?:dmg|pkg|msi|msix|appx|appimage|deb|rpm)$/i;
const packages=/\.(?:dmg|pkg|msi|msix|appx|appimage|deb|rpm|exe|zip|tar\.gz|tar\.xz)$/i;
const skippedNames=new Set(['.git','.hg','.svn','$recycle.bin','system volume information','.Trash','.Trashes']);
type DiscoveryOptions={home:string;platform:NodeJS.Platform;env?:NodeJS.ProcessEnv;profile:string;executablePath:string;roots:string[];signal:AbortSignal;deadline:number;maxDirectories?:number;onDirectory:(path:string,count:number)=>void;onRule:(rule:CleanupRule)=>Promise<void>};

/** Full-depth metadata discovery. Only recognized cache/dependency/package
 * candidates are offered; ordinary files are not inferred to be disposable. */
export async function discoverCleanupDirectories(options:DiscoveryOptions){
 const {home,platform,signal}=options;
 const templates=cleanupCatalog(home,platform,options.profile,{}).filter(rule=>inside(home,rule.path)&&!inside(options.profile,rule.path)).map(rule=>({...rule,suffix:cleanupPathKey(relative(home,rule.path),platform)}));
 const warnings:string[]=[],seen=new Set<string>(),physical=new Set<string>();let count=0,omitted=0,stopped=false;
 const key=(path:string)=>cleanupPathKey(resolve(path),platform);
 const note=(message:string)=>{omitted++;if(warnings.length<20)warnings.push(message);};
 const check=()=>{signal.throwIfAborted();if(Date.now()>options.deadline||count>=(options.maxDirectories??250000)){stopped=true;return false;}return true;};
 const system=(path:string)=>{
  if(platform==='darwin'&&['/System','/Library/Apple/System','/dev','/private/var/vm','/private/var/db'].some(root=>inside(root,path)))return true;
  if(platform==='linux'&&['/proc','/sys','/dev'].some(root=>inside(root,path)))return true;
  if(platform==='linux'&&inside('/run',path)&&!inside('/run/media',path))return true;
  if(platform==='linux'&&(path.endsWith(`${sep}.local${sep}share${sep}Trash`)||/^\.Trash-\d+$/.test(basename(path))))return true;
  const data=options.env?.XDG_DATA_HOME;
  return platform==='linux'&&!!data&&isAbsolute(data)&&inside(join(data,'Trash'),path);
 };
 const candidate=(path:string,name:string,category:CleanupRule['category'],risk:CleanupRule['risk'],description:string,impact:string):CleanupRule=>({path,name,category,risk,description,impact});
 const packageRule=(path:string,output:boolean)=>candidate(path,`${output?'打包产物':'安装包候选'} · ${basename(path)}`,'artifact',key(path)===key(options.executablePath)?'protected':'review','按文件类型与所在目录发现，尚未判断是否仍需保留。','请核对版本与用途；清理后可能需要重新下载、打包或安装。');
 const walk=async(path:string,depth:number,output:boolean):Promise<void>=>{
  if(!check())return;
  const normalized=key(path);if(seen.has(normalized)||system(path)||inside(options.profile,path))return;
  try{
   const info=await lstat(path);if(info.isSymbolicLink()||!info.isDirectory())return;
   if(key(await realpath(path))!==normalized){note(`已跳过重定向或符号链接目录：${path}`);return;}
   const identity=info.ino?`${info.dev}:${info.ino}`:undefined;
   if(identity&&physical.has(identity))return;if(identity)physical.add(identity);
   seen.add(normalized);count++;options.onDirectory(path,count);
   if(depth>80){note(`目录过深，未继续检查：${path}`);return;}
   const template=templates.find(rule=>normalized.endsWith(`${platform==='win32'?'\\':'/'}${rule.suffix}`));
   if(template){const {suffix,...rule}=template;await options.onRule({...rule,path});return;}
   const leaf=platform==='win32'?basename(path).toLowerCase():basename(path);
   if(leaf==='node_modules'){
    const active=inside(dirname(path),process.cwd())||inside(process.cwd(),dirname(path));
    const shared=normalized.replaceAll('\\','/').endsWith('/lib/node_modules')||normalized.replaceAll('\\','/').endsWith('/npm/node_modules');
    await options.onRule(candidate(path,`${basename(dirname(path))} · node_modules`,shared?'package':'project',active||shared?'protected':'review',shared?'全局共享依赖，可能提供多个应用或命令行工具。':'项目依赖，不能仅凭大小判断是否闲置。',shared?'清理可能导致全局命令与多个工具不可用；请先核对用途及恢复方式。':'清理会影响项目运行与构建，需使用锁文件重新安装依赖。'));return;
   }
   if(['.venv','venv'].includes(leaf)){
    try{if((await lstat(join(path,'pyvenv.cfg'))).isFile()){await options.onRule(candidate(path,`${basename(dirname(path))} · ${basename(path)}`,'project','review','项目的 Python 虚拟环境，可能仍在使用。','清理后需重新创建环境并安装依赖；请先停止 Python 与 Agent 任务。'));return;}}catch{}
   }
   const generated=await generatedOutputRule(path);if(generated){await options.onRule(generated);return;}
   if(['.turbo','.parcel-cache'].includes(leaf)||['.next/cache','node_modules/.vite'].some(suffix=>normalized.replaceAll('\\','/').endsWith(`/${suffix}`))){
    await options.onRule(candidate(path,`${basename(dirname(path))} · ${basename(path)}`,'build','rebuildable','开发工具生成的构建缓存。','请先停止构建；下次启动或构建会重新生成缓存。'));return;
   }
   if(platform==='darwin'&&/\.app$/i.test(basename(path))){
    const protectedApp=inside('/Applications',path)||inside('/Library',path)||inside(join(home,'Applications'),path)||inside(path,options.executablePath);
    await options.onRule(candidate(path,`应用文件 · ${basename(path)}`,'artifact',protectedApp?'protected':'review','应用程序包，未判断是否重复或仍在使用。','清理会移走此应用；请退出应用，核对版本并保留恢复方式。'));return;
   }
   const directory=await opendir(path);
   for await(const entry of directory){
    if(!check())break;
    const name=platform==='win32'?entry.name.toLowerCase():entry.name;
    if(entry.isSymbolicLink()||skippedNames.has(name))continue;
    const child=join(path,entry.name);
    if(entry.isDirectory())await walk(child,depth+1,output||packagingFolders.has(name));
    else if(entry.isFile()&&(installers.test(entry.name)||output&&packages.test(entry.name)||/(?:setup|installer|portable)[\w .-]*\.exe$/i.test(entry.name)))await options.onRule(packageRule(child,output));
   }
  }catch(error){if(signal.aborted)throw error;note(`无法完整检查目录：${path}`);}
 };
 for(const root of options.roots){if(!check())break;await walk(resolve(root),0,packagingFolders.has(platform==='win32'?basename(root).toLowerCase():basename(root)));}
 if(omitted>warnings.length)warnings.push(`另有 ${omitted-warnings.length} 个位置未完整检查。`);
 if(stopped)warnings.push('已达到全盘查找时限或目录上限，结果不覆盖所有位置；可选择具体磁盘或文件夹后再次扫描。');
 return {warnings,complete:!stopped&&omitted===0};
}
