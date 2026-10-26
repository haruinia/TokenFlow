import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it} from 'vitest';
// @ts-expect-error Build scripts are native ESM JavaScript.
import {cleanPackage} from '../scripts/clean-package.mjs';

const directories:string[]=[];
afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true});});

it('cleans packaging outputs while preserving reconciliation journals and other diagnostic artifacts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tokenflow-package-clean-'));directories.push(root);
 const journal=join(root,'artifacts','codex-reconciliation');await mkdir(journal,{recursive:true});
 await writeFile(join(journal,'events.jsonl'),'existing-account-response\n');
 await writeFile(join(journal,'monitor.json'),'{"since":"2026-10-17T00:00:00Z"}');
 await writeFile(join(journal,'recorder.lock'),'live-recorder-lock');
 await writeFile(join(root,'artifacts','audit.json'),'saved-diagnostic-report');
 await writeFile(join(root,'package.json'),'source-file');
 for(const name of ['release','.tmp','output']){await mkdir(join(root,name));await writeFile(join(root,name,'generated'),'output');}
 await cleanPackage(root);
 expect(await readFile(join(journal,'events.jsonl'),'utf8')).toBe('existing-account-response\n');
 expect(await readFile(join(journal,'monitor.json'),'utf8')).toBe('{"since":"2026-10-17T00:00:00Z"}');
 expect(await readFile(join(journal,'recorder.lock'),'utf8')).toBe('live-recorder-lock');
 expect(await readFile(join(root,'artifacts','audit.json'),'utf8')).toBe('saved-diagnostic-report');
 expect(await readFile(join(root,'package.json'),'utf8')).toBe('source-file');
 for(const name of ['release','.tmp','output'])await expect(access(join(root,name))).rejects.toMatchObject({code:'ENOENT'});
});
