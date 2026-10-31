import {createHash,randomUUID} from 'node:crypto';
import type {Stats} from 'node:fs';
import {lstat,opendir,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {CleanupEntry,CleanupSnapshot,CleanupMethod,CleanupScanScope} from '../../../apps/shared/file-cleanup.js';
import {cleanupCatalog,type CleanupRule} from './file-cleanup-catalog.js';
import {inspectArtifactEvidence} from './file-cleanup-evidence.js';
import {fileCleanupGuidance} from './file-cleanup-guidance.js';
import {artifactLocations,discoverCleanupArtifacts} from './file-cleanup-artifacts.js';
import {cleanupPathKey,type CleanupUserFolders} from './file-cleanup-paths.js';
import {cleanupDiskRoots,discoverCleanupDirectories} from './file-cleanup-discovery.js';

export type FileCleanupOptions={
 home?:string;platform?:NodeJS.Platform;env?:NodeJS.ProcessEnv;
 trashItem?:(path:string)=>Promise<void>;deleteItem?:(path:string)=>Promise<void>;pickDirectory?:()=>Promise<string|undefined>;reveal?:(path:string)=>Promise<void>;
 maxEntries?:number;maxItemMs?:number;maxScanMs?:number;maxDiscoveryDirectories?:number;diskRoots?:()=>Promise<string[]>;
 runningExecutables?:()=>Promise<string[]>;
 applicationRoots?:string[];userFolders?:CleanupUserFolders;executablePath?:string;
};
const failure=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const within=(parent:string,path:string)=>{const rel=relative(parent,path);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`));};
const overlaps=(a:string,b:string)=>within(a,b)||within(b,a);
const errorCode=(error:unknown)=>(error as NodeJS.ErrnoException).code;
type Measured={bytes:number;files:number;complete:boolean;fingerprint:string;rootIdentity?:string;blockedReason?:string;modifiedAt?:string;issue?:string};
type Candidate={rule:CleanupRule;fingerprint:string;rootIdentity:string;complete:boolean};
const rootIdentity=(info:Stats)=>JSON.stringify([info.dev,info.ino,info.birthtimeMs,info.isDirectory(),info.isFile()]);

/** Metadata scans with bounded application/package evidence reads. Mutations accept scan IDs, never client supplied paths or commands. */
export class FileCleanup {
 private readonly home:string;
 private state:CleanupSnapshot;
 private candidates=new Map<string,Candidate>();
 private controller?:AbortController;
 private pending:Promise<void>=Promise.resolve();
 private picking=false;
 private scanDeadline=0;
 private scanFinished=0;
 constructor(private profile:string,private options:FileCleanupOptions={}){
  this.options={...options,env:{...(options.env??process.env)}};
  this.home=resolve(options.home??homedir());
  this.profile=resolve(profile);
  const locations=[...cleanupCatalog(this.home,options.platform??process.platform,this.profile,this.options.env).map(({name,path,category,risk})=>({name,path,category,risk})),...artifactLocations(this.home,options.platform??process.platform,this.options.env,options.applicationRoots,options.userFolders)];
  this.state={status:'idle',checked:0,planned:0,entries:[],locations,warnings:[],projectRoots:[],scanScope:'common',diskRoots:[],walkedDirectories:0,platform:options.platform??process.platform,capabilities:{trash:!!options.trashItem,delete:!!options.deleteItem,pickDirectory:!!options.pickDirectory,reveal:!!options.reveal}};
 }
 snapshot():CleanupSnapshot{return structuredClone(this.state);}
 report(){
  const {entries,...scan}=this.snapshot();
  return {guidance:fileCleanupGuidance(this.home,this.options.platform??process.platform,this.profile,this.options.env),scan:{...scan,entries:entries.slice(0,30),totalEntries:entries.length,totals:Object.fromEntries(['rebuildable','review','protected'].map(risk=>[risk,entries.filter(e=>e.risk===risk&&e.state!=='trashed'&&e.state!=='deleted').reduce((sum,e)=>sum+e.bytes,0)]))}};
 }
 isCleaning(){return this.state.status==='cleaning';}
 settled(){return this.pending;}
 private busy(){return this.picking||['scanning','cleaning'].includes(this.state.status);}
 private resetResults(){
  this.candidates.clear();this.scanFinished=0;
  const locations=[...cleanupCatalog(this.home,this.options.platform??process.platform,this.profile,this.options.env).map(({name,path,category,risk})=>({name,path,category,risk})),...artifactLocations(this.home,this.options.platform??process.platform,this.options.env,this.options.applicationRoots,this.options.userFolders)];
  this.state={...this.state,status:'idle',scanId:undefined,startedAt:undefined,finishedAt:undefined,current:undefined,entries:[],locations,checked:0,planned:0,walkedDirectories:0,result:undefined,warnings:[]};
 }
 async configureScope(scope:CleanupScanScope){
  if(this.busy())throw failure('请等待当前扫描或清理完成。');
  this.picking=true;
  try{
   const diskRoots=scope==='all'?await(this.options.diskRoots??(()=>cleanupDiskRoots(this.options.platform??process.platform)))():[];
   if(scope==='all'&&!diskRoots.length)throw failure('未找到可访问的磁盘，请选择扫描位置。',400);
   this.state={...this.state,scanScope:scope,diskRoots};this.resetResults();
   return this.snapshot();
  }finally{this.picking=false;}
 }
 async addProjectRoot(){
  if(this.busy())throw failure('请等待当前扫描或清理完成。');
  if(!this.options.pickDirectory)throw failure('请在桌面版中选择扫描位置。',400);
  this.picking=true;
  try{
   const selected=await this.options.pickDirectory();if(!selected)return this.snapshot();
   const path=await realpath(resolve(selected));
   if(!(await lstat(path)).isDirectory())throw failure('请选择文件夹或磁盘。',400);
   if(this.state.projectRoots.some(root=>within(root,path)))return this.snapshot();
   if(this.state.projectRoots.length>=8)throw failure('最多添加 8 个扫描位置。',400);
   this.state.projectRoots=this.state.projectRoots.filter(root=>!within(path,root)).concat(path);
   this.resetResults();
   return this.snapshot();
  }finally{this.picking=false;}
 }
 removeProjectRoot(index:number){
  if(this.busy())throw failure('请等待当前扫描或清理完成。');
  if(!Number.isInteger(index)||index<0||index>=this.state.projectRoots.length)throw failure('扫描位置不存在。',400);
  this.state.projectRoots.splice(index,1);this.resetResults();return this.snapshot();
 }
 start(){
  if(this.busy())throw failure('扫描或清理正在进行。');
  this.controller=new AbortController();this.candidates.clear();this.scanFinished=0;
  this.state={...this.state,scanId:randomUUID(),status:'scanning',startedAt:new Date().toISOString(),finishedAt:undefined,current:undefined,checked:0,planned:0,walkedDirectories:0,entries:[],warnings:[],result:undefined};
  this.scanDeadline=Date.now()+(this.options.maxScanMs??(this.state.scanScope==='all'?15*60*1000:180000));
  this.pending=this.scan(this.controller.signal).catch(error=>{
   this.state.status=this.controller?.signal.aborted?'cancelled':'failed';
   if(this.state.status==='failed')this.state.warnings.push(error instanceof Error?error.message:'扫描失败，请重新扫描。');
  }).finally(()=>{this.state.entries.sort((a,b)=>b.bytes-a.bytes);this.state.current=undefined;this.state.finishedAt=new Date().toISOString();});
  return this.snapshot();
 }
 cancel(){if(this.state.status==='scanning')this.controller?.abort();return this.snapshot();}
 private async canonical(path:string){
  const absolute=resolve(path),actual=await realpath(absolute);
  // Refuse symbolic links in ancestors as well as at the candidate root.
  const platform=this.options.platform??process.platform;
  if(cleanupPathKey(actual,platform)!==cleanupPathKey(absolute,platform))throw failure('路径含符号链接，已跳过。');
  const info=await lstat(absolute);
  if(info.isSymbolicLink())throw failure('路径含符号链接，已跳过。');
  return info;
 }
 private async measure(path:string,signal:AbortSignal,deadline:number):Promise<Measured>{
  let bytes=0,files=0,visited=0,modified=0,complete=true,issue:string|undefined;
  const hash=createHash('sha256'),seen=new Set<string>();
  let identity:string;
  try{identity=rootIdentity(await this.canonical(path));}catch(error){
   signal.throwIfAborted();
   const blockedReason=error instanceof Error&&'statusCode' in error?error.message:'无法确认所选路径，请重新扫描。';
   return {bytes,files,complete:false,fingerprint:hash.digest('hex'),blockedReason};
  }
  const check=()=>{signal.throwIfAborted();if(Date.now()>deadline||visited>=(this.options.maxEntries??200000))throw failure('已达到扫描上限，大小仅为已统计部分；仍可选择清理。');};
  const walk=async(file:string,depth:number):Promise<void>=>{
   check();visited++;
   try{
    const info=await lstat(file);
    hash.update(JSON.stringify([relative(path,file),info.dev,info.ino,info.mode,info.size,info.mtimeMs,info.ctimeMs]));
    if(info.isSymbolicLink())return;
    modified=Math.max(modified,info.mtimeMs);
    if(info.isFile()){
     const key=`${info.dev}:${info.ino}`;if(seen.has(key))return;seen.add(key);
     bytes+=info.size;files++;return;
    }
    if(!info.isDirectory())return;
    if(depth>80)throw failure('目录层级过深，未完整统计。');
    const directory=await opendir(file);
    for await(const entry of directory)await walk(join(file,entry.name),depth+1);
   }catch(error){
    if(signal.aborted)throw error;
    complete=false;
    issue=errorCode(error)==='EACCES'||errorCode(error)==='EPERM'?'部分文件无法读取，大小未完整统计；仍可选择清理。':errorCode(error)==='ENOENT'?'扫描时部分文件发生变化，大小仅供参考。':error instanceof Error&&'statusCode' in error?error.message:'部分文件未能统计，大小仅供参考；仍可选择清理。';
    if(Date.now()>deadline||visited>=(this.options.maxEntries??200000))throw failure(issue);
   }
  };
  try{await walk(path,0);}catch(error){if(signal.aborted)throw error;complete=false;issue=error instanceof Error&&'statusCode' in error?error.message:'未能完整统计大小，仍可选择清理。';}
  return {bytes,files,complete,issue,rootIdentity:identity,fingerprint:hash.digest('hex'),modifiedAt:modified?new Date(modified).toISOString():undefined};
 }
 private async scan(signal:AbortSignal){
  const rules=cleanupCatalog(this.home,this.options.platform??process.platform,this.profile,this.options.env);
  const artifactScope=artifactLocations(this.home,this.options.platform??process.platform,this.options.env,this.options.applicationRoots,this.options.userFolders);
  this.state.locations=[...rules.map(({name,path,category,risk})=>({name,path,category,risk})),...artifactScope];
  // Additional OpenClaw profiles are personal data too; never infer that they are unused.
  try{const home=await opendir(this.home);for await(const entry of home){signal.throwIfAborted();if(entry.isDirectory()&&entry.name.startsWith('.openclaw-'))rules.push({path:join(this.home,entry.name),name:entry.name,category:'agent',risk:'protected',description:'独立 OpenClaw 资料，可能包含记忆、配置或登录。',impact:'清理可能丢失记忆、配置和登录，请核对用途并备份。'});}}catch(error){if(signal.aborted)throw error;this.state.warnings.push('无法枚举额外的 OpenClaw 资料目录。');}
  const blocked=rules.filter(rule=>rule.risk==='protected').map(rule=>resolve(rule.path));
  this.state.current='正在检查应用副本与打包版本';
  const artifacts=await discoverCleanupArtifacts({home:this.home,platform:this.options.platform??process.platform,env:this.options.env,applicationRoots:this.options.applicationRoots,userFolders:this.options.userFolders,profile:this.profile,executablePath:this.options.executablePath??process.execPath,signal,deadline:this.scanDeadline});
  rules.push(...artifacts.rules);this.state.warnings.push(...artifacts.warnings);
  this.state.locations=[...rules.map(({name,path,category,risk})=>({name,path,category,risk})),...artifactScope];
  blocked.push(...artifacts.rules.filter(rule=>rule.risk==='protected').map(rule=>resolve(rule.path)));
  this.state.planned=rules.length;
  const measuredPaths=new Set<string>();
  const measureRule=async(rule:CleanupRule)=>{
   signal.throwIfAborted();
   if(Date.now()>this.scanDeadline)return;
   const path=resolve(rule.path),key=cleanupPathKey(path,this.options.platform??process.platform);
   if(measuredPaths.has(key))return;measuredPaths.add(key);
   this.state.current=rule.path;this.state.checked++;
   try{await lstat(rule.path);}catch(error){if(errorCode(error)!=='ENOENT')this.state.warnings.push(`无法访问：${rule.path}`);return;}
   // No nested selections, so bytes are not double counted and parents cannot subsume protected data.
   if(this.state.entries.some(entry=>overlaps(entry.path,path)))return;
   if(rule.risk!=='protected'&&blocked.some(root=>overlaps(root,path)))return;
   const measured=await this.measure(path,signal,Math.min(this.scanDeadline,Date.now()+(this.options.maxItemMs??20000)));
   if(measured.bytes===0&&measured.complete)return;
   const id=randomUUID();const {fingerprint,rootIdentity,...metadata}=measured;
   this.state.entries.push({...rule,path,id,...metadata,state:'ready'});
   if(rootIdentity)this.candidates.set(id,{rule:{...rule,path},fingerprint,rootIdentity,complete:measured.complete});
  };
  for(const rule of rules)await measureRule(rule);
  const roots=[...(this.state.scanScope==='all'?this.state.diskRoots:[]),...this.state.projectRoots];
  if(roots.length){
   const discovery=await discoverCleanupDirectories({home:this.home,platform:this.options.platform??process.platform,env:this.options.env,profile:this.profile,executablePath:this.options.executablePath??process.execPath,roots,signal,deadline:this.scanDeadline,maxDirectories:this.options.maxDiscoveryDirectories,onDirectory:(path,count)=>{this.state.current=path;this.state.walkedDirectories=count;},onRule:async rule=>{
    if(rule.risk==='protected')blocked.push(resolve(rule.path));
    if(!measuredPaths.has(cleanupPathKey(resolve(rule.path),this.options.platform??process.platform))){
     this.state.planned++;const {name,path,category,risk}=rule;this.state.locations.push({name,path,category,risk});
     await measureRule(rule);
    }
   }});
   this.state.warnings.push(...discovery.warnings);
  }
  if(Date.now()>this.scanDeadline)this.state.warnings.push('已达到扫描时限，结果仅覆盖已完成检查的位置。');
  this.state.current='正在核对应用版本与重复安装包';
  this.state.warnings.push(...await inspectArtifactEvidence(this.state.entries,{platform:this.options.platform??process.platform,signal,deadline:this.scanDeadline}));
  const running=await this.runningPaths();
  for(const entry of this.state.entries){const reason=this.inUse(entry.path,running);if(reason){entry.blockedReason=reason;entry.risk='protected';}}
  this.state.status='complete';this.scanFinished=Date.now();
 }
 private async runningPaths(){try{return await this.options.runningExecutables?.()??[];}catch{return undefined;}}
 private inUse(path:string,running:string[]|undefined){
  if(within(path,resolve(this.options.executablePath??process.execPath)))return '当前 TokenFlow 程序正在使用，不能在应用内清理自身。';
  if(running===undefined&&(/\.app$/i.test(path)||/\.(exe|appimage)$/i.test(path)))return '无法核对运行中的程序，请稍后重新扫描。';
  if(running?.some(executable=>within(path,resolve(executable))))return '此位置包含正在运行的程序，请退出后重新扫描。';
 }
 clean(scanId:string,ids:string[],confirmReview:boolean,method:CleanupMethod='trash',confirmPermanent=false,confirmProtected=false){
  if(this.busy())throw failure('扫描或清理正在进行。');
  const perform=method==='delete'?this.options.deleteItem:this.options.trashItem;
  if(!perform)throw failure('当前清理方式不可用；只读服务请在桌面版中清理。',400);
  if(method==='delete'&&!confirmPermanent)throw failure('永久删除不可从回收站恢复，请先人工确认。',400);
  if(this.state.status!=='complete'||scanId!==this.state.scanId||Date.now()-this.scanFinished>30*60*1000)throw failure('扫描结果已失效，请重新扫描。');
  if(!ids.length||ids.length>200||new Set(ids).size!==ids.length)throw failure('请选择有效且不重复的清理项。',400);
  const selected=ids.map(id=>{
   const candidate=this.candidates.get(id),entry=this.state.entries.find(e=>e.id===id);
   if(!entry||entry.state!=='ready')throw failure('所选项不存在或需要重新扫描。',400);
   if(entry.blockedReason)throw failure(entry.blockedReason);
   if(!candidate)throw failure('所选项不存在或需要重新扫描。',400);
   if(entry.risk==='protected'&&!confirmProtected)throw failure('请先核对受保护数据的丢失风险，再确认清理。',400);
   if(entry.risk==='review'&&!confirmReview)throw failure('请先确认需要人工判断的项目及其影响。',400);
   return {candidate,entry};
  });
  this.state.status='cleaning';this.state.result={method,moved:0,deleted:0,bytes:0,failed:0};
  this.pending=(async()=>{
   for(const {candidate,entry} of selected){
    this.state.current=entry.path;
    try{
     const running=await this.runningPaths(),reason=this.inUse(candidate.rule.path,running);if(reason)throw failure(reason);
     // Incomplete size estimates do not revoke the user's choice to remove this
     // directory. Only compare whole-tree fingerprints when both are complete.
     if(candidate.complete){
      const current=await this.measure(candidate.rule.path,new AbortController().signal,Date.now()+(this.options.maxItemMs??20000));
      if(current.complete&&current.fingerprint!==candidate.fingerprint)throw failure('文件已变化，请重新扫描。');
     }
     if(rootIdentity(await this.canonical(candidate.rule.path))!==candidate.rootIdentity)throw failure('文件已变化，请重新扫描。');
     await perform(candidate.rule.path);
     entry.state=method==='delete'?'deleted':'trashed';this.state.result![method==='delete'?'deleted':'moved']++;this.state.result!.bytes+=entry.bytes;
     if(!entry.complete)this.state.result!.bytesIncomplete=true;
    }catch(error){
     entry.state='failed';entry.issue=error instanceof Error&&'statusCode' in error?error.message:method==='delete'?'永久删除未完成，部分文件可能已删除。请检查文件占用或权限后重新扫描。':'无法移到系统回收站 / 废纸篓。请关闭相关应用、检查权限后重新扫描；未自动改为永久删除。';this.state.result!.failed++;
    }
    this.candidates.delete(entry.id);
   }
  })().finally(()=>{this.state.status='complete';this.state.current=undefined;});
  return this.snapshot();
 }
 async reveal(id:string){
  const entry=this.state.entries.find(item=>item.id===id);
  if(!entry||entry.state==='trashed'||entry.state==='deleted')throw failure('该扫描项已不存在，请重新扫描。',400);
  if(!this.options.reveal)throw failure('请在桌面版中打开文件位置。',400);
  await this.canonical(entry.path);await this.options.reveal(entry.path);return {opened:true};
 }
 async close(){this.controller?.abort();await this.pending;}
}
