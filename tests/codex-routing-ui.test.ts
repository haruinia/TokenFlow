import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CodexRoutingMode} from '../apps/console/src/CodexRoutingMode';
const render=(mode:'official'|'gateway'|'coexist'|'external')=>renderToStaticMarkup(createElement(CodexRoutingMode,{mode,busy:false,canRestore:mode!=='official',canGateway:true,dirty:false,onOfficial:()=>{},onGateway:()=>{}}));
it('distinguishes saved routing from login and running sessions',()=>{
 const direct=render('official');expect(direct).toContain('Codex → OpenAI');expect(direct).toContain('退出 TokenFlow 不影响官方对话');expect(direct).toContain('已打开的会话不会热切换');
 const gateway=render('gateway');expect(gateway).toContain('官方登录保留');expect(gateway).toContain('Codex 请求当前模型生成摘要');
 const legacy=render('coexist');expect(legacy).toContain('官方账号＋网关模型（统一网关）');expect(legacy).toContain('官方和网关请求都经过 TokenFlow');
 expect(render('external')).not.toContain('退出 TokenFlow 不影响官方对话');
});
it('does not claim hybrid routing is active from configuration alone',()=>{
 const markup=renderToStaticMarkup(createElement(CodexRoutingMode,{mode:'official',hybrid:true,bridge:{supported:true,connected:false},busy:false,canRestore:true,canGateway:true,dirty:false,onOfficial:()=>{},onGateway:()=>{},onHybrid:()=>{}}));
 expect(markup).toContain('官方直连＋网关（实验）');expect(markup).toContain('会话桥未连接');expect(markup).toContain('普通图标启动不保证加载');expect(markup).not.toContain('会话桥已连接');
});
it('discloses the old runtime until restarted and labels independent gateway tasks accurately',()=>{
 const props={mode:'official' as const,hybrid:true,busy:false,canRestore:true,canGateway:true,dirty:false,onOfficial:()=>{},onGateway:()=>{}};
 const waiting=renderToStaticMarkup(createElement(CodexRoutingMode,{...props,bridge:{supported:true,connected:true,compatibilityEngineActive:true,gatewayWorkersSupported:true}}));
 expect(waiting).toContain('仍在使用旧兼容后台');expect(waiting).toContain('配置修改前自动备份');expect(waiting).not.toContain('网关任务入口已连接');
 const active=renderToStaticMarkup(createElement(CodexRoutingMode,{...props,bridge:{supported:true,connected:true,gatewayWorkersSupported:true,gatewayWorkersConnected:true}}));expect(active).toContain('网关任务入口已连接');expect(active).toContain('旧对话不补写工具');expect(active).not.toContain('复用原生任务管理');
});

it('offers unified routing independently of the optional bridge',()=>{
 const html=renderToStaticMarkup(createElement(CodexRoutingMode,{mode:'official',busy:false,canRestore:false,canGateway:true,dirty:false,onOfficial:()=>{},onGateway:()=>{},onCoexist:()=>{},bridge:{supported:false,connected:false}}));
 expect(html).toContain('<button type="button">官方账号＋网关模型…</button>');
 expect(html).toContain('disabled="">官方直连＋网关（实验）…');
});
