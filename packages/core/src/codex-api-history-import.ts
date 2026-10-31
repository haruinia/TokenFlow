import {createHash,randomUUID} from 'node:crypto';
import {copyFile,mkdir,readFile,readdir,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,sep} from 'node:path';
import {readConfig,safePath} from './agent-connections.js';
import {codexRuntimeClient} from './codex-runtime.js';

/** One-time adoption of API chats created by the former shared-home mode.
 * Native archive keeps the old copy recoverable; no official/gateway chat is
 * copied, converted, compacted or removed. Never overwrite the adopted copy. */
export async function importLegacyApiHistory(original:string,destination:string,provider:string){
 const names=await readdir(original).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});
 const state=names.filter(n=>/^state_\d+\.sqlite$/.test(n)).sort((a,b)=>Number(b.match(/\d+/)![0])-Number(a.match(/\d+/)![0]))[0];if(!state)return;
 const {DatabaseSync}=await import('node:sqlite');await safePath(join(original,state));const db=new DatabaseSync(join(original,state),{readOnly:true});
 let rows:{id:string;path:string;archived:boolean}[];
 try{rows=db.prepare('SELECT id,rollout_path,archived FROM threads WHERE model_provider=?').all(provider).map(r=>({id:String(r.id),path:String(r.rollout_path),archived:!!r.archived}));}finally{db.close();}
 if(!rows.length)return;
 const journalPath=join(destination,'tokenflow-legacy-api-import.json');const raw=await readConfig(journalPath),done:Record<string,{copied:true;complete?:boolean}>=raw?JSON.parse(raw):{};
 const save=async()=>{const temp=journalPath+'.'+randomUUID();try{await writeImport(temp,done);await rename(temp,journalPath);}finally{await rm(temp,{force:true});}};
 const pending=rows.filter(r=>!done[r.id]?.complete);if(!pending.length)return;
 const copied:{id:string;path:string;archived:boolean}[]=[];
 for(const row of pending){
  if(done[row.id]?.copied){copied.push(row);continue;}
  const rel=relative(original,row.path);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)||!['sessions','archived_sessions'].includes(rel.split(sep)[0]!)||!/^rollout-.*\.jsonl$/.test(basename(row.path)))throw Error('旧 API 对话路径异常，原记录保留。');
  await safePath(row.path);const dest=join(destination,rel);await safePath(dest);await mkdir(dirname(dest),{recursive:true,mode:0o700});
  try{await copyFile(row.path,dest,constants.COPYFILE_EXCL);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
   const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
   if(hash(await readFile(row.path))!==hash(await readFile(dest)))throw Error('旧 API 对话与独立目录中的副本不同，已保留两份记录。');
  }
  done[row.id]={copied:true};await save();copied.push(row);
 }
 // Start native indexing only after every owned rollout exists, so inherited
 // branches can resolve their API ancestors without reading the ordinary home.
 const target=await codexRuntimeClient(destination);let source:Awaited<ReturnType<typeof codexRuntimeClient>>|undefined;
 try{
  for(const row of copied){
   if(row.archived)await target.rpc('thread/unarchive',{threadId:row.id});
   const result=await target.rpc('thread/resume',{threadId:row.id});if(result.thread?.modelProvider!==provider)throw Error('旧 API 对话来源未确认，原记录保留。');
   await target.rpc('thread/unsubscribe',{threadId:row.id});if(row.archived)await target.rpc('thread/archive',{threadId:row.id});
   source??=await codexRuntimeClient(original);if(!row.archived)await source.rpc('thread/archive',{threadId:row.id});
   done[row.id]={copied:true,complete:true};await save();
  }
 }finally{await target.close();await source?.close();}
}
async function writeImport(path:string,value:unknown){const {writeFile}=await import('node:fs/promises');await writeFile(path,JSON.stringify(value),{mode:0o600,flag:'wx'});}
