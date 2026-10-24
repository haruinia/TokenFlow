import * as codexRuntime from '../packages/core/src/codex-runtime.js';
import { afterEach,expect,it,vi } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { AgentConnections,agentPaths,connectedConfig } from '../packages/core/src/agent-connections.js';
import { agentConfig } from '../apps/console/src/agent-config.js';
import { connectionEvidence } from '../apps/console/src/connection-evidence.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(){const root=await mkdtemp(join(await realpath(tmpdir()),'agent-connect-test-'));roots.push(root);const paths={qoder:join(root,'qoder/settings.json'),codex:join(root,'codex','config.toml'),claude:join(root,'claude','settings.json'),workbuddy:join(root,'workbuddy','models.json')};let pids:number[]=[];const connections=new AgentConnections(root,paths,async()=>pids);await mkdir(join(root,'codex'));await mkdir(join(root,'claude'));return {root,paths,connections,running:(next:number[])=>pids=next};}
it('backs up exact original config, preserves providers and unrelated settings, restores and recovers across reopen',async()=>{
 const {root,paths,connections}=await setup();const original='# original comment\nmodel = "old"\nprofile = "work"\n[profiles.work]\nmodel = "profile-old"\n[model_providers.original]\nbase_url = "https://example.test"\n';await writeFile(paths.codex,original);
 const status=(await connections.status())[0];const record=await connections.apply({target:'codex',revision:status.revision,origin:'http://127.0.0.1:9527',model:'codex/model',sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
 const text=await readFile(paths.codex,'utf8');const parsed=parse(text);expect(parsed.profile).toBe('work');expect(parsed.model_provider).toBe('token_flow');expect(parsed.model_providers).toHaveProperty('original');expect(parsed.profiles).toHaveProperty('work.model','codex/model');
 expect((await stat(paths.codex)).mode&0o777).toBe(0o600);expect(JSON.stringify(await connections.status())).not.toContain('fixture-key');
 await new AgentConnections(root,paths,async()=>[]).restore(record.id);expect(await readFile(paths.codex,'utf8')).toBe(original);
});

it('stays configured when the client adds its own settings, but not when a connected field changes',async()=>{
 const {paths,connections}=await setup();await writeFile(paths.codex,'model = "old"\n');
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'codex/model',sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
 await writeFile(paths.codex,await readFile(paths.codex,'utf8')+'\n[projects."/work/app"]\ntrust_level = "trusted"\n');
 let codex=(await connections.status())[0];expect([codex.configurationState,codex.drift]).toEqual(['configured',false]);expect((await connections.review(record.id)).checks.find(c=>c.name==='配置与接入备份一致')?.ok).toBe(true);
 await writeFile(paths.codex,(await readFile(paths.codex,'utf8')).replace('model = "codex/model"','model = "other"'));
 codex=(await connections.status())[0];expect([codex.configurationState,codex.drift]).toEqual(['changed',true]);
});

it('allows restore and model replacement when Codex changed only its selected token-flow model',async()=>{
 const {paths,connections}=await setup();await writeFile(paths.codex,'model = "native"\napproval_policy = "untrusted"\n');
 const first=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'qoder/first',sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
 await writeFile(paths.codex,(await readFile(paths.codex,'utf8')).replaceAll('qoder/first','qoder/changed-in-codex'));
 expect((await connections.status())[0].configurationState).toBe('changed');
 const preview=await connections.preview('codex','http://127.0.0.1:9527','qoder/second');
 const second=await connections.apply({target:'codex',revision:preview.revision,replaceId:first.id,origin:'http://127.0.0.1:9527',model:'qoder/second',sourceId:'source',keyId:randomUUID(),key:'second-key'});
 expect(parse(await readFile(paths.codex,'utf8'))).toMatchObject({model:'qoder/second',model_provider:'token_flow',approval_policy:'untrusted'});
 await connections.restore(second.id);
 expect(parse(await readFile(paths.codex,'utf8'))).toEqual({model:'native',approval_policy:'untrusted'});
});

it('preserves Codex local policy and active legacy profile through model switches, reviews and rollback',async()=>{
 const {paths,connections}=await setup();
 const original=`model = "old"
model_auto_compact_token_limit = 9999999
model_context_window = 123456
profile = "work"
model_auto_compact_token_limit_scope = "total"
approval_policy = "untrusted"
sandbox_mode = "read-only"
[profiles.work]
model = "profile-model"
model_auto_compact_token_limit = 8888888
model_context_window = 123456
model_provider = "original"
model_auto_compact_token_limit_scope = "total"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
web_search = "live"
[profiles.other]
model = "untouched"
approval_policy = "never"
[sandbox_workspace_write]
network_access = false
writable_roots = ["/tmp/allowed-fixture"]
[shell_environment_policy]
inherit = "none"
[mcp_servers.fixture]
command = "fixture-mcp"
[projects."/tmp/project-fixture"]
trust_level = "untrusted"
`;
 await writeFile(paths.codex,original);
 const before=parse(original);
 for(const model of ['qoder/test','workbuddy/test','codex/test']){
  const preview=await connections.preview('codex','http://127.0.0.1:9527',model);
  expect(preview.routing).toMatchObject({profile:'work',model,model_provider:'token_flow',web_search:'live'});
  const record=await connections.apply({target:'codex',revision:preview.revision,replaceId:preview.replaceId,origin:'http://127.0.0.1:9527',model,sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
  const after=parse(await readFile(paths.codex,'utf8'));
  expect(after).toMatchObject({profile:'work',model_auto_compact_token_limit_scope:'total',approval_policy:'untrusted',sandbox_mode:'read-only',profiles:{work:{model,model_provider:'token_flow',model_auto_compact_token_limit_scope:'total',approval_policy:'on-request',sandbox_mode:'workspace-write',web_search:'live'},other:{model:'untouched',approval_policy:'never'}}});
  expect(after.model_auto_compact_token_limit).toBeUndefined();expect(after.model_context_window).toBeUndefined();
  expect((after.profiles as any).work.model_auto_compact_token_limit).toBeUndefined();expect((after.profiles as any).work.model_context_window).toBeUndefined();
  expect((after.model_providers as any).token_flow.name).toBe('TokenFlow');
  for(const field of ['sandbox_workspace_write','shell_environment_policy','mcp_servers','projects'])expect(after[field]).toEqual(before[field]);
  expect((await connections.review(record.id)).checks.every(c=>c.ok)).toBe(true);
 }
 const record=(await connections.status())[0].connection!;
 const modified=parse(await readFile(paths.codex,'utf8')) as any;
 modified.profiles.work.model='wrong-model';
 const {stringify}=await import('smol-toml');await writeFile(paths.codex,stringify(modified));
 expect((await connections.review(record.id)).checks.find(c=>c.name==='模型与配置层级正确')?.ok).toBe(false);
 await writeFile(paths.codex,connectedConfig('codex',original,'http://127.0.0.1:9527','codex/test','fixture-key'));
 await connections.restore(record.id);expect(await readFile(paths.codex,'utf8')).toBe(original);
});

it('rejects invalid active legacy profiles instead of silently dropping their policy',()=>{
 for(const original of ['profile = "missing"','profile = false','profile = "work"\nprofiles.work = "invalid"']){
  expect(()=>connectedConfig('codex',original,'http://127.0.0.1:9527','codex/test','key')).toThrow();
 }
});

it('keeps local Claude and Qoder tool, hook and approval settings when adding a model provider',()=>{
 const local={permissions:{defaultMode:'default',allow:['Read'],deny:['Bash(rm *)'],ask:['Bash'],additionalDirectories:['/tmp/fixture']},sandbox:{enabled:true},hooks:{PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'fixture-check'}]}]},mcpServers:{fixture:{command:'fixture-mcp'}}};
 for(const target of ['claude','qoder'] as const){
  const config=JSON.parse(connectedConfig(target,JSON.stringify(local),'http://127.0.0.1:9527','workbuddy/test','key'));
  for(const [name,value] of Object.entries(local))expect(config[name]).toEqual(value);
 }
 for(const target of ['codex','claude'] as const){
  for(const powershell of [false,true])expect(agentConfig(target,'http://127.0.0.1:9527','workbuddy/test',powershell)).not.toMatch(/approval_policy|sandbox_mode|permission-mode|skip-permissions|allowedTools/);
 }
});

it('preserves Codex search preferences across source changes',async()=>{
 const {paths,connections}=await setup();const original='web_search = "live"\napproval_policy = "on-request"\n';await writeFile(paths.codex,original);
 for(const model of ['qoder/kmodel_latest','workbuddy/glm-5.1','codex/model']){
  const preview=await connections.preview('codex','http://127.0.0.1:9527',model);
  const expected='live';expect(preview.routing.web_search).toBe(expected);
  await connections.apply({target:'codex',revision:preview.revision,replaceId:preview.replaceId,origin:'http://127.0.0.1:9527',model,sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
  expect(parse(await readFile(paths.codex,'utf8'))).toMatchObject({web_search:expected,approval_policy:'on-request'});
  const manual=agentConfig('codex','http://127.0.0.1:9527',model);
  expect(manual.includes('web_search="disabled"')).toBe(false);
  expect(manual).toContain('model_auto_compact_token_limit_scope="total"');
 }
 const record=(await connections.status())[0].connection!;await connections.restore(record.id);expect(await readFile(paths.codex,'utf8')).toBe(original);
});
it('refuses live processes, stale previews, external modifications, duplicate apply and symlinks',async()=>{
 const {paths,connections,running}=await setup();await writeFile(paths.claude,'{"env":{"KEEP":"yes"},"permissions":{"allow":[]}}');
 const selected=(await connections.status())[1];const input={target:'claude' as const,revision:selected.revision,origin:'http://127.0.0.1:9527',model:'codex/model',sourceId:'source',keyId:randomUUID(),key:'fixture-key'};
 running([42]);await expect(connections.apply(input)).rejects.toThrow('42');running([]);
 const record=await connections.apply(input);const updated=JSON.parse(await readFile(paths.claude,'utf8'));expect(updated.env.KEEP).toBe('yes');expect(updated.permissions).toEqual({allow:[]});
 await expect(connections.apply(input)).rejects.toThrow('配置已变更');
 await writeFile(paths.claude,'{"user":"new edit"}');await expect(connections.restore(record.id)).rejects.toThrow('外部修改');expect(await readFile(paths.claude,'utf8')).toContain('new edit');
 await symlink(paths.claude,paths.codex);await expect(connections.apply({...input,target:'codex'})).rejects.toThrow('符号链接');
});
it('restores an originally absent file and fails closed on malformed configuration',async()=>{
 const {paths,connections}=await setup();const status=(await connections.status())[1];const record=await connections.apply({target:'claude',revision:status.revision,origin:'http://127.0.0.1:9527',model:'m',sourceId:'s',keyId:randomUUID(),key:'key'});await connections.restore(record.id);await expect(readFile(paths.claude)).rejects.toMatchObject({code:'ENOENT'});
 expect(()=>connectedConfig('codex','invalid ???','http://127.0.0.1:9527','m','k')).toThrow();expect(()=>connectedConfig('claude','[]','http://127.0.0.1:9527','m','k')).toThrow();
});

it('recovers a prepared backup without overwriting changed files or losing rollback',async()=>{
 const {root,paths,connections}=await setup();const original='{"original":true}';await writeFile(paths.claude,original);
 const state=(await connections.status())[1];const record=await connections.apply({target:'claude',revision:state.revision,origin:'http://127.0.0.1:9527',model:'m',sourceId:'s',keyId:randomUUID(),key:'k'});
 const backup=join(root,'agent-backups',`${record.id}.json`);const journal=JSON.parse(await readFile(backup,'utf8'));journal.state='prepared';await writeFile(backup,JSON.stringify(journal));await writeFile(paths.claude,original);
 await connections.repair(record.id);expect(await readFile(paths.claude,'utf8')).toBe(journal.after);await connections.restore(record.id);expect(await readFile(paths.claude,'utf8')).toBe(original);
 journal.before='tampered';await writeFile(backup,JSON.stringify(journal));await expect(connections.status()).rejects.toThrow('备份记录损坏');
});

it('allows confirmed settings writes while agent runs, with backup and conflict checks intact',async()=>{
 const {paths,connections,running}=await setup();await writeFile(paths.claude,'{"original":true}');const status=(await connections.status())[1];running([42]);
 const record=await connections.apply({target:'claude',revision:status.revision,origin:'http://127.0.0.1:9527',model:'m',sourceId:'s',keyId:randomUUID(),key:'k',allowRunning:true});expect(JSON.parse(await readFile(paths.claude,'utf8')).model).toBe('m');expect(record.state).toBe('applied');running([]);await connections.restore(record.id);expect(await readFile(paths.claude,'utf8')).toBe('{"original":true}');
});

it('generates Qoder IDE parameters and pins Claude auxiliary models in both connection paths',()=>{
 const qoder=JSON.parse(agentConfig('qoder','http://127.0.0.1:9527','antigravity/gemini'));expect(qoder).toMatchObject({provider:'OpenAI Compatible',api:'Responses',baseURL:'http://127.0.0.1:9527/v1',model:'antigravity/gemini'});
 const original=JSON.stringify({env:{ANTHROPIC_SMALL_FAST_MODEL:'old',CLAUDE_CODE_SUBAGENT_MODEL:'old-sub',KEEP:'yes'}});const config=JSON.parse(connectedConfig('claude',original,'http://127.0.0.1:9527','antigravity/gemini','key'));
 for(const name of ['ANTHROPIC_SMALL_FAST_MODEL']){expect(config.env[name]).toBe('antigravity/gemini');expect(agentConfig('claude','http://127.0.0.1:9527','antigravity/gemini')).toContain(`${name}='antigravity/gemini'`);}
 expect(config.env.KEEP).toBe('yes');expect(config.env.ANTHROPIC_MODEL).toBe('');expect(config.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('');
 const split=JSON.parse(connectedConfig('claude','{}','http://127.0.0.1:9527','qoder/main','key',undefined,['qoder/main','qoder/fast'],{},'qoder/fast'));
 expect(split.model).toBe('qoder/main');expect(split.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('qoder/main');expect(split.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('qoder/main');expect(split.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('qoder/main');
 expect(split.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('qoder/fast');expect(split.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('qoder/fast');expect(split.env.CLAUDE_CODE_BG_CLASSIFIER_MODEL).toBe('qoder/fast');expect(split.env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe('qoder/fast');expect(split.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('');
});

it('reviews a Claude connection whose fast model differs from the session default',async()=>{
 const {connections}=await setup();const source='a'.repeat(24),other='b'.repeat(24);
 const record=await connections.apply({target:'claude',revision:(await connections.status())[1].revision,origin:'http://127.0.0.1:9527',model:'qoder/main',sourceId:source,fastModel:'qoder/fast',selections:[{sourceId:source,model:'qoder/main'},{sourceId:other,model:'qoder/fast'}],keyId:randomUUID(),key:'fixture-key'});
 expect(record.fastModel).toBe('qoder/fast');expect((await connections.review(record.id)).checks.every(check=>check.ok)).toBe(true);
 await expect(connections.apply({target:'claude',revision:(await connections.status())[1].revision,origin:'http://127.0.0.1:9527',model:'qoder/main',sourceId:source,fastModel:'qoder/other',selections:[{sourceId:source,model:'qoder/main'}],keyId:randomUUID(),key:'fixture-key',replaceId:record.id})).rejects.toThrow('快速模型必须在已选模型中');
});

it('reviews actual Claude routing without exposing keys and detects stale auxiliary settings',async()=>{
 const {paths,connections}=await setup();const status=(await connections.status())[1];const record=await connections.apply({target:'claude',revision:status.revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'s',keyId:randomUUID(),key:'private-key'});const valid=await connections.review(record.id);expect(valid.checks.every(c=>c.ok)).toBe(true);expect(valid.liveCallVerified).toBe(false);expect(valid.compatibility?.autoMode).toBe('unverified');expect(JSON.stringify(valid)).not.toContain('private-key');
 const config=JSON.parse(await readFile(paths.claude,'utf8'));config.env.ANTHROPIC_SMALL_FAST_MODEL='stale';await writeFile(paths.claude,JSON.stringify(config));const drift=await connections.review(record.id);expect(drift.checks.find(c=>c.name==='主模型可切换，子代理继承会话')?.ok).toBe(false);expect(drift.checks.find(c=>c.name==='配置与接入备份一致')?.ok).toBe(false);
});

it.each(['opus','sonnet','haiku','opusplan'])('keeps equivalent Claude model alias %s configured without a false alarm',async(alias)=>{
 const {paths,connections}=await setup();
 const record=await connections.apply({target:'claude',revision:(await connections.status())[1].revision,origin:'http://127.0.0.1:9527',model:'qoder/kmodel_latest',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const config=JSON.parse(await readFile(paths.claude,'utf8'));config.model=alias;
 const current=JSON.stringify(config);await writeFile(paths.claude,current);
 const target=(await connections.status())[1];
 expect([target.configurationState,target.drift]).toEqual(['configured',false]);
 expect((await connections.review(record.id)).checks.every(check=>check.ok)).toBe(true);
 expect(connectionEvidence(target,[],[{id:'s',models:[record.model]}]).tone).toBe('neutral');
 await connections.repair(record.id);
 expect(await readFile(paths.claude,'utf8')).toBe(current);
 await connections.restore(record.id);
 expect(await readFile(paths.claude,'utf8').catch(()=>null)).toBeNull();
});

it('still flags real Claude routing changes when a model alias is selected',async()=>{
 const {paths,connections}=await setup();
 const record=await connections.apply({target:'claude',revision:(await connections.status())[1].revision,origin:'http://127.0.0.1:9527',model:'qoder/kmodel_latest',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const config=JSON.parse(await readFile(paths.claude,'utf8'));config.model='opus';
 for(const [field,value] of [['ANTHROPIC_DEFAULT_OPUS_MODEL','other'],['ANTHROPIC_SMALL_FAST_MODEL','other'],['ANTHROPIC_BASE_URL','http://127.0.0.1:9999'],['ANTHROPIC_AUTH_TOKEN','other-key']]){
  await writeFile(paths.claude,JSON.stringify({...config,env:{...config.env,[field]:value}}));
  expect((await connections.status())[1].configurationState).toBe('changed');
  expect((await connections.review(record.id)).checks.some(check=>!check.ok)).toBe(true);
  await expect(connections.restore(record.id)).rejects.toThrow('外部修改');
  await expect(connections.repair(record.id)).rejects.toThrow('外部修改');
 }
 await writeFile(paths.claude,JSON.stringify({...config,model:'unknown-alias'}));
 expect((await connections.status())[1].configurationState).toBe('changed');
 await expect(connections.restore(record.id)).rejects.toThrow('外部修改');
});

it('switches Claude models after an equivalent alias edit while preserving unrelated settings and original rollback',async()=>{
 const {paths,connections}=await setup();const original=JSON.stringify({model:'original',env:{KEEP:'yes'},permissions:{defaultMode:'default'}});await writeFile(paths.claude,original);
 const first=await connections.apply({target:'claude',revision:(await connections.status())[1].revision,origin:'http://127.0.0.1:9527',model:'qoder/first',sourceId:'s',keyId:randomUUID(),key:'first-key'});
 const config=JSON.parse(await readFile(paths.claude,'utf8'));config.model='opus';config.language='chinese';await writeFile(paths.claude,JSON.stringify(config));
 const preview=await connections.preview('claude','http://127.0.0.1:9527','qoder/second');
 const next=await connections.apply({target:'claude',revision:preview.revision,replaceId:first.id,origin:'http://127.0.0.1:9527',model:'qoder/second',sourceId:'s',keyId:randomUUID(),key:'next-key'});
 expect(JSON.parse(await readFile(paths.claude,'utf8'))).toMatchObject({model:'qoder/second',language:'chinese',env:{KEEP:'yes'},permissions:{defaultMode:'default'}});
 await connections.restore(next.id);
 expect(JSON.parse(await readFile(paths.claude,'utf8'))).toEqual({...JSON.parse(original),language:'chinese'});
});

it('refuses lossy WorkBuddy object conversion and reviews native arrays',async()=>{
 expect(()=>connectedConfig('workbuddy','{"models":[],"availableModels":[]}','http://127.0.0.1:9527','qoder/test','fixture-key')).toThrow('额外设置');
 const {paths,connections}=await setup();const status=(await connections.status())[2];const record=await connections.apply({target:'workbuddy',revision:status.revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const saved=JSON.parse(await readFile(paths.workbuddy,'utf8'));await writeFile(paths.workbuddy,JSON.stringify(Array.isArray(saved)?saved:saved.models));const review=await connections.review(record.id);expect(review.checks.find(c=>c.name==='自定义模型已写入配置')?.ok).toBe(true);expect(review.checks.find(c=>c.name==='接口地址与工具能力正确')?.ok).toBe(true);expect(review.liveCallVerified).toBe(false);expect(review.note).toContain('输入框下方');
});

it('keeps native WorkBuddy models through its array-only startup cleanup',()=>{
 for(const original of [null,'[]','{"models":[]}']){
  const config=JSON.parse(connectedConfig('workbuddy',original,'http://127.0.0.1:9527','qoder/k3','key'));
  // Installed WorkBuddy hardware-gate cleanup only retains root-array remote models.
  const retained=(Array.isArray(config)?config:[]).filter(m=>m?.local!==true);
  expect(retained).toHaveLength(1);expect(retained[0].id).toBe('qoder/k3');
 }
});
it('switches a missing WorkBuddy connection to the selected source while preserving original rollback',async()=>{
 const {paths,connections}=await setup();await mkdir(join(paths.workbuddy,'..'),{recursive:true});await writeFile(paths.workbuddy,'[]');
 const initial=(await connections.status())[2];const old=await connections.apply({target:'workbuddy',revision:initial.revision,origin:'http://127.0.0.1:9527',model:'antigravity/old',sourceId:'old',keyId:randomUUID(),key:'old-key'});
 await writeFile(paths.workbuddy,'[]');expect((await connections.status())[2].configurationState).toBe('missing');
 const preview=await connections.preview('workbuddy','http://127.0.0.1:9527','qoder/k3');expect(preview.replaceId).toBe(old.id);expect(JSON.stringify(preview)).not.toContain('old-key');
 const next=await connections.apply({target:'workbuddy',revision:preview.revision,replaceId:old.id,origin:'http://127.0.0.1:9527',model:'qoder/k3',sourceId:'qoder',keyId:randomUUID(),key:'new-key'});
 expect(JSON.parse(await readFile(paths.workbuddy,'utf8'))[0].id).toBe('qoder/k3');expect((await connections.status())[2].configurationState).toBe('configured');expect((await connections.review(next.id)).checks.every(c=>c.ok)).toBe(true);
 await connections.restore(next.id);expect(await readFile(paths.workbuddy,'utf8')).toBe('[]');expect((await connections.status())[2].backups.every(r=>r.state==='restored')).toBe(true);
});
it('writes WorkBuddyAI gateway models without changing the domestic file',async()=>{
 const {paths,connections}=await setup();await mkdir(join(paths.workbuddy,'..'),{recursive:true});await writeFile(paths.workbuddy,'[{"id":"kept"}]');
 const ai=(await connections.status()).find(item=>item.id==='workbuddy-ai')!;
 expect(ai.path).not.toBe(paths.workbuddy);
 const record=await connections.apply({target:'workbuddy-ai',revision:ai.revision,origin:'http://127.0.0.1:9527',model:'qoder/k3',sourceId:'s',keyId:randomUUID(),key:'ai-key'});
 expect(JSON.parse(await readFile(ai.path,'utf8'))[0]).toMatchObject({id:'qoder/k3',url:'http://127.0.0.1:9527/v1/chat/completions',supportsToolCall:true});
 expect(await readFile(paths.workbuddy,'utf8')).toBe('[{"id":"kept"}]');
 expect((await connections.review(record.id)).checks.every(check=>check.ok)).toBe(true);
 await connections.restore(record.id);
 expect(await readFile(paths.workbuddy,'utf8')).toBe('[{"id":"kept"}]');
 await expect(readFile(ai.path)).rejects.toMatchObject({code:'ENOENT'});
});
it('redacts unrelated provider secrets from approval previews and refuses changed revisions',async()=>{
 const {paths,connections}=await setup();await writeFile(paths.claude,JSON.stringify({env:{ANTHROPIC_CUSTOM_SECRET:'private-secret'}}));const p=await connections.preview('claude','http://127.0.0.1:9527','qoder/k3');expect(JSON.stringify(p)).not.toContain('private-secret');await writeFile(paths.claude,'{"new":true}');
 await expect(connections.apply({target:'claude',revision:p.revision,origin:'http://127.0.0.1:9527',model:'qoder/k3',sourceId:'s',keyId:randomUUID(),key:'key'})).rejects.toThrow();expect(await readFile(paths.claude,'utf8')).toBe('{"new":true}');
});
it('recovers interrupted replacement journals and verifies replacement backup checksums',async()=>{
 const {root,paths,connections}=await setup();await writeFile(paths.claude,'{}');const initial=(await connections.status())[1];const old=await connections.apply({target:'claude',revision:initial.revision,origin:'http://127.0.0.1:9527',model:'old/m',sourceId:'old',keyId:randomUUID(),key:'old-key'});const before=await readFile(paths.claude,'utf8');const preview=await connections.preview('claude','http://127.0.0.1:9527','new/m');
 const next=await connections.apply({target:'claude',revision:preview.revision,replaceId:old.id,origin:'http://127.0.0.1:9527',model:'new/m',sourceId:'new',keyId:randomUUID(),key:'new-key'});const path=join(root,'agent-backups',`${next.id}.json`);const journal=JSON.parse(await readFile(path,'utf8'));journal.state='prepared';await writeFile(path,JSON.stringify(journal));await writeFile(paths.claude,before);
 await connections.repair(next.id);expect(JSON.parse(await readFile(paths.claude,'utf8')).model).toBe('new/m');await connections.restore(next.id);expect(await readFile(paths.claude,'utf8')).toBe('{}');journal.previousConfig='corrupt';await writeFile(path,JSON.stringify(journal));await expect(connections.status()).rejects.toThrow('备份记录损坏');
});
it('recognizes WorkBuddy formatting rewrites and can replace the selected model',async()=>{
 const {root,paths,connections}=await setup();await mkdir(join(root,'workbuddy'));await writeFile(paths.workbuddy,'[]');
 const first=await connections.apply({target:'workbuddy',revision:(await connections.status())[2].revision,origin:'http://127.0.0.1:9527',model:'qoder/old',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 await writeFile(paths.workbuddy,JSON.stringify(JSON.parse(await readFile(paths.workbuddy,'utf8'))));
 expect((await connections.status())[2].configurationState).toBe('configured');expect((await connections.review(first.id)).checks.every(c=>c.ok)).toBe(true);
 const preview=await connections.preview('workbuddy','http://127.0.0.1:9527','qoder/new');
 const second=await connections.apply({target:'workbuddy',revision:preview.revision,replaceId:first.id,origin:'http://127.0.0.1:9527',model:'qoder/new',sourceId:'s',keyId:randomUUID(),key:'next-key'});
 await writeFile(paths.workbuddy,JSON.stringify(JSON.parse(await readFile(paths.workbuddy,'utf8'))));await connections.restore(second.id);expect(await readFile(paths.workbuddy,'utf8')).toBe('[]');
});

it('adds, switches and restores Qoder standalone providers while preserving unrelated settings',async()=>{
 const {paths,connections}=await setup();await mkdir(join(paths.qoder,'..'),{recursive:true});
 const original=JSON.stringify({hooks:{keep:true},providers:{existing:{apiKey:'original-key',baseUrl:'https://example.test'}}});await writeFile(paths.qoder,original);
 const first=await connections.apply({target:'qoder',revision:(await connections.status()).find(t=>t.id==='qoder')!.revision,origin:'http://127.0.0.1:9527',model:'codex/first',sourceId:'source',keyId:randomUUID(),key:'first-key'});
 expect((await connections.review(first.id)).checks.every(c=>c.ok)).toBe(true);
 const preview=await connections.preview('qoder','http://127.0.0.1:9527','codex/second');expect(JSON.stringify(preview)).not.toContain('original-key');expect(JSON.stringify(preview)).not.toContain('first-key');
 const next=await connections.apply({target:'qoder',revision:preview.revision,replaceId:first.id,origin:'http://127.0.0.1:9527',model:'codex/second',sourceId:'source',keyId:randomUUID(),key:'second-key'});
 const doc=JSON.parse(await readFile(paths.qoder,'utf8'));expect(doc.hooks).toEqual({keep:true});expect(doc.providers.existing.apiKey).toBe('original-key');expect(doc.providers['token-flow']).toMatchObject({protocol:'openai-responses',baseUrl:'http://127.0.0.1:9527/v1',model:'codex/second',apiKey:'second-key'});
 await connections.restore(next.id);expect(await readFile(paths.qoder,'utf8')).toBe(original);
 expect(JSON.parse(connectedConfig('qoder','{"providers":{"token-flow":{}}}','http://127.0.0.1:9527','codex/model','key')).providers['token-flow'].model).toBe('codex/model');
});

it('restores and switches Codex routing while preserving unrelated client edits',async()=>{
 const {paths,connections}=await setup();await writeFile(paths.codex,'model = "original"\n');
 const first=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'antigravity/old',sourceId:'s',keyId:randomUUID(),key:'first-key'});
 await writeFile(paths.codex,'approval_policy = "on-request"\n'+await readFile(paths.codex,'utf8'));
 const preview=await connections.preview('codex','http://127.0.0.1:9527','workbuddy/new');
 const next=await connections.apply({target:'codex',revision:preview.revision,replaceId:first.id,origin:'http://127.0.0.1:9527',model:'workbuddy/new',sourceId:'s',keyId:randomUUID(),key:'next-key'});
 await connections.remove(first.id,(await connections.status())[0].revision);expect((await connections.status())[0].connection?.id).toBe(next.id);
 await writeFile(paths.codex,'sandbox_mode = "workspace-write"\n'+await readFile(paths.codex,'utf8'));
 await connections.restore(next.id);expect(parse(await readFile(paths.codex,'utf8'))).toEqual({model:'original',approval_policy:'on-request',sandbox_mode:'workspace-write'});
});
it('exports the selected Codex model to its picker and allows model-only edits before another switch',async()=>{
 const {paths,connections}=await setup();const original='model = "original"\nmodel_catalog_json = "/fixture/original-models.json"\n';await writeFile(paths.codex,original);
 const first=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'qoder/kmodel_latest',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const doc=parse(await readFile(paths.codex,'utf8'));
 const catalog=JSON.parse(await readFile(String(doc.model_catalog_json),'utf8'));
 expect(catalog.models.map((m:{slug:string})=>m.slug)).toEqual(['qoder/kmodel_latest']);
 await writeFile(paths.codex,'model_reasoning_effort = "high"\n'+(await readFile(paths.codex,'utf8')).replace('model = "qoder/kmodel_latest"','model = "gpt-5"'));
 const preview=await connections.preview('codex','http://127.0.0.1:9527','qoder/next');
 const next=await connections.apply({target:'codex',revision:preview.revision,replaceId:first.id,origin:'http://127.0.0.1:9527',model:'qoder/next',sourceId:'s',keyId:randomUUID(),key:'next-key'});
 expect(parse(await readFile(paths.codex,'utf8')).model).toBe('qoder/next');
 await connections.restore(next.id);
 expect(parse(await readFile(paths.codex,'utf8'))).toEqual({model:'original',model_catalog_json:'/fixture/original-models.json',model_reasoning_effort:'high'});
});
it('allows image attachments without a per-model capability registry on forwarding transports',async()=>{
 const {paths,connections}=await setup();
 const ids=['workbuddy/new-model','qoder/new-model',`api-${'a'.repeat(24)}/unknown`,'codex/new-model','cursor/text-adapter'];
 await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:ids[0]!,sourceId:'a'.repeat(24),keyId:randomUUID(),key:'fixture-key',selections:ids.map(model=>({model,sourceId:'a'.repeat(24)}))});
 const config=parse(await readFile(paths.codex,'utf8'));
 const catalog=JSON.parse(await readFile(String(config.model_catalog_json),'utf8'));
 expect(catalog.models.map((m:any)=>m.input_modalities)).toEqual([['text','image'],['text','image'],['text','image'],['text','image'],['text','image']]);
});
it('deletes stale records after reinstall without touching the new config, and keeps history selectable',async()=>{
 const {root,paths,connections}=await setup();await writeFile(paths.codex,'model = "original"\n');
 const first=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'antigravity/old',sourceId:'s',keyId:randomUUID(),key:'first-key'});
 const original=await readFile(paths.codex,'utf8');await connections.restore(first.id);expect((await connections.status())[0].backups).toHaveLength(1);
 const next=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'workbuddy/new',sourceId:'s',keyId:randomUUID(),key:'next-key'});
 await writeFile(paths.codex,'model = "reinstalled"\n');
 await expect(connections.restore(next.id)).rejects.toThrow('外部修改');
 await expect(connections.remove(next.id,'0'.repeat(64))).rejects.toThrow('配置已变更');
 await connections.remove(next.id,(await connections.status())[0].revision);
 const reopened=new AgentConnections(root,paths,async()=>[]);const status=(await reopened.status())[0];expect(status.connection).toBeNull();expect(status.backups.map(r=>r.id)).toEqual([first.id]);expect(await readFile(paths.codex,'utf8')).toBe('model = "reinstalled"\n');
 await reopened.remove(first.id,status.revision);expect((await reopened.status())[0].backups).toEqual([]);expect(original).toContain('first-key');
});
it('returns an in-place edited Codex gateway to the official model',async()=>{
 const {paths,connections}=await setup();await writeFile(paths.codex,'model = "original"\n');
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'antigravity/old',sourceId:'s',keyId:randomUUID(),key:'first-key'});
 await writeFile(paths.codex,(await readFile(paths.codex,'utf8')).replace('model = "antigravity/old"','model = "hand-edited"'));
 await connections.restore(record.id);
 const doc=parse(await readFile(paths.codex,'utf8'));
 expect(doc.model).toBe('original');expect(doc.model_provider).toBeUndefined();expect(doc).not.toHaveProperty('model_providers.token_flow');
});
it('previews the saved custom provider without exposing credentials and keeps external routing intact',async()=>{
 const {paths,connections}=await setup();
 const original='model="original-model"\nmodel_provider="other"\n[model_providers.other]\nbase_url="https://example.test/v1"\nexperimental_bearer_token="private-fixture"\n';
 await writeFile(paths.codex,original);
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'codex/new',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const ready=await connections.restorePreview(record.id);
 expect(ready).toMatchObject({canRestore:true,destination:{kind:'custom',provider:'other',model:'original-model'}});
 expect(JSON.stringify(ready)).not.toMatch(/private-fixture|fixture-key|example.test/);
 const external=(await readFile(paths.codex,'utf8')).replace('model_provider = "token_flow"','model_provider = "external"');
 await writeFile(paths.codex,external);
 const blocked=await connections.restorePreview(record.id);expect(blocked.canRestore).toBe(false);expect(blocked.reason).toContain('外部修改');
 await expect(connections.restore(record.id)).rejects.toThrow('外部修改');expect(await readFile(paths.codex,'utf8')).toBe(external);
});
it.each([null,'model="native"','profile="work"\n[profiles.work]\nmodel_provider="custom"\nmodel="profile-model"'])('previews missing, official and profile restore destinations (%s)',async original=>{
 const {paths,connections}=await setup();if(original!==null)await writeFile(paths.codex,original);
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'codex/new',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const preview=await connections.restorePreview(record.id);
 expect(preview.canRestore).toBe(true);
 expect(preview.destination).toEqual(original===null?{kind:'default',provider:'openai'}:original.startsWith('model=')?{kind:'official',provider:'openai',model:'native'}:{kind:'custom',provider:'custom',model:'profile-model'});
});
it('restores a missing file without requiring a maintenance model',async()=>{
 const {paths,connections}=await setup();
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'antigravity/m',sourceId:'s',keyId:randomUUID(),key:'key'});
 await rm(paths.codex);await connections.restore(record.id);expect((await connections.status())[0].connection).toBeNull();
});

it('requires a public HTTPS endpoint for manual Cursor setup and never invents a writable settings file',()=>{
 for(const url of ['http://127.0.0.1:9527','https://localhost','https://10.0.0.1','https://192.168.1.2','https://gateway.example.com/v1','https://user:password@gateway.example.com'])expect(()=>agentConfig('cursor',url,'antigravity/gemini-3-flash')).toThrow();
 expect(JSON.parse(agentConfig('cursor','https://gateway.example.com','antigravity/gemini-3-flash'))).toMatchObject({overrideOpenAIBaseURL:'https://gateway.example.com/v1',customModel:'antigravity/gemini-3-flash'});
});

it('writes multiple client menu entries and accepts an authorized client model switch without losing rollback',async()=>{
 const {paths,connections}=await setup();
 const selections=[{sourceId:'a'.repeat(24),model:'codex/first'},{sourceId:'b'.repeat(24),model:'claude/second'}];
 for(const target of ['codex','claude','workbuddy','qoder'] as const){
  const status=(await connections.status()).find(t=>t.id===target)!;
  const record=await connections.apply({target,revision:status.revision,origin:'http://127.0.0.1:9527',...selections[0],selections,keyId:randomUUID(),key:'fixture-key'});
  expect((await connections.review(record.id)).checks.every(c=>c.ok)).toBe(true);
  const text=await readFile(paths[target],'utf8');
  const menu=target==='codex'?await readFile(String(parse(text).model_catalog_json),'utf8'):text;
  for(const selection of selections)expect(menu).toContain(selection.model);
  if(target==='codex'){
   await writeFile(paths[target],text.replace('model = "codex/first"','model = "claude/second"'));
   expect((await connections.status()).find(t=>t.id===target)?.configurationState).toBe('configured');
   expect((await connections.review(record.id)).checks.every(c=>c.ok)).toBe(true);
  }
  if(target==='claude'){
   const config=JSON.parse(text);expect(config.modelPicker.options.map((m:{model:string})=>m.model)).toEqual(selections.map(s=>s.model));
   config.model=selections[1].model;await writeFile(paths[target],JSON.stringify(config));
   expect((await connections.status()).find(t=>t.id===target)?.configurationState).toBe('configured');
   expect((await connections.review(record.id)).checks.every(c=>c.ok)).toBe(true);
  }
  await connections.restore(record.id);
  expect((await connections.status()).find(t=>t.id===target)?.exists).toBe(false);
 }
});

it('makes Codex subagents inherit the selected parent model and restores their original defaults',async()=>{
 const {paths,connections}=await setup();
 const original='model = "native"\nprofile = "work"\n[agents]\ndefault_subagent_model = "native-small"\ndefault_subagent_reasoning_effort = "high"\nmax_threads = 3\nenabled = true\n[agents.reviewer]\ndescription = "Review changes"\n[profiles.work]\nmodel = "native-work"\n[profiles.work.agents]\ndefault_subagent_model = "native-profile-small"\ndefault_subagent_reasoning_effort = "low"\nmax_threads = 2\n';
 await writeFile(paths.codex,original);
 for(const model of ['qoder/kmodel_latest','workbuddy/hy4-preview']){
  const state=(await connections.status())[0];
  await connections.apply({target:'codex',revision:state.revision,replaceId:state.connection?.id,origin:'http://127.0.0.1:9527',model,sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
  const doc=parse(await readFile(paths.codex,'utf8')) as any;
  expect(doc.agents).toEqual({max_threads:3,enabled:true,reviewer:{description:'Review changes'}});
  expect(doc.profiles.work.agents).toEqual({max_threads:2});
  expect(doc.model).toBe(model);
 }
 await connections.restore((await connections.status())[0].connection!.id);
 expect(await readFile(paths.codex,'utf8')).toBe(original);
});

it('exports catalog display names without changing Qoder routing IDs and restores original configs',async()=>{
 const {paths,connections}=await setup();
 const model='qoder/kmodel_latest';const modelLabels={[model]:'qoder/Kimi-K3'};
 for(const target of ['claude','codex','qoder','workbuddy','pi','deepseek'] as const){
  const path=connections.paths[target];
  const original=target==='codex'?'model = "native"\n':target==='workbuddy'||target==='deepseek'?'[]\n':'{}\n';
  await mkdir(join(path,'..'),{recursive:true});await writeFile(path,original);
  const status=(await connections.status()).find(item=>item.id===target)!;
  const record=await connections.apply({target,revision:status.revision,origin:'http://127.0.0.1:9527',model,sourceId:'a'.repeat(24),keyId:randomUUID(),key:'fixture-key',selections:[{model,sourceId:'a'.repeat(24)}],modelLabels});
  const text=await readFile(path,'utf8');
  if(target==='codex'){
   const config=parse(text);expect(config.model).toBe(model);
   const catalog=JSON.parse(await readFile(String(config.model_catalog_json),'utf8'));
   expect(catalog.models[0]).toMatchObject({slug:model,display_name:'qoder/Kimi-K3'});
  }else if(target==='deepseek'){
   const entries=(await import('yaml')).parse(text);
   expect(entries.find((entry:{id:string})=>entry.id==='llm-pi-ai').config.providers['token-flow'].models[0]).toMatchObject({id:model,name:'qoder/Kimi-K3'});
   expect(entries.find((entry:{id:string})=>entry.id==='agent-default-model').config.model).toBe(model);
  }else{
   const config=JSON.parse(text);
   if(target==='claude'){
    expect(config.env.ANTHROPIC_MODEL).toBe('');expect(config.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('');
    expect(config.modelPicker.options).toEqual([{model,label:'qoder/Kimi-K3'}]);
   }else if(target==='pi')expect(config.providers['token-flow'].models[0]).toMatchObject({id:model,name:'qoder/Kimi-K3'});
   else if(target==='qoder')expect(config.providers['token-flow'].models).toEqual([{model,displayName:'qoder/Kimi-K3'}]);
   else expect(config[0]).toMatchObject({id:'qoder/Kimi-K3',name:'qoder/Kimi-K3'});
  }
  await connections.restore(record.id);expect(await readFile(path,'utf8')).toBe(original);
 }
});

it.each(['pi','deepseek'] as const)('imports %s models, rejects stale writes and restores unrelated settings',async target=>{
 const {connections,root}=await setup();const path=connections.paths[target];
 const original=target==='pi'?'{"providers":{"personal":{"apiKey":"private-original","models":[{"id":"mine"}]}}}':'# original\n- id: llm-pi-ai\n  config:\n    providers:\n      personal:\n        apiKeyEnv: PERSONAL_KEY\n- id: agent-default-model\n  config:\n    provider: personal\n    model: mine\n';
 await mkdir(join(path,'..'),{recursive:true});await writeFile(path,original);
 const selections=[{sourceId:'a'.repeat(24),model:'qoder/one'},{sourceId:'b'.repeat(24),model:'workbuddy/two'}];
 let state=(await connections.status()).find(t=>t.id===target)!;
 const first=await connections.apply({target,revision:state.revision,origin:'http://127.0.0.1:9527',model:selections[0].model,sourceId:selections[0].sourceId,selections,keyId:randomUUID(),key:'private-gateway-key'});
 expect((await connections.review(first.id)).checks.every(c=>c.ok)).toBe(true);
 if(target==='deepseek'){
  const yaml=await import('yaml');const entries=yaml.parse(await readFile(path,'utf8'));
  entries.find((entry:{id:string})=>entry.id==='agent-default-model').config.model=selections[1].model;
  await writeFile(path,yaml.stringify(entries));
  expect((await connections.status()).find(t=>t.id===target)?.configurationState).toBe('configured');
  expect((await connections.review(first.id)).checks.every(c=>c.ok)).toBe(true);
 }
 const preview=await connections.preview(target,'http://127.0.0.1:9527',selections[1].model,false,selections);
 expect(JSON.stringify(preview)).not.toContain('private-original');expect(JSON.stringify(preview)).not.toContain('private-gateway-key');
 expect(JSON.stringify(await connections.status())).not.toContain('private-gateway-key');
 const second=await connections.apply({target,replaceId:first.id,revision:preview.revision,origin:'http://127.0.0.1:9527',model:selections[1].model,sourceId:selections[1].sourceId,selections,keyId:randomUUID(),key:'second-private-key'});
 expect((await connections.review(second.id)).checks.every(c=>c.ok)).toBe(true);
 await connections.restore(second.id);expect(await readFile(path,'utf8')).toBe(original);
 const stale=await connections.preview(target,'http://127.0.0.1:9527',selections[0].model);
 await writeFile(path,target==='pi'?'{"providers":{}}':'[]\n');
 await expect(connections.apply({target,revision:stale.revision,origin:'http://127.0.0.1:9527',model:selections[0].model,sourceId:selections[0].sourceId,keyId:randomUUID(),key:'unused-key'})).rejects.toThrow('变更');
 expect(connections.paths[target]).toContain(root);
});

it('refuses ambiguous or executable DeepSeek YAML without converting user plugins',()=>{
 for(const original of ['- id: llm-pi-ai\n- id: llm-pi-ai\n','- id: custom\n  config: !!js process.env.KEY\n'])expect(()=>connectedConfig('deepseek',original,'http://127.0.0.1:9527','qoder/test','key')).toThrow();
});

it.each([false,true])('connects DeepSeek in its editable desktop profile and preserves providers added in Harness settings (existing provider: %s)',async existing=>{
 const {root,connections}=await setup();const home=join(root,'.dsh'),profile=join(home,'profiles/desktop/cordis.patch.yml');
 expect(connections.paths.deepseek).toBe(profile);
 const previousHome=process.env.DSH_HOME;process.env.DSH_HOME=home;
 try{expect(agentPaths().deepseek).toBe(profile);}finally{if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;}
 const yaml=await import('yaml');
 const personal=existing?{personal:{apiKeyEnv:'PERSONAL_KEY'}}:{};
 const original=existing?[{id:'llm-pi-ai',config:{providers:personal}}]:[];
 await mkdir(join(profile,'..'),{recursive:true});await writeFile(profile,yaml.stringify(original));
 const state=(await connections.status()).find(t=>t.id==='deepseek')!;
 const record=await connections.apply({target:'deepseek',revision:state.revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
 const entries=yaml.parse(await readFile(profile,'utf8'));
 entries.find((entry:{id:string})=>entry.id==='llm-pi-ai').config.providers.manual={apiKeyEnv:'MANUAL_KEY'};
 await writeFile(profile,yaml.stringify(entries));
 expect((await connections.status()).find(t=>t.id==='deepseek')?.configurationState).toBe('configured');
 await connections.restore(record.id);
 expect(yaml.parse(await readFile(profile,'utf8'))).toEqual([{id:'llm-pi-ai',config:{providers:{...personal,manual:{apiKeyEnv:'MANUAL_KEY'}}}}]);
 await expect(readFile(join(home,'cordis.patch.yml'))).rejects.toMatchObject({code:'ENOENT'});
});

it('restores legacy DeepSeek home patches before using the desktop profile, including after reopening',async()=>{
 const {root}=await setup();const home=join(root,'.dsh'),legacy=join(home,'cordis.patch.yml'),profile=join(home,'profiles/desktop/cordis.patch.yml');
 const old=new AgentConnections(root,{deepseek:legacy},async()=>[]);
 const state=(await old.status()).find(t=>t.id==='deepseek')!;
 const record=await old.apply({target:'deepseek',revision:state.revision,origin:'http://127.0.0.1:9527',model:'qoder/old',sourceId:'source',keyId:randomUUID(),key:'old-fixture-key'});
 const backup=join(root,'agent-backups',`${record.id}.json`),journal=JSON.parse(await readFile(backup,'utf8'));
 delete journal.deepseekScope;await writeFile(backup,JSON.stringify(journal));
 await mkdir(join(profile,'..'),{recursive:true});const manual='- id: llm-pi-ai\n  config:\n    providers:\n      personal:\n        apiKeyEnv: PERSONAL_KEY\n';await writeFile(profile,manual);
 const reopened=new AgentConnections(root,{deepseek:profile},async()=>[]);
 expect((await reopened.status()).find(t=>t.id==='deepseek')).toMatchObject({path:legacy,configurationState:'configured'});
 await expect(reopened.preview('deepseek','http://127.0.0.1:9527','qoder/new')).rejects.toThrow('恢复原配置');
 await expect(reopened.apply({target:'deepseek',replaceId:record.id,revision:state.revision,origin:'http://127.0.0.1:9527',model:'qoder/new',sourceId:'source',keyId:randomUUID(),key:'unused-key'})).rejects.toThrow('恢复原配置');
 await reopened.restore(record.id);
 await expect(readFile(legacy)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(profile,'utf8')).toBe(manual);
 const next=(await reopened.status()).find(t=>t.id==='deepseek')!;expect(next.path).toBe(profile);
 const connected=await reopened.apply({target:'deepseek',revision:next.revision,origin:'http://127.0.0.1:9527',model:'qoder/new',sourceId:'source',keyId:randomUUID(),key:'new-fixture-key'});
 const again=new AgentConnections(root,{deepseek:profile},async()=>[]);
 expect((await again.status()).find(t=>t.id==='deepseek')).toMatchObject({path:profile,configurationState:'configured'});
 await again.restore(connected.id);expect(await readFile(profile,'utf8')).toBe(manual);
});

it.each(['llm-pi-ai','agent-default-model'])('refuses a DeepSeek profile write shadowed by an unmanaged global %s override',async id=>{
 const {root,connections}=await setup();const homePatch=join(root,'.dsh/cordis.patch.yml');
 await mkdir(join(homePatch,'..'),{recursive:true});const original=JSON.stringify([{id,config:{fixture:'personal-setting'}}]);await writeFile(homePatch,original);
 const state=(await connections.status()).find(t=>t.id==='deepseek')!;
 await expect(connections.preview('deepseek','http://127.0.0.1:9527','qoder/test')).rejects.toThrow('全局补丁');
 await expect(connections.apply({target:'deepseek',revision:state.revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'source',keyId:randomUUID(),key:'unused-key'})).rejects.toThrow('全局补丁');
 expect(await readFile(homePatch,'utf8')).toBe(original);await expect(readFile(connections.paths.deepseek)).rejects.toMatchObject({code:'ENOENT'});
});

it('resolves an implicit official model when the original configuration omits it',async()=>{
 const resolver=vi.spyOn(codexRuntime,'codexDefaultModel').mockResolvedValue('official-default');
 try{
 const {paths,connections}=await setup();await writeFile(paths.codex,'approval_policy = "untrusted"\n');
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
 expect(await connections.officialModel(record.id)).toBe('official-default');
 expect(resolver).toHaveBeenCalledOnce();
 }finally{resolver.mockRestore();}
});

it.each([null,'','profile="work"\n[profiles.work]\napproval_policy="untrusted"'])('resolves the official default for missing or implicit profile configuration (%s)',async original=>{
 const {paths,connections}=await setup();if(original!==null)await writeFile(paths.codex,original);
 const resolver=vi.spyOn(codexRuntime,'codexDefaultModel').mockImplementation(async home=>{
  expect(parse(await readFile(join(home,'config.toml'),'utf8'))).toEqual({model_provider:'openai',cli_auth_credentials_store:'file'});
  expect(home).not.toBe(join(paths.codex,'..'));return 'official-default';
 });
 try{
  const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
  expect(await connections.officialModel(record.id)).toBe('official-default');
  await expect(stat(resolver.mock.calls[0]![0])).rejects.toMatchObject({code:'ENOENT'});
  await connections.restore(record.id);expect(await readFile(paths.codex,'utf8').catch(()=>null)).toBe(original);
 }finally{resolver.mockRestore();}
});
it('uses the original explicit profile model and refuses to invent an official model for a custom provider',async()=>{
 const resolver=vi.spyOn(codexRuntime,'codexDefaultModel');
 try{for(const provider of ['openai','custom']){
  const {paths,connections}=await setup();await writeFile(paths.codex,`model="root-model"\nprofile="work"\n[profiles.work]\nmodel="profile-model"\nmodel_provider="${provider}"`);
  const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
  expect(await connections.officialModel(record.id)).toBe(provider==='openai'?'profile-model':undefined);
 }expect(resolver).not.toHaveBeenCalled();}finally{resolver.mockRestore();}
});
it('cleans up isolated default-model resolution on failure and keeps the active gateway config',async()=>{
 const {paths,connections}=await setup();await writeFile(paths.codex,'');
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
 const active=await readFile(paths.codex,'utf8');const resolver=vi.spyOn(codexRuntime,'codexDefaultModel').mockRejectedValue(Error('catalog unavailable'));
 try{await expect(connections.officialModel(record.id)).rejects.toThrow('catalog unavailable');
  await expect(stat(resolver.mock.calls[0]![0])).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(paths.codex,'utf8')).toBe(active);
 }finally{resolver.mockRestore();}
});

// A copied installation or the native provider editor can leave an unmanaged token-flow entry.
it('reconnects Qoder after native API edits and preserves exact preimages',async()=>{
 const {root,paths,connections}=await setup();await mkdir(join(paths.qoder,'..'),{recursive:true});
 const original=JSON.stringify({hooks:{keep:true},providers:{'token-flow':{apiKey:'manual-key',model:'manual'},personal:{apiKey:'keep-key'}}});
 await writeFile(paths.qoder,original);
 const first=await connections.apply({target:'qoder',revision:(await connections.status()).find(t=>t.id==='qoder')!.revision,origin:'http://127.0.0.1:9527',model:'workbuddy/one',sourceId:'source',keyId:randomUUID(),key:'first-key'});
 expect((await connections.review(first.id)).checks.every(c=>c.ok)).toBe(true);
 const changed=JSON.parse(await readFile(paths.qoder,'utf8'));changed.providers['token-flow'].apiKey='edited-key';changed.providers['token-flow'].model='edited';changed.theme='dark';
 const edited=JSON.stringify(changed);await writeFile(paths.qoder,edited);
 const preview=await connections.preview('qoder','http://127.0.0.1:9527','workbuddy/two');
 const second=await connections.apply({target:'qoder',revision:preview.revision,replaceId:preview.replaceId,origin:'http://127.0.0.1:9527',model:'workbuddy/two',sourceId:'source',keyId:randomUUID(),key:'second-key'});
 const journal=JSON.parse(await readFile(join(root,'agent-backups',second.id+'.json'),'utf8'));
 expect(journal.previousConfig).toBe(edited);
 expect(JSON.parse(await readFile(paths.qoder,'utf8'))).toMatchObject({hooks:{keep:true},theme:'dark',providers:{personal:{apiKey:'keep-key'},'token-flow':{model:'workbuddy/two',apiKey:'second-key'}}});
 await connections.restore(second.id);
 expect(JSON.parse(await readFile(paths.qoder,'utf8'))).toMatchObject({theme:'dark',providers:{'token-flow':{apiKey:'manual-key',model:'manual'}}});
});

it('keeps Qoder stale revisions and malformed files protected while allowing model add/remove cycles',async()=>{
 const {paths,connections}=await setup();await mkdir(join(paths.qoder,'..'),{recursive:true});
 const origin='http://127.0.0.1:9527',sourceId='a'.repeat(24);
 await writeFile(paths.qoder,'{"providers":{"token-flow":{"apiKey":"manual"}},"hooks":{"keep":true}}');
 for(const models of [['workbuddy/one'],['workbuddy/one','qoder/two'],['qoder/two'],['workbuddy/one']]){
  const selections=models.map(model=>({model,sourceId}));
  const p=await connections.preview('qoder',origin,models[0],false,selections);
  await connections.apply({target:'qoder',origin,model:models[0],sourceId,revision:p.revision,replaceId:p.replaceId,selections,keyId:randomUUID(),key:'fixture'});
  const written=JSON.parse(await readFile(paths.qoder,'utf8'));
  expect(written.providers['token-flow'].models.map((m:{model:string})=>m.model)).toEqual(models);
  expect(written.hooks).toEqual({keep:true});
 }
 const p=await connections.preview('qoder',origin,'workbuddy/one');
 const damaged='{"providers":';await writeFile(paths.qoder,damaged);
 await expect(connections.apply({target:'qoder',origin,model:'workbuddy/one',sourceId,revision:p.revision,replaceId:p.replaceId,keyId:randomUUID(),key:'fixture'})).rejects.toThrow('配置已变更');
 expect(await readFile(paths.qoder,'utf8')).toBe(damaged);
 await expect(connections.preview('qoder',origin,'workbuddy/one')).rejects.toThrow();
 expect(await readFile(paths.qoder,'utf8')).toBe(damaged);
});

it('neutralizes conflicting Claude cloud routing and restores it after local gateway use',async()=>{
 const {paths,connections}=await setup();const original={env:{CLAUDE_CODE_USE_BEDROCK:'1',CLAUDE_CODE_USE_VERTEX:'1',CLAUDE_CODE_USE_FOUNDRY:'1',ANTHROPIC_PROFILE:'custom',ANTHROPIC_MODEL:'stale',CLAUDE_CODE_OAUTH_TOKEN:'old-oauth'},apiKeyHelper:'old-helper',forceLoginGatewayUrl:'https://original.example',forceLoginMethod:'console',forceLoginOrgUUID:'old-org'};await writeFile(paths.claude,JSON.stringify(original));
 const record=await connections.apply({target:'claude',revision:(await connections.status())[1].revision,origin:'http://127.0.0.1:9527',model:'claude/first',sourceId:'a'.repeat(24),keyId:randomUUID(),key:'fixture-key',selections:[{model:'claude/first',sourceId:'a'.repeat(24)},{model:'claude/second',sourceId:'a'.repeat(24)}]});
 const doc=JSON.parse(await readFile(paths.claude,'utf8'));for(const k of ['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'])expect(doc.env[k]).toBe('0');expect(doc.apiKeyHelper).toBeUndefined();expect(doc.forceLoginGatewayUrl).toBeUndefined();doc.model='claude/second';await writeFile(paths.claude,JSON.stringify(doc));
 expect((await connections.review(record.id)).checks.every(c=>c.ok)).toBe(true);expect(doc.env.ANTHROPIC_MODEL).toBe('');expect(doc.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('');
 await connections.restore(record.id);expect(JSON.parse(await readFile(paths.claude,'utf8'))).toEqual(original);
});

it('returns Codex to official defaults from current conflicting routing without replaying a previous provider or changing login',async()=>{
 const {root,paths,connections}=await setup();
 await writeFile(paths.codex,'model_provider="old_vendor"\nmodel="old-model"\n');
 const auth=join(paths.codex,'..','auth.json');await writeFile(auth,'{"fixture_login":"unchanged"}');
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'codex/model',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const external='model_provider="other"\nmodel="other-model"\nopenai_base_url="https://fixture.invalid"\nmodel_catalog_json="custom.json"\nprofile="work"\napproval_policy="on-request"\n[profiles.work]\nmodel_provider="other"\nmodel="sub-model"\nopenai_base_url="https://fixture.invalid"\n[agents]\ndefault_subagent_model="other-model"\n[model_providers.openai]\nbase_url="https://fixture.invalid"\n[model_providers.token_flow]\nbase_url="http://127.0.0.1:9527/v1"\n';
 await writeFile(paths.codex,external);
 const preview=await connections.restorePreview(record.id,'native');
 expect(preview).toMatchObject({canRestore:true,destination:{kind:'official',provider:'openai'}});
 await connections.restore(record.id,{revision:preview.revision,allowRunning:false},'native');
 const result=parse(await readFile(paths.codex,'utf8')) as any;
 expect(result).toMatchObject({model_provider:'openai',approval_policy:'on-request',profiles:{work:{model_provider:'openai'}}});
 for(const field of ['model','openai_base_url','model_catalog_json']){expect(result[field]).toBeUndefined();expect(result.profiles.work[field]).toBeUndefined();}
 expect(result.model_providers?.openai).toBeUndefined();expect(result.model_providers?.token_flow).toBeUndefined();expect(result.agents?.default_subagent_model).toBeUndefined();
 expect(await readFile(auth,'utf8')).toBe('{"fixture_login":"unchanged"}');
 const {readdir}=await import('node:fs/promises');const backup=(await readdir(join(root,'agent-backups'))).find(name=>name.startsWith(`native-${record.id}-`))!;
 expect(JSON.parse(await readFile(join(root,'agent-backups',backup),'utf8')).before).toBe(external);
});

it('returns gateway profiles and their subagent defaults to official routing after the selected profile changes',async()=>{
 const {paths,connections}=await setup();
 await writeFile(paths.codex,'profile="work"\n[agents]\ndefault_subagent_model="native-small"\nmax_threads=3\n[profiles.work]\nmodel="native-work"\n[profiles.work.agents]\ndefault_subagent_model="native-work-small"\nmax_threads=2\n[profiles.personal]\nmodel_provider="openai"\n[profiles.custom]\nmodel_provider="custom"\nmodel="own-model"\n');
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'codex/model',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const current=parse(await readFile(paths.codex,'utf8')) as any;
 current.profile='personal';current.agents.default_subagent_model='codex/model';current.profiles.work.agents.default_subagent_model='codex/model';
 await writeFile(paths.codex,stringify(current));
 const preview=await connections.restorePreview(record.id,'native');
 await connections.restore(record.id,{revision:preview.revision,allowRunning:false},'native');
 const restored=parse(await readFile(paths.codex,'utf8')) as any;
 expect(restored.model_provider).toBe('openai');
 expect(restored.profiles.work.model_provider).toBe('openai');
 expect(restored.profiles.work.model).toBeUndefined();
 expect(restored.profiles.work.agents).toEqual({max_threads:2});
 expect(restored.agents).toEqual({max_threads:3});
 expect(restored.profiles.custom).toEqual({model_provider:'custom',model:'own-model'});
});

it('can directly replace conflicting gateway routing for every local Agent',async()=>{
 const {paths,connections}=await setup();
 for(const target of ['codex','claude','pi','qoder','workbuddy','workbuddy-ai','deepseek'] as const){
  const path=connections.paths[target];const first=await connections.preview(target,'http://127.0.0.1:9527','codex/one');
  const record=await connections.apply({target,revision:first.revision,origin:'http://127.0.0.1:9527',model:'codex/one',sourceId:'s',keyId:randomUUID(),key:'first-key'});
  await writeFile(path,(await readFile(path,'utf8')).replaceAll('first-key','external-key'));
  const preview=await connections.preview(target,'http://127.0.0.1:9527','codex/two');
  await connections.apply({target,revision:preview.revision,replaceId:record.id,origin:'http://127.0.0.1:9527',model:'codex/two',sourceId:'s',keyId:randomUUID(),key:'next-key'});
  expect(await readFile(path,'utf8')).toContain('next-key');
 }
});

it.each(['claude','pi','qoder','workbuddy','workbuddy-ai','deepseek'] as const)('exits %s gateway from current settings instead of replaying the pre-connection config',async target=>{
 const {root,connections}=await setup();const path=connections.paths[target];await mkdir(join(path,'..'),{recursive:true});
 const original=target==='claude'?'{"env":{"ANTHROPIC_BASE_URL":"https://old.invalid","ANTHROPIC_SMALL_FAST_MODEL":"old-third-party"},"theme":"old"}':target==='deepseek'?'[]':target==='workbuddy'||target==='workbuddy-ai'?'[]':'{}';
 await writeFile(path,original);
 const record=await connections.apply({target,revision:(await connections.preview(target,'http://127.0.0.1:9527','codex/one')).revision,origin:'http://127.0.0.1:9527',model:'codex/one',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const current=(await readFile(path,'utf8')).replaceAll('fixture-key','external-key');await writeFile(path,current);
 const preview=await connections.restorePreview(record.id,'native');expect(preview.canRestore).toBe(true);
 await connections.restore(record.id,{revision:preview.revision,allowRunning:false},'native');
 const result=await readFile(path,'utf8');expect(result).not.toContain('external-key');expect(result).not.toContain('old-third-party');expect(result).not.toContain('https://old.invalid');
 if(target==='claude')expect(JSON.parse(result)).toEqual({env:{},theme:'old'});
 const {readdir}=await import('node:fs/promises');expect((await readdir(join(root,'agent-backups'))).some(name=>name.startsWith(`native-${record.id}-`))).toBe(true);
});

it('disconnects DeepSeek gateway without changing a subsequently selected unrelated API model',async()=>{
 const {connections}=await setup();const path=connections.paths.deepseek;
 const preview=await connections.preview('deepseek','http://127.0.0.1:9527','codex/one');
 const record=await connections.apply({target:'deepseek',revision:preview.revision,origin:'http://127.0.0.1:9527',model:'codex/one',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const yaml=await import('yaml');const entries=yaml.parse(await readFile(path,'utf8'));
 const defaults=entries.find((entry:{id:string})=>entry.id==='agent-default-model');defaults.config={provider:'other-api',model:'chosen-by-user',temperature:0.5};
 const providers=entries.find((entry:{id:string})=>entry.id==='llm-pi-ai').config.providers;providers['other-api']={baseURL:'https://fixture.invalid',apiKey:'keep-fixture-key',models:[{id:'chosen-by-user'}]};
 await writeFile(path,yaml.stringify(entries));
 const leaving=await connections.restorePreview(record.id,'native');expect(leaving.destination?.kind).toBe('disconnect');
 await connections.restore(record.id,{revision:leaving.revision,allowRunning:false},'native');
 const result=yaml.parse(await readFile(path,'utf8'));
 expect(result.find((entry:{id:string})=>entry.id==='agent-default-model').config).toEqual(defaults.config);
 const after=result.find((entry:{id:string})=>entry.id==='llm-pi-ai').config.providers;
 expect(after['token-flow']).toBeUndefined();expect(after['other-api']).toEqual(providers['other-api']);
});

const duplicateCodex='model = "broken"\n[model_providers.duplicate]\nbase_url = "https://fixture.invalid"\n[model_providers.duplicate]\nbase_url = "https://other.invalid"\n';
it('rebuilds duplicate Codex TOML from a minimal legal base and privately preserves exact damaged bytes',async()=>{
 const {root,paths,connections}=await setup();await writeFile(paths.codex,duplicateCodex);
 const preview=await connections.preview('codex','http://127.0.0.1:9527','fixture/model');
 expect(preview.recovery?.strategy).toBe('minimal');
 const record=await connections.apply({target:'codex',revision:preview.revision,origin:'http://127.0.0.1:9527',model:'fixture/model',sourceId:'s',keyId:randomUUID(),key:'private-key'});
 expect(parse(await readFile(paths.codex,'utf8'))).toMatchObject({model:'fixture/model',model_provider:'token_flow'});
 expect((await connections.status())[0]).toMatchObject({configurationState:'configured',drift:false});
 expect((await connections.review(record.id)).checks.every(check=>check.ok)).toBe(true);
 const journal=JSON.parse(await readFile(join(root,'agent-backups',record.id+'.json'),'utf8'));expect(journal.previousConfig).toBe(duplicateCodex);
 expect(JSON.stringify(await connections.status())).not.toContain('broken');
 await connections.restore(record.id);
 expect(parse(await readFile(paths.codex,'utf8'))).toEqual({});
});
it('repairs active Codex drift using a legal backup while preserving non-routing settings and the bad preimage',async()=>{
 const {root,paths,connections}=await setup();await writeFile(paths.codex,'approval_policy="on-request"\n[mcp_servers.fixture]\ncommand="fixture"\n');
 const first=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'fixture/first',sourceId:'s',keyId:randomUUID(),key:'first-key'});
 await writeFile(paths.codex,duplicateCodex);
 const preview=await connections.preview('codex','http://127.0.0.1:9527','fixture/second');expect(preview.recovery?.strategy).toBe('backup');
 const second=await connections.apply({target:'codex',revision:preview.revision,replaceId:first.id,origin:'http://127.0.0.1:9527',model:'fixture/second',sourceId:'s',keyId:randomUUID(),key:'second-key'});
 expect(parse(await readFile(paths.codex,'utf8'))).toMatchObject({approval_policy:'on-request',mcp_servers:{fixture:{command:'fixture'}},model:'fixture/second'});
 const journal=JSON.parse(await readFile(join(root,'agent-backups',second.id+'.json'),'utf8'));expect(journal.previousConfig).toBe(duplicateCodex);
 await connections.restore(second.id);expect(parse(await readFile(paths.codex,'utf8'))).toMatchObject({approval_policy:'on-request',mcp_servers:{fixture:{command:'fixture'}}});
});
it.each(['previous','native'] as const)('restores %s from malformed active Codex and refuses a newer concurrent revision',async destination=>{
 const {root,paths,connections}=await setup();await writeFile(paths.codex,'approval_policy="on-request"\nmodel="native"\n');
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'fixture/first',sourceId:'s',keyId:randomUUID(),key:'first-key'});
 await writeFile(paths.codex,duplicateCodex);
 const restoration=await connections.restoration(record.id,destination)??'';const preview=await connections.restorePreview(record.id,destination);expect(preview.canRestore).toBe(true);expect(()=>parse(restoration)).not.toThrow();
 const newer='approval_policy="never"\n';await writeFile(paths.codex,newer);
 await expect(connections.restore(record.id,{revision:preview.revision,allowRunning:true},destination)).rejects.toThrow('已变更');expect(await readFile(paths.codex,'utf8')).toBe(newer);
 await writeFile(paths.codex,duplicateCodex);await connections.restore(record.id,{revision:preview.revision,allowRunning:true},destination);
 expect(parse(await readFile(paths.codex,'utf8'))).toMatchObject({approval_policy:'on-request'});
 const {readdir}=await import('node:fs/promises');const names=await readdir(join(root,'agent-backups'));
 const backups=await Promise.all(names.filter(name=>name.startsWith('codex-repair-')).map(name=>readFile(join(root,'agent-backups',name),'utf8')));expect(backups.some(text=>JSON.parse(text).before===duplicateCodex)).toBe(true);
});
it('does not overwrite a newer Codex file after a malformed preview',async()=>{
 const {paths,connections}=await setup();await writeFile(paths.codex,duplicateCodex);const preview=await connections.preview('codex','http://127.0.0.1:9527','fixture/model');
 const newer='model="newer"\n';await writeFile(paths.codex,newer);
 await expect(connections.apply({target:'codex',revision:preview.revision,origin:'http://127.0.0.1:9527',model:'fixture/model',sourceId:'s',keyId:randomUUID(),key:'private-key'})).rejects.toThrow('已变更');expect(await readFile(paths.codex,'utf8')).toBe(newer);
});
it.each(['apply','native'] as const)('preserves a newer file written during %s after the damaged preimage backup',async operation=>{
 const {root,paths,connections}=await setup();await writeFile(paths.codex,'approval_policy="on-request"\n');
 const first=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'fixture/first',sourceId:'s',keyId:randomUUID(),key:'first-key'});
 await writeFile(paths.codex,duplicateCodex);
 const revision=(await connections.status())[0].revision,newer='model="concurrent"\n';let checks=0;
 // apply checks processes once before reading, then again immediately before replacement.
 const concurrent=new AgentConnections(root,paths,async()=>{checks++;if(checks===(operation==='apply'?2:1))await writeFile(paths.codex,newer);return [];});
 const task=operation==='apply'?concurrent.apply({target:'codex',revision,replaceId:first.id,origin:'http://127.0.0.1:9527',model:'fixture/second',sourceId:'s',keyId:randomUUID(),key:'second-key'}):concurrent.restore(first.id,{revision,allowRunning:false},'native');
 await expect(task).rejects.toThrow('其他应用修改');expect(await readFile(paths.codex,'utf8')).toBe(newer);
});
it('uses legal official config for model preflight while the damaged current file remains untouched',async()=>{
 const {paths,connections}=await setup();await writeFile(paths.codex,duplicateCodex);
 const resolver=vi.spyOn(codexRuntime,'codexDefaultModel').mockImplementation(async home=>{
  expect(parse(await readFile(join(home,'config.toml'),'utf8'))).toMatchObject({model_provider:'openai'});return 'fixture-official';
 });
 try{expect(await connections.currentOfficialModel()).toBe('fixture-official');expect(await readFile(paths.codex,'utf8')).toBe(duplicateCodex);}finally{resolver.mockRestore();}
});
it('keeps byte-exact damaged Codex backups and never replays the old gateway from a legal image',async()=>{
 const {root,paths,connections}=await setup();
 const first=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'fixture/first',sourceId:'s',keyId:randomUUID(),key:'old-private-key'});
 const damaged=Buffer.concat([Buffer.from(duplicateCodex),Buffer.from([0xff,0xfe])]);await writeFile(paths.codex,damaged);
 const preview=await connections.restorePreview(first.id,'native');expect(preview.recovery?.strategy).toBe('backup');
 await connections.restore(first.id,{revision:preview.revision,allowRunning:true},'native');
 const text=await readFile(paths.codex,'utf8');expect(text).not.toContain('old-private-key');expect(text).not.toContain('token_flow');expect(parse(text).model_provider).toBe('openai');
 const {readdir}=await import('node:fs/promises');const backups=(await readdir(join(root,'agent-backups'))).filter(name=>name.startsWith('codex-repair-'));
 const backup=JSON.parse(await readFile(join(root,'agent-backups',backups[0]),'utf8'));expect(Buffer.from(backup.bytes,'base64')).toEqual(damaged);expect((await stat(join(root,'agent-backups',backups[0]))).mode&0o777).toBe(0o600);
});

it('keeps official Codex catalog metadata and ChatGPT authentication alongside gateway selections',async()=>{
 const {paths,connections}=await setup();const original='model="native"\nprofile="work"\napproval_policy="on-request"\n[profiles.work]\nmodel="native"\n';await writeFile(paths.codex,original);
 const auth=join(paths.codex,'..','auth.json'),login='{"tokens":{"access_token":"private-official-token"}}';await writeFile(auth,login);
 const {codexModelCatalog}=await import('../packages/core/src/codex-model-catalog');
 const official={models:codexModelCatalog('gpt-fixture').models.map(model=>({...model,description:'original official metadata',context_window:1000000,default_reasoning_level:'high'}))};
 const selections=[{model:'fixture/gateway',sourceId:'a'.repeat(24)}];
 const first=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',...selections[0],selections,keyId:randomUUID(),key:'gateway-key',officialCatalog:official});
 expect(first).toMatchObject({codexCoexist:true,officialModelSlugs:['gpt-fixture']});
 const current=parse(await readFile(paths.codex,'utf8')) as any;
 expect(current.model_providers.token_flow).toEqual({name:'TokenFlow',base_url:'http://127.0.0.1:9527/codex/v1',wire_api:'responses',http_headers:{'x-tokenflow-client-key':'gateway-key'},requires_openai_auth:true,supports_websockets:false,capabilities:{remote_compaction:'v2'}});
 const catalog=JSON.parse(await readFile(current.model_catalog_json,'utf8'));expect(catalog.models[0]).toEqual(official.models[0]);expect(catalog.models.map((model:any)=>model.slug)).toEqual(['gpt-fixture','fixture/gateway']);
 expect(catalog.tokenflow_gateway_models).toEqual(['fixture/gateway']);expect(await readFile(auth,'utf8')).toBe(login);
 current.model='gpt-fixture';current.profiles.work.model='gpt-fixture';await writeFile(paths.codex,stringify(current));
 expect((await connections.status())[0]).toMatchObject({configurationState:'configured',drift:false});expect((await connections.review(first.id)).checks.every(check=>check.ok)).toBe(true);
 current.model_providers.token_flow.http_headers['x-tokenflow-client-key']='external-key';await writeFile(paths.codex,stringify(current));expect((await connections.status())[0].drift).toBe(true);expect((await connections.review(first.id)).checks.find(check=>check.name==='客户端 Key 未被覆盖')?.ok).toBe(false);current.model_providers.token_flow.http_headers['x-tokenflow-client-key']='gateway-key';await writeFile(paths.codex,stringify(current));
 const probe=vi.fn(async()=>64000);await connections.refreshCodexCompactionLimits(probe);expect(probe).toHaveBeenCalledTimes(1);expect(probe).toHaveBeenCalledWith('fixture/gateway');
 expect(JSON.parse(await readFile(current.model_catalog_json,'utf8')).models[0]).toEqual(official.models[0]);
 const second=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,replaceId:first.id,origin:'http://127.0.0.1:9527',...selections[0],selections,keyId:randomUUID(),key:'standalone-key'});
 const standalone=parse(await readFile(paths.codex,'utf8')) as any;expect(standalone.model_providers.token_flow.experimental_bearer_token).toBe('standalone-key');expect(standalone.model_providers.token_flow.http_headers).toBeUndefined();expect(standalone.model_providers.token_flow.requires_openai_auth).toBe(false);
 expect(standalone.model_providers.token_flow.capabilities).toBeUndefined();
 await connections.restore(second.id);expect(await readFile(paths.codex,'utf8')).toBe(original);expect(await readFile(auth,'utf8')).toBe(login);
});
it('rejects official and gateway model slug collisions before changing Codex configuration',async()=>{
 const {paths,connections}=await setup();const original='model="native"\n';await writeFile(paths.codex,original);
 await expect(connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'collision',sourceId:'s',keyId:randomUUID(),key:'key',officialCatalog:{models:[{slug:'collision'}]}})).rejects.toThrow('重复');expect(await readFile(paths.codex,'utf8')).toBe(original);
});
