import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CodexRoutingMode} from '../apps/console/src/CodexRoutingMode';
const render=(mode:'official'|'gateway'|'coexist'|'external')=>renderToStaticMarkup(createElement(CodexRoutingMode,{mode,busy:false,canRestore:mode!=='official',canGateway:true,dirty:false,onOfficial:()=>{},onGateway:()=>{}}));
it('distinguishes saved routing from login and running sessions',()=>{
 const direct=render('official');expect(direct).toContain('Codex → OpenAI');expect(direct).toContain('退出 TokenFlow 不影响官方对话');expect(direct).toContain('已打开的会话不会热切换');
 const gateway=render('gateway');expect(gateway).toContain('官方登录保留');expect(gateway).toContain('Codex 请求当前模型生成摘要');
 const legacy=render('coexist');expect(legacy).toContain('聚合共存（旧模式）');expect(legacy).toContain('官方和网关请求都经过 TokenFlow');
 expect(render('external')).not.toContain('退出 TokenFlow 不影响官方对话');
});
it('does not claim hybrid routing is active from configuration alone',()=>{
 const markup=renderToStaticMarkup(createElement(CodexRoutingMode,{mode:'official',hybrid:true,bridge:{supported:true,connected:false},busy:false,canRestore:true,canGateway:true,dirty:false,onOfficial:()=>{},onGateway:()=>{},onHybrid:()=>{}}));
 expect(markup).toContain('官方直连＋网关（实验）');expect(markup).toContain('会话桥未连接');expect(markup).toContain('普通图标启动不保证加载');expect(markup).not.toContain('会话桥已连接');
});
