import type {CodexRoutingMode as Mode} from '../../../packages/core/src/codex-routing-mode';

const labels:Record<Mode,string>={official:'官方直连',gateway:'网关模型',coexist:'官方账号＋网关模型（统一网关）',external:'自定义接入',unreadable:'配置无法确认'};
const descriptions:Record<Mode,string>={
 official:'Codex → OpenAI。使用官方原生压缩；退出 TokenFlow 不影响官方对话，用量从本机记录统计。',
 gateway:'Codex → TokenFlow → 网关模型。官方登录保留；Codex 请求当前模型生成摘要，使用时需保持 TokenFlow 运行。',
 coexist:'官方和网关请求都经过 TokenFlow。官方登录和原生压缩保留，第三方模型使用摘要兼容；子代理使用原生派发。使用时请保持 TokenFlow 运行。',
 external:'当前配置使用自定义来源，不能据此认定为官方直连。',
 unreadable:'暂时无法判断连接方式，请先检查配置。'
};

export function CodexRoutingMode({mode='unreadable',busy,canRestore,canGateway,dirty,onOfficial,onGateway,onCoexist,onHybrid,hybrid=false,configurationMatches=false,bridge}:{mode?:Mode;busy:boolean;canRestore:boolean;canGateway:boolean;dirty:boolean;onOfficial:()=>void;onGateway:()=>void;onCoexist?:()=>void;onHybrid?:()=>void;hybrid?:boolean;configurationMatches?:boolean;bridge?:{supported:boolean;connected:boolean;nativeAgentsSupported?:boolean;nativeAgentsConnected?:boolean;compatibilityEngineActive?:boolean;gatewayWorkersSupported?:boolean;gatewayWorkersConnected?:boolean;stage?:string}}){
 const hybridSaved=hybrid&&configurationMatches&&!dirty;
 return <section className="tfCodexRouting" aria-label="Codex 连接方式">
  <div className="tfCodexRoutingHead"><strong>连接方式</strong><span>已保存配置：{hybrid?'官方直连＋网关（实验）':labels[mode]}</span><div className="tfRow">
   <button type="button" disabled={busy||!canGateway||!onCoexist||mode==='coexist'&&configurationMatches&&!dirty} onClick={onCoexist}>{mode==='coexist'&&!dirty?'统一网关已配置':'官方账号＋网关模型…'}</button>
   <button type="button" disabled={busy||!canGateway||!bridge?.supported||hybridSaved} onClick={onHybrid}>{hybridSaved?'官方直连＋网关已配置':hybrid&&dirty?'应用直连混合更改…':'官方直连＋网关（实验）…'}</button>
   <button type="button" disabled={busy||!canRestore} onClick={onOfficial}>{mode==='official'&&!hybrid?'官方直连已配置':'使用官方直连…'}</button>
   <button type="button" disabled={busy||!canGateway||mode==='gateway'&&!dirty} onClick={onGateway}>{mode==='gateway'&&!dirty?'网关模型已配置':dirty?'应用网关模型…':'使用网关模型…'}</button>
  </div></div>
  <p className="tfHint">{hybrid?'官方模型及压缩直连 OpenAI；网关模型通过 TokenFlow。官方登录保留。':descriptions[mode]}</p>
  {hybrid?<p className="tfHint" role="status">{bridge?.connected?(bridge.stage==='summarizing'?'正在生成网关摘要，请稍候…':bridge.stage==='reloading'?'正在重载当前会话…':bridge.stage==='failed'?'上次会话切换未完成，请在 Codex 查看提示后重试。':'会话桥已连接。可在 Codex 模型菜单切换；等待当前回复和工具结束。'):'会话桥未连接。请从本页「重启」入口启动 Codex；普通图标启动不保证加载。'} 返回官方前可能需要网关生成摘要，完成后可退出 TokenFlow。</p>:<p className="tfHint">切换前请结束正在进行的任务。应用连接方式会备份并转换所需上下文，重新打开 Codex 后继续原对话；已打开的会话不会热切换。</p>}
  {hybrid&&bridge?.compatibilityEngineActive&&<p className="tfHint" role="status">当前 Codex 仍在使用旧兼容后台。从本页重启后将恢复官方后台；配置修改前自动备份。</p>}
  {hybrid&&bridge?.gatewayWorkersSupported&&<p className="tfHint" role="status">{bridge.gatewayWorkersConnected?'网关任务入口已连接。新建官方对话可派发独立网关工作会话；状态、等待和取消使用专用工具。':'从本页重启 Codex 后，新建官方对话可使用网关任务入口。'} 官方子代理及网关内的原生派发保持原方式。旧对话不补写工具，独立任务不显示为原生子代理。</p>}
 </section>;
}
