import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parse,stringify} from 'smol-toml';
import {CodexApiAccess} from '../packages/core/src/codex-api-access.js';
import {CodexApiDirect} from '../packages/core/src/codex-api-direct.js';
import {configureNativeUnifiedAgents} from '../packages/core/src/codex-unified-agent-catalog.js';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const a={sourceId:'a'.repeat(24),name:'A',model:'same-model',baseURL:'https://a.example.test/v1',apiKey:'synthetic-a'};
const b={...a,sourceId:'b'.repeat(24),name:'B',baseURL:'https://b.example.test/v1',apiKey:'synthetic-b'};
async function setup(provider='openai'){
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-api-shared-'));roots.push(root);
 const home=join(root,'home');await mkdir(join(home,'sessions'),{recursive:true});const config=join(home,'config.toml');
 const before=stringify({model:'original-model',model_provider:provider,features:{multi_agent_v2:provider==='openai'},...(provider==='token_flow'?{model_providers:{token_flow:{base_url:'http://127.0.0.1:9527/codex/v1',wire_api:'responses',requires_openai_auth:true}}}:{})});
 await writeFile(config,before);await writeFile(join(home,'auth.json'),'original-account-login');await writeFile(join(home,'sessions','history.jsonl'),'original-history');
 const api=new CodexApiAccess(root,config,async()=>[]);return {root,home,config,before,api};
}
it.each(['openai','token_flow'])('switches APIs through shared custom without migrating %s history or altering login',async provider=>{
 const {root,home,config,before,api}=await setup(provider);
 for(const selection of [a,b]){
  await api.apply(selection,await api.revision());
  const doc:any=parse(await readFile(config,'utf8'));
  expect(doc.model_provider).toBe('custom');expect(doc.model_providers.custom).toMatchObject({base_url:selection.baseURL,experimental_bearer_token:selection.apiKey});
  if(provider==='token_flow')expect(doc.model_providers.token_flow).toEqual((parse(before) as any).model_providers.token_flow);
  expect(await api.launchEnvironment()).toEqual({});
  expect(await readFile(join(home,'auth.json'),'utf8')).toBe('original-account-login');
  expect(await readFile(join(home,'sessions','history.jsonl'),'utf8')).toBe('original-history');
  await expect(readFile(join(root,'codex-api-workspaces',selection.sourceId,'home','config.toml'))).rejects.toMatchObject({code:'ENOENT'});
 }
 await api.restore(await api.revision());const restored:any=parse(await readFile(config,'utf8'));
 expect(restored.model_provider).toBe(provider);expect(restored.model).toBe('original-model');
 expect(restored.features).toEqual(parse(before).features);expect(JSON.stringify(restored)).not.toContain('synthetic-');
 expect(restored.model_providers.custom.base_url).toContain('/codex/inactive/');
});

it('suspends only the managed gateway directory and restores it with the gateway configuration',async()=>{
 const {api,config,before}=await setup('token_flow'),doc:any=parse(before);
 doc.developer_instructions='User-owned instructions';configureNativeUnifiedAgents(doc,{models:[{slug:'gateway/model'}],tokenflow_gateway_models:['gateway/model']});
 await writeFile(config,stringify(doc));await api.apply(a,await api.revision());
 expect(parse(await readFile(config,'utf8')).developer_instructions).toBe('User-owned instructions');
 await api.restore(await api.revision());expect(parse(await readFile(config,'utf8')).developer_instructions).toBe(doc.developer_instructions);
});

it('restores an existing third-party custom definition instead of replacing it with the inactive route',async()=>{
 const {api,config,before}=await setup(),doc:any=parse(before);
 doc.model_providers={custom:{name:'Existing user route',base_url:'https://original.example.test/v1',wire_api:'responses',experimental_bearer_token:'original-key'}};
 await writeFile(config,stringify(doc));await api.apply(a,await api.revision());await api.apply(b,await api.revision());await api.restore(await api.revision());
 expect(parse(await readFile(config,'utf8'))).toEqual(doc);
});

it('leaves .97 workspace history intact and stops selecting its launch environment on the next API switch',async()=>{
 const {api,root,config}=await setup();
 const oldRoot=join(root,'codex-api-workspaces',a.sourceId),oldHome=join(oldRoot,'home');await mkdir(join(oldHome,'sessions'),{recursive:true});
 const old=new CodexApiDirect(oldRoot,join(oldHome,'config.toml'),async()=>[]);await old.apply(a,await old.revision());
 // Reproduce the old unique provider and durable journal without touching the ordinary home.
 const oldConfig:any=parse(await readFile(old.configPath,'utf8')),provider='api_direct_'+a.sourceId;
 oldConfig.model_provider=provider;oldConfig.model_providers[provider]=oldConfig.model_providers.custom;delete oldConfig.model_providers.custom;
 const journalPath=join(oldRoot,'codex-api-direct','active.json'),journal=JSON.parse(await readFile(journalPath,'utf8'));journal.after=stringify(oldConfig);
 await writeFile(old.configPath,journal.after);await writeFile(journalPath,JSON.stringify(journal));
 await writeFile(join(oldHome,'sessions','history.jsonl'),'API_WORKSPACE_HISTORY');
 await writeFile(join(root,'codex-api-workspaces','active.json'),JSON.stringify({sourceId:a.sourceId}));
 expect((await api.launchEnvironment()).CODEX_HOME).toBe(oldHome);
 await api.apply(b,await api.revision());expect(await api.launchEnvironment()).toEqual({});
 expect(parse(await readFile(config,'utf8')).model_provider).toBe('custom');
 expect(await readFile(join(oldHome,'sessions','history.jsonl'),'utf8')).toBe('API_WORKSPACE_HISTORY');
 await api.retireSource(a.sourceId);expect(await readFile(old.configPath,'utf8')).not.toContain(a.apiKey);
 expect((await api.status())?.sourceId).toBe(b.sourceId);
});
