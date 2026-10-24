import {it,expect} from 'vitest';
import {activityStats} from '../apps/console/src/UsageOverview';
import type {UsageRow} from '../apps/console/src/usage-model';
const row=(day:string,total:number):UsageRow=>({day,target:'codex',keyId:'native',keyName:'native',sourceId:'',model:'test',requests:1,failed:0,unmeasured:0,inputTokens:total,cachedTokens:0,cacheBaseTokens:0,outputTokens:0,durationMs:0,last:`${day}T12:00:00`});
it('aggregates daily activity, detects gaps, and ignores future timestamps',()=>{
 const stats=activityStats([row('2026-10-01',10),row('2026-10-02',20),row('2026-10-02',5),row('2026-10-10',30),row('2026-10-11',40),row('2026-10-12',50),row('2026-10-14',999)],new Date('2026-10-12T12:00:00'));
 expect(stats.days.get('2026-10-02')).toBe(25);expect(stats.peak).toBe(50);expect(stats.activeDays).toBe(5);expect(stats.longest).toBe(3);expect(stats.current).toBe(3);expect(stats.days.has('2026-10-14')).toBe(false);
});
it('keeps yesterday’s streak before today has activity and ends it after an idle day',()=>{
 const rows=[row('2026-10-10',1),row('2026-10-11',1)];expect(activityStats(rows,new Date('2026-10-12T12:00:00')).current).toBe(2);expect(activityStats(rows,new Date('2026-10-13T12:00:00')).current).toBe(0);
});

import {modelManufacturer,usagePopoverPosition} from '../apps/console/src/UsagePanel';
import type {LocalAgentSnapshot} from '../packages/core/src/cliproxy';
it('recognizes GPT manufacturer independent of source namespace',()=>{const local={models:[]} as unknown as LocalAgentSnapshot;for(const id of ['gpt-6-astra','gpt-6.1-sol','api-custom/gpt-6.1-sol','codex/gpt-6-astra'])expect(modelManufacturer(id,local)).toBe('codex');expect(modelManufacturer('workbuddy/DeepSeek-V4-Pro',local)).toBe('deepseek');expect(modelManufacturer('antigravity/gemini-3-flash',local)).toBe('gemini');});
it('reads the catalog display name when a gateway route id hides the manufacturer',()=>{const local={models:[{id:'qoder/gfmodel',displayName:'GLM-5.3-Flash',provider:'qoder'},{id:'qoder/km',displayName:'Kimi-K2.5-Preview',provider:'qoder'},{id:'qoder/mm',displayName:'MiniMax-M3',provider:'qoder'},{id:'qoder/qw',displayName:'Qwen3.7-Max',provider:'qoder'},{id:'xai/grok-4.7',displayName:'Grok-4.7',provider:'xai'}]} as unknown as LocalAgentSnapshot;expect(modelManufacturer('qoder/gfmodel',local)).toBe('zai');expect(modelManufacturer('qoder/km',local)).toBe('kimi');expect(modelManufacturer('qoder/mm',local)).toBe('minimax');expect(modelManufacturer('qoder/qw',local)).toBe('qwen');expect(modelManufacturer('xai/grok-4.7',local)).toBe('xai');expect(modelManufacturer('qoder/performance',local)).toBe('qoder');});
it('anchors the usage popover to the control instead of a fixed viewport offset',()=>{const viewport={width:1200,height:800};expect(usagePopoverPosition({left:40,top:80,bottom:112},viewport)).toMatchObject({top:120,maxHeight:668});const low=usagePopoverPosition({left:40,top:700,bottom:732},viewport);expect(low.top).toBe(332);expect(low.top+low.maxHeight).toBe(692);});

import {connectivityResult} from '../apps/console/src/ApiInflow';
it('keeps connectivity results to a short phrase',()=>{expect(connectivityResult(true,'最小文本调用通过；未验证工具、图片或客户端。')).toMatchObject({phrase:'已连通',hint:'接口可用'});expect(connectivityResult(false,'接口有响应，但未返回完整文本；可能达到输出上限，不能据此判断权限失效。')).toMatchObject({phrase:'有响应'});expect(connectivityResult(false,'最小调用未通过（HTTP 401）；请检查地址、协议、密钥和模型权限。').phrase).toBe('未连通');});
