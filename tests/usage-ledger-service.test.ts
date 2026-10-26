import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDesktopService } from '../packages/core/src/service.js';
import type { UsageRow } from '../packages/core/src/usage-ledger.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function open(root?: string) {
  const dir = root ?? await mkdtemp(join(await realpath(tmpdir()), 'usage-ledger-'));
  if (!root) { cleanup.push(() => rm(dir, { recursive: true, force: true })); await mkdir(join(dir, 'cliproxy')); await writeFile(join(dir, 'cliproxy', 'fixture-accounts.json'), JSON.stringify([{ name: 'codex.json', provider: 'codex', email: 'codex@example.test', status: 'active', models: ['shared-model'] }])); }
  const allocator = createServer(); await new Promise<void>(r => allocator.listen(0, '127.0.0.1', r)); const port = (allocator.address() as { port: number }).port; await new Promise<void>(r => allocator.close(() => r()));
  const service = await createDesktopService({ root: dir, proxyPort: port, binary: resolve('tests/fixtures/fake-cliproxy.mjs'), token: 'admin-token', localKey: 'internal-sidecar-key', secrets: { get: async () => '', set: async () => {} } });
  cleanup.push(() => service.app.close());
  await service.proxy.start();
  return { dir, service, admin: { host: '127.0.0.1:9527', authorization: 'Bearer admin-token' } };
}

it('records per-day, per-Key token statistics that survive a restart and never contain prompts', async () => {
  const first = await open();
  const { service, admin } = first;
  const created = await service.app.inject({ method: 'POST', url: '/api/gateway-keys', headers: admin, payload: { name: 'Cursor', models: ['codex/shared-model'] } });
  expect(created.statusCode, created.body).toBe(200);
  const { apiKey, key } = created.json();
  const headers = { host: admin.host, authorization: `Bearer ${apiKey}` };
  for (let index = 0; index < 2; index++) expect((await service.app.inject({ method: 'POST', url: '/v1/responses', headers, payload: { model: 'codex/shared-model', input: [{role:'user',content:'not-for-logs'},{type:'function_call_output',call_id:'tool0',output:'RESULT_FOR_TRACE'}] } })).statusCode).toBe(200);
  expect((await service.app.inject({ method: 'POST', url: '/v1/responses', headers, payload: { model: 'claude/other' } })).statusCode).toBe(403);
  await service.app.inject({ method: 'POST', url: '/v1/messages/count_tokens', headers: { ...headers, 'x-api-key': apiKey }, payload: { model: 'codex/shared-model', messages: [] } });

  const report = (await service.app.inject({ url: '/api/gateway/usage?days=1', headers: admin })).json() as { rows: UsageRow[]; since: string };
  const served = report.rows.find(row => row.model === 'codex/shared-model')!;
  expect(served).toMatchObject({ target: 'key', keyId: key.id, keyName: 'Cursor', requests: 2, failed: 0, inputTokens: 14, outputTokens: 6 });
  expect(report.rows.find(row => row.requests === 1 && row.failed === 1)).toBeTruthy();
  expect(report.rows.every(row => row.model !== '' && !JSON.stringify(row).includes('not-for-logs'))).toBe(true);
  // Token counting is a preflight, not a generation.
  expect(report.rows.reduce((sum, row) => sum + row.requests, 0)).toBe(3);
  expect(report.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect((await service.app.inject({ url: '/api/gateway/usage', headers })).statusCode).toBe(401);
  expect((await service.app.inject({url:'/api/usage/overview',headers})).statusCode).toBe(401);
  expect((await service.app.inject({ url: '/api/gateway/usage?days=-1', headers: admin })).statusCode).toBeGreaterThanOrEqual(400);

  const traces=(await service.app.inject({url:'/api/gateway/traces?days=1',headers:admin})).json().records;
  expect(traces).toHaveLength(3);expect(traces.filter((r:any)=>r.toolResults===1)).toHaveLength(1);
  expect(JSON.stringify(traces)).not.toContain('RESULT_FOR_TRACE');
  const detail=(await service.app.inject({url:`/api/gateway/traces/${traces.find((r:any)=>r.toolResults===1).id}`,headers:admin})).json().record;
  expect(detail.results[0].result).toBe('RESULT_FOR_TRACE');expect(JSON.stringify(detail)).not.toContain('not-for-logs');
  expect((await service.app.inject({url:'/api/gateway/traces',headers})).statusCode).toBe(401);
  expect((await service.app.inject({url:`/api/gateway/traces/${detail.id}`,headers})).statusCode).toBe(401);
  await service.app.close();
  const again = await open(first.dir);
  const restored = (await again.service.app.inject({ url: '/api/gateway/usage?days=0', headers: again.admin })).json() as { rows: UsageRow[] };
  expect(restored.rows.find(row => row.model === 'codex/shared-model')).toMatchObject({ requests: 2, inputTokens: 14, outputTokens: 6,toolResults:1 });
  expect((await again.service.app.inject({url:'/api/gateway/traces?days=0',headers:again.admin})).json().records).toHaveLength(3);
});


it('only associates proven official native usage with an official billing account',async()=>{
 const {service,admin}=await open();
 const {LocalUsageIndex}=await import('../packages/core/src/local-usage-index.js');const {nativeIdentity}=await import('../packages/core/src/local-usage.js');
 const base={day:'2026-10-13',target:'codex',keyId:'native',keyName:'native',sourceId:'',model:'gpt-6.1-sol',requests:1,failed:0,unmeasured:0,inputTokens:100,cachedTokens:60,cacheBaseTokens:100,outputTokens:20,durationMs:0,last:'2026-10-13T08:00:00Z',origin:'native' as const,provider:'codex',nativeAccountId:nativeIdentity('codex','billing-account')};
 const snapshot=vi.spyOn(LocalUsageIndex.prototype,'snapshot').mockReturnValue({rows:[{...base,channel:'official'},{...base,channel:'api'},{...base,channel:'unknown'}],coverage:[],scanning:false});
 const accounts=vi.spyOn(service.proxy,'nativeUsageAccounts').mockResolvedValue([{id:'official-source',provider:'codex',accountId:'billing-account',email:'official@example.test',organizationId:null,label:'Official fixture'}]);
 try{const overview=(await service.app.inject({url:'/api/usage/overview?days=0',headers:admin})).json();expect(accounts).toHaveBeenCalledWith();expect(overview.nativeRows.map((r: {sourceId:string})=>r.sourceId)).toEqual(['official-source','','']);expect(overview.nativeRows.reduce((n:number,r:{inputTokens:number;outputTokens:number})=>n+r.inputTokens+r.outputTokens,0)).toBe(360);}finally{snapshot.mockRestore();accounts.mockRestore();}
});

it('lists and opens native activity through administrator-only endpoints without inventing timing',async()=>{
 const {service,admin}=await open();
 const {LocalUsageIndex}=await import('../packages/core/src/local-usage-index.js');const {LocalUsageParser}=await import('../packages/core/src/local-usage.js');
 const parser=new LocalUsageParser('codex','fixture');parser.accept({type:'session_meta',payload:{model_provider:'openai',auth_mode:'chatgpt'}});parser.accept({type:'turn_context',payload:{model:'gpt-test'}});parser.accept({type:'token_usage_record',timestamp:new Date().toISOString(),payload:{response_id:'private-response',usage:{input_tokens:20,output_tokens:3}}});
 const snapshot=vi.spyOn(LocalUsageIndex.prototype,'snapshot').mockReturnValue({rows:parser.rows(),recent:parser.rows(),coverage:[],scanning:false});
 try{
  expect((await service.app.inject({url:'/api/activity/traces',headers:{host:admin.host}})).statusCode).toBe(401);
  const native=(await service.app.inject({url:'/api/activity/traces?origin=native',headers:admin})).json().records;expect(native).toHaveLength(1);expect(native[0]).toMatchObject({origin:'native',channel:'official',timingKnown:false});
  expect((await service.app.inject({url:'/api/activity/traces?origin=gateway',headers:admin})).json().records).toEqual([]);
  const detail=(await service.app.inject({url:`/api/activity/traces/${native[0].id}`,headers:admin})).json().record;expect(detail).toMatchObject({inputTokens:20,outputTokens:3,statusKnown:false,toolTraceKnown:false});
  expect(JSON.stringify(detail)).not.toContain('private-response');expect((await service.app.inject({url:`/api/activity/traces/${native[0].id}`,headers:{host:admin.host}})).statusCode).toBe(401);
 }finally{snapshot.mockRestore();}
});
