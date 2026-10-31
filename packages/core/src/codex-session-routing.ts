import {RunnerCoreError} from './errors.js';
/** The session header is Codex's provider bucket; turn_context records which
 * model actually produced each turn and must not be relabelled. */
export function rewriteSessionProvider(text:string,provider:string,allowedProviders:readonly string[]){
 const end=text.indexOf('\n'),line=end<0?text:text.slice(0,end);let row:any;
 try{row=JSON.parse(line);}catch{return text;}
 if(row?.type!=='session_meta'||!row.payload||typeof row.payload!=='object')return text;
 const previous=row.payload.model_provider;
 if(previous===provider)return text;
 if(previous!==undefined&&previous!==null&&!allowedProviders.includes(previous))throw new RunnerCoreError('会话文件的来源已被其他程序修改，原记录和备份保留。',{statusCode:409,code:'codex_migration_failed'});
 row.payload.model_provider=provider;
 return JSON.stringify(row)+(end<0?'':text.slice(end));
}
