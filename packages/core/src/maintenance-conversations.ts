import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';

export const maintenanceContext=z.object({page:z.enum(['agents','accounts','apis','proxy','usage','activity','cleanup','settings']),target:z.enum(['codex','claude','workbuddy','qoder','deepseek','pi','workbuddy-ai']).optional(),provider:z.string().max(80).optional(),sourceId:z.string().max(100).optional(),
 range:z.enum(['today','7d','30d','all']).optional(),mode:z.enum(['day','week','cumulative']).optional(),day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
 model:z.string().max(300).optional(),keyId:z.string().max(80).optional(),origin:z.enum(['all','native','gateway']).optional(),traceId:z.string().max(100).optional(),
 breakdown:z.enum(['method','agent','model','task','source']).optional(),intent:z.enum(['codex-history','file-cleanup']).optional(),
}).strict();
export type MaintenanceContext=z.infer<typeof maintenanceContext>;
const message=z.object({role:z.string().max(20),text:z.string().max(32000)});
const conversation=z.object({id:z.string().uuid(),title:z.string().max(100),updatedAt:z.string(),context:maintenanceContext.optional(),chain:z.object({target:z.enum(['codex','claude','workbuddy','qoder','deepseek','pi','workbuddy-ai']),sourceId:z.string().optional(),model:z.string().optional(),connectionId:z.string().optional()}).optional(),model:z.string().optional(),status:z.enum(['idle','running','completed','failed']),messages:z.array(message).max(100)});
export type MaintenanceConversation=z.infer<typeof conversation>;

/** Local transcripts only; old proposals and execution permissions are never restored. */
export class MaintenanceConversations {
 private entries:MaintenanceConversation[]=[];
 private writing:Promise<void>=Promise.resolve();
 constructor(private root:string){}
 async load(){try{this.entries=z.array(conversation).max(20).parse(JSON.parse(await readFile(join(this.root,'maintenance-conversations.json'),'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('无法读取维修历史，原文件已保留。');}}
 list(){return this.entries.map(({messages,...entry})=>({...entry,messageCount:messages.length}));}
 get(id:string){const found=this.entries.find(entry=>entry.id===id);if(!found)throw Object.assign(new Error('找不到这段维修对话。'),{statusCode:404});return structuredClone(found);}
 save(entry:MaintenanceConversation){
  if(!entry.messages.some(message=>message.role==='user'))return;
  let size=0;const messages=entry.messages.slice(-100).map(message=>({...message,text:message.text.slice(0,32000)})).reverse().filter(message=>{size+=message.text.length;return size<=200000;}).reverse();
  this.entries=[{...structuredClone(entry),messages},...this.entries.filter(item=>item.id!==entry.id)].slice(0,20);
  const contents=JSON.stringify(this.entries);
  this.writing=this.writing.catch(()=>{}).then(async()=>{const path=join(this.root,'maintenance-conversations.json');await writeFile(`${path}.tmp`,contents,{mode:0o600});await rename(`${path}.tmp`,path);});
  // Surface persistence failures through flush(), without unhandled rejections between requests.
  void this.writing.catch(()=>{});
 }
 async flush(){await this.writing;}
}
