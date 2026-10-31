import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {withCodexBackupLock,assertCodexBackupLock} from './codex-backup-lock.js';
import {safePath} from './agent-connections.js';

export type HistorySnapshot={key:string;revision:string};
type Revision={size:number;full?:string;parent?:string;prefix?:number;suffix?:number;splices?:{offset:number;length:number}[]};
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');

/** Immutable full baseline plus byte deltas. Route changes never restore an old
 * snapshot over live history; these records are only the recovery journal. */
export class CodexHistoryBackups {
 private directory:string;
 constructor(private root:string){this.directory=join(root,'codex-history-backups');}
 private folder(key:string){if(!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid history backup key');return join(this.directory,key);}
 private async atomic(path:string,value:Buffer|string){
  assertCodexBackupLock(this.root);const temp=path+'.'+randomUUID();try{await writeFile(temp,value,{mode:0o600,flag:'wx'});assertCodexBackupLock(this.root);await rename(temp,path);}finally{await rm(temp,{force:true});}
 }
 async read(snapshot:HistorySnapshot):Promise<Buffer>{
  const folder=this.folder(snapshot.key),chain:{revision:string;meta:Revision}[]=[];let revision=snapshot.revision;const visited=new Set<string>();let contents:Buffer;
  for(;;){
   if(!/^[a-f0-9]{64}$/.test(revision)||visited.has(revision))throw Error('Invalid history backup revision');visited.add(revision);
   const meta=JSON.parse(await readFile(join(folder,revision+'.json'),'utf8')) as Revision;
   if(meta.full){await safePath(meta.full);contents=await readFile(meta.full);if(hash(contents)!==revision)throw Error('History backup baseline changed');break;}
   chain.push({revision,meta});if(!meta.parent)throw Error('Missing history backup parent');revision=meta.parent;
  }
  for(const {revision,meta} of chain.reverse()){
   const middle=await readFile(join(folder,revision+'.delta'));
   if(meta.splices){
    const output=Buffer.from(contents);let consumed=0,end=0;
    for(const part of meta.splices){
     if(!Number.isSafeInteger(part.offset)||!Number.isSafeInteger(part.length)||part.offset<end||part.length<=0||part.offset+part.length>output.length||consumed+part.length>middle.length)throw Error('Invalid history backup splice');
     middle.copy(output,part.offset,consumed,consumed+part.length);consumed+=part.length;end=part.offset+part.length;
    }
    if(consumed!==middle.length)throw Error('Incomplete history backup splices');contents=output;
   }else contents=Buffer.concat([contents.subarray(0,meta.prefix),middle,contents.subarray(contents.length-(meta.suffix??0))]);
   if(contents.length!==meta.size||hash(contents)!==revision)throw Error('History backup delta is incomplete');
  }
  return contents;
 }
 async capture(path:string,contents:Buffer,baseline?:string):Promise<HistorySnapshot>{return withCodexBackupLock(this.root,()=>this.captureLocked(path,contents,baseline));}
 private async captureLocked(path:string,contents:Buffer,baseline?:string):Promise<HistorySnapshot>{
  const key=hash(path),folder=this.folder(key),revision=hash(contents),snapshot={key,revision};await mkdir(folder,{recursive:true,mode:0o700});
  let previous:string|undefined;try{previous=(await readFile(join(folder,'latest'),'utf8')).trim();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!previous&&baseline){
   await safePath(baseline);const original=await readFile(baseline);previous=hash(original);
   await this.atomic(join(folder,previous+'.json'),JSON.stringify({size:original.length,full:baseline} satisfies Revision));
  }
  // A rollback may revisit an earlier revision. Reuse it rather than turning
  // the immutable parent chain into a cycle by overwriting its metadata.
  try{await this.read(snapshot);await this.atomic(join(folder,'latest'),revision);return snapshot;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  {
   let original:Buffer|undefined;
   if(previous&&previous!==revision)try{original=await this.read({key,revision:previous});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(original){
    let prefix=0,suffix=0;
    while(prefix<original.length&&prefix<contents.length&&original[prefix]===contents[prefix])prefix++;
    while(suffix<original.length-prefix&&suffix<contents.length-prefix&&original[original.length-1-suffix]===contents[contents.length-1-suffix])suffix++;
    // Protocol changes are small edits spread throughout an otherwise identical
    // rollout. One middle slice would copy almost the entire history again.
    const splices:{offset:number;length:number}[]=[];
    if(original.length===contents.length&&contents.length-prefix-suffix>65536){
     let start=prefix,last=prefix;
     for(let i=prefix;i<contents.length-suffix;i++)if(original[i]!==contents[i]){
      if(i-last>1024){splices.push({offset:start,length:last-start+1});start=i;}last=i;
     }
     splices.push({offset:start,length:last-start+1});
    }
    const sparse=splices.length>1&&splices.length<100000&&splices.reduce((sum,p)=>sum+p.length,0)+splices.length*40<(contents.length-prefix-suffix)/2;
    await this.atomic(join(folder,revision+'.delta'),sparse?Buffer.concat(splices.map(p=>contents.subarray(p.offset,p.offset+p.length))):contents.subarray(prefix,contents.length-suffix));
    await this.atomic(join(folder,revision+'.json'),JSON.stringify({size:contents.length,parent:previous,prefix,suffix,...(sparse?{splices}:{})} satisfies Revision));
   }else{
    const full=join(folder,revision+'.jsonl');await this.atomic(full,contents);
    await this.atomic(join(folder,revision+'.json'),JSON.stringify({size:contents.length,full} satisfies Revision));
   }
  }
  await this.atomic(join(folder,'latest'),revision);return snapshot;
 }
}
