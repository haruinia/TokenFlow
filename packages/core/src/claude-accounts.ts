import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { readConfig } from './agent-connections.js';
import { nativeConflict, nativeDigest, writePrivate, type NativeStore, type NativeState, type NativeCredential } from './native-accounts.js';
import type {NativeUsageLogin} from './native-usage-logins.js';
const exec=promisify(execFile);
export interface CredentialStore {read():Promise<string|null>;write(value:string|null):Promise<void>}
export function claudeKeychainService(configDir:string,env:NodeJS.ProcessEnv=process.env){
  const secureDir=env.CLAUDE_SECURESTORAGE_CONFIG_DIR,configEnv=env.CLAUDE_CONFIG_DIR;
  // Claude Code hashes the raw variable value, not a resolved path. Without the variable (e.g. launched from Finder),
  // a non-default directory can only belong to a CLI started with CLAUDE_CONFIG_DIR set to it.
  const custom=secureDir!==undefined?secureDir:configEnv?configEnv:resolve(configDir)!==join(homedir(),'.claude')?configDir:'';
  return `Claude Code-credentials${custom?`-${createHash('sha256').update(custom.normalize('NFC')).digest('hex').slice(0,8)}`:''}`;
}
export function claudeKeychain(configDir:string):CredentialStore {
  const service=claudeKeychainService(configDir);
  const user=process.env.USER||userInfo().username;const account=/^[a-zA-Z0-9._-]+$/.test(user)?user:'claude-code-user';
  return {
    async read(){try{return (await exec('/usr/bin/security',['find-generic-password','-a',account,'-s',service,'-w'],{timeout:10000,maxBuffer:2*1024*1024})).stdout.trim();}catch(e){if((e as {code?:number}).code===44)return null;throw nativeConflict('无法读取 Claude Code 钥匙串，请解锁系统钥匙串后重试。');}},
    async write(value){
      if(value===null){try{await exec('/usr/bin/security',['delete-generic-password','-a',account,'-s',service],{timeout:10000});}catch(e){if((e as {code?:number}).code!==44)throw nativeConflict('无法还原 Claude Code 钥匙串。');}return;}
      // security's interactive input keeps the credential out of process arguments.
      const quote=(v:string)=>`"${v.replaceAll('\\','\\\\').replaceAll('"','\\"')}"`;
      await new Promise<void>((yes,no)=>{
        const child=spawn('/usr/bin/security',['-i'],{stdio:['pipe','ignore','pipe']});let failed=false;
        const timer=setTimeout(()=>{failed=true;child.kill();},10000);
        child.stderr.on('data',(chunk:Buffer)=>{if(/SecKeychain|Error:|error:/i.test(chunk.toString()))failed=true;});
        child.on('error',()=>{clearTimeout(timer);no(nativeConflict('无法写入 Claude Code 钥匙串。'));});
        child.on('close',code=>{clearTimeout(timer);code===0&&!failed?yes():no(nativeConflict('无法写入 Claude Code 钥匙串，请解锁后重试。'));});
        child.stdin.on('error',()=>{failed=true;});
        child.stdin.end(`add-generic-password -U -a ${quote(account)} -s ${quote(service)} -w ${quote(value)}\n`);
      });
      if(await this.read()!==value)throw nativeConflict('Claude Code 钥匙串写入校验失败。');
    },
  };
}
function object(raw:string|null):Record<string,unknown>{try{const v=JSON.parse(raw??'{}');if(v&&typeof v==='object'&&!Array.isArray(v))return v;}catch{}throw nativeConflict('Claude Code 配置格式无效，未修改。');}
const field=(v:unknown)=>v===undefined?null:JSON.stringify(v);
const put=(doc:Record<string,unknown>,key:string,value:string|null)=>{if(value===null)delete doc[key];else doc[key]=JSON.parse(value);};
const routingKeys=['ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_SMALL_FAST_MODEL','CLAUDE_CODE_SUBAGENT_MODEL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','ANTHROPIC_PROFILE'];
export function claudeSettingsState(raw:string|null){
  const settings=object(raw),env=object(field(settings.env));
  const routing=Object.fromEntries(routingKeys.filter(k=>env[k]!==undefined).map(k=>[k,env[k]]));
  for(const key of ['apiKeyHelper','forceLoginMethod','forceLoginOrgUUID','forceLoginGatewayUrl'])if(settings[key]!==undefined)routing[key]=settings[key];
  return {model:field(settings.model),routing:JSON.stringify(routing)};
}
export class ClaudeAccountStore implements NativeStore {
  lockPath:string;storage:string;
  private credentials:string;private profile:string;
  constructor(private settings:string,private keychain:CredentialStore|null=process.platform==='darwin'?claudeKeychain(dirname(settings)):null){
    const dir=dirname(settings);const secureDir=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;this.credentials=join(secureDir===undefined?dir:secureDir||join(homedir(),'.claude'),'.credentials.json');
    this.profile=join(resolve(dir)===join(homedir(),'.claude')&&!process.env.CLAUDE_CONFIG_DIR?homedir():dir,'.claude.json');
    this.lockPath=`${settings}.token-flow.lock`;this.storage=keychain?'系统钥匙串':'本地凭据文件';
  }
  private async docs(){return {settings:await readConfig(this.settings),profile:await readConfig(this.profile),file:await readConfig(this.credentials),keychain:this.keychain?await this.keychain.read():null};}
  async read(){
    const d=await this.docs(),profile=object(d.profile);
    return {auth:field(object(d.keychain).claudeAiOauth),fileAuth:field(object(d.file).claudeAiOauth),account:field(profile.oauthAccount),...claudeSettingsState(d.settings)};
  }
  describe(state:NativeState){const account=object(state.account);return {email:typeof account.emailAddress==='string'?account.emailAddress:null,accountId:typeof account.accountUuid==='string'?account.accountUuid:null,organizationId:typeof account.organizationUuid==='string'?account.organizationUuid:null,model:state.model?JSON.parse(state.model) as string:null};}
  loginStatus(state:NativeState):{loginState:'signed-in'|'signed-out'|'unreadable';readError?:string}{
    const oauth=object(state.auth??state.fileAuth);
    if(typeof oauth.accessToken!=='string'||!oauth.accessToken.trim())return {loginState:'signed-out'};
    if(!this.describe(state).email)return {loginState:'unreadable',readError:'检测到 Claude Code 凭据，但缺少账号资料，请在客户端完成登录。'};
    return {loginState:'signed-in'};
  }
  async usageLogin():Promise<NativeUsageLogin|null>{
    const state=await this.read(),login=this.describe(state),routing=object(state.routing),oauth=object(state.auth??state.fileAuth);
    const overrides=['ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_PROFILE','apiKeyHelper','forceLoginGatewayUrl'];
    if(!login.accountId||!oauth.accessToken||overrides.some(k=>!!routing[k])||['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'].some(k=>!!routing[k]&&routing[k]!=='0'&&routing[k]!==false)||routing.forceLoginMethod&&routing.forceLoginMethod!=='claudeai')return null;
    return {provider:'claude',accountId:login.accountId,email:login.email,organizationId:login.organizationId};
  }
  identity(state:NativeState){const a=this.describe(state);return a.email?JSON.stringify([a.accountId,a.organizationId,a.email.toLowerCase()]):null;}
  signedOut(state:NativeState){return state.auth===null&&state.fileAuth===null&&state.account===null;}
  restoreState(current:NativeState,original:NativeState,applied:NativeState){return {...original,routing:current.routing,model:current.model!==applied.model&&current.model!==original.model?current.model:original.model};}
  prepare(before:NativeState,c:NativeCredential,model?:string){
    const routing=object(before.routing);
    if(Object.entries(routing).some(([k,v])=>k==='forceLoginMethod'?v!=='claudeai':k.startsWith('CLAUDE_CODE_USE_')?!!v&&v!=='0'&&v!==false:!!v))throw nativeConflict('Claude Code 有接口、模型或登录限制配置，请先还原接口或清除覆盖设置。');
    if(model&&!/^claude\/[a-zA-Z0-9._-]+$/.test(model))throw nativeConflict('请选择 Claude Code 支持的模型。');
    const scopes=c.scopes??c.scope?.split(/\s+/).filter(Boolean)??['user:profile','user:inference','user:sessions:claude_code','user:mcp_servers','user:file_upload'];
    if(!scopes.includes('user:inference'))throw nativeConflict('账号没有 Claude Code 推理权限，请重新授权。');
    const auth=JSON.stringify({accessToken:c.access_token,refreshToken:c.refresh_token,expiresAt:Date.parse(c.expired),scopes,subscriptionType:null,rateLimitTier:null});
    const previous=this.describe(before);
    const same=!!c.account_uuid&&!!c.organization_uuid&&previous.accountId===c.account_uuid&&previous.organizationId===c.organization_uuid&&previous.email?.toLowerCase()===c.email.toLowerCase()&&(before.auth!==null||before.fileAuth!==null);
    return {...before,auth:same?before.auth:this.keychain?auth:null,fileAuth:same?before.fileAuth:this.keychain?null:auth,account:JSON.stringify({emailAddress:c.email,...(c.account_uuid?{accountUuid:c.account_uuid}:{}),...(c.organization_uuid?{organizationUuid:c.organization_uuid}:{})}),model:model?JSON.stringify(model.slice(7)):before.model};
  }
  async write(before:NativeState,after:NativeState){
    if(nativeDigest(await this.read())!==nativeDigest(before))throw nativeConflict('Claude Code 登录已被其他程序修改。');
    const d=await this.docs();
    const settings=object(d.settings),profile=object(d.profile),file=object(d.file),keychain=object(d.keychain);
    put(settings,'model',after.model);put(profile,'oauthAccount',after.account);put(file,'claudeAiOauth',after.fileAuth);put(keychain,'claudeAiOauth',after.auth);
    const serialized=(doc:Record<string,unknown>,original:string|null)=>!Object.keys(doc).length&&original===null?null:JSON.stringify(doc,null,2)+'\n';
    const changes:[string,string|null,string|null][]=[[this.credentials,d.file,serialized(file,d.file)],[this.profile,d.profile,serialized(profile,d.profile)],[this.settings,d.settings,serialized(settings,d.settings)]];
    const nextKeychain=Object.keys(keychain).length?JSON.stringify(keychain):null;
    try{
      if(this.keychain)await this.keychain.write(nextKeychain);
      for(const [path,original,next] of changes){if(await readConfig(path)!==original)throw nativeConflict('Claude Code 配置被其他程序修改，已停止切换。');await writePrivate(path,next);}
    }catch(error){
      for(const [path,original,next] of changes)if(await readConfig(path)===next)await writePrivate(path,original);
      if(this.keychain&&await this.keychain.read()===nextKeychain)await this.keychain.write(d.keychain);
      throw error;
    }
  }
}
