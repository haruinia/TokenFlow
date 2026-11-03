import {expect,it} from 'vitest';
import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {ModelContextSelect} from '../apps/console/src/ModelContextSelect';
it('offers only the advertised windows and preserves a selected 1M window',()=>{
 const html=renderToStaticMarkup(createElement(ModelContextSelect,{modelLabel:'DeepSeek-Flash',capability:{contextWindow:200000,contextWindows:[200000,400000,1000000]},value:1000000,disabled:false,onChange:()=>{}}));
 expect(html).toContain('aria-label="DeepSeek-Flash 上下文"');expect(html).toContain('默认 · 200K');expect(html).toContain('<option value="1000000" selected="">1M</option>');expect(html).not.toContain('128K');
});
it('hides the control without advertised window choices',()=>{
 expect(renderToStaticMarkup(createElement(ModelContextSelect,{modelLabel:'Unknown',capability:{contextWindow:1000000},disabled:false,onChange:()=>{}}))).toBe('');
});
