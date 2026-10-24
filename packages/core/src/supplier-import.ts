import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { normalizeApiBaseURL } from '../../../apps/shared/api-endpoint.js';
import { ApiSources, parseApiSourceInput } from './api-sources.js';
import { RunnerCoreError } from './errors.js';

const MAX_BYTES=16*1024*1024, MAX_ROWS=1000;
type Input=ReturnType<typeof parseApiSourceInput>;
type Row=Record<string,unknown>;
export type SupplierImportRow={id:string;name:string;app:string;baseURL?:string;protocol?:Input['protocol'];models:string[];status:'ready'|'exists'|'unsupported';reason?:string};
export type SupplierImportPreview={token:string;rows:SupplierImportRow[]};
type Candidate={row:SupplierImportRow;input?:Input};
const object=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const str=(v:unknown)=>typeof v==='string'?v.trim():'';
const invalid=(message='无法读取供应商数据，请选择 CC Switch 数据库、SQL 备份或 JSON 配置。')=>new RunnerCoreError(message,{statusCode:400,code:'supplier_import_invalid'});
const jsonObject=(v:unknown)=>typeof v==='string'?object(JSON.parse(v)):object(v);

/** Read literal values only. SQL backups are data here, and are never executed. */
function tokens(sql:string){
 const out:string[]=[];const re=/\s+|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|[(),;]|./gy;
 let m:RegExpExecArray|null;while((m=re.exec(sql))){if(!/^\s|^--|^\/\*/.test(m[0]))out.push(m[0]);if(out.length>2_000_000)throw invalid('导入文件包含过多字段。');}return out;
}
const identifier=(v:string)=>v?.replace(/^(?:["`\[])(.*)(?:["`\]])$/s,'$1').toLowerCase();
function sqlRows(text:string):Row[]{
 const all=tokens(text),rows:Row[]=[];let columns:string[]=[];
 for(let begin=0;begin<all.length;){let end=begin;while(end<all.length&&all[end]!==';')end++;const t=all.slice(begin,end);begin=end+1;
  const upper=t.map(v=>v.toUpperCase());
  if(upper[0]==='CREATE'&&upper[1]==='TABLE'){
   let p=2;if(upper[p]==='IF')p+=3;if(identifier(t[p])!=='providers'||t[++p]!=='(')continue;
   columns=[];let depth=0,first=true;for(p++;p<t.length;p++){const v=t[p];if(v==='(')depth++;if(v===')'){if(depth===0)break;depth--;}
    if(first){if(!['PRIMARY','UNIQUE','FOREIGN','CHECK','CONSTRAINT'].includes(upper[p]))columns.push(identifier(v));first=false;}
    if(v===','&&depth===0)first=true;
   }
  }
  if(upper[0]!=='INSERT'&&upper[0]!=='REPLACE')continue;
  let p=upper.indexOf('INTO');if(p<0||identifier(t[++p])!=='providers')continue;p++;
  let names=columns;
  if(t[p]==='('){names=[];for(p++;p<t.length&&t[p]!==')';p++)if(t[p]!==',')names.push(identifier(t[p]));p++;}
  if(!names.length||upper[p++]!=='VALUES')throw invalid('供应商 SQL 需要明确的列和字面量 VALUES。');
  while(p<t.length){if(t[p++]!=='(')throw invalid();const values:unknown[]=[];
   while(p<t.length&&t[p]!==')'){const v=t[p++];if(/^'(?:''|[^'])*'$/.test(v))values.push(v.slice(1,-1).replace(/''/g,"'"));else if(/^NULL$/i.test(v))values.push(null);else if(/^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(v))values.push(Number(v));else throw invalid('供应商 SQL 仅支持字面量，未执行任何 SQL。');if(t[p]===',')p++;else if(t[p]!==')')throw invalid();}
   if(t[p++]!==')'||values.length!==names.length)throw invalid();rows.push(Object.fromEntries(names.map((n,i)=>[n,values[i]])));if(rows.length>MAX_ROWS)throw invalid('每次最多导入 1000 个供应商。');if(p<t.length&&t[p++]!==',')throw invalid();
  }
 }return rows;
}

function databaseRows(path:string):Row[]{
 const db=new DatabaseSync(path,{readOnly:true,allowExtension:false});
 try{db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN');
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='providers' AND type='table'").get())throw invalid('所选数据库中没有 providers 表。');
  const columns=new Set(db.prepare('PRAGMA table_info(providers)').all().map(row=>String(row.name)));
  if(!['id','app_type','name','settings_config'].every(n=>columns.has(n)))throw invalid('供应商数据库格式不受支持。');
  const rows:Row[]=[];let bytes=0;for(const row of db.prepare(`SELECT id,app_type,name,settings_config${columns.has('meta')?',meta':''}${columns.has('category')?',category':''} FROM providers LIMIT ${MAX_ROWS+1}`).iterate()){bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>MAX_BYTES)throw invalid('供应商配置合计超过 16 MB，请分批导入。');rows.push(row);}return rows;
 }finally{db.close();}
}
function jsonRows(value:unknown):Row[]{
 if(Array.isArray(value))return value.map(object);
 const root=object(value);if(Array.isArray(root.sources))return root.sources.map(v=>({...object(v),app_type:'api'}));
 if(Array.isArray(root.providers))return root.providers.map(object);
 const result:Row[]=[];
 for(const app of ['claude','codex','gemini','opencode']){const entries=object(object(root[app]).providers);for(const [id,v]of Object.entries(entries))result.push({id,...object(v),app_type:app});}
 return result;
}
function importedProtocol(format:string,fallback:Input['protocol']):Input['protocol']|undefined{
 if(!format)return fallback;
 if(['responses','openai_responses'].includes(format))return 'responses';
 if(['chat','chat-completions','chat_completions','openai-chat','openai_chat'].includes(format))return 'chat';
 if(['messages','anthropic'].includes(format))return 'messages';
 return undefined;
}
function candidate(raw:Row,index:number):Candidate{
 const row:SupplierImportRow={id:String(index),name:str(raw.name).slice(0,80)||`供应商 ${index+1}`,app:str(raw.app_type??raw.appType),models:[],status:'unsupported'};
 const skip=(reason:string)=>({row:{...row,reason}});
 try{
  const settings=jsonObject(raw.settings_config??raw.settingsConfig),meta=jsonObject(raw.meta??{});
  if(/oauth|copilot|official/i.test([raw.category,meta.providerType,meta.authType].map(str).join(' ')))return skip('此条目使用官方登录或托管认证，请在账号授权中添加。');
  let baseURL='',apiKey='',protocol:Input['protocol']='responses',models:string[]=[];
  if(row.app==='api'){
   baseURL=str(raw.baseURL);apiKey=str(raw.apiKey);protocol=raw.protocol as Input['protocol'];models=Array.isArray(raw.models)?raw.models.map(str):[];
  }else if(row.app==='claude'){
   const env=object(settings.env);baseURL=str(env.ANTHROPIC_BASE_URL);apiKey=str(env.ANTHROPIC_AUTH_TOKEN)||str(env.ANTHROPIC_API_KEY);const selectedProtocol=importedProtocol(str(meta.apiFormat),'messages');if(!selectedProtocol)return skip('接口协议不受支持，请手动添加。');protocol=selectedProtocol;
   // Claude's native base URL excludes its /v1/messages route; ApiSources stores the route base.
   if(protocol==='messages'&&baseURL&&!/\/(?:v\d+|messages)\/?$/.test(new URL(baseURL).pathname))baseURL=baseURL.replace(/\/+$/,'')+'/v1';
   models=['ANTHROPIC_MODEL','ANTHROPIC_SMALL_FAST_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL'].map(k=>str(env[k]));
   if(env.ANTHROPIC_CUSTOM_HEADERS||settings.apiKeyHelper)return skip('包含额外请求头或动态凭据，请手动配置该供应商。');
  }else if(row.app==='codex'){
   const config=object(parse(str(settings.config))),provider=object(object(config.model_providers)[str(config.model_provider)]),auth=object(settings.auth);
   const openAIAuth=provider.requires_openai_auth===true,directBearer=str(provider.experimental_bearer_token);
   // A declared credential source is authoritative. Never resolve environment
   // variables or commands while importing, or replace them with an unrelated
   // auth.json key. OpenAI authentication explicitly ignores env_key in Codex.
   if(provider.http_headers||provider.env_http_headers)return skip('包含额外请求头，请手动配置该供应商。');
   if(provider.command||provider.auth)return skip('使用命令获取凭据，无法直接导入；请手动填写该供应商的 API Key。');
   if(!openAIAuth&&provider.env_key)return skip('使用环境变量提供凭据，导出文件未包含其值；请手动填写该供应商的 API Key。');
   if(openAIAuth&&directBearer)return skip('同时配置了 OpenAI 登录和直接令牌，请确认认证方式后手动添加。');
   baseURL=str(provider.base_url);apiKey=openAIAuth?str(auth.OPENAI_API_KEY):directBearer||str(auth.OPENAI_API_KEY);
   const selectedProtocol=importedProtocol(str(meta.apiFormat)||str(provider.wire_api),'responses');if(!selectedProtocol)return skip('接口协议不受支持，请手动添加。');protocol=selectedProtocol;
   models=[str(config.model)];
   const catalog=object(settings.modelCatalog??meta.modelCatalog??raw.modelCatalog);
   if(Array.isArray(catalog.models))models.push(...catalog.models.map(v=>str(object(v).model)));
  }else return skip('当前支持 Claude Code、Codex 的 API 供应商以及 TokenFlow API JSON。');
  if(!baseURL||!apiKey)return skip('缺少 API 地址或可导入的 API Key；登录账号需单独授权。');
  models=[...new Set(models.filter(Boolean))];
  const input=parseApiSourceInput({name:row.name,baseURL:normalizeApiBaseURL(baseURL),apiKey,protocol,models,enabled:row.app==='api'&&raw.enabled===false?false:true,...(row.app==='api'&&raw.modelRoutes?{modelRoutes:raw.modelRoutes}:{} )});
  return {row:{...row,baseURL:input.baseURL,protocol,models,status:'ready',...(!models.length?{reason:'未配置模型；导入后可读取模型列表或手动添加。'}:{})},input};
 }catch{return skip('该供应商的配置格式无效，请修正后重试。');}
}
const fingerprint=(input:{baseURL:string;protocol:string;apiKey?:string;models?:string[];modelRoutes?:Input['modelRoutes']})=>createHash('sha256').update(JSON.stringify([normalizeApiBaseURL(input.baseURL),input.protocol,input.apiKey,[...(input.models??[])].sort().map(model=>[model,input.modelRoutes?.[model]?.protocol??input.protocol,normalizeApiBaseURL(input.modelRoutes?.[model]?.baseURL??input.baseURL)])])).digest('hex');

export class SupplierImporter{
 private previews=new Map<string,{expires:number;candidates:Candidate[];result?:{imported:number;skipped:number}}>();
 constructor(private sources:ApiSources,private localPath=join(homedir(),'.cc-switch','cc-switch.db')){}
 async preview(input:{local?:boolean;file?:string;content?:string}):Promise<SupplierImportPreview>{
  let rows:Row[];
  try{
   if(input.local){rows=databaseRows(this.localPath);}
   else{
    if(!input.content||input.content.length>Math.ceil(MAX_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.content))throw invalid();
    const bytes=Buffer.from(input.content,'base64');if(bytes.length>MAX_BYTES)throw invalid('供应商文件超过 16 MB。');
    if(bytes.subarray(0,16).toString()==='SQLite format 3\0'){
     const root=await mkdtemp(join(tmpdir(),'tokenflow-import-'));try{const path=join(root,'providers.db');await writeFile(path,bytes,{mode:0o600});rows=databaseRows(path);}finally{await rm(root,{recursive:true,force:true});}
    }else{const text=bytes.toString('utf8');rows=/^\s*[{[]/.test(text)?jsonRows(JSON.parse(text)):sqlRows(text);}
   }
  }catch(error){if(error instanceof RunnerCoreError)throw error;if((error as NodeJS.ErrnoException).code==='ENOENT')throw invalid('未找到本机 CC Switch 数据库，请选择其导出文件。');throw invalid();}
  if(!rows.length||rows.length>MAX_ROWS)throw invalid(rows.length?'每次最多导入 1000 个供应商。':'没有找到可识别的供应商记录。');
  const candidates=rows.map(candidate),existing=await this.existing();
  for(const c of candidates)if(c.input){const id=fingerprint(c.input);if(existing.has(id)){c.row.status='exists';c.row.reason='相同地址、协议、密钥和模型的供应商已存在。';}else existing.add(id);}
  for(const [key,p]of this.previews)if(p.expires<Date.now())this.previews.delete(key);
  if(this.previews.size>=4)this.previews.delete(this.previews.keys().next().value!);
  const token=randomBytes(24).toString('hex');this.previews.set(token,{expires:Date.now()+10*60_000,candidates});
  return {token,rows:candidates.map(c=>c.row)};
 }
 private async existing(){const set=new Set<string>();for(const source of await this.sources.list())set.add(fingerprint({...source,apiKey:await this.sources.keyFor(source.id)}));return set;}
 async apply(token:string,ids:string[]){
  const preview=this.previews.get(token);if(!preview||preview.expires<Date.now())throw invalid('导入预览已过期，请重新读取文件。');
  if(preview.result)return preview.result;
  if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!preview.candidates.some(c=>c.row.id===id&&c.row.status==='ready')))throw invalid('请选择可导入的供应商。');
  const existing=await this.existing(),inputs:Input[]=[];let skipped=0;
  for(const id of ids){const c=preview.candidates.find(c=>c.row.id===id)!;const key=fingerprint(c.input!);if(existing.has(key)){skipped++;continue;}existing.add(key);inputs.push(c.input!);}
  await this.sources.importBatch(inputs);preview.result={imported:inputs.length,skipped};preview.candidates=[];return preview.result;
 }
 discard(token:string){this.previews.delete(token);}
 close(){this.previews.clear();}
}
