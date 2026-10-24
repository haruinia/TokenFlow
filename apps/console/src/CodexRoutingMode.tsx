import type {CodexRoutingMode as Mode} from '../../../packages/core/src/codex-routing-mode';

const labels:Record<Mode,string>={official:'官方直连',gateway:'网关模型',coexist:'聚合共存（旧模式）',external:'自定义接入',unreadable:'配置无法确认'};
const descriptions:Record<Mode,string>={
 official:'Codex → OpenAI。使用官方原生压缩；退出 TokenFlow 不影响官方对话，用量从本机记录统计。',
 gateway:'Codex → TokenFlow → 网关模型。官方登录保留；Codex 请求当前模型生成摘要，使用时需保持 TokenFlow 运行。',
 coexist:'官方和网关请求都经过 TokenFlow。可切回官方直连，或切为仅使用网关模型。',
 external:'当前配置使用自定义来源，不能据此认定为官方直连。',
 unreadable:'暂时无法判断连接方式，请先检查配置。'
};

export function CodexRoutingMode({mode='unreadable',busy,canRestore,canGateway,dirty,onOfficial,onGateway}:{mode?:Mode;busy:boolean;canRestore:boolean;canGateway:boolean;dirty:boolean;onOfficial:()=>void;onGateway:()=>void}){
 return <section className="tfCodexRouting" aria-label="Codex 连接方式">
  <div className="tfCodexRoutingHead"><strong>连接方式</strong><span>已保存配置：{labels[mode]}</span><div className="tfRow">
   <button type="button" disabled={busy||!canRestore} onClick={onOfficial}>{mode==='official'?'官方直连已配置':'使用官方直连…'}</button>
   <button type="button" disabled={busy||!canGateway||mode==='gateway'&&!dirty} onClick={onGateway}>{mode==='gateway'&&!dirty?'网关模型已配置':dirty?'应用网关模型…':'使用网关模型…'}</button>
  </div></div>
  <p className="tfHint">{descriptions[mode]}</p>
  <p className="tfHint">切换前请结束正在进行的任务。切换会备份并转换所需上下文，重新打开 Codex 后继续原对话；已打开的会话不会热切换。</p>
 </section>;
}
