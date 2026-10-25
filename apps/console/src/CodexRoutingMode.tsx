import type {CodexRoutingMode as Mode} from '../../../packages/core/src/codex-routing-mode';

const labels:Record<Mode,string>={official:'官方直连',gateway:'网关模型',coexist:'聚合共存（旧模式）',external:'自定义接入',unreadable:'配置无法确认'};
const descriptions:Record<Mode,string>={
 official:'Codex → OpenAI。使用官方原生压缩；退出 TokenFlow 不影响官方对话，用量从本机记录统计。',
 gateway:'Codex → TokenFlow → 网关模型。官方登录保留；Codex 请求当前模型生成摘要，使用时需保持 TokenFlow 运行。',
 coexist:'官方和网关请求都经过 TokenFlow。可切回官方直连，或切为仅使用网关模型。',
 external:'当前配置使用自定义来源，不能据此认定为官方直连。',
 unreadable:'暂时无法判断连接方式，请先检查配置。'
};

export function CodexRoutingMode({mode='unreadable',busy,canRestore,canGateway,dirty,onOfficial,onGateway,onHybrid,hybrid=false,configurationMatches=false,bridge}:{mode?:Mode;busy:boolean;canRestore:boolean;canGateway:boolean;dirty:boolean;onOfficial:()=>void;onGateway:()=>void;onHybrid?:()=>void;hybrid?:boolean;configurationMatches?:boolean;bridge?:{supported:boolean;connected:boolean;nativeAgentsSupported?:boolean;nativeAgentsConnected?:boolean;stage?:string}}){
 const hybridSaved=hybrid&&configurationMatches&&!dirty;
 return <section className="tfCodexRouting" aria-label="Codex 连接方式">
  <div className="tfCodexRoutingHead"><strong>连接方式</strong><span>已保存配置：{hybrid?'官方直连＋网关（实验）':labels[mode]}</span><div className="tfRow">
   <button type="button" disabled={busy||!canGateway||!bridge?.supported||hybridSaved} onClick={onHybrid}>{hybridSaved?'官方账号＋网关模型已配置':hybrid&&dirty?'应用混合模式的模型更改…':'官方账号＋网关模型…'}</button>
   <button type="button" disabled={busy||!canRestore} onClick={onOfficial}>{mode==='official'&&!hybrid?'官方直连已配置':'使用官方直连…'}</button>
   <button type="button" disabled={busy||!canGateway||mode==='gateway'&&!dirty} onClick={onGateway}>{mode==='gateway'&&!dirty?'网关模型已配置':dirty?'应用网关模型…':'使用网关模型…'}</button>
  </div></div>
  <p className="tfHint">{hybrid?'官方模型及压缩直连 OpenAI；网关模型通过 TokenFlow。官方登录保留。':descriptions[mode]}</p>
  {hybrid?<p className="tfHint" role="status">{bridge?.connected?(bridge.stage==='summarizing'?'正在生成网关摘要，请稍候…':bridge.stage==='reloading'?'正在重载当前会话…':bridge.stage==='failed'?'上次会话切换未完成，请在 Codex 查看提示后重试。':'会话桥已连接。可在 Codex 模型菜单切换；等待当前回复和工具结束。'):'会话桥未连接。请从本页「重启」入口启动 Codex；普通图标启动不保证加载。'} 返回官方前可能需要网关生成摘要，完成后可退出 TokenFlow。</p>:<p className="tfHint">切换前请结束正在进行的任务。应用连接方式会备份并转换所需上下文，重新打开 Codex 后继续原对话；已打开的会话不会热切换。</p>}
  {hybrid&&bridge?.nativeAgentsSupported&&<p className="tfHint" role="status">{bridge.nativeAgentsConnected?'子代理双入口已加载：官方派发保持原方式，网关派发复用原生任务管理。':'子代理双入口将在从本页重启 Codex 后加载。'} 配置修改前自动备份；官方程序不替换，启动时使用独立兼容引擎。</p>}
 </section>;
}
