import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodexBackupMaintenance} from '../../../packages/core/src/codex-backup-maintenance.js';
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-backup-bench-'));
try{
 const id=randomUUID(),dir=join(root,'codex-thread-backups',id);await mkdir(dir,{recursive:true});
 const entries=[];
 for(let i=0;i<100;i++){await writeFile(join(dir,`${i}.jsonl`),String(i).padStart(8,'0')+'x'.repeat(128*1024));entries.push({id:`thread-${i}`,source:'vscode'});}
 await writeFile(join(dir,'manifest.json'),JSON.stringify({version:1,id,state:'restored',entries}));
 const maintenance=new CodexBackupMaintenance(root,async()=>{}),times=[];
 for(let i=0;i<2;i++){const start=performance.now();const result=await maintenance.run();times.push({ms:Math.round(performance.now()-start),...result});}
 console.log(JSON.stringify({files:100,synthetic:true,runs:times}));
}finally{await rm(root,{recursive:true,force:true});}
