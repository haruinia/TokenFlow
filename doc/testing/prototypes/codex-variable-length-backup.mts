import {mkdtemp,rm,stat,realpath,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {CodexHistoryBackups} from '../../../packages/core/src/codex-history-backups.js';
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-review-delta-'));
try{const store=new CodexHistoryBackups(root),history=Array.from({length:20},()=>JSON.stringify({type:'turn_context',model:'official-short'})+'\n'+JSON.stringify({type:'message',text:'SYNTHETIC '.repeat(20000)})+'\n').join('');
 const before=Buffer.from(history),after=Buffer.from(history.replaceAll('official-short','gateway/source/long-model-name'));
 const a=await store.capture('/synthetic/rollout.jsonl',before),b=await store.capture('/synthetic/rollout.jsonl',after);const delta=(await stat(join(root,'codex-history-backups',b.key,b.revision+'.delta'))).size;
 const result={synthetic:true,originalBytes:before.length,changedBytes:after.length,deltaBytes:delta,deltaPercent:Math.round(delta/after.length*100),restoresBoth:(await store.read(a)).equals(before)&&(await store.read(b)).equals(after)};
 console.log(JSON.stringify(result));await writeFile('doc/testing/results/codex-variable-length-backup-review-2026-10-31.json',JSON.stringify(result,null,2)+'\n');
}finally{await rm(root,{recursive:true,force:true});}
