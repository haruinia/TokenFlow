// Diagnostic research fixture: never opens a real Codex profile.
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CodexContext} from '../packages/core/src/codex-context.ts';
import {GatewayContext} from '../packages/core/src/gateway-context.ts';
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-projection-research-'));
const logical='11111111-1111-4111-8111-111111111111';
const rollout='22222222-2222-4222-8222-222222222222';
try {
 const home=join(root,'codex'),directory=join(home,'sessions/2026/10/23');
 await mkdir(directory,{recursive:true});
 const file=join(directory,`rollout-2026-10-23T01-00-00-${logical}_${rollout}.jsonl`);
 const before=[{ordinal:0,type:'session_meta',payload:{id:logical,model_provider:'token_flow'}},{ordinal:1,type:'response_item',payload:{type:'reasoning',id:'rs_chatcmpl_'+'x'.repeat(160),encrypted_content:'',summary:[]}}].map(x=>JSON.stringify(x)+'\n').join('');
 await writeFile(file,before);
 const db=new DatabaseSync(join(home,'thread_history_1.sqlite'));
 const tables=['thread_turns','thread_items','thread_history_projection_state','thread_realtime_items'];
 for(const table of tables){db.exec(`create table ${table}(thread_id text, rollout_byte_offset integer)`);db.prepare(`insert into ${table} values (?,?)`).run(rollout,Buffer.byteLength(before));}
 const context=await GatewayContext.open(root);
 const migration=new CodexContext(root,join(home,'config.toml'),context);
 const result=await migration.prepareOfficial([],async()=>[]);
 const after=await readFile(file,'utf8');
 const stale=tables.filter(table=>!!db.prepare(`select 1 from ${table} where thread_id=?`).get(rollout));
 db.close();
 console.log(JSON.stringify({rewritten:result.migrated,beforeBytes:Buffer.byteLength(before),afterBytes:Buffer.byteLength(after),staleOffsetBeyondEOF:stale.length>0&&Buffer.byteLength(before)>Buffer.byteLength(after),remainingStaleProjections:stale,verdict:stale.length?'FAIL: rollout-ID projections survive logical-ID invalidation':'PASS'}));
 process.exitCode=stale.length?1:0;
} finally {await rm(root,{recursive:true,force:true});}
