import {macAppIdentity,macQoderIdeProcesses} from './agent-lifecycle.js';
import {codexDefaultModel} from './codex-runtime.js';
import {codexRoutingMode} from './codex-routing-mode.js';
import { readFile, writeFile, mkdir, rename, lstat, unlink, open, rm, mkdtemp, copyFile, chmod, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, parse as parsePath, win32 } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { parseDocument as parseYAMLDocument, stringify as stringifyYAML } from 'yaml';
import { detectAgent } from './agent-installation.js';
import {mergeCodexCatalog,type OfficialCodexCatalog} from './codex-coexist.js';
import { codexModelCatalog, codexContextMetadata, CODEX_TOOL_OUTPUT_LIMIT } from './codex-model-catalog.js';
import { apiModelDisplayName } from '../../../apps/shared/api-endpoint.js';
import { deepseekConfigPath,deepseekHome } from './deepseek-config.js';
import {WindowsAgentLifecycle} from './windows-agent-lifecycle.js';

/** Read the official default with an isolated config, never the active gateway catalog. */
export async function officialCodexModel(configPath:string,text:string|null,originalAuth?:string|null){
 const config=parse(text??''),effective={...config,...codexProfile(config)};
 if((effective.model_provider??'openai')!=='openai')return undefined;
 if(typeof effective.model==='string'&&effective.model.trim())return effective.model;
 const home=await mkdtemp(join(await realpath(tmpdir()),'token-flow-official-model-'));
 try{
  const auth=originalAuth===undefined?await readConfig(join(dirname(configPath),'auth.json')):originalAuth;
  if(auth!==null)await writeFile(join(home,'auth.json'),auth,{mode:0o600});
  const cache=join(dirname(configPath),'models_cache.json');await safePath(cache);
  try{await copyFile(cache,join(home,'models_cache.json'));await chmod(join(home,'models_cache.json'),0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await writeFile(join(home,'config.toml'),stringify({model_provider:'openai',cli_auth_credentials_store:'file',...(typeof effective.model_catalog_json==='string'?{model_catalog_json:resolve(dirname(configPath),effective.model_catalog_json)}:{})}),{mode:0o600});
  return await codexDefaultModel(home);
 }finally{await rm(home,{recursive:true,force:true});}
}

export const targetSchema=z.enum(['codex','claude','workbuddy','qoder','deepseek','pi','workbuddy-ai']);
export type Target=z.infer<typeof targetSchema>;
const exec=promisify(execFile);
const hash=(text:string|null)=>createHash('sha256').update(text===null?'missing':`file:${text}`).digest('hex');
const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
export const modelSelectionSchema=z.object({sourceId:z.string().regex(/^[a-f0-9]{24}$/),model:z.string().min(3).max(300)}).strict();
export type ModelSelection=z.infer<typeof modelSelectionSchema>;
export const modelSelectionsSchema=z.array(modelSelectionSchema).min(1).max(100).refine(items=>new Set(items.map(i=>i.model)).size===items.length,'每个模型只能选择一个来源账号');
const recoverySchema=z.object({strategy:z.enum(['backup','minimal']),message:z.string()});
const recordSchema=z.object({codexDirectHybrid:z.boolean().optional(),codexCoexist:z.boolean().optional(),officialModelSlugs:z.array(z.string().min(1)).max(1000).optional(),recovery:recoverySchema.optional(),id:z.string().uuid(),target:targetSchema,createdAt:z.string(),before:z.string().nullable(),after:z.string(),beforeHash:z.string(),afterHash:z.string(),state:z.enum(['prepared','applied','restored']),keyId:z.string().uuid(),sourceId:z.string(),model:z.string(),fastModel:z.string().min(1).max(300).optional(),selections:modelSelectionsSchema.optional(),modelAliases:z.record(z.string().min(1).max(300)).optional(),supersedes:z.string().uuid().optional(),previousConfig:z.string().nullable().optional(),previousHash:z.string().optional(),deepseekScope:z.enum(['home','profile']).optional()});
type Record=z.infer<typeof recordSchema>;
export type ConnectionRecord=Omit<Record,'before'|'after'|'previousConfig'>;
const publicRecord=({before,after,previousConfig,...record}:Record):ConnectionRecord=>record;
const codexModelAllowed=(record:Record,model:unknown)=>typeof model==='string'&&((record.selections??[record]).some(item=>item.model===model)||!!(record.codexCoexist||record.codexDirectHybrid)&&!!record.officialModelSlugs?.includes(model));
const clientModelID=(record:Record,model:string)=>Object.entries(record.modelAliases??{}).find(([,route])=>route===model)?.[0]??model;
export type AgentPaths={[K in Target]:string};
const targetNames={codex:'Codex',claude:'Claude Code',workbuddy:'WorkBuddy',qoder:'Qoder',deepseek:'DeepSeek Harness',pi:'Pi Agent','workbuddy-ai':'WorkBuddyAI'};
const workbuddyModels=(target:Target)=>target==='workbuddy'||target==='workbuddy-ai';
export function agentPaths(home=homedir()):AgentPaths {
  return {pi:join(process.env.PI_CODING_AGENT_DIR||join(home,'.pi','agent'),'models.json'),deepseek:deepseekConfigPath(home,process.env.DSH_HOME),qoder:join(process.env.QODER_CONFIG_DIR||join(home,'.qoder'),'settings.json'),codex:join(process.env.CODEX_HOME||join(home,'.codex'),'config.toml'),claude:join(process.env.CLAUDE_CONFIG_DIR||join(home,'.claude'),'settings.json'),workbuddy:join(process.env.WORKBUDDY_CONFIG_DIR||process.env.CODEBUDDY_CONFIG_DIR||join(home,'.workbuddy'),'models.json'),'workbuddy-ai':join(process.env.WORKBUDDY_AI_CONFIG_DIR||join(home,'.workbuddy-ai'),'models.json')};
}
// Only return program identities. Node entrypoint inspection never returns or persists arguments.
export async function agentProcesses(target:Target|'antigravity'|'workbuddy-ai'|'qoder-ide'):Promise<number[]> {
  try {
    if(process.platform==='win32') {
      // Migration must see the native CLI PID before desktop-only identity checks.
      // This is read-only; lifecycle stop/open validates an app separately.
      if(target==='codex'){
        // Cold-start PowerShell/CIM on Windows can exceed 5s; these are read-only queries.
        const {stdout}=await exec('tasklist',['/FO','CSV','/NH'],{timeout:15000,maxBuffer:2*1024*1024});
        return stdout.split('\n').flatMap(line=>{const m=line.match(/^"(?:codex|ChatGPT|CodexCLI)(?:\.exe)?","(\d+)"/i);return m?[Number(m[1])]:[];});
      }
      if(target==='qoder'||target==='qoder-ide'||target==='workbuddy'||target==='workbuddy-ai'||target==='deepseek'){
        const desktop=(await new WindowsAgentLifecycle().processes(target)).map(p=>p.pid);
        if(target!=='deepseek'||desktop.length)return desktop;
      }
      if(target==='claude'){
        // Claude Desktop ships its own Claude.exe tree and an embedded Claude Code helper.
        // Only the standalone CLI counts as a Claude Code session.
        const runtime=basename(process.execPath).replaceAll("'","''");
        const script=`Get-CimInstance Win32_Process -Filter "Name='claude.exe' OR Name='node.exe' OR Name='${runtime}'" | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
        const result=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:15000,maxBuffer:2*1024*1024,windowsHide:true});
        const rows=result.stdout.trim()?JSON.parse(result.stdout):[];
        const desktopRoots=[process.env.LOCALAPPDATA&&win32.join(process.env.LOCALAPPDATA,'Claude-3p'),process.env.LOCALAPPDATA&&win32.join(process.env.LOCALAPPDATA,'AnthropicClaude'),process.env.LOCALAPPDATA&&win32.join(process.env.LOCALAPPDATA,'Programs','Claude'),process.env.LOCALAPPDATA&&win32.join(process.env.LOCALAPPDATA,'Claude')].filter((root):root is string=>!!root);
        const desktop=(path:string)=>{
          const normalized=win32.normalize(path).toLowerCase();
          if(/[\\/]windowsapps[\\/]anthropicpbc\.claude_/.test(normalized))return true;
          // Desktop installs also live in another user's profile; match the layout, not only the current home.
          if(/[\\/]appdata[\\/]local[\\/](?:claude-3p[\\/]claude-code|anthropicclaude|programs[\\/]claude|claude)[\\/]/.test(normalized))return true;
          return desktopRoots.some(root=>{const base=win32.normalize(root).toLowerCase();return normalized===base||normalized.startsWith(base+win32.sep);});
        };
        const launcher=/[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js$/i;
        return [...new Set((Array.isArray(rows)?rows:[rows]).flatMap(row=>{
          if(!Number.isInteger(row?.ProcessId)||row.ProcessId<=1||row.ProcessId===process.pid)return [];
          const quote=typeof row.CommandLine==='string'?row.CommandLine.match(/^\s*(?:"([^"]+)"|(\S+))/):null;
          const first=typeof row.ExecutablePath==='string'&&row.ExecutablePath?row.ExecutablePath:quote?.[1]??quote?.[2];
          if(typeof first==='string'&&/[\\/]claude\.exe$/i.test(first))return desktop(first)?[]:[row.ProcessId as number];
          const m=typeof row.CommandLine==='string'?row.CommandLine.match(/^\s*(?:"[^"]*"|\S+)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/):null;
          return m&&launcher.test(m[1]??m[2]??m[3]??'')?[row.ProcessId as number]:[];
        }))];
      }
      const {stdout}=await exec('tasklist',['/FO','CSV','/NH'],{timeout:15000,maxBuffer:2*1024*1024});
      const names=target==='deepseek'?'dsh':`${target}${target==='antigravity'?'(?: IDE)?':''}`;
      const found=stdout.split('\n').flatMap(line=>{const m=line.match(/^"([^"]+)","(\d+)"/);return m&&new RegExp(`^${names}(?:\\.exe)?$`,'i').test(m[1])?[Number(m[2])]:[];});
      if(!['pi','deepseek'].includes(target))return found;
      const runtime=basename(process.execPath).replaceAll("'","''");
      const script=`Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='${runtime}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
      const result=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:15000,maxBuffer:2*1024*1024,windowsHide:true});
      const nodes=result.stdout.trim()?JSON.parse(result.stdout):[];
      const launcher=target==='pi'?/[\\/](?:@earendil-works|@mariozechner)[\\/]pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js$/i:/[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/i;
      return [...new Set([...found,...(Array.isArray(nodes)?nodes:[nodes]).flatMap(node=>{const m=typeof node.CommandLine==='string'?node.CommandLine.match(/^\s*(?:"[^"]*"|\S+)\s+(?:"([^"]+)"|(\S+))/):null;return m&&Number.isInteger(node.ProcessId)&&launcher.test(m[1]??m[2])?[node.ProcessId]:[];})])];
    }
    const {stdout}=await exec('ps',['-axo','pid=,comm='],{timeout:5000,maxBuffer:2*1024*1024});
    if(process.platform==='darwin'&&(target==='workbuddy'||target==='workbuddy-ai'||target==='qoder'||target==='qoder-ide')){
      const bundle=target==='workbuddy'?'com.tencent.workbuddy.mac':target==='workbuddy-ai'?'com.workbuddy.workbuddy-ai':target==='qoder-ide'?'com.qoder.ide':'com.qoder.app';
      if(target==='qoder-ide'){
       return (await macQoderIdeProcesses(stdout)).map(row=>row.pid);
      }
      const candidates=stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(\/.*\.app)\/Contents\/MacOS\/([^/]+)$/);return m?[{pid:Number(m[1]),path:m[2],executable:m[3]}]:[];});
      const verified=await Promise.all(candidates.map(async candidate=>{const identity=await macAppIdentity(candidate.path);return identity?.bundle===bundle&&identity.executable===candidate.executable?candidate.pid:null;}));
      return verified.filter((pid):pid is number=>pid!==null);
    }
    const desktop=target==='deepseek'?'/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness':undefined;
    const codexDesktop=/(?:\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)|\/CodexCLI\.app\/Contents\/MacOS\/codex)$/i;
    // Match Codex's executable, not directories such as "Codex Framework".
    // Crash reporters can outlive the desktop and must not block migrations.
    const program=new RegExp(`(?:^|/)${target==='deepseek'?'dsh':target}${target==='claude'?'(?:\\.exe)?$':target==='pi'||target==='codex'?'$':'(?:$|[- ])'}`,'i');
    const found=stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(.+)$/);return m&&!(target==='claude'&&m[2].includes('/Claude.app/'))&&!(target==='qoder'&&m[2].includes('/Qoder IDE.app/'))&&(desktop&&m[2].endsWith(desktop)||target==='codex'&&codexDesktop.test(m[2])||program.test(m[2])||target==='claude'&&/\/claude\/versions\/\d+\.\d+\.\d+(?:[-.+][\w.-]+)?$/.test(m[2]))?[Number(m[1])]:[];});
    if(target!=='deepseek'&&target!=='pi'&&target!=='claude')return found;
    const nodes=stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(.+)$/);return m&&(/(?:^|\/)node$/.test(m[2])||m[2]===process.execPath)&&Number(m[1])!==process.pid?[m[1]]:[];});
    if(!nodes.length)return found;
    // CLI launchers may keep the process name "node". Inspect only the launcher token;
    // full arguments stay local to this call and are discarded without logging.
    const commands=await exec('ps',['-p',nodes.join(','),'-o','pid=,args='],{timeout:5000,maxBuffer:2*1024*1024});
    const launcher=target==='claude'?/(?:\/claude|\/@anthropic-ai\/claude-code\/cli\.js)$/:target==='deepseek'?/(?:\/dsh|\/@deepseek-ai\/dsh\/lib\/bin\.js)$/:/(?:\/pi|\/(?:@earendil-works|@mariozechner)\/pi-coding-agent\/dist\/(?:bundle\/)?cli\.js)$/;
    const scripts=commands.stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(?:"[^"]*"|'[^']*'|\S+)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);return m&&launcher.test(m[2]??m[3]??m[4])?[Number(m[1])]:[];});
    return [...new Set([...found,...scripts])];
  }catch(error){if((error as {statusCode?:number})?.statusCode===409)throw error;throw conflict('无法检查 Agent 进程，未修改配置。请确认系统进程查询可用。');}
}
export async function safePath(path:string) {
  let current=resolve(path);const root=parsePath(current).root;
  while(current!==root){try{const stat=await lstat(current);if(stat.isSymbolicLink())throw conflict('配置路径含符号链接，请手动处理以避免修改其他文件。');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}current=dirname(current);}
}
export async function readConfig(path:string):Promise<string|null> {
  await safePath(path);
  try{const stat=await lstat(path);if(!stat.isFile()||stat.size>2*1024*1024)throw conflict('配置不是普通文件或超过 2 MB，未修改。');return await readFile(path,'utf8');}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
function equivalentConfig(target:Target,a:string|null,b:string|null):boolean {
  if(a===b)return true;if(a===null||b===null)return false;
  const equal=(x:unknown,y:unknown):boolean=>{
    if(x===y)return true;
    if(!x||!y||typeof x!=='object'||typeof y!=='object'||Array.isArray(x)!==Array.isArray(y))return false;
    const left=x as {[key:string]:unknown},right=y as {[key:string]:unknown};
    return Object.keys(left).length===Object.keys(right).length&&Object.keys(left).every(k=>Object.hasOwn(right,k)&&equal(left[k],right[k]));
  };
  try{return equal(decodeConfig(target,a),decodeConfig(target,b));}catch{return false;}
}
const isObject=(value:unknown):value is {[key:string]:unknown}=>!!value&&typeof value==='object'&&!Array.isArray(value);
const decodeConfig=(target:Target,text:string):unknown=>{
  if(target==='codex')return parse(text);
  if(target!=='deepseek')return JSON.parse(text);
  const document=parseYAMLDocument(text);
  if(document.errors.length||document.warnings.length)throw conflict('DeepSeek 配置包含不支持的 YAML 格式，未修改。');
  const entries=z.array(z.object({id:z.string().min(1)}).passthrough()).parse(document.toJSON()??[]);
  if(new Set(entries.map(entry=>entry.id)).size!==entries.length)throw conflict('DeepSeek 配置存在重复插件，未修改。');
  return Object.fromEntries(entries.map(entry=>[entry.id,entry]));
};
const encodeConfig=(target:Target,value:unknown)=>target==='codex'?stringify(object(value)):target==='deepseek'?stringifyYAML(Object.entries(object(value)).map(([id,entry])=>({...object(entry),id}))):JSON.stringify(value,null,2)+'\n';
// Claude's /model picker can save an alias while its pinned model stays unchanged.
function claudeModelMatches(doc:{[key:string]:unknown},model:string):boolean {
  if(doc.model===model)return true;
  if(!isObject(doc.env))return false;
  switch(doc.model){
    case 'opus':return doc.env.ANTHROPIC_DEFAULT_OPUS_MODEL===model;
    case 'sonnet':return doc.env.ANTHROPIC_DEFAULT_SONNET_MODEL===model;
    case 'haiku':return doc.env.ANTHROPIC_DEFAULT_HAIKU_MODEL===model;
    case 'opusplan':return doc.env.ANTHROPIC_DEFAULT_OPUS_MODEL===model&&doc.env.ANTHROPIC_DEFAULT_SONNET_MODEL===model;
    default:return false;
  }
}
function normalizeOwnedModelDrift(record:Record,after:unknown,actual:unknown):unknown {
  if(record.target==='deepseek'&&record.selections&&isObject(after)&&isObject(actual)){
    const expected=after['agent-default-model'],entry=actual['agent-default-model'];
    if(isObject(expected)&&isObject(expected.config)&&isObject(entry)&&isObject(entry.config)){
      const config=entry.config;
      if(config.provider==='token-flow'&&record.selections.some(item=>item.model===config.model))return {...actual,'agent-default-model':{...entry,config:{...config,model:expected.config.model}}};
    }
  }
  if(record.target==='qoder'&&record.selections&&isObject(after)&&isObject(actual)&&isObject(after.providers)&&isObject(actual.providers)){
    const expected=after.providers['token-flow'],provider=actual.providers['token-flow'];
    if(isObject(expected)&&isObject(provider)&&record.selections.some(item=>item.model===provider.model))return {...actual,providers:{...actual.providers,'token-flow':{...provider,model:expected.model}}};
  }
  if(record.target!=='codex'||!isObject(after)||!isObject(actual))return actual;
  const expectedProviders=after.model_providers,actualProviders=actual.model_providers;
  if(!isObject(expectedProviders)||!isObject(actualProviders)||!isDeepStrictEqual(actualProviders.token_flow,expectedProviders.token_flow)||actual.model_provider!==(record.codexDirectHybrid?'openai':'token_flow'))return actual;
  const normalized:{[key:string]:unknown}={...actual,model:after.model};
  if(typeof after.profile==='string'&&actual.profile===after.profile&&isObject(after.profiles)&&isObject(actual.profiles)){
    const expectedProfile=after.profiles[after.profile],actualProfile=actual.profiles[after.profile];
    if(isObject(expectedProfile)&&isObject(actualProfile)&&actualProfile.model_provider===(record.codexDirectHybrid?'openai':'token_flow'))normalized.profiles={...actual.profiles,[after.profile]:{...actualProfile,model:expectedProfile.model}};
  }
  return normalized;
}
// Clients write their own settings after we connect (Codex trusts projects, for example); the connection holds while every field it changed is intact.
function appliedConfig(record:Record,current:string|null):boolean {
  if(equivalentConfig(record.target,current,record.after))return true;
  if(current===null)return false;
  const kept=(before:unknown,after:unknown,actual:unknown):boolean=>{
    if(isDeepStrictEqual(before,after))return true;
    if(isObject(after)&&isObject(actual)){
      const original=isObject(before)?before:{};
      return [...new Set([...Object.keys(original),...Object.keys(after)])].every(key=>kept(original[key],after[key],actual[key]));
    }
    if(Array.isArray(after)&&Array.isArray(actual)){
      const original=Array.isArray(before)?before:[];
      return after.every(item=>original.some(value=>isDeepStrictEqual(value,item))||actual.some(value=>isDeepStrictEqual(value,item)));
    }
    return isDeepStrictEqual(after,actual);
  };
  try{
    let actual=decodeConfig(record.target,current);
    if(record.target==='claude'&&isObject(actual)&&(record.selections??[record]).some(item=>claudeModelMatches(actual as {[key:string]:unknown},item.model)))actual={...actual,model:record.model};
    if(record.selections&&(record.target==='qoder'||record.target==='deepseek'))actual=normalizeOwnedModelDrift(record,decodeConfig(record.target,record.after),actual);
    if((record.selections||record.codexCoexist||record.codexDirectHybrid)&&record.target==='codex'&&isObject(actual)){
      const effective={...actual,...codexProfile(actual)};
      if(codexModelAllowed(record,effective.model))actual=normalizeOwnedModelDrift(record,decodeConfig(record.target,record.after),actual);
    }
    return kept(record.before===null?undefined:decodeConfig(record.target,record.before),decodeConfig(record.target,record.after),actual);
  }catch{return false;}
}
// Codex may rewrite a gateway field in place. Leaving that gateway is still safe when its route remains.
function codexGatewayStillPresent(current:string|null):boolean {
  if(current===null)return false;
  try{
    const doc=decodeConfig('codex',current) as {[key:string]:any};
    const profile=typeof doc.profile==='string'&&isObject(doc.profiles)?doc.profiles[doc.profile]:undefined;
    const provider=isObject(profile)&&typeof profile.model_provider==='string'?profile.model_provider:doc.model_provider;
    return provider==='token_flow';
  }catch{return false;}
}
// Reverse only the fields this connection changed. Client settings added later survive.
function restoredConfig(record:Record,current:string|null):string|null {
  if(equivalentConfig(record.target,current,record.before))return current;
  if(equivalentConfig(record.target,current,record.after))return record.before;
  const fail=()=>{throw conflict('接入字段存在外部修改，无法安全还原。请检查配置，或删除失效记录后重新接入。备份仍保留。');};
  if(current===null)return fail();
  const decode=(text:string)=>decodeConfig(record.target,text);
  const reverse=(before:unknown,after:unknown,actual:unknown):unknown=>{
    if(isDeepStrictEqual(before,after)||isDeepStrictEqual(actual,before))return actual;
    if(isDeepStrictEqual(actual,after))return before;
    if(isObject(after)&&isObject(actual)&&(before===undefined||isObject(before))){
      const result={...actual};const original=isObject(before)?before:{};
      for(const key of new Set([...Object.keys(original),...Object.keys(after)])){
        const value=reverse(original[key],after[key],actual[key]);
        if(value===undefined)delete result[key];else Object.defineProperty(result,key,{value,writable:true,enumerable:true,configurable:true});
      }
      return Object.keys(result).length||before!==undefined?result:undefined;
    }
    return fail();
  };
  try{
    const before=record.before===null?undefined:decode(record.before),after=decode(record.after);
    let actual=decode(current);
    // An equivalent alias is safe to reverse only when this connection owned the model field.
    if(record.target==='claude'&&isObject(after)&&(!isObject(before)||before.model!==after.model)&&isObject(actual)&&(record.selections??[record]).some(item=>claudeModelMatches(actual as {[key:string]:unknown},item.model)))actual={...actual,model:record.model};
    actual=normalizeOwnedModelDrift(record,after,actual);
    const result=reverse(before,after,actual);
    if(isDeepStrictEqual(result,before))return record.before;
    return result===undefined?null:encodeConfig(record.target,result);
  }catch{return fail();}
}
function object(value:unknown):{[key:string]:any} {
  if(!value||typeof value!=='object'||Array.isArray(value))throw conflict('配置格式无效，未覆盖原文件。');return value;
}
// Applying a selected model replaces drifted routing fields.
// The exact current bytes are still journaled and checked again before writing.
function repairConfigBase(record:Record,current:string|null):string|null {
  try{return restoredConfig(record,current);}catch{/* The selected model replaces drifted routing fields below. */}
  if(current===null)return record.before;
  const actual=decodeConfig(record.target,current),before=record.before===null?undefined:decodeConfig(record.target,record.before),after=decodeConfig(record.target,record.after);
  if(workbuddyModels(record.target)){
    const models=Array.isArray(actual)?actual:object(actual).models;
    if(!Array.isArray(models))throw conflict('WorkBuddy 模型配置格式无效，未覆盖。');
    const owned=new Set([...(record.selections??[record]).map(m=>m.model),...Object.keys(record.modelAliases??{})]);
    const kept=models.filter(item=>!owned.has(String(item.id).replace(/^custom-local:/,'')));
    return JSON.stringify(Array.isArray(actual)?kept:{...object(actual),models:kept},null,2)+'\n';
  }
  if(record.target==='qoder'){
    const doc=object(actual),providers={...object(doc.providers??{})};const originalProviders=object(object(before??{}).providers??{});
    if(Object.hasOwn(originalProviders,'token-flow'))providers['token-flow']=originalProviders['token-flow'];else delete providers['token-flow'];
    return JSON.stringify({...doc,providers},null,2)+'\n';
  }
  const reverseOwned=(original:unknown,written:unknown,value:unknown):unknown=>{
    if(isDeepStrictEqual(original,written))return value;
    if(isObject(written)&&isObject(value)){
      const result={...value},base=isObject(original)?original:{};
      for(const key of new Set([...Object.keys(base),...Object.keys(written)])){
        const next=reverseOwned(base[key],written[key],value[key]);
        if(next===undefined)delete result[key];else Object.defineProperty(result,key,{value:next,writable:true,enumerable:true,configurable:true});
      }
      return Object.keys(result).length||original!==undefined?result:undefined;
    }
    return original;
  };
  const result=reverseOwned(before,after,actual);
  return result===undefined?null:encodeConfig(record.target,result);
}
function codexProfile(doc:{[key:string]:any}):{[key:string]:any}|undefined {
  if(doc.profile===undefined)return;
  if(typeof doc.profile!=='string'||!Object.hasOwn(object(doc.profiles),doc.profile))throw conflict('Codex 当前配置档案无效，未修改原设置。');
  return object(doc.profiles[doc.profile]);
}
/** Exit gateway routing from the current document, never replay a previous provider. */
function nativeCodexConfig(current:string|null):string {
 const doc=current===null?{}:object(parse(current));
  const clean=(config:{[key:string]:any})=>{
   for(const key of ['model','review_model','openai_base_url','model_catalog_json','model_context_window','model_auto_compact_token_limit','model_auto_compact_token_limit_scope','forced_login_method','forced_chatgpt_workspace_id'])delete config[key];
   config.model_provider='openai';
   if(config.agents){const agents={...object(config.agents)};delete agents.default_subagent_model;delete agents.default_subagent_reasoning_effort;if(Object.keys(agents).length)config.agents=agents;else delete config.agents;}
   if(config.model_providers){const providers={...object(config.model_providers)};delete providers.token_flow;delete providers.openai;if(Object.keys(providers).length)config.model_providers=providers;else delete config.model_providers;}
  };
  const profile=codexProfile(doc);
  // A user can change profiles while connected. Earlier gateway profiles must
  // also stop selecting TokenFlow after its provider and client key are removed.
  clean(doc);
  if(profile)clean(profile);
  if(isObject(doc.profiles))for(const candidate of Object.values(doc.profiles)){
   if(isObject(candidate)&&candidate.model_provider==='token_flow')clean(candidate);
  }

 return encodeConfig('codex',doc);
}
function nativeConfig(target:Target,current:string|null,record:Record):string|null {
 if(target==='codex')return nativeCodexConfig(current);
 if(current===null)return null;
 const value=decodeConfig(target,current);
 if(workbuddyModels(target)){
  const doc=Array.isArray(value)?{models:value}:object(value);
  const models=z.array(z.object({id:z.string()}).passthrough()).parse(doc.models??[]);
  const owned=new Set([...(record.selections??[record]).map(item=>item.model),...Object.keys(record.modelAliases??{})]);
  const kept=models.filter(item=>!owned.has(item.id.replace(/^custom-local:/,'')));
  return encodeConfig(target,Array.isArray(value)?kept:{...doc,models:kept});
 }
 const doc=object(value);
 if(target==='claude'){
  for(const key of ['model','availableModels','modelPicker','apiKeyHelper','forceLoginMethod','forceLoginOrgUUID','forceLoginGatewayUrl'])delete doc[key];
  if(doc.env){const env={...object(doc.env)};
   for(const key of ['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_PROFILE','ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_FABLE_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_SMALL_FAST_MODEL','CLAUDE_CODE_BG_CLASSIFIER_MODEL','CLAUDE_CODE_AUTO_MODE_MODEL','CLAUDE_CODE_SUBAGENT_MODEL','CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'])delete env[key];
   doc.env=env;
  }
 }else if(target==='pi'||target==='qoder'){
  if(doc.providers){const providers={...object(doc.providers)};delete providers['token-flow'];doc.providers=providers;}
 }else if(target==='deepseek'){
  const entry=doc['llm-pi-ai'];if(entry?.config?.providers){const providers={...object(entry.config.providers)};delete providers['token-flow'];entry.config.providers=providers;}
  const defaults=doc['agent-default-model'];if(defaults?.config?.provider==='token-flow'){delete defaults.config.provider;delete defaults.config.model;}
 }
 return encodeConfig(target,doc);
}

// Invalid TOML cannot be edited field by field. Recover only from a fully parsed
// journal image; remove its routing before using it as a new configuration base.
export function recoverCodexConfig(current:string|null,candidates:(string|null|undefined)[]=[]){
 try{if(current!==null)parse(current);return {original:current,recovery:undefined};}catch{/* Preserve the damaged preimage before any eventual write. */}
 for(const candidate of candidates){
  if(candidate===undefined||candidate===null)continue;
  try{
   parse(candidate);
   const original=nativeCodexConfig(candidate);
   return {original,recovery:{strategy:'backup' as const,message:'原 Codex 配置无法解析；使用最近合法备份保留非路由设置，完整坏文件另存备份。'}};
  }catch{/* A damaged or semantically invalid image is never replayed. */}
 }
 return {original:'',recovery:{strategy:'minimal' as const,message:'原 Codex 配置无法解析；重建最小配置，无法解析的非路由设置仅保留在完整坏文件备份中。'}};
}

export async function backupCodexConfig(configPath:string,root:string,current:string|null){
 if(current===null)return;
 await safePath(configPath);const bytes=await readFile(configPath);
 if(hash(bytes.toString('utf8'))!==hash(current))throw conflict('配置已被其他应用修改，请重新检查后再操作。');
 const directory=join(root,'agent-backups');await mkdir(directory,{recursive:true,mode:0o700});
 const path=join(directory,`codex-repair-${randomUUID()}.json`);
 await writeFile(path,JSON.stringify({target:'codex',before:current,bytes:bytes.toString('base64'),revision:hash(current),createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
}

const codexRecovery=(current:string|null,records:Record[])=>recoverCodexConfig(current,records.filter(record=>record.target==='codex').flatMap(record=>[record.before,record.previousConfig,record.after]));

export function connectedConfig(target:Target,original:string|null,origin:string,model:string,key:string,catalogPath?:string,selectedModels?:string[],modelLabels:{[id:string]:string}={},fastModel?:string,codexCoexist=false) {
  const chosen=selectedModels??[model];
  const label=(id:string)=>apiModelDisplayName(modelLabels[id]?.trim()||id);
  const url=new URL(origin);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('接入地址必须是本机网关');
  if(target==='pi'||target==='deepseek'){
    const doc=original===null?{}:object(decodeConfig(target,original));
    const modelList=chosen.map(id=>({id,name:label(id),input:['text'],reasoning:false,contextWindow:131072,maxTokens:16384}));
    if(target==='pi'){
      const providers=object(doc.providers??{});
      return encodeConfig(target,{...doc,providers:{...providers,'token-flow':{baseUrl:`${url.origin}/v1`,api:'openai-completions',apiKey:key,models:modelList}}});
    }
    const entry=object(doc['llm-pi-ai']??{id:'llm-pi-ai'}),config=object(entry.config??{}),providers=object(config.providers??{});
    return encodeConfig(target,{...doc,'agent-default-model':{...object(doc['agent-default-model']??{id:'agent-default-model'}),config:{...object(doc['agent-default-model']?.config??{}),provider:'token-flow',model}},'llm-pi-ai':{...entry,config:{...config,providers:{...providers,'token-flow':{baseURL:`${url.origin}/v1`,api:'openai-completions',headers:{Authorization:`Bearer ${key}`},models:chosen.map(id=>({id,name:label(id),input:['text'],contextWindow:131072,maxTokens:16384}))}}}}});
  }
  if(target==='qoder'){
    const doc=original===null?{}:object(JSON.parse(original));
    const providers=doc.providers===undefined?{}:object(doc.providers);
    // Connecting explicitly replaces this managed provider, including native UI edits
    // and orphaned entries copied from another installation. The journal keeps the preimage.
    return JSON.stringify({...doc,providers:{...providers,'token-flow':{type:'openai-compatible',protocol:'openai-responses',authType:'bearer',baseUrl:`${url.origin}/v1`,apiKey:key,displayName:'token-flow',model,models:chosen.map(model=>({model,displayName:label(model)}))}}},null,2)+'\n';
  }
  if(workbuddyModels(target)){
    const value=original===null?[]:JSON.parse(original);
    const doc=Array.isArray(value)?{models:value}:object(value);
    if(Object.keys(doc).some(k=>k!=='models'))throw conflict('WorkBuddy models.json 包含额外设置，自动转换为原生数组会丢失字段，已保留原文件；请先整理这些设置再接入。');
    const models=(doc.models===undefined?[]:z.array(z.object({id:z.string()}).passthrough()).parse(doc.models)).filter(m=>!chosen.some(model=>m.id===model||m.id===`custom-local:${model}`));
    // WorkBuddy renders custom models as name:ID when those two fields differ.
    // Give it a readable ID; the connection journal maps it back to the authorized route.
    const used=new Set(models.map(m=>m.id.replace(/^custom-local:/,'')));
    const imported=chosen.map(model=>{
      const base=label(model).replace(/[\r\n\t]/g,' ').slice(0,260);let id=base,n=2;
      while(used.has(id)||chosen.some(other=>other!==model&&other===id))id=`${base} (${n++})`;
      used.add(id);return {id,name:id,url:`${url.origin}/v1/chat/completions`,apiKey:key,supportsToolCall:true};
    });
    const next:{[key:string]:any}={...doc,models:[...models,...imported]};
    return JSON.stringify(next.models,null,2)+'\n';
  }
  if(target==='claude'){
    const doc=original===null?{}:object(JSON.parse(original));
    const env=doc.env===undefined?{}:object(doc.env);
    // Clear conflicting routes, but journal them so restoring recovers the exact prior setup.
    delete doc.apiKeyHelper;delete doc.forceLoginMethod;delete doc.forceLoginOrgUUID;delete doc.forceLoginGatewayUrl;
    const fast=fastModel&&chosen.includes(fastModel)?fastModel:model;
    return JSON.stringify({...doc,model,...(selectedModels?{availableModels:chosen,modelPicker:{replaceBuiltInOptions:true,options:chosen.map(model=>({model,label:label(model)}))}}:{}),env:{...env,...(selectedModels?{CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY:'1'}:{}),ANTHROPIC_BASE_URL:url.origin,ANTHROPIC_AUTH_TOKEN:key,ANTHROPIC_API_KEY:'',CLAUDE_CODE_USE_BEDROCK:'0',CLAUDE_CODE_USE_VERTEX:'0',CLAUDE_CODE_USE_FOUNDRY:'0',CLAUDE_CODE_OAUTH_TOKEN:'',ANTHROPIC_PROFILE:'',ANTHROPIC_MODEL:'',ANTHROPIC_DEFAULT_OPUS_MODEL:model,ANTHROPIC_DEFAULT_SONNET_MODEL:model,ANTHROPIC_DEFAULT_FABLE_MODEL:model,ANTHROPIC_DEFAULT_HAIKU_MODEL:fast,ANTHROPIC_SMALL_FAST_MODEL:fast,CLAUDE_CODE_BG_CLASSIFIER_MODEL:fast,CLAUDE_CODE_AUTO_MODE_MODEL:fast,CLAUDE_CODE_SUBAGENT_MODEL:''}},null,2)+'\n';
  }
  const doc=original===null?{}:parse(original);
  // Full original bytes remain in the backup; TOML serialization preserves semantic settings.
  const providers=doc.model_providers===undefined?{}:object(doc.model_providers);
  // Coexistence exposes one provider: Codex triggers remote compaction, official
  // models retain native checkpoints, and gateway models use our summary bridge.
  // Standalone gateway mode keeps Codex's client-owned summary behavior.
  const routing={model,model_provider:'token_flow',model_auto_compact_token_limit_scope:'total',...(catalogPath?{model_catalog_json:catalogPath}:{})};
  delete doc.openai_base_url;delete doc.review_model;delete doc.model_auto_compact_token_limit;delete doc.model_context_window;
  const next:{[key:string]:any}={...doc,...routing,model_providers:{...providers,token_flow:{name:'TokenFlow',base_url:`${url.origin}${codexCoexist?'/codex':''}/v1`,wire_api:'responses',...(codexCoexist?{http_headers:{'x-tokenflow-client-key':key},capabilities:{remote_compaction:'v2'}}:{experimental_bearer_token:key}),requires_openai_auth:codexCoexist,supports_websockets:false}}};
  // Legacy clients overlay the selected profile. Keep its policy and selection;
  // update only model routing. Newer CLI-selected profile files stay user-owned.
  const profile=codexProfile(doc);
  if(profile){const selected:{[key:string]:any}={...profile,...routing};delete selected.openai_base_url;delete selected.review_model;delete selected.model_auto_compact_token_limit;delete selected.model_context_window;next.profiles={...object(doc.profiles),[doc.profile as string]:selected};}
  // Remove only explicit subagent model defaults while connected. Codex then
  // inherits the current parent's model/effort, including in-app model changes.
  // The connection journal restores these defaults with the official config.
  const inheritParent=(config:{[key:string]:any})=>{
    if(config.agents===undefined)return;
    const agents={...object(config.agents)};
    delete agents.default_subagent_model;
    delete agents.default_subagent_reasoning_effort;
    config.agents=agents;
  };
  inheritParent(next);
  if(profile)inheritParent(next.profiles[doc.profile as string]);
  return stringify(next);
}

/** Backups are journaled before a single atomic configuration replacement. Never expose their contents. */
export class AgentConnections {
  private tail:Promise<unknown>=Promise.resolve();
  private readonly deepseekProfilePath:string|undefined;
  readonly paths:AgentPaths;
  constructor(private root:string,paths:Partial<AgentPaths>=agentPaths(),private processes:(target:Target)=>Promise<number[]>=agentProcesses) {
    this.paths={...agentPaths(root),...paths};
    this.deepseekProfilePath=deepseekHome(this.paths.deepseek)!==dirname(this.paths.deepseek)?this.paths.deepseek:undefined;
  }
  private dir(){return join(this.root,'agent-backups');}
  private catalogPath(model:string){return join(this.dir(),`codex-models-${hash(model)}.json`);}
  /** Update only app-generated model metadata. Routing, credentials, history and
   * the user's config bytes stay intact; Codex reads the catalog on startup. */
  async refreshCodexCompactionLimits(window:(model:string)=>Promise<number|undefined>){
    const {readdir}=await import('node:fs/promises');
    const files=await readdir(this.dir()).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    const capacities=new Map<string,number|undefined>();let updated=0,failed=0;
    const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
    for(const name of files.filter(name=>/^codex-models-[a-f0-9]+\.json$/.test(name))){
      const path=join(this.dir(),name),temp=`${path}.${randomUUID()}.tmp`;
      try{
        await safePath(path);const catalog=JSON.parse(await readFile(path,'utf8'));
        if(!Array.isArray(catalog.models)||!catalog.models.every((model:any)=>model&&typeof model.slug==='string')){failed++;continue;}
        const gatewayModels=catalog.tokenflow_gateway_models===undefined?undefined:z.array(z.string()).parse(catalog.tokenflow_gateway_models);
        if(gatewayModels&&(!gatewayModels.every((slug:string)=>catalog.models.some((model:any)=>model.slug===slug))||new Set(gatewayModels).size!==gatewayModels.length)){failed++;continue;}
        const legacy=catalog.tokenflow_context_windows===undefined;
        const windows={...object(catalog.tokenflow_context_windows??{})};let changed=legacy;
        for(const model of catalog.models){
          if(gatewayModels&&!gatewayModels.includes(model.slug))continue;
          // Migrate only our former unlimited sentinel; preserve user/source budgets.
          if(model.truncation_policy?.mode==='bytes'&&model.truncation_policy.limit===Number.MAX_SAFE_INTEGER){model.truncation_policy={mode:'bytes',limit:CODEX_TOOL_OUTPUT_LIMIT};changed=true;}
          if(!capacities.has(model.slug))capacities.set(model.slug,await window(model.slug));
          const discovered=capacities.get(model.slug);
          if(positive(discovered)&&windows[model.slug]!==discovered){windows[model.slug]=discovered;changed=true;}
          const known=windows[model.slug];
          // Preserve existing metadata when discovery is unavailable. Older
          // catalogs did not store provenance; migrate their known hardcoded
          // defaults, while retaining other declared windows or trigger values.
          const oldDefault=legacy&&model.context_window===131072&&model.auto_compact_token_limit===65536;
          const declared=!oldDefault&&positive(model.context_window)?model.context_window:undefined;
          const limit=positive(model.auto_compact_token_limit)?model.auto_compact_token_limit:undefined;
          const capacity=positive(known)?known:declared;
          const next:ReturnType<typeof codexContextMetadata>=capacity!==undefined?codexContextMetadata(capacity):limit!==undefined&&!(legacy&&[65536,128000,217600].includes(limit))?{auto_compact_token_limit:limit}:codexContextMetadata();
          for(const field of ['context_window','max_context_window','auto_compact_token_limit'] as const){
            const value=field==='max_context_window'?undefined:next[field];
            if(value===undefined){if(field in model){delete model[field];changed=true;}}
            else if(model[field]!==value){model[field]=value;changed=true;}
          }
        }
        if(changed){catalog.tokenflow_context_windows=windows;await writeFile(temp,JSON.stringify(catalog),{mode:0o600,flag:'wx'});await rename(temp,path);updated++;}
      }catch{failed++;}finally{await rm(temp,{force:true}).catch(()=>{});}
    }
    return {updated,failed};
  }
  private async records():Promise<Record[]> {
    const {readdir}=await import('node:fs/promises');await mkdir(this.dir(),{recursive:true,mode:0o700});
    const files=await readdir(this.dir());const records:Record[]=[];
    for(const file of files.filter(f=>/^[a-f0-9-]{36}\.json$/.test(f))){try{const record=recordSchema.parse(JSON.parse(await readFile(join(this.dir(),file),'utf8')));if(hash(record.before)!==record.beforeHash||hash(record.after)!==record.afterHash||(record.previousConfig!==undefined&&hash(record.previousConfig)!==record.previousHash))throw new Error('Backup checksum mismatch');records.push(record);}catch{throw conflict('接入备份记录损坏，请保留文件并人工检查。');}}
    records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    // Older journals wrote the global home patch. Keep restoration pointed at that file.
    if(this.deepseekProfilePath){
      const active=records.find(r=>r.target==='deepseek'&&r.state!=='restored');
      this.paths.deepseek=active&&active.deepseekScope!=='profile'?join(deepseekHome(this.deepseekProfilePath),'cordis.patch.yml'):this.deepseekProfilePath;
    }
    return records;
  }
  private async save(record:Record,expected?:string|null){
    const path=join(this.dir(),`${record.id}.json`),temp=`${path}.${randomUUID()}.tmp`;
    try{await writeFile(temp,JSON.stringify(record),{mode:0o600,flag:'wx'});if(expected!==undefined&&await readConfig(path)!==expected)throw conflict('接入备份已被其他操作修改，已保留。');await rename(temp,path);}finally{await rm(temp,{force:true});}
  }
  private run<T>(target:Target,operation:()=>Promise<T>):Promise<T>{
    const task=this.tail.then(async()=>{
      if(target==='deepseek')await this.records();
      const lock=`${this.paths[target]}.token-flow.lock`;
      await safePath(this.paths[target]);await mkdir(dirname(lock),{recursive:true,mode:0o700});
      let file;try{file=await open(lock,'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw conflict('另一个接入操作持有配置锁；如应用曾异常退出，请先检查锁文件，未强行覆盖。');throw e;}
      try{await file.writeFile(String(process.pid));return await operation();}finally{await file.close();await unlink(lock);}
    });this.tail=task.catch(()=>{});return task;
  }
  private async requireEditableProfile(target:Target){
    if(target!=='deepseek'||!this.deepseekProfilePath)return;
    if(this.paths.deepseek!==this.deepseekProfilePath)throw conflict('旧版 DeepSeek 接入使用全局补丁，会阻止 Harness 保存 API Key。请先点击“恢复原配置”，再重新接入桌面版配置。');
    const global=await readConfig(join(deepseekHome(this.deepseekProfilePath),'cordis.patch.yml'));
    if(global===null)return;
    const document=parseYAMLDocument(global);
    if(document.errors.length||document.warnings.length)throw conflict('DeepSeek 全局补丁无法安全解析，未修改配置。');
    const entries=document.toJSON()??[];
    if(!Array.isArray(entries))throw conflict('DeepSeek 全局补丁格式无效，未修改配置。');
    if(entries.some(entry=>isObject(entry)&&['llm-pi-ai','agent-default-model'].includes(String(entry.id))&&entry.insert===undefined&&Object.hasOwn(entry,'config')))throw conflict('DeepSeek 全局补丁仍覆盖模型配置，Harness 无法保存 API Key。请先检查全局 cordis.patch.yml 中的模型覆盖；未修改原文件。');
  }
  private async idle(target:Target){const pids=await this.processes(target);if(pids.length)throw conflict(`请先退出 ${targetNames[target]} 再重试；检测到进程 ${pids.join(', ')}。不会强制终止运行中的任务。`);}
  /**
   * Harness resolves credential references from the inherited environment over the
   * managed `$DSH_HOME/.credentials.yaml`, with the home `.env` as a documented
   * fallback source. Keeping `DEEPSEEK_API_KEY` current there makes the desktop
   * welcome (`needsWelcome = !loggedIn && !hasApiKey`) resolve hasApiKey on every
   * launch, including ones the user starts by hand.
   */
  private async updateDeepseekEnv(key:string|null){
    const home=deepseekHome(this.paths.deepseek),path=join(home,'.env');
    let lines:string[]=[];
    try{lines=(await readFile(path,'utf8')).split(/\r?\n/);}catch{}
    const kept=lines.filter(line=>!/^\s*DEEPSEEK_API_KEY\s*=/.test(line));
    if(key!==null)kept.push(`DEEPSEEK_API_KEY=${key}`);
    const content=kept.join('\n').replace(/^\n+/,'').trimEnd();
    try{
      if(!content){await rm(path,{force:true});return;}
      const temp=`${path}.token-flow-${randomUUID()}.tmp`;
      try{await writeFile(temp,content+'\n',{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await rm(temp,{force:true});}
    }catch{}
  }
  private backupDamagedCodex(current:string|null){return backupCodexConfig(this.paths.codex,this.root,current);}
  private async replace(target:Target,expected:string,next:string|null,allowRunning=false){
    if(!allowRunning)await this.idle(target);const path=this.paths[target];if(hash(await readConfig(path))!==expected)throw conflict('配置已被其他应用修改，请重新检查后再操作。');
    if(target==='codex'&&next!==null)codexProfile(parse(next));
    if(next===null){await unlink(path);return;}
    const temp=`${path}.token-flow-${randomUUID()}.tmp`;
    try{await writeFile(temp,next,{mode:0o600,flag:'wx'});if(hash(await readConfig(path))!==expected)throw conflict('配置发生并发修改，已停止写入。');await rename(temp,path);}finally{await rm(temp,{force:true});}
  }
  async status(){
    const records=await this.records();
    return Promise.all(targetSchema.options.map(async target=>{
      let current:string|null=null,error='';try{current=await readConfig(this.paths[target]);}catch(e){error=e instanceof Error?e.message:'读取失败';}
      let pids:number[]=[];try{pids=await this.processes(target);}catch(e){error=e instanceof Error?e.message:'进程检查失败';}
      const latest=records.find(r=>r.target===target&&r.state!=='restored');const applied=!!latest&&appliedConfig(latest,current);
      return {id:target,name:targetNames[target],...(target==='codex'?{codexRoutingMode:error?'unreadable' as const:codexRoutingMode(current)}:{}),installation:await detectAgent(target),...((process.platform==='darwin'||process.platform==='win32'&&['pi','codex','qoder','workbuddy','workbuddy-ai','deepseek'].includes(target))?{restartSupported:true}:{}),path:this.paths[target],exists:current!==null,revision:hash(current),pids,error,connection:latest?publicRecord(latest):null,drift:!!latest&&!applied,configurationState:error?'unreadable':!latest?'unmanaged':applied?'configured':equivalentConfig(target,current,latest.before)?'missing':'changed',backups:records.filter(r=>r.target===target).map(publicRecord)};
    }));
  }
  async review(id:string){
    const record=(await this.records()).find(r=>r.id===id&&r.state!=='restored');if(!record)throw conflict('接入记录不存在或已还原');
    const current=await readConfig(this.paths[record.target]);
    const checks:{name:string;ok:boolean}[]=[{name:'配置与接入备份一致',ok:appliedConfig(record,current)},{name:'接入写入已完成',ok:record.state==='applied'}];
    try{
      const parsed=decodeConfig(record.target,current??(record.target==='deepseek'?'[]':record.target==='codex'?'':'{}'));
      const actual=workbuddyModels(record.target)&&Array.isArray(parsed)?{models:parsed}:object(parsed);
      const expectedValue=decodeConfig(record.target,record.after) as {[key:string]:any};
      const expected=workbuddyModels(record.target)&&Array.isArray(expectedValue)?{models:expectedValue}:expectedValue;
      if(record.target==='claude'){
        const fast=record.fastModel??record.model;
        checks.push({name:'主模型可切换，子代理继承会话',ok:(record.selections??[record]).some(item=>claudeModelMatches(actual as {[key:string]:unknown},item.model))&&!actual.env?.ANTHROPIC_MODEL&&!actual.env?.CLAUDE_CODE_SUBAGENT_MODEL&&actual.env?.ANTHROPIC_DEFAULT_OPUS_MODEL===record.model&&actual.env?.ANTHROPIC_DEFAULT_SONNET_MODEL===record.model&&(actual.env?.ANTHROPIC_DEFAULT_FABLE_MODEL===undefined||actual.env.ANTHROPIC_DEFAULT_FABLE_MODEL===record.model)&&actual.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL===fast&&actual.env?.ANTHROPIC_SMALL_FAST_MODEL===fast&&[actual.env?.CLAUDE_CODE_BG_CLASSIFIER_MODEL,actual.env?.CLAUDE_CODE_AUTO_MODE_MODEL].every(value=>value===undefined||value===fast)},
          {name:'接口地址与服务路由正确',ok:actual.env?.ANTHROPIC_BASE_URL===expected.env.ANTHROPIC_BASE_URL&&['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'].every(k=>!actual.env?.[k]||actual.env[k]==='0')&&!actual.apiKeyHelper&&!actual.forceLoginGatewayUrl},
          {name:'客户端 Key 未被覆盖',ok:actual.env?.ANTHROPIC_AUTH_TOKEN===expected.env.ANTHROPIC_AUTH_TOKEN&&actual.env?.ANTHROPIC_API_KEY===''});
      }else if(record.target==='qoder'){
        const provider=actual.providers?.['token-flow'],original=expected.providers['token-flow'];
        checks.push({name:'自定义模型已写入',ok:(record.selections??[record]).some(item=>item.model===provider?.model)&&(record.selections??[record]).every(item=>provider.models?.some((m:{model:string})=>m.model===item.model))},{name:'Responses 接口正确',ok:provider?.baseUrl===original.baseUrl&&provider?.protocol==='openai-responses'},{name:'客户端 Key 未被覆盖',ok:provider?.apiKey===original.apiKey});
      }else if(workbuddyModels(record.target)){
        const id=clientModelID(record,record.model),model=actual.models?.find((m:{id:string})=>m.id===id);const original=expected.models.find((m:{id:string})=>m.id===id);
        checks.push({name:'自定义模型已写入配置',ok:!!model&&(!actual.availableModels?.length||actual.availableModels.includes(id))},{name:'接口地址与工具能力正确',ok:model?.url===original.url&&model?.supportsToolCall===true},{name:'客户端 Key 未被覆盖',ok:model?.apiKey===original.apiKey});
      }else if(record.target==='pi'||record.target==='deepseek'){
        const provider=record.target==='pi'?actual.providers?.['token-flow']:actual['llm-pi-ai']?.config?.providers?.['token-flow'];
        const original=record.target==='pi'?expected.providers['token-flow']:expected['llm-pi-ai'].config.providers['token-flow'];
        if(record.target==='deepseek')checks.push({name:'默认模型已选择',ok:actual['agent-default-model']?.config?.provider==='token-flow'&&(record.selections??[record]).some(item=>item.model===actual['agent-default-model']?.config?.model)});
        checks.push({name:'所选模型配置完整',ok:(record.selections??[record]).every(item=>provider?.models?.some((m:{id:string})=>m.id===item.model))},{name:'接口与协议正确',ok:provider?.api==='openai-completions'&&(provider.baseUrl??provider.baseURL)===(original.baseUrl??original.baseURL)},{name:'客户端 Key 未被覆盖',ok:record.target==='pi'?provider?.apiKey===original.apiKey:provider?.headers?.Authorization===original.headers.Authorization});
      }else{
        const provider=actual.model_providers?.token_flow;const original=expected.model_providers.token_flow;
        const effective={...actual,...codexProfile(actual)};
        checks.push({name:'模型与配置层级正确',ok:codexModelAllowed(record,effective.model)&&effective.model_provider===(record.codexDirectHybrid?'openai':'token_flow')&&actual.profile===expected.profile},{name:'接口与协议正确',ok:provider?.base_url===original.base_url&&provider?.wire_api==='responses'&&provider?.requires_openai_auth===!!record.codexCoexist},{name:'客户端 Key 未被覆盖',ok:record.codexCoexist?provider?.experimental_bearer_token===undefined&&isDeepStrictEqual(provider?.http_headers,original.http_headers):provider?.experimental_bearer_token===original.experimental_bearer_token});
        checks.push({name:'本地配置档案选择保留',ok:actual.profile===parse(record.before??'').profile});
      }
      if(record.selections||record.codexCoexist||record.codexDirectHybrid){
        const ids=(record.selections??[record]).map(item=>item.model);
        if(record.target==='codex'){const catalog=JSON.parse(await readFile(String(actual.model_catalog_json),'utf8'));checks.push({name:'所选模型目录完整',ok:isDeepStrictEqual(catalog.models.map((m:{slug:string})=>m.slug),[...((record.codexCoexist||record.codexDirectHybrid)?record.officialModelSlugs??[]:[]),...ids])});}
        if(record.target==='claude')checks.push({name:'所选模型菜单与授权一致',ok:isDeepStrictEqual(actual.availableModels,ids)&&isDeepStrictEqual(actual.modelPicker,expected.modelPicker)&&actual.env?.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY==='1'});
        if(workbuddyModels(record.target))checks.push({name:'所选模型配置完整',ok:ids.every(route=>{const id=clientModelID(record,route),model=actual.models?.find((m:{id:string})=>m.id===id),original=expected.models.find((m:{id:string})=>m.id===id);return model?.apiKey===original?.apiKey&&model?.url===original?.url&&model?.supportsToolCall===true;})});
      }
    }catch{checks.push({name:'配置格式可解析',ok:false});}
    return {id,target:record.target,model:record.model,checks,liveCallVerified:false,...(record.target==='claude'?{compatibility:{autoMode:'unverified' as const,note:'主模型、辅助模型配置一致不代表 Auto Mode 审批可用。审批分类器与 App 的维修审批模型相互独立；Messages 文本和工具检测也不能验证分类器。'}}:{}),note:record.target==='pi'?'在官方 Pi 的 /model 菜单选择 token-flow 模型。':record.target==='deepseek'?'重新打开 DeepSeek Harness 官方桌面应用，在模型菜单选择 token-flow 模型；已有对话从历史继续。':record.target==='qoder'?`重启 Qoder 独立应用，在模型菜单选择 ${record.model}。原登录与内置模型保留；不适用于 Qoder IDE。`:record.target==='workbuddy'?`在 WorkBuddy 新建任务的输入框下方打开模型菜单，选择 ${record.model}。若没有显示，重启 WorkBuddy 后再查看。配置检查不代表已在客户端选用。`:record.target==='workbuddy-ai'?`在 WorkBuddyAI 新建任务的输入框下方打开模型菜单，选择 ${record.model}。若没有显示，重启 WorkBuddyAI 后再查看。配置检查不代表已在客户端选用。官方登录保持不变。`:'重启 Agent 后加载配置；项目级设置或已有终端环境变量仍可能覆盖用户配置。'};
  }
  async apply(input:{target:Target;revision:string;origin:string;model:string;sourceId:string;keyId:string;key:string;allowRunning?:boolean;replaceId?:string;rewrite?:boolean;selections?:ModelSelection[];fastModel?:string;modelLabels?:{[id:string]:string};modelContextWindows?:{[id:string]:number};officialCatalog?:OfficialCodexCatalog;codexDirectHybrid?:boolean}){
    return this.run(input.target,async()=>{
      await this.requireEditableProfile(input.target);
      if(!input.allowRunning)await this.idle(input.target);
      const before=await readConfig(this.paths[input.target]);if(hash(before)!==input.revision)throw conflict('配置已变更，请刷新接入预览。');
      const records=await this.records();const active=records.find(r=>r.target===input.target&&r.state!=='restored');
      if(active&&active.id!==input.replaceId)throw conflict('此 Agent 已有接入记录，请审批切换方案后再接入。');
      if(input.replaceId&&!active)throw conflict('接入记录已变化，请重新生成维修方案。');
      const recovered=input.target==='codex'?codexRecovery(before,records):{original:before,recovery:undefined};
      const original=recovered.recovery?recovered.original:active?repairConfigBase(active,before):before;
      const selectedModels=input.selections?.map(item=>item.model);
      if(input.selections){modelSelectionsSchema.parse(input.selections);if(!input.selections.some(item=>item.model===input.model&&item.sourceId===input.sourceId))throw conflict('默认模型必须在已选模型中');}
      if(input.fastModel&&!(input.selections??[{model:input.model,sourceId:input.sourceId}]).some(item=>item.model===input.fastModel))throw conflict('快速模型必须在已选模型中');
      // Include display metadata so a renamed menu does not reuse the legacy cached path.
      if(input.officialCatalog&&input.target!=='codex')throw conflict('官方模型共存仅支持 Codex。');
      const gatewayCatalog=input.target==='codex'?codexModelCatalog(selectedModels??input.model,input.modelLabels,input.modelContextWindows):undefined;
      const catalog=gatewayCatalog&&input.officialCatalog?mergeCodexCatalog(gatewayCatalog,input.officialCatalog):gatewayCatalog;
      const catalogPath=catalog?this.catalogPath(JSON.stringify(catalog)):undefined;
      let after:string;try{after=connectedConfig(input.target,original,input.origin,input.model,input.key,catalogPath,selectedModels,input.modelLabels,input.fastModel,!!input.officialCatalog&&!input.codexDirectHybrid);}catch{throw conflict('配置格式无法安全解析，未修改原文件。');}
      if(input.codexDirectHybrid){
        if(!input.officialCatalog?.models.length)throw conflict('官方模型目录缺失，未启用直连混合模式。');
        const doc=parse(after) as any,prior=parse(original??'') as any;
        const official=input.officialCatalog.models.map(m=>m.slug),preferred={...prior,...codexProfile(prior)}.model;
        const nativeModel=official.includes(preferred)?preferred:official[0];
        const configure=(d:any)=>{d.model_provider='openai';d.model=nativeModel;delete d.model_auto_compact_token_limit_scope;delete d.openai_base_url;if(d.model_providers)delete d.model_providers.openai;};
        configure(doc);const profile=codexProfile(doc);if(profile){configure(profile);if(profile.model_providers)delete profile.model_providers.token_flow;}
        doc.model_providers.token_flow.capabilities={remote_compaction:'unsupported'};
        after=stringify(doc);
      }
      if(catalogPath){
        await safePath(catalogPath);const temp=`${catalogPath}.${randomUUID()}.tmp`;
        try{await writeFile(temp,JSON.stringify(catalog),{mode:0o600,flag:'wx'});await rename(temp,catalogPath);}finally{await rm(temp,{force:true});}
      }
      const routes=selectedModels??[input.model];
      const modelAliases=workbuddyModels(input.target)?Object.fromEntries((JSON.parse(after) as {id:string}[]).slice(-routes.length).flatMap((entry,i)=>entry.id!==routes[i]?[[entry.id,routes[i]]]:[])):undefined;
      if(recovered.recovery)await this.backupDamagedCodex(before);
      const record:Record={...(input.officialCatalog?{codexCoexist:!input.codexDirectHybrid,...(input.codexDirectHybrid?{codexDirectHybrid:true}:{}),officialModelSlugs:input.officialCatalog.models.map(model=>model.slug)}:{}),...(recovered.recovery?{recovery:recovered.recovery}:{}),id:randomUUID(),target:input.target,createdAt:new Date().toISOString(),before:original,after,beforeHash:hash(original),afterHash:hash(after),state:'prepared',keyId:input.keyId,sourceId:input.sourceId,model:input.model,...(input.fastModel?{fastModel:input.fastModel}:{}),...(modelAliases&&Object.keys(modelAliases).length?{modelAliases}:{}),...(input.target==='deepseek'?{deepseekScope:this.deepseekProfilePath?'profile' as const:'home' as const}:{}),...(input.selections?{selections:input.selections}:{}),...(active?{supersedes:active.id}:{}),...((active||recovered.recovery)?{previousConfig:before,previousHash:hash(before)}:{})};
      await this.save(record);await this.replace(input.target,input.revision,after,input.allowRunning);
      if(input.target==='deepseek')await this.updateDeepseekEnv(input.key);
      record.state='applied';await this.save(record);await this.retirePrevious(record);return publicRecord(record);
    });
  }
  /** Prepare an identity-only catalog update. The caller holds the shared Codex config lock
   * throughout preparation, auth/config replacement, apply and rollback. No key is replaced. */
  async prepareCodexIdentityCatalog(id:string,current:string|null,official:OfficialCodexCatalog,recovery?:{before:string|null;after:string}){
    const record=(await this.records()).find(r=>r.id===id&&r.target==='codex'&&r.state==='applied'&&(r.codexCoexist||r.codexDirectHybrid));
    const interrupted=record&&recovery&&(current===recovery.before||current===recovery.after)&&(appliedConfig(record,recovery.before)||appliedConfig(record,recovery.after));
    if(!record||!appliedConfig(record,current)&&!interrupted)throw conflict('Codex 共存配置已变化，请刷新或重新应用后再切换账号。');
    const doc=parse(current??''),profile=codexProfile(doc),effective={...doc,...profile};
    const oldCatalogPath=effective.model_catalog_json;
    if(typeof oldCatalogPath!=='string')throw conflict('Codex 共存模型目录缺失，请重新应用后再切换账号。');
    const path=resolve(dirname(this.paths.codex),oldCatalogPath);await safePath(path);
    const cached=JSON.parse(await readFile(path,'utf8'));
    const gatewaySlugs=(record.selections??[record]).map(item=>item.model);
    if(!Array.isArray(cached.models))throw conflict('Codex 共存模型目录无法读取，请重新应用后再切换账号。');
    const gatewayModels=gatewaySlugs.map(slug=>cached.models.find((model:{slug:string})=>model.slug===slug));
    if(gatewayModels.some(model=>!model))throw conflict('Codex 网关模型目录不完整，请重新应用后再切换账号。');
    const catalog=mergeCodexCatalog({...cached,models:gatewayModels},official),catalogPath=this.catalogPath(JSON.stringify(catalog));
    const allowed=new Set([...official.models.map(model=>model.slug),...gatewaySlugs]);
    const update=(config:{[key:string]:any})=>{config.model_catalog_json=catalogPath;if(!allowed.has(config.model))config.model=record.codexDirectHybrid?official.models[0].slug:record.model;};
    update(doc);if(profile)update(profile);
    // Keep the ownership baseline: copying current user settings into `after` would
    // make a later gateway restore mistake those settings for fields we created.
    const expected=parse(record.after),expectedProfile=codexProfile(expected);update(expected);if(expectedProfile)update(expectedProfile);
    const config=stringify(doc),expectedConfig=stringify(expected),next={...record,after:expectedConfig,afterHash:hash(expectedConfig),officialModelSlugs:official.models.map(model=>model.slug)};
    const recordPath=join(this.dir(),`${id}.json`),before=await readConfig(recordPath),after=JSON.stringify(next);
    if(before===null||!isDeepStrictEqual(recordSchema.parse(JSON.parse(before)),record))throw conflict('接入备份已变化，请刷新后再切换账号。');
    const rollback=async()=>{if(await readConfig(recordPath)===after){const temp=`${recordPath}.${randomUUID()}.tmp`;try{await writeFile(temp,before!,{mode:0o600,flag:'wx'});if(await readConfig(recordPath)!==after)throw conflict('接入备份已被其他操作修改，已保留。');await rename(temp,recordPath);}finally{await rm(temp,{force:true});}}};
    // Persist immutable metadata before any config can point to it. A crash may leave an
    // unreferenced catalog, but never a config referring to a missing catalog.
    await safePath(catalogPath);const catalogText=JSON.stringify(catalog),temp=`${catalogPath}.${randomUUID()}.tmp`;
    try{await writeFile(temp,catalogText,{mode:0o600,flag:'wx'});await rename(temp,catalogPath);}finally{await rm(temp,{force:true});}
    return {config,record:publicRecord(next),rollback,apply:async()=>{
      if(await readConfig(this.paths.codex)!==config||await readConfig(recordPath)!==before||await readConfig(catalogPath)!==catalogText)throw conflict('Codex 配置、目录或接入备份已变化，已停止切换账号。');
      try{await this.save(next,before);}catch(error){await rollback();throw error;}
    }};
  }
  private async retirePrevious(record:Record){
    if(!record.supersedes)return;const previous=(await this.records()).find(r=>r.id===record.supersedes);
    if(previous&&previous.state!=='restored'){previous.state='restored';await this.save(previous);}
  }
  async preview(target:Target,origin:string,model:string,rewrite=false,selections?:ModelSelection[],fastModel?:string){
    const records=await this.records();const active=records.find(r=>r.target===target&&r.state!=='restored');
    await this.requireEditableProfile(target);
    const current=await readConfig(this.paths[target]);
    const recovered=target==='codex'?codexRecovery(current,records):{original:current,recovery:undefined};
    const original=recovered.recovery?recovered.original:active?repairConfigBase(active,current):current;
    const after=connectedConfig(target,original,origin,model,'<审批后由网关注入客户端 Key>',target==='codex'?this.catalogPath(selections?JSON.stringify(selections.map(item=>item.model)):model):undefined,selections?.map(item=>item.model),{},fastModel,!!active?.codexCoexist);
    // Only expose gateway-owned routing fields, never the full user configuration.
    const parsed=decodeConfig(target,after) as {[key:string]:any};
    const effective=target==='codex'?{...parsed,...codexProfile(parsed)}:parsed;
    const routing=target==='pi'?parsed.providers['token-flow']:target==='deepseek'?parsed['llm-pi-ai'].config.providers['token-flow']:target==='qoder'?parsed.providers['token-flow']:workbuddyModels(target)?(Array.isArray(parsed)?parsed:parsed.models).find((m:{id:string})=>m.id===model):target==='codex'?{model:effective.model,model_provider:effective.model_provider,model_catalog_json:effective.model_catalog_json,...(parsed.profile!==undefined?{profile:parsed.profile}:{}),...(effective.web_search!==undefined?{web_search:effective.web_search}:{}),token_flow:parsed.model_providers.token_flow}:Object.fromEntries(Object.entries(parsed.env).filter(([k])=>['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_FABLE_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_SMALL_FAST_MODEL','CLAUDE_CODE_BG_CLASSIFIER_MODEL','CLAUDE_CODE_AUTO_MODE_MODEL','CLAUDE_CODE_SUBAGENT_MODEL'].includes(k)));
    return {target,...(recovered.recovery?{recovery:recovered.recovery}:{}),path:this.paths[target],revision:hash(current),replaceId:active?.id,previousModel:active?.model,...(selections?{selections}:{}),pids:await this.processes(target),routing};
  }
  async repair(id:string){
    const entry=(await this.records()).find(r=>r.id===id);if(!entry||entry.state==='restored')throw conflict('没有可修复的接入记录，请重新接入。');
    return this.run(entry.target,async()=>{
      const record=(await this.records()).find(r=>r.id===id)!;
      const currentText=await readConfig(this.paths[record.target]);const current=hash(currentText);
      if(appliedConfig(record,currentText)){record.state='applied';await this.save(record);await this.retirePrevious(record);return publicRecord(record);}
      await this.requireEditableProfile(record.target);
      if(current!==record.beforeHash&&!(record.previousConfig!==undefined&&current===hash(record.previousConfig)))throw conflict('配置存在外部修改，无法安全自动修复，请先检查并保留备份。');
      await this.replace(record.target,current,record.after);
      if(record.target==='deepseek')await this.updateDeepseekEnv(record.after.match(/tfl_[a-f0-9]{20,}/)?.[0]??null);
      record.state='applied';await this.save(record);await this.retirePrevious(record);return publicRecord(record);
    });
  }
  async remove(id:string,revision:string){
    const entry=(await this.records()).find(r=>r.id===id);if(!entry)throw conflict('备份不存在');
    return this.run(entry.target,async()=>{
      const records=await this.records();const record=records.find(r=>r.id===id);if(!record)throw conflict('备份不存在');
      if(hash(await readConfig(this.paths[record.target]))!==revision)throw conflict('配置已变更，请刷新后再删除记录。');
      // An interrupted replacement can still depend on the previous journal.
      if(records.some(r=>r.state==='prepared'&&r.supersedes===id))throw conflict('新接入仍依赖此备份，请先还原或删除新接入记录。');
      await this.retirePrevious(record);
      await unlink(join(this.dir(),`${id}.json`));return publicRecord(record);
    });
  }
  async currentOfficialModel(){const recovered=codexRecovery(await readConfig(this.paths.codex),await this.records());return officialCodexModel(this.paths.codex,recovered.original);}
  async nativeModel(id:string){return officialCodexModel(this.paths.codex,await this.restoration(id,'native'));}
  async restoration(id:string,destination:'previous'|'native'='previous'){
    const records=await this.records();const record=records.find(r=>r.id===id);if(!record)throw conflict('备份不存在');
    const current=await readConfig(this.paths[record.target]);
    const base=record.target==='codex'?codexRecovery(current,records).original:current;
    return destination==='native'?nativeConfig(record.target,base,record):this.restoreText(record,current,records);
  }
  private restoreText(record:Record,current:string|null,records:Record[]=[record]){
    if(record.target==='codex'){const recovered=codexRecovery(current,records);if(recovered.recovery)return recovered.original;}
    try{return restoredConfig(record,current);}
    catch(error){
      if(record.target!=='codex'||!(error instanceof Error)||!error.message.includes('无法安全还原')||!codexGatewayStillPresent(current))throw error;
      return repairConfigBase(record,current);
    }
  }
  async restorePreview(id:string,mode:'previous'|'native'='previous'){
    const records=await this.records();const record=records.find(r=>r.id===id&&r.state!=='restored');if(!record)throw conflict('接入记录不存在或已还原，请刷新。');
    const current=await readConfig(this.paths[record.target]);
    const recovered=record.target==='codex'?codexRecovery(current,records):{original:current,recovery:undefined};
    let reason='';try{if(mode==='native')nativeConfig(record.target,recovered.original,record);else this.restoreText(record,current,records);}catch(error){reason=error instanceof Error?error.message:'无法确认原配置，请检查后重试。';}
    let destination:{kind:'official'|'custom'|'default'|'disconnect';provider:string;model?:string}|undefined;
    if(mode==='native')destination={kind:record.target==='codex'||record.target==='claude'?'official':'disconnect',provider:record.target==='codex'?'openai':record.target};
    else if(record.target==='codex'){
      const original=parse((recovered.recovery?recovered.original:record.before)??''),effective={...original,...codexProfile(original)};
      const provider=typeof effective.model_provider==='string'?effective.model_provider:'openai';
      const official=provider==='openai'&&!effective.openai_base_url&&!(isObject(original.model_providers)&&Object.hasOwn(original.model_providers,'openai'));
      destination={kind:record.before===null?'default':official?'official':'custom',provider,...(typeof effective.model==='string'?{model:effective.model}:{})};
    }
    return {id,target:record.target,...(recovered.recovery?{recovery:recovered.recovery}:{}),revision:hash(current),canRestore:!reason,reason,destination};
  }
  async officialModel(id:string){
    const record=(await this.records()).find(r=>r.id===id&&r.target==='codex');
    if(!record)return undefined;
    return officialCodexModel(this.paths.codex,codexRecovery(record.before,[record]).original);
  }
  async restore(id:string,approval?:{revision?:string;allowRunning?:boolean;overwrite?:boolean},destination:'previous'|'native'='previous'){
    const entry=(await this.records()).find(r=>r.id===id);if(!entry)throw conflict('备份不存在');
    return this.run(entry.target,async()=>{
      const records=await this.records();const record=records.find(r=>r.id===id)!;
      if(record.state==='restored')return publicRecord(record);
      const currentText=await readConfig(this.paths[record.target]);const current=hash(currentText);
      if(approval?.revision&&current!==approval.revision)throw conflict('审批后配置已变更，请重新生成方案。');
      if(destination==='previous'&&equivalentConfig(record.target,currentText,record.before)){record.state='restored';await this.save(record);if(record.target==='deepseek')await this.updateDeepseekEnv(null);await this.retirePrevious(record);return publicRecord(record);}
      const recovered=record.target==='codex'?codexRecovery(currentText,records):{original:currentText,recovery:undefined};
      const restored=destination==='native'?nativeConfig(record.target,recovered.original,record):this.restoreText(record,currentText,records);
      if(recovered.recovery)await this.backupDamagedCodex(currentText);
      if(destination==='native'){
        // Keep each exact preimage privately, including third-party edits made after connecting.
        const backup=join(this.dir(),`native-${record.id}-${current}.json`),temp=`${backup}.${randomUUID()}.tmp`;
        await safePath(backup);try{await writeFile(temp,JSON.stringify({target:record.target,before:currentText,revision:current,createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});await rename(temp,backup);}finally{await rm(temp,{force:true});}
      }
      if(restored!==currentText)await this.replace(record.target,current,restored,approval?.allowRunning);
      if(record.target==='deepseek')await this.updateDeepseekEnv(null);
      record.state='restored';await this.save(record);await this.retirePrevious(record);return publicRecord(record);
    });
  }
}
