import {parse as parseYAML} from 'yaml';
import type {Target} from './agent-connections.js';
import type {AgentInstallation} from './agent-installation.js';
export type AgentUpdate={status:'available'|'current'|'unknown'|'unsupported';currentVersion?:string;latestVersion?:string};
function parsedVersion(value:string){return /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(value);}
export function newerVersion(latest:string,current:string){
 const a=parsedVersion(latest),b=parsedVersion(current);if(!a||!b)return false;
 for(let i=1;i<=3;i++)if(Number(a[i])!==Number(b[i]))return Number(a[i])>Number(b[i]);
 if(!a[4]||!b[4])return !!b[4]&&!a[4];
 const left=a[4].split('.'),right=b[4].split('.');
 for(let i=0;i<Math.max(left.length,right.length);i++){
  if(left[i]===undefined)return false;if(right[i]===undefined)return true;if(left[i]===right[i])continue;
  const ln=/^\d+$/.test(left[i]),rn=/^\d+$/.test(right[i]);
  return ln&&rn?Number(left[i])>Number(right[i]):ln!==rn?!ln:left[i]>right[i];
 }
 return false;
}
export class AgentUpdates{
 private cache=new Map<Target,{key:string;expires:number;result:Promise<AgentUpdate>}>();
 constructor(private fetcher:typeof fetch=fetch,private platform=process.platform,private arch=process.arch,private now=()=>Date.now()){}
 check(target:Target,installed:AgentInstallation):Promise<AgentUpdate>{
  if(installed.supported===false)return Promise.resolve({status:'unsupported',currentVersion:installed.version});
  if(!installed.installed||!installed.version||!parsedVersion(installed.version))return Promise.resolve({status:'unknown',currentVersion:installed.version});
  const key=`${installed.channel}:${installed.version}:${this.platform}:${this.arch}`;
  const cached=this.cache.get(target);if(cached?.key===key&&cached.expires>this.now())return cached.result;
  const result=this.load(target,installed);this.cache.set(target,{key,expires:this.now()+30*60*1000,result});return result;
 }
 private async load(target:Target,installed:AgentInstallation):Promise<AgentUpdate>{
  const currentVersion=installed.version!;const unknown:AgentUpdate={status:'unknown',currentVersion};
  try{
   let url:string|undefined;
   const npm:Partial<Record<Target,string>>={pi:'@earendil-works/pi-coding-agent',claude:'@anthropic-ai/claude-code',codex:'@openai/codex'};
   if(npm[target]&&installed.channel==='npm')url=`https://registry.npmjs.org/${encodeURIComponent(npm[target]!)}/latest`;
   else if(target==='deepseek'&&this.platform==='darwin'&&this.arch==='arm64')url='https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml';
   else if(target==='deepseek'&&this.platform==='win32'&&this.arch==='x64')url='https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml';
   else if(target==='qoder'&&this.platform==='darwin')url='https://download.qoder.com.cn/qoder-app/releases/latest-mac.yml';
   else if(target==='qoder'&&this.platform==='win32')url='https://download.qoder.com.cn/qoder-app/releases/latest.yml';
   else if(target==='workbuddy'&&['darwin','win32'].includes(this.platform))url=`https://copilot.tencent.com/v2/update?platform=workbuddy-${this.platform}-${this.arch}&version=${encodeURIComponent(currentVersion)}`;
   if(!url)return unknown;
   const response=await this.fetcher(url,{signal:AbortSignal.timeout(6000),headers:{Accept:'application/json, application/yaml, text/yaml'}});
   if(target==='workbuddy'&&response.status===204)return {status:'current',currentVersion,latestVersion:currentVersion};
   if(!response.ok||Number(response.headers.get('content-length'))>256*1024)return unknown;
   if(!response.body)return unknown;
   const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>256*1024){await reader.cancel();return unknown;}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
   const data=url.endsWith('.yml')?parseYAML(text):JSON.parse(text);
   const latestVersion=data?.productVersion??data?.version;
   if(typeof latestVersion!=='string'||!parsedVersion(latestVersion))return unknown;
   // A feed offering only a different architecture cannot confirm a compatible update.
   if(target==='qoder'&&Array.isArray(data.files)&&!data.files.some((file:{url?:string})=>typeof file.url==='string'&&new RegExp(`-${this.arch}(?:[.-])`).test(file.url)))return unknown;
   return {status:newerVersion(latestVersion,currentVersion)?'available':'current',currentVersion,latestVersion};
  }catch{return unknown;}
 }
}
