import {parse} from 'smol-toml';
import {readConfig} from './agent-connections.js';
import { readFile } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { z } from 'zod';
import type { AgentPaths } from './agent-connections.js';
import {ClaudeAccountStore,type CredentialStore} from './claude-accounts.js';
import {nativeCredentialSchema} from './native-accounts.js';
const token=z.string().min(1).max(20000);
// Startup discovery and explicit imports read only supported local OAuth files; never return secrets to the renderer.
export async function localCredential(target:'codex'|'claude',paths:AgentPaths,keychain?:CredentialStore|null,options?:{retry?:boolean}):Promise<Record<string,unknown>> {
  if(target==='claude'){
    const store=new ClaudeAccountStore(paths.claude,keychain),state=await store.read(options);
    const oauth=z.object({accessToken:token,refreshToken:token,expiresAt:z.number(),scopes:z.array(z.string()).optional()}).parse(JSON.parse(state.auth??state.fileAuth??'null'));
    const identity=store.describe(state);
    const credential=nativeCredentialSchema.safeParse({access_token:oauth.accessToken,refresh_token:oauth.refreshToken,expired:new Date(oauth.expiresAt).toISOString(),email:identity.email,account_uuid:identity.accountId??undefined,organization_uuid:identity.organizationId??undefined,scopes:oauth.scopes});
    if(!credential.success)throw new Error('本地 Claude Code 缺少完整账号资料，请先在客户端完成登录，或在账号授权页重新授权。');
    return credential.data;
  }
  const config=parse(await readConfig(paths.codex)??'');
  if((config.cli_auth_credentials_store??'file')!=='file')throw new Error('Codex 当前使用系统钥匙串或自动凭据存储，暂不支持直接导入，请在账号授权页重新授权。');
  const path=join(dirname(paths.codex),'auth.json');
  let value:unknown;try{value=JSON.parse(await readFile(path,'utf8'));}catch{throw new Error('未找到可读取的本地 OAuth 凭据；若保存在系统钥匙串，请通过模型中心重新授权。');}
  if(target==='codex'){
    const mode=z.object({auth_mode:z.string().optional(),OPENAI_API_KEY:z.unknown().optional()}).parse(value);
    if(mode.auth_mode&&mode.auth_mode!=='chatgpt'||mode.OPENAI_API_KEY)throw new Error('本机 Codex 当前使用 API Key，请在账号授权页登录订阅账号。');
    const {tokens,last_refresh}=z.object({last_refresh:z.string().optional(),tokens:z.object({access_token:token,refresh_token:token,id_token:token,account_id:z.string().optional()})}).parse(value);
    let claims:Record<string,unknown>={};try{claims=JSON.parse(Buffer.from(tokens.id_token.split('.')[1],'base64url').toString());}catch{/* Unverified claims are display hints only. */}
    return {...tokens,email:typeof claims.email==='string'?claims.email:'本地 Codex 授权',expired:typeof claims.exp==='number'?new Date(claims.exp*1000).toISOString():undefined,last_refresh};
  }
  throw new Error('不支持的本地账号类型');
}
