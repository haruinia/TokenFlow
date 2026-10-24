import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApiSources } from '../packages/core/src/api-sources.js';
import { SupplierImporter } from '../packages/core/src/supplier-import.js';
import { defaultProvider } from '../packages/core/src/providers.js';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'supplier-import-test-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const values=new Map<string,string>();let failAt=0,sets=0;
 const sources=await ApiSources.open(root,{persistent:true,get:async k=>values.get(k)??'',set:async(k,v)=>{if(++sets===failAt)throw new Error('private storage detail');values.set(k,v);},remove:async k=>{values.delete(k);}},defaultProvider);
 cleanup.push(()=>sources.close());const importer=new SupplierImporter(sources,join(root,'cc-switch.db'));
 const preview=(data:unknown)=>importer.preview({file:'providers.json',content:Buffer.from(typeof data==='string'?data:JSON.stringify(data)).toString('base64')});
 return {root,values,sources,importer,preview,failNextBatch:()=>{failAt=sets+2;}};
}
const claude={id:'c',app_type:'claude',name:'Claude supplier',settings_config:JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://supplier.example/v1/messages',ANTHROPIC_AUTH_TOKEN:'test-secret-key',ANTHROPIC_MODEL:'claude-custom',ANTHROPIC_DEFAULT_SONNET_MODEL:'claude-custom'}})};
const codex={id:'d',app_type:'codex',name:'Codex supplier',settings_config:JSON.stringify({auth:{OPENAI_API_KEY:'other-secret'},config:'model="real-model"\nmodel_provider="custom"\n[model_providers.custom]\nbase_url="https://supplier.example/v1"\nwire_api="responses"',modelCatalog:{models:[{model:'catalog-model',displayName:'display-only'}]}})};
it('previews literal provider configuration without exposing secrets; atomically imports and deduplicates retries',async()=>{
 const {preview,importer,sources,root}=await fixture();const p=await preview([claude,codex]);
 expect(JSON.stringify(p)).not.toMatch(/secret|OPENAI_API_KEY|ANTHROPIC_AUTH/);expect(p.rows.map(r=>r.status)).toEqual(['ready','ready']);
 expect(p.rows[0].baseURL).toBe('https://supplier.example/v1');expect(p.rows[1].models).toEqual(['real-model','catalog-model']);
 expect(await importer.apply(p.token,['0','1'])).toEqual({imported:2,skipped:0});expect(await importer.apply(p.token,['0','1'])).toEqual({imported:2,skipped:0});expect(await sources.list()).toHaveLength(2);
 expect(await readFile(join(root,'api-sources.json'),'utf8')).not.toContain('secret');expect((await preview([claude])).rows[0].status).toBe('exists');
});
it('does not execute SQL statements or expressions while accepting official-style literal INSERT backups',async()=>{
 const {preview,importer,sources,root}=await fixture();const sentinel=join(root,'sentinel');await writeFile(sentinel,'keep');
 const quote=(s:string)=>"'"+s.replace(/'/g,"''")+"'";
 const p=await preview(`PRAGMA foreign_keys=OFF; CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, PRIMARY KEY(id,app_type)); INSERT INTO "providers" VALUES ('c','claude','O''Brien; sample',${quote(claude.settings_config)}); ATTACH DATABASE '${sentinel}' AS external; DELETE FROM providers; SELECT load_extension('not-executed');`);
 expect(p.rows[0].name).toBe("O'Brien; sample");await importer.apply(p.token,['0']);expect(await sources.list()).toHaveLength(1);expect(await readFile(sentinel,'utf8')).toBe('keep');
 await expect(preview("INSERT INTO providers(id,app_type,name,settings_config) VALUES ('x','claude',readfile('/etc/passwd'),'{}');")).rejects.toMatchObject({code:'supplier_import_invalid'});
});
it('reads the local SQLite table including committed WAL rows without modifying it',async()=>{
 const {root,importer}=await fixture();const path=join(root,'cc-switch.db'),db=new DatabaseSync(path);
 try{db.exec('PRAGMA journal_mode=WAL; CREATE TABLE providers(id TEXT,app_type TEXT,name TEXT,settings_config TEXT)');db.prepare('INSERT INTO providers VALUES(?,?,?,?)').run(claude.id,claude.app_type,claude.name,claude.settings_config);
  expect((await importer.preview({local:true})).rows[0].status).toBe('ready');expect(db.prepare('SELECT count(*) AS n FROM providers').get()?.n).toBe(1);
 }finally{db.close();}
});
it('rolls back the whole selection when a later encrypted credential fails, and supports retry',async()=>{
 const {preview,importer,sources,values,failNextBatch}=await fixture();const p=await preview([claude,codex]);failNextBatch();
 await expect(importer.apply(p.token,['0','1'])).rejects.toMatchObject({code:'supplier_import_storage'});expect(await sources.list()).toEqual([]);expect(values.size).toBe(0);
 expect(await importer.apply(p.token,['0','1'])).toEqual({imported:2,skipped:0});
});
it('skips managed credentials, external headers and invalid TOML without leaking raw values',async()=>{
 const {preview}=await fixture();const p=await preview([{...codex,category:'codex_oauth'},{...claude,settings_config:JSON.stringify({env:{ANTHROPIC_CUSTOM_HEADERS:'secret-header'}})},{...codex,settings_config:JSON.stringify({config:'model="secret-a"\nmodel="secret-b"'})}]);
 expect(p.rows.every(r=>r.status==='unsupported')).toBe(true);expect(JSON.stringify(p)).not.toContain('secret-');
});
it('detects duplicates created after preview and rejects invalid selection or discarded previews',async()=>{
 const {preview,importer,sources}=await fixture();const p=await preview([claude]);await expect(importer.apply(p.token,['9'])).rejects.toMatchObject({code:'supplier_import_invalid'});
 await sources.save({name:'Already added',baseURL:'https://supplier.example/v1',protocol:'messages',models:['claude-custom'],apiKey:'test-secret-key'});
 expect(await importer.apply(p.token,['0'])).toEqual({imported:0,skipped:1});const next=await preview([codex]);importer.discard(next.token);await expect(importer.apply(next.token,['0'])).rejects.toMatchObject({code:'supplier_import_invalid'});
});
it('supports legacy provider JSON and generic API sources while retaining real model IDs',async()=>{
 const {preview}=await fixture();expect((await preview({claude:{providers:{legacy:{name:'legacy',settingsConfig:JSON.parse(claude.settings_config)}}}})).rows[0].models).toEqual(['claude-custom']);
 expect((await preview({sources:[{name:'other',baseURL:'https://example.org/v1',apiKey:'key',protocol:'chat',models:['real-id']}]})).rows[0].status).toBe('ready');
});
it('uses CC Switch official protocol identifiers for both client kinds and Claude native route bases',async()=>{
 const {preview}=await fixture();
 const p=await preview([{...codex,meta:{apiFormat:'openai_responses'}},{...codex,meta:{apiFormat:'openai_chat'}},{...claude,meta:{apiFormat:'openai_chat'}},{...claude,meta:{apiFormat:'anthropic'},settings_config:JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://supplier.example/anthropic',ANTHROPIC_API_KEY:'fixture',ANTHROPIC_MODEL:'custom'}})}]);
 expect(p.rows.map(r=>r.protocol)).toEqual(['responses','chat','chat','messages']);expect(p.rows.every(r=>r.status!=='unsupported')).toBe(true);expect(p.rows[3].baseURL).toBe('https://supplier.example/anthropic/v1');
});
it('retains per-model routes and does not silently drop additional models sharing a credential',async()=>{
 const {preview,importer,sources}=await fixture();const base={name:'Mixed',baseURL:'https://example.org/v1',apiKey:'key',protocol:'responses',models:['a'],modelRoutes:{a:{protocol:'messages',baseURL:'https://example.org/anthropic/v1'}}};
 const p=await preview({sources:[base,{...base,models:['a','b']}]});expect(p.rows.map(row=>row.status)).toEqual(['ready','ready']);await importer.apply(p.token,['0','1']);expect((await sources.list())[0].modelRoutes).toEqual(base.modelRoutes);expect((await sources.list())[1].models).toEqual(['a','b']);
});
