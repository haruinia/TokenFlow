import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayActivity } from '../packages/core/src/gateway-activity.js';
import { UsageLedger, dayOf } from '../packages/core/src/usage-ledger.js';

let root = '';
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'token-flow-ledger-')); });
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

const event = (overrides: Partial<Parameters<UsageLedger['add']>[0]> = {}) => ({
  target: 'codex', keyId: 'k1', keyName: 'A2A · codex', sourceId: 'acct', model: 'codex/gpt-5',
  startedAt: new Date().toISOString(), durationMs: 100, status: 200, inputTokens: 1000, cachedTokens: 400, outputTokens: 50, ...overrides,
});

it('adds up tokens per day, agent, source and model and keeps them across a restart', async () => {
  const ledger = await UsageLedger.open(root, { flushDelay: 10 });
  ledger.add(event()); ledger.add(event({ inputTokens: 500, cachedTokens: 100, outputTokens: 20 }));
  ledger.add(event({ model: 'codex/other' }));
  await ledger.close();
  const reopened = await UsageLedger.open(root);
  const rows = reopened.list();
  expect(rows).toHaveLength(2);
  const main = rows.find(row => row.model === 'codex/gpt-5')!;
  expect(main).toMatchObject({ requests: 2, failed: 0, inputTokens: 1500, cachedTokens: 500, cacheBaseTokens: 1500, outputTokens: 70, durationMs: 200, target: 'codex', sourceId: 'acct' });
  expect(JSON.parse(await readFile(join(root, 'usage-ledger.json'), 'utf8')).rows).toHaveLength(2);
});

it('counts failures and unmetered calls separately, and ignores cache data an upstream never reported', async () => {
  const ledger = await UsageLedger.open(root);
  ledger.add(event({ status: 502, inputTokens: null, cachedTokens: null, outputTokens: null }));
  ledger.add(event({ status: 200, inputTokens: null, cachedTokens: null, outputTokens: null }));
  ledger.add(event({ status: 200, inputTokens: 80, cachedTokens: null, outputTokens: 5 }));
  const [row] = ledger.list();
  expect(row).toMatchObject({ requests: 3, failed: 1, unmeasured: 1, inputTokens: 80, cachedTokens: 0, cacheBaseTokens: 0, outputTokens: 5 });
  // A cache read can never exceed the input it belongs to.
  ledger.add(event({ model: 'x', inputTokens: 10, cachedTokens: 99, outputTokens: 1 }));
  expect(ledger.list().find(item => item.model === 'x')).toMatchObject({ cachedTokens: 10, cacheBaseTokens: 10 });
});

it('limits rows by calendar days and drops what is past retention', async () => {
  const now = new Date(2026, 9, 12, 12).getTime();
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
  const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
  await writeFile(join(root, 'usage-ledger.json'), JSON.stringify({ version: 1, rows: [] }));
  const ledger = await UsageLedger.open(root, { retentionDays: 30 });
  ledger.add(event({ startedAt: at(0), model: 'today' })); ledger.add(event({ startedAt: at(3), model: 'recent' })); ledger.add(event({ startedAt: at(20), model: 'older' }));
  expect(ledger.list(1, now).map(row => row.model)).toEqual(['today']);
  expect(ledger.list(7, now).map(row => row.model).sort()).toEqual(['recent', 'today']);
  expect(ledger.list(0, now)).toHaveLength(3);
  expect(ledger.firstDay()).toBe(dayOf(at(20)));
  await ledger.close();
  const old = await UsageLedger.open(root, { retentionDays: 10 });
  expect(old.list().map(row => row.model).sort()).toEqual(['recent', 'today']);
});

it('keeps an unreadable ledger for inspection instead of overwriting it', async () => {
  await writeFile(join(root, 'usage-ledger.json'), '{broken');
  const ledger = await UsageLedger.open(root);
  expect(ledger.list()).toEqual([]);
  expect(ledger.warning).toContain('usage-ledger.json.unreadable');
  expect(await readFile(join(root, 'usage-ledger.json.unreadable'), 'utf8')).toBe('{broken');
});

it('feeds the ledger from gateway activity without storing prompts and skips token counting', async () => {
  const ledger = await UsageLedger.open(root);
  const activity = new GatewayActivity(ledger);
  const base = { keyId: 'k1', agent: 'A2A · codex', target: 'codex', sourceId: 'acct', model: 'codex/gpt-5', startedAt: new Date().toISOString(), durationMs: 5, status: 200 };
  activity.record({ ...base, protocol: 'responses', inputTokens: 100, cachedTokens: 60, outputTokens: 4 });
  activity.record({ ...base, protocol: 'messages/count_tokens', inputTokens: null, outputTokens: null });
  expect(ledger.list()).toHaveLength(1);
  expect(ledger.list()[0]).toMatchObject({ requests: 1, inputTokens: 100, cachedTokens: 60, outputTokens: 4, keyName: 'A2A · codex' });
  expect(activity.snapshot()).toMatchObject({ total: 2, inputTokens: 100, cachedTokens: 60 });
});
