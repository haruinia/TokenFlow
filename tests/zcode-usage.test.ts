import {expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readFile,symlink,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readZcodeUsage,zcodeChannel} from '../packages/core/src/zcode-usage.js';

function zcodeDatabase(path:string,rows:unknown[][]){
 const db=new DatabaseSync(path);
 db.exec('CREATE TABLE model_usage(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,provider_id TEXT,model_id TEXT,started_at INTEGER,completed_at INTEGER,status TEXT,input_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,cache_creation_input_tokens INTEGER,cache_read_input_tokens INTEGER,computed_total_tokens INTEGER,error_message TEXT)');
 const insert=db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');for(const row of rows)insert.run(...(row as never[]));db.close();
}

it('reads ZCode model usage with inclusive input and keeps coding-plan and key spend apart',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-zcode-')),now=Date.parse('2026-10-17T08:00:00Z');
 try{const path=join(root,'db.sqlite');zcodeDatabase(path,[
   ['u1','s','m1','zai-coding-plan','glm-4.6',now,now+900,'success',1000,200,50,100,600,1200,null],
   ['u2','s','m2','bigmodel-api','glm-4.6',now+1000,now+1500,'success',300,30,0,0,0,330,null],
   ['u3','s','m3','token-flow','antigravity/claude',now+2000,now+2500,'success',400,40,0,0,0,440,null],
   ['u4','s','m4','zai','glm-4.6',now+3000,now+3100,'error',0,0,0,0,0,0,'PRIVATE ERROR'],
  ]);
  const before=await readFile(path),rows=await readZcodeUsage(path);
  expect(rows).toHaveLength(2);
  expect(rows.find(r=>r.channel==='official')).toMatchObject({target:'zcode',provider:'zcode',origin:'native',model:'glm-4.6',requests:1,inputTokens:1000,cachedTokens:600,cacheWriteTokens:100,outputTokens:200,reasoningTokens:50});
  expect(rows.find(r=>r.channel==='api')).toMatchObject({inputTokens:300,outputTokens:30,requests:1});
  expect(JSON.stringify(rows)).not.toContain('PRIVATE');expect(await readFile(path)).toEqual(before);
  const link=join(root,'link.sqlite');await symlink(path,link);await expect(readZcodeUsage(link)).rejects.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});

it('maps ZCode provider families to official, API or unknown channels',()=>{
 expect(['bigmodel','zai','zhipu-account','bigmodel-coding-plan','zai-coding-plan'].map(zcodeChannel)).toEqual(Array(5).fill('oauth'));
 expect(['bigmodel-api','zai-api','custom'].map(zcodeChannel)).toEqual(Array(3).fill('api-key'));
 expect(zcodeChannel('openrouter')).toBeUndefined();
});
