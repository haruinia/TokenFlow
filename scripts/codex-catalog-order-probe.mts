/** Read the real installed engine's picker with an isolated catalog; no live inference/auth. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {stringify} from 'smol-toml';
import {mergeCodexCatalog} from '../packages/core/src/codex-coexist.ts';
import {codexModelCatalog} from '../packages/core/src/codex-model-catalog.ts';
const root=await mkdtemp(join(tmpdir(),'tf-catalog-order-')),home=join(root,'codex');await mkdir(home);
const official=JSON.parse(await readFile(join(homedir(),'.codex/models_cache.json'),'utf8'));
const gateway=codexModelCatalog(['fixture/gateway-a','fixture/gateway-b'],{'fixture/gateway-a':'Example · Gemini','fixture/gateway-b':'Example · DeepSeek'});
const merged=mergeCodexCatalog(gateway,official),catalog=join(root,'models.json');
assert.deepEqual(merged.models.slice(0,official.models.length),official.models);
await writeFile(catalog,JSON.stringify(merged));
await writeFile(join(home,'config.toml'),stringify({model:'fixture/gateway-a',model_provider:'token_flow',model_catalog_json:catalog,analytics:{enabled:false},features:{apps:false},model_providers:{token_flow:{name:'Fixture',base_url:'http://127.0.0.1:1/v1',wire_api:'responses',experimental_bearer_token:'fixture'}}}));
const proc=spawn('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});proc.stderr!.resume();
let seq=0,buffer='',error:string|undefined;const pending=new Map<number,any>(),rows:any[]=[];
proc.stdout!.on('data',c=>{buffer+=c;let at;while((at=buffer.indexOf('\n'))>=0){let m;try{m=JSON.parse(buffer.slice(0,at));}catch{}buffer=buffer.slice(at+1);const p=pending.get(m?.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}});
const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},15000);pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v);},reject:(e:any)=>{clearTimeout(t);reject(e);}});proc.stdin!.write(JSON.stringify({id,method,params})+'\n');});
try{
 await rpc('initialize',{clientInfo:{name:'catalog_order_probe',version:'1'},capabilities:{experimentalApi:true}});proc.stdin!.write('{"method":"initialized"}\n');
 let cursor:string|null=null;do{const r=await rpc('model/list',{limit:100,includeHidden:true,cursor});rows.push(...r.data);cursor=r.nextCursor;}while(cursor);
 const nativeIds=new Set(official.models.map((m:any)=>m.slug));
 const native=rows.filter(m=>nativeIds.has(m.model)),added=rows.filter(m=>gateway.models.some(g=>g.slug===m.model));
 assert.equal(added.length,2);assert.equal(native.length,official.models.length);
 assert.ok(rows.indexOf(added[0])>Math.max(...native.map(m=>rows.indexOf(m))));
 for(const m of native)assert.equal(m.displayName,official.models.find((o:any)=>o.slug===m.model).display_name);
 for(const m of added)assert.ok(m.displayName.startsWith('TokenFlow · '));
 assert.deepEqual(native.map(m=>m.model),[...official.models].sort((a:any,b:any)=>a.priority-b.priority).map((m:any)=>m.slug));
}catch(e){error=e instanceof Error?e.message:'Probe failed';process.exitCode=1;}
finally{if(proc.exitCode===null&&proc.signalCode===null)await new Promise<void>(r=>{proc.once('exit',()=>r());proc.kill();});await rm(root,{recursive:true,force:true});}
const report={passed:!error,...(error?{error}:{}),scope:'Installed official engine model/list, isolated home; no inference',officialMetadataUnchanged:true,modelOrder:rows.map(m=>({id:m.model,name:m.displayName}))};
console.log(JSON.stringify(report));const out=process.argv.indexOf('--out');if(out>=0)await writeFile(resolve(process.argv[out+1]),JSON.stringify(report,null,2)+'\n');
