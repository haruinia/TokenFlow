import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {gatewayIPAddress} from './gateway-ip.js';

export const gatewayKeyInput = z.object({
  name: z.string().trim().min(1).max(80),
  purpose:z.string().trim().max(160).optional(),
  enabled: z.boolean().default(true),
  access: z.enum(['local','lan']).default('local'),
  allowedIPs:z.array(gatewayIPAddress).max(256).optional().transform(values=>values?[...new Set(values)]:undefined),
  sourceId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  modelSources: z.record(z.string().regex(/^[a-f0-9]{24}$/)).optional(),
  agents: z.array(z.enum(['codex','claude','openai'])).max(3).default(['codex','claude','openai']).transform(ids=>[...new Set(ids)]),
  tokenLimit: z.number().int().min(0).max(1_000_000_000_000).nullable().default(null),
  models: z.array(z.string().min(3).max(300)).max(2000).transform(ids => [...new Set(ids)].sort()),
}).strict();
const storedKey = gatewayKeyInput.extend({exported:z.boolean().optional(),id:z.string().uuid(), prefix:z.string(), digest:z.string().regex(/^[a-f0-9]{64}$/), createdAt:z.string(), usedTokens:z.number().nonnegative().default(0), unmeteredRequests:z.number().int().nonnegative().default(0), pending:z.array(z.string().uuid()).default([])});
type StoredKey = z.infer<typeof storedKey>;
export type GatewayKey = Omit<StoredKey, 'digest'|'pending'> & {pendingRequests:number};
const publicKey=({digest:_digest,pending,...entry}:StoredKey):GatewayKey=>({...structuredClone(entry),pendingRequests:pending.length});
const denied=(message:string,statusCode=429)=>Object.assign(new Error(message),{statusCode});
export const allowsProtocol=(agents:GatewayKey['agents'],path:string)=>path.startsWith('messages')?agents.includes('claude'):path==='chat/completions'?agents.includes('openai'):agents.includes('codex')||agents.includes('openai');
const hash = (value: string) => createHash('sha256').update(value).digest();

/** Client keys are model-scoped and verified using hashes. Exported copies may live in system-encrypted storage. They never grant desktop management access. */
export class GatewayKeys {
  private entries: StoredKey[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(private path: string) {}
  static async open(root: string) {
    const store = new GatewayKeys(join(root, 'gateway-keys.json'));
    try {store.entries = z.array(storedKey).parse(JSON.parse(await readFile(store.path, 'utf8')));}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('客户端 Key 配置读取失败，请检查 gateway-keys.json；未重置已有权限。');}
    if(store.entries.some(key=>key.pending.length))await store.mutate(entries=>{for(const key of entries){key.unmeteredRequests+=key.pending.length;key.pending=[];}});
    return store;
  }
  list(): GatewayKey[] {return this.entries.map(publicKey);}
  authenticate(value: string): GatewayKey | undefined {
    if (!value || value.length > 256) return;
    const digest = hash(value);
    const entry = this.entries.find(key => key.enabled && timingSafeEqual(digest, Buffer.from(key.digest, 'hex')));
    if (entry) return publicKey(entry);
  }
  private mutate<T>(fn: (entries: StoredKey[]) => T): Promise<T> {
    const task = this.pending.then(async () => {
      const entries = structuredClone(this.entries);
      const result = fn(entries);
      await writeFile(`${this.path}.tmp`, JSON.stringify(entries, null, 2), {mode:0o600});
      await rename(`${this.path}.tmp`, this.path);
      this.entries = entries;
      return result;
    });
    this.pending = task.catch(() => undefined);
    return task;
  }
  create(input: z.infer<typeof gatewayKeyInput>, exported=false) {
    return this.mutate(entries => {
      if (entries.length >= 100) throw Object.assign(new Error('最多创建 100 个客户端 Key'), {statusCode:400});
      const apiKey = `tfl_${randomBytes(32).toString('hex')}`;
      const entry:StoredKey = {...input,...(exported?{exported:true}:{}),usedTokens:0,unmeteredRequests:0,pending:[], id:randomUUID(), prefix:apiKey.slice(0,12), digest:hash(apiKey).toString('hex'), createdAt:new Date().toISOString()};
      entries.push(entry);
      return {key:publicKey(entry), apiKey};
    });
  }
  update(id: string, input: z.infer<typeof gatewayKeyInput>) {
    return this.mutate(entries => {
      const entry = entries.find(key => key.id === id);
      if (!entry) throw Object.assign(new Error('Key 不存在'), {statusCode:404});
      const allowedIPs=entry.allowedIPs;
      Object.assign(entry, input);
      // Omission keeps the current policy, including one migrated while this
      // update was queued. An explicit empty array removes the restriction.
      if(input.allowedIPs===undefined&&allowedIPs!==undefined)entry.allowedIPs=allowedIPs;
      return publicKey(entry);
    });
  }
  /** Move the former entrance-wide policy onto existing keys before removing it. */
  inheritLANIPs(allowedIPs:string[]) {
    return this.mutate(entries=>{
      for(const entry of entries){
        if(!entry.exported||entry.access!=='lan')continue;
        const next=entry.allowedIPs?.length?entry.allowedIPs.filter(ip=>allowedIPs.includes(ip)):[...allowedIPs];
        if(!next.length)throw denied(`「${entry.name}」的旧来源限制没有交集，请先改为仅本机，再重新设置局域网来源。`,409);
        entry.allowedIPs=next;
      }
    });
  }
  updateModels(id:string,models:string[],modelSources:Record<string,string>,access?:GatewayKey['access'],allowedIPs?:string[]) {
    return this.mutate(entries=>{
      const entry=entries.find(key=>key.id===id);
      if(!entry)throw Object.assign(new Error('Key 不存在'),{statusCode:404});
      entry.models=models;entry.modelSources=modelSources;delete entry.sourceId;
      if(access!==undefined)entry.access=access;
      if(allowedIPs!==undefined)entry.allowedIPs=allowedIPs;
      // Legacy exported keys had no marker; keep them visible after pinning their model sources.
      entry.exported=true;
      return publicKey(entry);
    });
  }
  /** Reserve before forwarding and persist in-flight requests so a restart cannot erase unreported usage. */
  reserve(id:string,model:string,path:string) {
    return this.mutate(entries=>{
      const entry=entries.find(key=>key.id===id);
      if(!entry?.enabled)throw denied('Key 已停用或删除',401);
      if(!entry.models.includes(model)||!allowsProtocol(entry.agents,path))throw denied('Key 未授权此模型或 Agent 协议',403);
      if(entry.tokenLimit!==null){
        if(entry.unmeteredRequests)throw denied('存在未结算请求，请先核对并重置用量');
        if(entry.usedTokens>=entry.tokenLimit)throw denied('此 Key 的 token 额度已耗尽');
        if(entry.pending.length)throw denied('有限额 Key 正在处理其他请求，请完成后重试');
      }
      if(entry.pending.length>=128)throw denied('此 Key 的并发请求过多');
      const reservation=randomUUID();entry.pending.push(reservation);
      return reservation;
    });
  }
  settle(id:string,reservation:string,usage:{inputTokens:number|null;outputTokens:number|null},uncertain:boolean) {
    return this.mutate(entries=>{
      const entry=entries.find(key=>key.id===id);
      if(!entry||!entry.pending.includes(reservation))return;
      entry.pending=entry.pending.filter(value=>value!==reservation);
      entry.usedTokens=Math.min(Number.MAX_SAFE_INTEGER,entry.usedTokens+Math.max(0,usage.inputTokens??0)+Math.max(0,usage.outputTokens??0));
      if(uncertain)entry.unmeteredRequests++;
    });
  }
  resetUsage(id:string) {
    return this.mutate(entries=>{
      const entry=entries.find(key=>key.id===id);if(!entry)throw denied('Key 不存在',404);
      if(entry.pending.length)throw denied('仍有在途请求，完成后才能重置用量',409);
      entry.usedTokens=0;entry.unmeteredRequests=0;return publicKey(entry);
    });
  }
  detachSource(sourceId:string){return this.mutate(entries=>{
    for(const entry of entries){
      const removed=entry.models.filter(model=>entry.sourceId===sourceId||entry.modelSources?.[model]===sourceId||model.startsWith(`api-${sourceId}/`));
      if(!removed.length)continue;
      entry.models=entry.models.filter(model=>!removed.includes(model));
      if(entry.modelSources)for(const model of removed)delete entry.modelSources[model];
      if(entry.sourceId===sourceId)delete entry.sourceId;
    }
    for(let i=entries.length-1;i>=0;i--)if(!entries[i]!.models.length)entries.splice(i,1);
  });}
  remove(id: string) {return this.mutate(entries => {
    const index = entries.findIndex(key => key.id === id);
    if (index < 0) throw Object.assign(new Error('Key 不存在'), {statusCode:404});
    entries.splice(index,1); return {ok:true};
  });}
}
