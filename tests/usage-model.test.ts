import { describe, expect, it } from 'vitest';
import { chartSpan, dailyTokens, durationText, groupUsage, localDay, percentText, sourceKey, spentByPlatform, totalsOf, type UsageRow } from '../apps/console/src/usage-model.js';

const row = (overrides: Partial<UsageRow> = {}): UsageRow => ({
  day: '2026-10-12', target: 'codex', keyId: 'k', keyName: 'A2A · codex', sourceId: 'acct', model: 'codex/gpt-5',
  requests: 1, failed: 0, unmeasured: 0, inputTokens: 0, cachedTokens: 0, cacheBaseTokens: 0, outputTokens: 0, durationMs: 0, last: '2026-10-12T08:00:00.000Z', ...overrides,
});

describe('usage model', () => {
  it('reproduces the official split: total = uncached input + cache reads + output, hit rate from cache reads', () => {
    // The desktop harness reported 14,882 = 13,319 + 1,408 + 155 and a 10% cache hit.
    const totals = totalsOf([row({ inputTokens: 14_727, cachedTokens: 1_408, cacheBaseTokens: 14_727, outputTokens: 155, durationMs: 3000 })]);
    expect(totals).toMatchObject({ totalTokens: 14_882, uncachedTokens: 13_319, cachedTokens: 1_408, outputTokens: 155, avgMs: 3000 });
    expect(percentText(totals.hitRate)).toBe('10%');
  });

  it('only measures the hit rate over calls whose upstream reported cache usage', () => {
    const reported = row({ inputTokens: 1000, cachedTokens: 500, cacheBaseTokens: 1000 });
    const silent = row({ model: 'other', inputTokens: 9000 });
    expect(totalsOf([reported, silent]).hitRate).toBe(0.5);
    expect(totalsOf([silent]).hitRate).toBeNull();
    expect(percentText(null)).toBe('—');
    expect(percentText(0.001)).toBe('<1%');
    expect(percentText(0.996)).toBe('99%');
    expect(percentText(1)).toBe('100%');
  });

  it('groups by biggest consumer and keeps failures, unmetered calls and latest time', () => {
    const groups = groupUsage([
      row({ model: 'a', inputTokens: 10, outputTokens: 1 }),
      row({ model: 'b', inputTokens: 500, outputTokens: 5, failed: 1, requests: 2, last: '2026-10-12T09:00:00.000Z' }),
      row({ model: 'a', day: '2026-10-11', inputTokens: 5, unmeasured: 1 }),
    ], item => item.model);
    expect(groups.map(group => group.key)).toEqual(['b', 'a']);
    expect(groups[0].totals).toMatchObject({ requests: 2, failed: 1, totalTokens: 505, last: '2026-10-12T09:00:00.000Z' });
    expect(groups[1].totals).toMatchObject({ requests: 2, unmeasured: 1, totalTokens: 16 });
  });

  it('fills quiet days so the daily chart keeps its shape', () => {
    const now = new Date(2026, 9, 12, 15);
    const days = dailyTokens([row({ day: '2026-10-12', inputTokens: 10, outputTokens: 2 }), row({ day: '2026-10-10', inputTokens: 4 })], 4, now);
    expect(days).toEqual([{ day: '2026-10-09', tokens: 0 }, { day: '2026-10-10', tokens: 4 }, { day: '2026-10-11', tokens: 0 }, { day: '2026-10-12', tokens: 12 }]);
    expect(localDay(now)).toBe('2026-10-12');
    expect(chartSpan('7d', [], now)).toBe(7);
    expect(chartSpan('all', [row({ day: '2026-10-05' })], now)).toBe(8);
    expect(chartSpan('all', [row({ day: '2025-01-01' })], now)).toBe(60);
    expect(chartSpan('all', [], now)).toBe(7);
  });

  it('names the source of a row by account, API source or provider', () => {
    expect(sourceKey(row({ sourceId: 'acct' }))).toBe('acct');
    expect(sourceKey(row({ sourceId: '', model: 'api-0123456789abcdef01234567/gpt-5' }))).toBe('0123456789abcdef01234567');
    expect(sourceKey(row({ sourceId: '', model: 'claude/sonnet' }))).toBe('provider:claude');
  });

  it('formats durations', () => {
    expect([durationText(null), durationText(420), durationText(2500), durationText(42_000), durationText(180_000)]).toEqual(['—', '420 ms', '2.5 秒', '42 秒', '3 分钟']);
  });
});

it('charges account authorization only for the serving account or a proven official local login',()=>{
 const antigravity={id:'antigravity',accounts:[{id:'ag-1'}]},claude={id:'claude',accounts:[{id:'cl-1'}]};
 const desktopViaGateway=row({target:'claude-desktop',sourceId:'ag-1',model:'antigravity/claude-opus-4-6-thinking',origin:'gateway',channel:'official'});
 expect(spentByPlatform(desktopViaGateway,antigravity)).toBe(true);expect(spentByPlatform(desktopViaGateway,claude)).toBe(false);
 const local=(channel:'official'|'api'|'unknown')=>row({target:'claude-desktop',sourceId:'',model:'claude-sonnet-4-6',origin:'native',provider:'claude',channel});
 expect(spentByPlatform(local('official'),claude)).toBe(true);expect(spentByPlatform(local('unknown'),claude)).toBe(false);expect(spentByPlatform(local('api'),claude)).toBe(false);
 expect(spentByPlatform(row({sourceId:'',model:'claude/claude-sonnet-4-6',origin:'gateway',channel:'official'}),claude)).toBe(true);
 expect(spentByPlatform(row({sourceId:'api-src',model:'api-0123456789abcdef01234567/claude-sonnet',origin:'gateway',channel:'api'}),claude)).toBe(false);
});

it('splits cache writes from uncached input without adding reasoning again, and uses weighted streaming rate',()=>{
 const result=totalsOf([row({inputTokens:35,cachedTokens:20,cacheWriteTokens:5,cacheBaseTokens:35,outputTokens:8,reasoningTokens:3,toolCalls:1,toolResults:1,generationMs:2000,timedOutputTokens:8})]);
 expect(result).toMatchObject({uncachedTokens:10,cachedTokens:20,cacheWriteTokens:5,outputTokens:8,totalTokens:43,reasoningTokens:3,toolCalls:1,toolResults:1,tokensPerSecond:4});
});
