// Synthetic backups only. Compare full content deduplication with switch-time reference checking.
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {CodexBackupMaintenance} from '../../../packages/core/src/codex-backup-maintenance.js';
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-backup-benchmark-'));
try{
 for(let i=0;i<12;i++){const id=randomUUID(),dir=join(root,'codex-thread-backups',id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'state_5.sqlite'),Buffer.alloc(16*1024*1024,i));await writeFile(join(dir,'manifest.json'),JSON.stringify({version:1,id,entries:[]}));}
 const start=performance.now(),full=await new CodexBackupMaintenance(root,async()=>{}).run(),fullMs=performance.now()-start;
 const again=performance.now(),switching=await new CodexBackupMaintenance(root,async()=>{}).run({deduplicate:false}),switchMs=performance.now()-again;
 const result={synthetic:true,historicalDatabaseBytes:12*16*1024*1024,full:{ms:Math.round(fullMs),...full},switching:{ms:Math.round(switchMs),...switching},sameReferences:full.verifiedReferences===switching.verifiedReferences};
 console.log(JSON.stringify(result));await writeFile('doc/testing/results/codex-backup-switch-benchmark-2026-11-01.json',JSON.stringify(result,null,2)+'\n');
}finally{await rm(root,{recursive:true,force:true});}
