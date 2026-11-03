import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {modelCapabilitiesSchema,type ModelCapabilities} from './model-capabilities.js';

/** Derived metadata only. Callers provide an identity revision, never credentials.
 * Cache reads cannot add models to an account's authorized model list. */
export class ModelMetadataCache{
 private directory:string;
 constructor(root:string){this.directory=join(root,'model-metadata');}
 private path(scope:readonly unknown[]){return join(this.directory,createHash('sha256').update(JSON.stringify(scope)).digest('hex')+'.json');}
 async read(scope:readonly unknown[],maxAge=7*86400000):Promise<{value:unknown;checkedAt:number}|undefined>{
  const path=this.path(scope);
  try{if((await lstat(this.directory)).isSymbolicLink())return;const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)return;
   const entry=JSON.parse(await readFile(path,'utf8')),age=Date.now()-entry.checkedAt;
   if(entry.version===1&&Number.isFinite(age)&&age>=0&&age<maxAge)return {value:entry.value,checkedAt:entry.checkedAt};
  }catch{/* A missing or corrupt derived cache is a miss, never a lost conversation. */}
 }
 async write(scope:readonly unknown[],value:unknown,checkedAt=Date.now()){
  await mkdir(this.directory,{recursive:true,mode:0o700});if((await lstat(this.directory)).isSymbolicLink())throw Error('Metadata cache directory must not be a symbolic link');
  const path=this.path(scope),temp=`${path}.${randomUUID()}.tmp`;
  try{await writeFile(temp,JSON.stringify({version:1,scope,checkedAt,value}),{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await rm(temp,{force:true});}
 }
 async remove(scope:readonly unknown[]){await rm(this.path(scope),{force:true});}
 async capabilities(scope:readonly unknown[]){const entry=await this.read(scope);const parsed=modelCapabilitiesSchema.safeParse(entry?.value);return parsed.success?parsed.data:undefined;}
 async remember(scope:readonly unknown[],capabilities:ModelCapabilities,checkedAt?:number){await this.write(scope,modelCapabilitiesSchema.parse(capabilities),checkedAt);}
}
