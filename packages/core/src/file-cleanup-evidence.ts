import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {basename,join,resolve} from 'node:path';
import type {CleanupEntry} from '../../../apps/shared/file-cleanup.js';
import {cleanupPathKey} from './file-cleanup-paths.js';
const packaged=/\.(?:dmg|pkg|msi|msix|appx|appimage|deb|rpm|exe|zip|tar\.gz|tar\.xz)$/i;
const sameStat=(a:Awaited<ReturnType<typeof lstat>>,b:Awaited<ReturnType<typeof lstat>>)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const numeric=(v:string)=>/^\d+(?:\.\d+){0,5}$/.test(v)?v.split('.').map(Number):undefined;
const compare=(a:string,b:string)=>{const x=numeric(a),y=numeric(b);if(!x||!y)return undefined;for(let i=0;i<Math.max(x.length,y.length);i++)if((x[i]??0)!==(y[i]??0))return (x[i]??0)-(y[i]??0);return 0;};
const family=(name:string)=>name.replace(packaged,'').replace(/(?:[\s_-](?:copy|副本)(?:[\s_-]*\d+)?|\s*\(\d+\))$/i,'').replace(/(?:^|[\s_-])v?\d+(?:\.\d+)+(?:[-.](?:beta|rc)\d*)?/ig,'').normalize('NFKC').toLowerCase();
export type ArtifactInspection={signal:AbortSignal;deadline:number;platform:NodeJS.Platform;maxHashBytes?:number;maxFileBytes?:number};
/** Bounded reads of application metadata and candidate packages only; no source or conversation files. */
export async function inspectArtifactEvidence(entries:CleanupEntry[],options:ArtifactInspection){
 let budget=options.maxHashBytes??256*1024*1024;const warnings:string[]=[];
 const check=()=>{options.signal.throwIfAborted();if(Date.now()>options.deadline)throw Error('应用版本与重复包检查达到时限，未验证项仍需人工核对。');};
 const safe=async(path:string)=>cleanupPathKey(await realpath(path),options.platform)===cleanupPathKey(resolve(path),options.platform);
 const boundedRead=async(path:string,limit:number)=>{
  check();if(!await safe(path))return;
  const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const before=await handle.stat();if(!before.isFile()||before.size>limit)return;const buffer=Buffer.alloc(before.size);let offset=0;
   while(offset<buffer.length){check();const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,null);if(!bytesRead)return;offset+=bytesRead;}
   if(!sameStat(before,await handle.stat())||!sameStat(before,await lstat(path)))return;return buffer;
  }finally{await handle.close();}
 };
 const apps:{entry:CleanupEntry;id:string;version:string;build:string}[]=[];
 const versions:{entry:CleanupEntry;family:string;version:string}[]=[];
 const files=new Map<string,CleanupEntry[]>();
 for(const entry of entries){
  if(entry.category!=='artifact'||!entry.complete||entry.state!=='ready')continue;
  try{
   check();if(!await safe(entry.path))continue;
   if(/\.app$/i.test(entry.path)){
    const path=join(entry.path,'Contents','Info.plist'),raw=await boundedRead(path,256*1024);if(!raw)continue;
    let plist:Record<string,unknown>={};
    if(raw.subarray(0,6).toString()==='bplist'&&process.platform==='darwin'){
     // plutil only decodes this checked metadata file; never execute the app itself.
     const stdout=await new Promise<string>((done,reject)=>{const child=execFile('/usr/bin/plutil',['-convert','json','-o','-','--','-'],{timeout:1000,maxBuffer:256*1024,signal:options.signal},(error,stdout)=>error?reject(error):done(stdout));child.stdin?.on('error',()=>{});child.stdin?.end(raw);});plist=JSON.parse(stdout);
    }else{const xml=raw.toString('utf8');for(const key of ['CFBundleIdentifier','CFBundleShortVersionString','CFBundleVersion']){const match=xml.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]{1,256})</string>`));if(match)plist[key]=match[1];}}
    const id=plist.CFBundleIdentifier,build=plist.CFBundleVersion,version=plist.CFBundleShortVersionString??build;
    if(typeof id==='string'&&typeof version==='string'&&id.length<=256&&version.length<=80){entry.artifact={...entry.artifact,groupKey:`app:${id}`,groupName:`${basename(entry.path).replace(/\.app$/i,'')} · 应用`,bundleId:id,version,...(typeof build==='string'&&build.length<=80?{build}:{}),basis:'bundle-metadata'};apps.push({entry,id,version,build:typeof build==='string'?build:''});}
   }else if(packaged.test(entry.path)){
    const stat=await lstat(entry.path);if(!stat.isFile())continue;
    const stem=basename(entry.path).replace(packaged,''),version=stem.match(/(?:^|[ _-])v?(\d+(?:\.\d+)+)(?=$|[ _-])/i)?.[1];
    const name=basename(entry.path),groupFamily=family(name)+':'+name.match(packaged)?.[0]?.toLowerCase();
    entry.artifact={basis:'filename',groupKey:`package:${groupFamily}`,groupName:`${name.replace(packaged,'').replace(/(?:[\s_-](?:copy|副本)(?:[\s_-]*\d+)?|\s*\(\d+\))$/i,'').replace(/(?:^|[\s_-])v?\d+(?:\.\d+)+(?:[-.](?:beta|rc)\d*)?/ig,'')} · 安装包`,...(version?{version}:{})};
    if(version)versions.push({entry,version,family:groupFamily});
    const key=`${family(basename(entry.path))}:${stat.size}`,group=files.get(key)??[];group.push(entry);files.set(key,group);
   }
  }catch(error){if(options.signal.aborted)throw error;if(Date.now()>options.deadline){warnings.push((error as Error).message);break;}}
 }
 for(const app of apps){const newer=apps.filter(other=>other.id===app.id&&((compare(other.version,app.version)??0)>0||compare(other.version,app.version)===0&&(compare(other.build,app.build)??0)>0)).sort((a,b)=>(compare(b.version,a.version)??0)||(compare(b.build,a.build)??0))[0];
  if(newer){app.entry.artifact!.newerPath=newer.entry.path;app.entry.description+=` 元数据版本 ${app.version}${app.build&&app.build!==app.version?`（构建 ${app.build}）`:''}，同应用发现更高版本：${newer.entry.path}。版本不同不代表内容重复，仍需核对架构、用途与回退需求。`;}
 }
 const sameVersions=new Map<string,typeof apps>();
 for(const app of apps){const key=JSON.stringify([app.id,app.version,app.build]);const group=sameVersions.get(key)??[];group.push(app);sameVersions.set(key,group);}
 for(const group of sameVersions.values())if(group.length>1){
  group.sort((a,b)=>Number(b.entry.risk==='protected')-Number(a.entry.risk==='protected')||a.entry.path.localeCompare(b.entry.path));
  for(const app of group.slice(1)){app.entry.artifact!.sameVersionPath=group[0].entry.path;app.entry.description+=` 同应用、同版本与构建号另有副本：${group[0].entry.path}。仅核对版本元数据，未认定整个应用内容一致。`;}
 }
 for(const file of versions){const newer=versions.filter(other=>other.family===file.family&&(compare(other.version,file.version)??0)>0).sort((a,b)=>(compare(b.version,a.version)??0))[0];if(newer){file.entry.artifact!.newerPath=newer.entry.path;file.entry.description+=` 文件名标注版本 ${file.version}，同名系列另有 ${newer.version}：${newer.entry.path}。这只是名称线索，不能证明实际应用版本、内容重复或已过时。`;}}
 let skipped=false;
 for(const group of files.values()){
  if(group.length<2)continue;
  const hashes=new Map<string,CleanupEntry[]>();
  for(const entry of group){
   try{check();if(entry.bytes>(options.maxFileBytes??64*1024*1024)||entry.bytes>budget){skipped=true;continue;}budget-=entry.bytes;
    const raw=await boundedRead(entry.path,options.maxFileBytes??64*1024*1024);if(!raw)continue;
    const hash=createHash('sha256').update(raw).digest('hex'),matching=hashes.get(hash)??[];matching.push(entry);hashes.set(hash,matching);
   }catch(error){if(options.signal.aborted)throw error;skipped=true;}
  }
  for(const matching of hashes.values())if(matching.length>1){matching.sort((a,b)=>Number(b.risk==='protected')-Number(a.risk==='protected')||(b.modifiedAt??'').localeCompare(a.modifiedAt??'')||a.path.localeCompare(b.path));
   for(const entry of matching.slice(1)){entry.artifact={...entry.artifact,basis:'content-sha256',duplicateOf:matching[0].path};entry.description+=` 安装包内容 SHA-256 相同：${matching[0].path}。这是本次扫描的内容比较，不自动决定保留哪一份；硬链接或文件系统克隆不代表可释放相同大小的空间。`;}
  }
 }
 if(skipped)warnings.push('部分安装包较大或达到内容比较预算，未比较完整内容；未标注重复不代表不存在重复。');
 return warnings;
}
