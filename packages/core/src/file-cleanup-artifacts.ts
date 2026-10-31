import {lstat,opendir,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {CleanupLocation} from '../../../apps/shared/file-cleanup.js';
import type {CleanupRule} from './file-cleanup-catalog.js';
import {cleanupPaths,cleanupPathKey,type CleanupUserFolders} from './file-cleanup-paths.js';

export const packagingFolders=new Set(['release','releases','dist','out','artifacts','build']);
type SearchRoot={path:string;kind:'installed'|'user'|'output';depth:number};
type ArtifactOptions={home:string;platform:NodeJS.Platform;env?:NodeJS.ProcessEnv;applicationRoots?:string[];userFolders?:CleanupUserFolders;outputRoots?:string[];profile:string;executablePath:string;signal:AbortSignal;deadline:number;maxEntries?:number};
const within=(parent:string,path:string)=>{const rel=relative(parent,path);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`));};
const installer=/\.(?:dmg|pkg|msi|msix|appx|appimage|deb|rpm)$/i;
const packaged=/\.(?:dmg|pkg|msi|msix|appx|appimage|deb|rpm|exe|zip|tar\.gz|tar\.xz)$/i;
const copyMarker=/(?:[\s_-](?:copy|副本)(?:[\s_-]*\d+)?|\s*\(\d+\))$/i;
const appStem=(name:string)=>name.replace(/\.(?:app|appimage)$/i,'');
const identity=(name:string)=>appStem(name).normalize('NFKC').toLowerCase().replace(copyMarker,'').replace(/[\s_-]+v?\d+(?:\.\d+)+(?:[\w.-]*)$/i,'').replace(/[\s_-]+(?:arm64|x64|universal)$/i,'').trim();

function searchRoots(home:string,platform:NodeJS.Platform,env:NodeJS.ProcessEnv,applicationRoots?:string[],userFolders:CleanupUserFolders={}):SearchRoot[]{
 const {path:{join},envPath,absolute,local}=cleanupPaths(home,platform,env);
 const installed=applicationRoots??(platform==='darwin'?['/Applications',join(home,'Applications')]:platform==='win32'?[join(local,'Programs'),...new Set([envPath('ProgramFiles'),envPath('ProgramFiles(x86)')].filter((path):path is string=>!!path))]:['/opt',join(home,'Applications')]);
 return [...installed.map(path=>({path,kind:'installed' as const,depth:0})),{path:home,kind:'user',depth:0},{path:absolute(userFolders.downloads)??join(home,'Downloads'),kind:'user',depth:2},{path:absolute(userFolders.desktop)??join(home,'Desktop'),kind:'user',depth:2}];
}
export function artifactLocations(home:string,platform:NodeJS.Platform,env:NodeJS.ProcessEnv=process.env,applicationRoots?:string[],userFolders?:CleanupUserFolders):CleanupLocation[]{
 const {path:{basename}}=cleanupPaths(home,platform,env);
 return searchRoots(home,platform,env,applicationRoots,userFolders).map(root=>({path:root.path,name:root.kind==='installed'?'应用副本候选':root.path===home?'用户目录中的应用与安装包':`${basename(root.path)} 中的应用与安装包`,category:'artifact',risk:'review'}));
}

/** Candidate discovery only: names suggest copies; file contents are never compared. */
export async function discoverCleanupArtifacts(options:ArtifactOptions){
 const roots=[...searchRoots(options.home,options.platform,options.env??process.env,options.applicationRoots,options.userFolders),...(options.outputRoots??[]).map(path=>({path,kind:'output' as const,depth:3}))];
 const rules:CleanupRule[]=[],warnings:string[]=[],seen=new Set<string>(),apps:{path:string;name:string;kind:SearchRoot['kind']}[]=[];
 let visited=0;
 const check=()=>{options.signal.throwIfAborted();if(Date.now()>options.deadline||visited++>=(options.maxEntries??12000))throw new Error('应用与打包文件较多，已停止发现；请缩小项目范围后重新扫描。');};
 const safe=async(path:string)=>{const absolute=resolve(path),actual=await realpath(absolute);return cleanupPathKey(absolute,options.platform)===cleanupPathKey(actual,options.platform);};
 const protectedPath=(path:string)=>within(path,resolve(options.executablePath))||within(path,resolve(options.profile))||within(resolve(options.profile),path);
 const add=(path:string,name:string,description:string)=>rules.push({path,name,category:'artifact',risk:protectedPath(path)?'protected':'review',description,impact:protectedPath(path)?'当前 TokenFlow 或应用资料正在使用此位置；清理可能导致应用无法运行或资料丢失，请确认已备份且能恢复。':'这不是可自动判定的垃圾。请核对版本与用途并退出相关应用；清理后可能需要重新下载、打包或安装。'});
 const walk=async(root:SearchRoot,path:string,depth:number):Promise<void>=>{
  check();if(seen.has(path)||!(await safe(path)))return;seen.add(path);
  const dir=await opendir(path);
  for await(const entry of dir){
   check();if(entry.isSymbolicLink())continue;
   if(entry.name.startsWith('.')){if(root.kind==='installed'&&entry.isDirectory()&&/^\.tokenflow-before-\d+-[\w-]+$/.test(entry.name))await walk({...root,kind:'output',depth:0},join(path,entry.name),0);continue;}
   const child=join(path,entry.name);
   if(within(resolve(options.profile),resolve(child)))continue;
   if(entry.isDirectory()&&(options.platform==='darwin'?/\.app$/i.test(entry.name):root.kind==='installed')){
    apps.push({path:child,name:entry.name,kind:root.kind});continue;
   }
   if(entry.isFile()&&(installer.test(entry.name)||root.kind==='output'&&packaged.test(entry.name)||root.kind==='user'&&(/\.exe$/i.test(entry.name)||/\.(?:zip|tar\.gz|tar\.xz)$/i.test(entry.name)&&/(?:[\s_-]v?\d+\.\d+|setup|installer|portable|darwin|macos|win32|win64|linux|arm64|x64)/i.test(entry.name)))){
    add(child,`${root.kind==='output'?'打包产物':installer.test(entry.name)?'安装包':'应用包候选'} · ${entry.name}`,'按文件类型与所在目录发现的候选项；尚未判断是否仍需保留。');continue;
   }
   if(entry.isDirectory()&&depth<root.depth&&!['node_modules','vendor','Library','AppData','.git'].includes(entry.name))await walk(root,child,depth+1);
  }
 };
 for(const root of roots){
  try{if((await lstat(root.path)).isDirectory())await walk(root,resolve(root.path),0);}catch(error){if(options.signal.aborted)throw error;const code=(error as NodeJS.ErrnoException).code;if(code==='ENOENT')continue;if(Date.now()>options.deadline||visited>=(options.maxEntries??12000)){warnings.push((error as Error).message);break;}warnings.push(`应用与打包目录未完整检查：${root.path}`);}
 }
 const groups=new Map<string,typeof apps>();
 for(const app of apps){const key=identity(app.name);if(!key)continue;groups.set(key,[...(groups.get(key)??[]),app]);}
 for(const group of groups.values())for(const app of group){
  if(app.kind!=='installed'){
   add(app.path,`${group.length>1?'应用副本候选':app.kind==='output'?'打包应用':'应用文件'} · ${app.name}`,group.length>1?`与 ${group.filter(other=>other!==app).map(other=>other.path).slice(0,3).join('、')} 名称相近；仅为疑似重复，未比较文件内容。`:'位于用户目录或打包目录的应用，尚未判断是否仍在使用。');
  }else if(group.length>1){
   const isCopy=copyMarker.test(appStem(app.name));
   add(app.path,`${isCopy?'应用副本候选':'已安装应用'} · ${app.name}`,'发现名称相近的多个应用；未比较内容，不能据此认定版本相同或可以删除。');
   if(!isCopy)rules[rules.length-1].risk='protected';
  }
 }
 return {rules,warnings};
}
