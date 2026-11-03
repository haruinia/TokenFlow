import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createReadStream} from 'node:fs';
import {readdir,readFile,lstat,link,rename,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname,basename,sep} from 'node:path';
import {withCodexBackupLock,assertCodexBackupLock} from './codex-backup-lock.js';
import {safePath} from './agent-connections.js';
import {RunnerCoreError} from './errors.js';
const uuid=/^[a-f0-9-]{36}$/,hash=/^[a-f0-9]{64}$/;
const fail=()=>new RunnerCoreError('对话备份引用检查未通过，旧副本已保留，请检查备份后重试。',{statusCode:409,code:'codex_backup_reference_conflict'});
const signature=(s:Awaited<ReturnType<typeof lstat>>)=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export type BackupMaintenanceResult={verifiedReferences:number;sharedFiles:number;sharedLogicalBytes:number;removedUnreferencedFiles:number;removedLogicalBytes:number;hashedFiles:number;metadataReads:number};
type File={path:string;size:number;signature:string;dev:number;ino:number;nlink:number;mode:number;uid:number;gid:number};
/** Preserve all recovery points. Identical immutable backup files share storage
 * without changing their paths. Only unpublished payloads with no references
 * are removed; completed/restored journals are not themselves a deletion policy. */
export class CodexBackupMaintenance {
 private digests=new Map<string,string>();
 constructor(private root:string,private idle:()=>Promise<void>){}
 async run(options:{deduplicate?:boolean}={}):Promise<BackupMaintenanceResult>{return withCodexBackupLock(this.root,()=>this.runLocked(options.deduplicate!==false));}
 private async guard(){assertCodexBackupLock(this.root);await this.idle();}
 private async runLocked(deduplicate:boolean):Promise<BackupMaintenanceResult>{
  await this.guard();
  const bases=['codex-thread-backups','codex-context-backups','codex-history-backups'].map(n=>resolve(this.root,n));
  const inside=(path:string)=>bases.some(base=>{const rel=relative(base,path);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'));});
  const files=new Map<string,File>(),metadata=new Map<string,string>(),refs=new Set<string>(),expected=new Map<string,string>(),revisions=new Map<string,any>();
  const batches:{path:string;kind:number;manifest?:any}[]=[];
  for(const [kind,base] of bases.entries()){
   await safePath(base);let entries;try{entries=await readdir(base,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
   for(const dir of entries){if(!dir.isDirectory()||!(kind===2?hash:uuid).test(dir.name))continue;
    const path=join(base,dir.name);await safePath(path);const batch:{path:string;kind:number;manifest?:any}={path,kind};batches.push(batch);
    for(const entry of await readdir(path,{withFileTypes:true})){
     const file=join(path,entry.name);if(entry.isSymbolicLink())throw fail();if(!entry.isFile())continue;
     const s=await lstat(file);files.set(file,{path:file,size:s.size,signature:signature(s),dev:s.dev,ino:s.ino,nlink:s.nlink,mode:s.mode,uid:s.uid,gid:s.gid});
     if(entry.name==='manifest.json'||kind===2&&entry.name.endsWith('.json')&&hash.test(entry.name.slice(0,-5))){
      const raw=await readFile(file,'utf8');metadata.set(file,raw);let value;try{value=JSON.parse(raw);}catch{throw fail();}
      if(entry.name==='manifest.json')batch.manifest=value;else revisions.set(file.slice(0,-5),value);
     }
    }
   }
  }
  const reference=(path:string)=>{path=resolve(path);if(!inside(path)||!files.has(path))throw fail();refs.add(path);return path;};
  const snapshot=(value:any)=>{if(!value||!hash.test(value.key)||!hash.test(value.revision))throw fail();reference(join(bases[2]!,value.key,value.revision+'.json'));};
  for(const batch of batches){
   const m=batch.manifest;
   if(batch.kind===2)continue;
   // An unpublished legacy batch is retained: there is no durable statement of
   // whether a caller ever used its recovery data.
   if(!m){for(const f of files.values())if(dirname(f.path)===batch.path)refs.add(f.path);continue;}
   if(batch.kind===0){
    if(m.version!==1||!Array.isArray(m.entries)||!uuid.test(m.id)||join(bases[0]!,m.id)!==batch.path)throw fail();
    if(m.databaseBackup){if(!uuid.test(m.databaseBackup))throw fail();const dbdir=join(bases[0]!,m.databaseBackup);if(!batches.some(b=>b.path===dbdir))throw fail();for(const f of files.values())if(dirname(f.path)===dbdir&&f.path.endsWith('.sqlite'))reference(f.path);}
    for(const [i,e] of m.entries.entries()){
     const saved=e.historyBackup;let path=join(batch.path,`${i}.jsonl`);
     if(saved){if(!uuid.test(saved.journalId)||!/^\d+\.jsonl$/.test(saved.file))throw fail();path=join(bases[0]!,saved.journalId,saved.file);reference(path);}
     else if(files.has(path))reference(path);
     for(const s of e.historySnapshots??[])snapshot(s.snapshot);
    }
   }else{
    if(!Array.isArray(m.files))throw fail();
    for(const [i,f] of m.files.entries()){
     if(f.historySnapshot)snapshot(f.historySnapshot);
     else if(files.has(join(batch.path,`${i}.jsonl`)))reference(join(batch.path,`${i}.jsonl`));
    }
    for(const path of Object.values(m.databaseBackups??{})){if(typeof path!=='string')throw fail();reference(path);}
   }
   // Legacy SQLite snapshots are distinct recovery points even if no newer
   // manifest borrows them. Never substitute different database versions.
   for(const f of files.values())if(dirname(f.path)===batch.path&&f.path.endsWith('.sqlite'))refs.add(f.path);
  }
  for(const [id,meta] of revisions){
   if(!Number.isSafeInteger(meta.size)||meta.size<0)throw fail();
   refs.add(id+'.json');
   if(typeof meta.full==='string'){
    const path=reference(meta.full),revision=basename(id);
    if(expected.has(path)&&expected.get(path)!==revision)throw fail();expected.set(path,revision);
   }else{
    if(!hash.test(meta.parent)||!Number.isSafeInteger(meta.prefix)||meta.prefix<0||!Number.isSafeInteger(meta.suffix)||meta.suffix<0)throw fail();
    reference(join(dirname(id),meta.parent+'.json'));reference(id+'.delta');
   }
  }
  // Check parent cycles and latest pointers before any mutation.
  const checked=new Set<string>();
  for(const id of revisions.keys()){
   let next=id;const chain=new Set<string>();
   while(!checked.has(next)){
    if(chain.has(next))throw fail();chain.add(next);const m=revisions.get(next);if(!m)throw fail();if(m.full)break;next=join(dirname(next),m.parent);
   }
   for(const item of chain)checked.add(item);
  }
  for(const batch of batches.filter(b=>b.kind===2)){
   const file=join(batch.path,'latest');if(!files.has(file))continue;const raw=await readFile(file,'utf8');metadata.set(file,raw);const revision=raw.trim();if(!hash.test(revision))throw fail();reference(join(batch.path,revision+'.json'));
  }
  const unchanged=async(f:File)=>{await safePath(f.path);if(signature(await lstat(f.path))!==f.signature)throw fail();};
  let hashedFiles=0;
  const digest=async(f:File)=>{await unchanged(f);const cached=this.digests.get(f.signature);if(cached)return cached;const h=createHash('sha256');for await(const chunk of createReadStream(f.path))h.update(chunk);await unchanged(f);hashedFiles++;const value=h.digest('hex');if(this.digests.size>=4096)this.digests.delete(this.digests.keys().next().value!);this.digests.set(f.signature,value);return value;};
  const payloads=[...files.values()].filter(f=>/\.(jsonl|sqlite|delta)$/.test(f.path));
  const sizes=new Map<number,File[]>();for(const f of payloads){const list=sizes.get(f.size)??[];list.push(f);sizes.set(f.size,list);}
  const hashes=new Map<string,string>(),inodeHashes=new Map<string,string>();
  for(const f of deduplicate?payloads:[]){if((sizes.get(f.size)?.length??0)<2&&!expected.has(f.path))continue;await unchanged(f);const value=inodeHashes.get(f.signature)??await digest(f);inodeHashes.set(f.signature,value);hashes.set(f.path,value);if(expected.has(f.path)&&expected.get(f.path)!==value)throw fail();}
  const report:BackupMaintenanceResult={verifiedReferences:refs.size,sharedFiles:0,sharedLogicalBytes:0,removedUnreferencedFiles:0,removedLogicalBytes:0,hashedFiles,metadataReads:0};
  // Recheck every manifest/revision after hashing. Sharing preserves content and
  // every reference; interrupted sharing is safe and can be retried.
  const stableMetadata=async()=>{
   for(const [kind,base] of bases.entries()){
    const dirs=await readdir(base,{withFileTypes:true}).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});
    for(const d of dirs){if(!d.isDirectory()||!(kind===2?hash:uuid).test(d.name))continue;const path=join(base,d.name);if(!batches.some(b=>b.path===path))throw fail();
     for(const name of await readdir(path))if((name==='manifest.json'||kind===2&&(name==='latest'||name.endsWith('.json')&&hash.test(name.slice(0,-5))))&&!metadata.has(join(path,name)))throw fail();
    }
   }
   for(const [path,raw] of metadata){await safePath(path);if(await readFile(path,'utf8')!==raw)throw fail();}};
  await stableMetadata();await this.guard();
  const canonical=new Map<string,File>(),metadataKeys=new Map<string,string|undefined>();
  const metadataKey=async(f:File)=>{
   // macOS exposes both ACLs and extended-attribute values for equivalence.
   // Other platforms retain independent copies until an equivalent adapter is available.
   if(process.platform!=='darwin')return undefined;
   if(!metadataKeys.has(f.path)){
    try{
     report.metadataReads++;const run=promisify(execFile),options={encoding:'utf8' as const,maxBuffer:65536};
     const {stdout:listing}=await run('/bin/ls',['-lde','--',f.path],options);
     const {stdout:attributes}=await run('/usr/bin/xattr',['-lx',f.path],options);
     metadataKeys.set(f.path,createHash('sha256').update(listing.split('\n').slice(1).join('\n')).update('\0').update(attributes).digest('hex'));
    }catch{metadataKeys.set(f.path,undefined);}
   }
   return metadataKeys.get(f.path);
  };
  const candidates=new Map<string,Set<number>>();
  const group=(f:File)=>`${f.dev}:${f.mode}:${f.uid}:${f.gid}:${hashes.get(f.path)}`;
  for(const f of payloads)if(refs.has(f.path)&&hashes.has(f.path)){const key=group(f),inodes=candidates.get(key)??new Set<number>();inodes.add(f.ino);candidates.set(key,inodes);}
  for(const f of payloads){
   if(!refs.has(f.path))continue;const value=hashes.get(f.path);if(!value||(candidates.get(group(f))?.size??0)<2)continue;const meta=await metadataKey(f);if(!meta)continue;const key=`${f.dev}:${f.mode}:${f.uid}:${f.gid}:${meta}:${value}`,first=canonical.get(key);
   if(!first){canonical.set(key,f);continue;}if(first.ino===f.ino||f.nlink>1)continue;
   await this.guard();await unchanged(first);await unchanged(f);const temp=f.path+'.share-'+randomUUID();
   try{
    await link(first.path,temp);await unchanged(f);await rename(temp,f.path);
    // Creating/removing hard links changes inode ctime, including the source.
    const source=await lstat(first.path);first.signature=signature(source);
    const linked=await lstat(f.path);f.signature=signature(linked);f.ino=linked.ino;
    report.sharedFiles++;report.sharedLogicalBytes+=f.size;
   }catch(e){if(!['EPERM','ENOTSUP','EXDEV','EACCES','EMLINK'].includes((e as NodeJS.ErrnoException).code??''))throw e;}
   finally{await rm(temp,{force:true});const current=await lstat(first.path);first.signature=signature(current);}
  }
  // Only orphaned history-store payloads have an unambiguous unpublished meaning.
  // No automatic pruning of historical manifests or standalone legacy batches.
  for(const f of payloads){if(refs.has(f.path)||!f.path.startsWith(bases[2]!+sep))continue;
   if(!/^[a-f0-9]{64}\.(jsonl|delta)$/.test(basename(f.path)))continue;
   await this.guard();await stableMetadata();await unchanged(f);await rm(f.path);report.removedUnreferencedFiles++;report.removedLogicalBytes+=f.size;
  }
  return report;
 }
}
