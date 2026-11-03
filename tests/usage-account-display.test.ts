import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {codexUsageAccountAliases,displayCodexUsageAccount} from '../packages/core/src/usage-account-display.js';
import {nativeIdentity} from '../packages/core/src/local-usage.js';
import {groupUsage,sourceKey,totalsOf,type UsageRow} from '../apps/console/src/usage-model.js';
import {describeSource,SourceUsage} from '../apps/console/src/UsagePanel.js';
import type {LocalAgentSnapshot} from '../packages/core/src/cliproxy.js';

const account={id:'saved-codex',provider:'codex',accountId:'account-A',email:'a@example.test',label:'a@example.test'};
const hash=nativeIdentity('codex','account-A');
const row=(extra:Partial<UsageRow>):UsageRow=>({day:'2026-11-02',target:'codex',keyId:'key',keyName:'Codex',sourceId:'codex-official',model:'gpt-test',requests:1,failed:0,unmeasured:0,inputTokens:100,cachedTokens:80,cacheBaseTokens:100,outputTokens:10,durationMs:10,last:'2026-11-02T00:00:00Z',...extra});
const local={accounts:[account],providers:[{id:'codex',label:'Codex'}],quotas:{},apiSources:[]} as unknown as LocalAgentSnapshot;

it('shows one account across official coexist, account-pool and native rows, with channels in details and unchanged totals',()=>{
 const rows=[row({billingAccountHash:hash,taskKind:'subagent',origin:'gateway'}),row({sourceId:account.id,origin:'gateway'}),row({sourceId:account.id,origin:'native',channel:'official',provider:'codex'})];
 const before=structuredClone(rows),aliases=codexUsageAccountAliases([account],[]),display=rows.map(r=>displayCodexUsageAccount(r,aliases)),groups=groupUsage(display,sourceKey);
 expect(groups).toHaveLength(1);expect(groups[0].key).toBe(account.id);expect(groups[0].totals).toEqual(totalsOf(rows));expect(rows).toEqual(before);
 expect(display[0]).toMatchObject({sourceId:'codex-official',billingAccountHash:hash,taskKind:'subagent'});
 expect(describeSource({...local,accounts:[]},account.id,[display[0]]).label).toBe(account.label);
 const html=renderToStaticMarkup(createElement(SourceUsage,{local,rows:display}));
 expect(html).toContain('<strong title="a@example.test">a@example.test</strong>');expect(html).not.toContain('按请求时的认证账号区分');expect(html).toContain('经 TokenFlow');expect(html).toContain('本机日志');
});

it('does not merge same-email accounts, shared-workspace identities, API sources or historical rows without identity',()=>{
 const other={...account,id:'other',accountId:'account-B'},shared={...account,id:'shared',email:'b@example.test'};
 const aliases=codexUsageAccountAliases([account,other],[]);
 expect(sourceKey(displayCodexUsageAccount(row({billingAccountHash:hash}),aliases))).not.toBe(sourceKey(displayCodexUsageAccount(row({billingAccountHash:nativeIdentity('codex','account-B')}),aliases)));
 expect(displayCodexUsageAccount(row({billingAccountHash:hash}),codexUsageAccountAliases([account,shared],[]))).not.toHaveProperty('usageSourceId');
 for(const r of [row({}),row({sourceId:'api-source',billingAccountHash:hash})])expect(displayCodexUsageAccount(r,aliases)).toEqual(r);
});

it('uses a verified historical account label when the saved source is absent without inventing a source link',()=>{
 const aliases=codexUsageAccountAliases([],[{provider:'codex',account:hash,email:nativeIdentity('email',account.email),label:account.label}]);
 const r=displayCodexUsageAccount(row({billingAccountHash:hash}),aliases);
 expect(r.usageSourceId).toBeUndefined();expect(describeSource(local,sourceKey(r),[r]).label).toBe(account.label);
 expect(codexUsageAccountAliases([account],[{provider:'codex',account:hash,email:nativeIdentity('email','b@example.test'),label:'b@example.test'}]).has(hash)).toBe(false);
});

it('reuses verified credential aliases so an older grant does not split the same account again',()=>{
 const aliases=codexUsageAccountAliases([account],[],[{id:'older-grant',provider:'codex',preferredCredentialId:account.id},{id:'api-source',provider:'api',preferredCredentialId:account.id}]);
 const rows=[row({billingAccountHash:hash}),row({sourceId:account.id}),row({sourceId:'older-grant'})];
 const display=rows.map(r=>displayCodexUsageAccount(r,aliases));
 expect(groupUsage(display,sourceKey)).toHaveLength(1);expect(totalsOf(display)).toEqual(totalsOf(rows));expect(display[2].sourceId).toBe('older-grant');
 expect(displayCodexUsageAccount(row({sourceId:'api-source'}),aliases)).not.toHaveProperty('usageSourceId');
});
