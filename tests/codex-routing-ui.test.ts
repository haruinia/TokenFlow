import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CodexRoutingMode} from '../apps/console/src/CodexRoutingMode';
it('shows only the restore action, without routing modes or bridge diagnostics',()=>{
 const html=renderToStaticMarkup(createElement(CodexRoutingMode,{busy:false,canRestore:true,onOfficial:()=>{}}));
 expect(html.match(/<button/g)).toHaveLength(1);expect(html).toContain('使用官方直连');
 for(const text of ['会话桥','网关任务入口','官方直连＋网关','连接方式','原生压缩'])expect(html).not.toContain(text);
});
