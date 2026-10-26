import type {UsageCoverage} from '../../../packages/core/src/local-usage';

export const usageClientNames:Record<string,string>={codex:'Codex',claude:'Claude CLI','claude-desktop':'Claude Desktop',antigravity:'Antigravity',workbuddy:'WorkBuddy','workbuddy-ai':'WorkBuddyAI',qoder:'Qoder','qoder-ide':'Qoder IDE',deepseek:'DeepSeek Harness',pi:'Pi Agent',kimi:'Kimi Code',zcode:'ZCode',trae:'Trae',cursor:'Cursor',xai:'xAI Grok'};
export function coverageText(item:UsageCoverage){
 if(item.status==='unsupported')return '尚未采集';
 if(item.status==='scanning')return '正在读取';
 if(item.status==='unavailable')return item.files?'暂时无法读取':'未找到本机记录';
 return item.skipped?'部分记录已采集':'已接入本机记录';
}
/** Coverage is independent of the counters: missing collectors are never zero usage. */
export function NativeUsageCoverage({coverage,scanning}:{coverage:readonly UsageCoverage[];scanning:boolean}){
 return <details className="tfNativeUsageCoverage"><summary>本机直连采集范围{scanning?' · 正在更新':''}</summary>
  <p className="tfHint">统计受支持客户端的本机记录，Cursor 会结合已授权账号的官方明细核对。未匹配的网页和其他设备账单不累计；无法确认账号的历史用量单独显示。未返回 Token 的请求单独标注；账号、Agent、模型是同一批请求的不同视角，不相加。</p>
  <ul>{coverage.map(item=><li key={item.target}><strong>{item.target==='claude'?'Claude CLI / Desktop':usageClientNames[item.target]??item.target}</strong><span>{coverageText(item)}</span>{item.note&&<small>{item.note}</small>}</li>)}</ul>
 </details>;
}
