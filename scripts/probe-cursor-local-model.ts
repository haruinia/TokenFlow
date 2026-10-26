// Explicitly invoked diagnostics only; never imported by startup or npm test.
// Supply the existing app's in-memory Secrets facade. This function does not
// initialize safeStorage or decrypt profile files. The caller must already have
// authorized read access; no credentials, prompts or response text are returned.
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelParameterValue,SDKModel} from '@cursor/sdk';

type Secrets={get:(name:string)=>Promise<string>};
type Options={accountId?:string;model?:string;runInference?:boolean;timeoutMs?:number};
const publicValue=(value:string)=>/^[a-zA-Z0-9_.:+-]{1,128}$/.test(value)?value:'unsupported-value';
const safeParams=(params:ModelParameterValue[])=>params.map(p=>({id:publicValue(p.id),value:publicValue(p.value)}));
async function bounded<T>(task:Promise<T>,ms:number):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject({code:'deadline_exceeded'}),ms);})]);}finally{clearTimeout(timer);}}
function failureStatus(value:unknown){const error=value as {status?:unknown;statusCode?:unknown}|null;const status=error?.status??error?.statusCode;return typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?status:undefined;}
function failureCode(value:unknown){
 const error=(value??{}) as {code?:string;name?:string;message?:string};
 const allowed=['model_not_found','invalid_argument','bad_request','bad_model_name','unavailable','internal','unauthenticated','permission_denied','plan_required','resource_exhausted','rate_limited','deadline_exceeded'];
 if(allowed.includes(error.code??''))return error.code;
 const status=failureStatus(value);if(status===401)return 'unauthenticated';if(status===403)return 'permission_denied';if(status===429)return 'rate_limited';
 if(error.name==='TypeError'||error.name==='NetworkError')return 'network_error';
 if(/\bmodel (?:was |is )?not found\b/i.test(error.message??''))return 'model_not_found';
 return 'unclassified';
}
export function cursorVariantProbePlan(model:SDKModel){
 const defaults=model.variants?.find(variant=>variant.isDefault)?.params.map(p=>({...p}))??[];
 const context=model.parameters?.find(parameter=>parameter.id==='context');
 const alternative=context?.values.find(value=>value.value==='256k');
 const variants=[{label:'catalog_default',params:defaults}];
 // Change exactly context, and only when that value is advertised for this account.
 if(alternative&&defaults.some(p=>p.id==='context'&&p.value!=='256k'))variants.push({label:'advertised_256k',params:defaults.map(p=>p.id==='context'?{...p,value:alternative.value}:{...p})});
 return variants;
}
export async function probeCursorLocalModel(secrets:Secrets,options:Options={}){
 if(process.env.CURSOR_BACKEND_URL)throw new Error('Remove CURSOR_BACKEND_URL before the official diagnostic.');
 const selected=options.model??'grok-4.7';if(!/^grok-4\.[67]$/.test(selected))throw new Error('Diagnostic is limited to Grok 4.6/4.7.');
 let raw:{version?:number;accounts?:unknown[];apiKey?:string};
 try{raw=JSON.parse(await secrets.get('cursor-account'));if(!raw||typeof raw!=='object')throw new Error();}catch{throw new Error('Existing in-memory Cursor authorization is unavailable.');}
 const credentials=(raw.version===1&&Array.isArray(raw.accounts)?raw.accounts:[raw]) as Array<{apiKey:string;email?:string;disabled?:boolean;apiKeyExpiresAtMs?:number}>;
 const credential=credentials.find(value=>value&&typeof value.apiKey==='string'&&!value.disabled&&(!value.apiKeyExpiresAtMs||value.apiKeyExpiresAtMs>Date.now())&&(!options.accountId||createHash('sha256').update(`cursor:${value.email||value.apiKey}`).digest('hex').slice(0,24)===options.accountId));
 if(!credential?.apiKey)throw new Error('No already-authorized Cursor account is available.');
 const {Cursor,Agent,JsonlLocalAgentStore}=await import('@cursor/sdk');
 let catalog:SDKModel[];
 try{catalog=await bounded(Cursor.models.list({apiKey:credential.apiKey}),20000);}catch(error){return {model:selected,available:false,catalogError:failureCode(error),catalogHttpStatus:failureStatus(error),probes:[]};}
 const model=catalog.find(model=>model.id===selected);
 if(!model)return {model:selected,available:false,probes:[]};
 const variants=cursorVariantProbePlan(model);const probes:Array<{label:string;params:ModelParameterValue[];status:string;error?:string;errorHttpStatus?:number;elapsedMs:number}>=[];
 const result={model:selected,available:true,parameters:model.parameters?.map(p=>({id:publicValue(p.id),values:p.values.map(v=>publicValue(v.value))})),catalogVariants:model.variants?.map(v=>({default:v.isDefault??false,params:safeParams(v.params)})),variants:variants.map(v=>({label:v.label,params:safeParams(v.params)})),probes};
 if(!options.runInference)return result;
 const limit=Math.max(1000,Math.min(60000,options.timeoutMs??60000));
 for(const variant of variants){
  const directory=await mkdtemp(join(tmpdir(),'tokenflow-cursor-protocol-'));let agent:Awaited<ReturnType<typeof Agent.create>>|undefined;let run:Awaited<ReturnType<NonNullable<typeof agent>['send']>>|undefined;const started=Date.now();const remaining=()=>Math.max(1,started+limit-Date.now());
  try{
   const creating=Agent.create({apiKey:credential.apiKey,model:{id:model.id,...(variant.params.length?{params:variant.params}:{})},tools:[],mcpServers:{},agents:{},local:{cwd:directory,settingSources:[],customTools:{},store:new JsonlLocalAgentStore(join(directory,'store'))}});
   try{agent=await bounded(creating,remaining());}catch(error){void creating.then(late=>late.close()).catch(()=>{});throw error;}
   run=await bounded(agent.send('Reply with OK only.'),remaining());const output=await bounded(run.wait(),remaining());
   probes.push({label:variant.label,params:safeParams(variant.params),status:output.status,...(output.status==='finished'?{}:{error:failureCode(output.error),errorHttpStatus:failureStatus(output.error)}),elapsedMs:Date.now()-started});
  }catch(error){probes.push({label:variant.label,params:safeParams(variant.params),status:'error',error:failureCode(error),errorHttpStatus:failureStatus(error),elapsedMs:Date.now()-started});}
  finally{if(run)await bounded(run.cancel(),5000).catch(()=>{});await agent?.close();await rm(directory,{recursive:true,force:true});}
 }
 return result;
}
