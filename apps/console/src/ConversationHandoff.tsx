import {useEffect, useState, type KeyboardEvent, type ReactNode} from 'react';
import {handoffAgents, handoffNames, type HandoffAgent, type HandoffConversation, type HandoffResult} from '../../../packages/core/src/conversation-handoff-shared';
import type {Notify} from './notify';
import {ProviderIcon} from './ProviderIcon';
import {requestJSON} from './request';

export type ToolboxTool = 'cleanup' | 'handoff';

function place(path: string) {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

export function ToolboxTools({tool, onTool}: {tool: ToolboxTool; onTool: (tool: ToolboxTool) => void}) {
  const select = (next: ToolboxTool) => onTool(next);
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    select(tool === 'cleanup' ? 'handoff' : 'cleanup');
  };
  return <div className="tfToolboxBar">
    <span>工具箱</span>
    <div className="tfSwitchTabs" role="tablist" aria-label="工具箱">
      <button type="button" role="tab" id="toolbox-tab-cleanup" aria-selected={tool === 'cleanup'} aria-controls="toolbox-panel-cleanup" tabIndex={tool === 'cleanup' ? 0 : -1} onKeyDown={onKey} onClick={() => select('cleanup')}>文件清理</button>
      <button type="button" role="tab" id="toolbox-tab-handoff" aria-selected={tool === 'handoff'} aria-controls="toolbox-panel-handoff" tabIndex={tool === 'handoff' ? 0 : -1} onKeyDown={onKey} onClick={() => select('handoff')}>继续对话</button>
    </div>
  </div>;
}

export function ConversationContinue({notify, tools}: {notify: Notify; tools?: ReactNode}) {
  const [source, setSource] = useState<HandoffAgent>('codex');
  const [target, setTarget] = useState<HandoffAgent>('claude');
  const [conversations, setConversations] = useState<HandoffConversation[]>();
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<HandoffResult>();
  useEffect(() => {
    let live = true;
    setError('');
    setConversations(undefined);
    void requestJSON<{conversations: HandoffConversation[]}>(`/api/a2a/conversations?agent=${source}`).then(result => {
      if (!live) return;
      setConversations(result.conversations);
      setSelected(current => result.conversations.some(item => item.id === current) ? current : result.conversations[0]?.id ?? '');
    }).catch(reason => {if (live) setError(reason instanceof Error ? reason.message : '无法读取对话');});
    return () => {live = false;};
  }, [source]);
  const destinations = handoffAgents.filter(item => item !== source);
  const current = conversations?.find(item => item.id === selected);
  const choose = (agent: HandoffAgent) => {
    setSource(agent);
    setTarget(value => value === agent ? handoffAgents.find(item => item !== agent) ?? 'claude' : value);
    setDone(undefined);
  };
  const moveAgent = (agent: HandoffAgent, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = handoffAgents[(handoffAgents.indexOf(agent) + (event.key === 'ArrowRight' ? 1 : handoffAgents.length - 1)) % handoffAgents.length];
    choose(next);
    queueMicrotask(() => document.getElementById(`continue-agent-${next}`)?.focus());
  };
  const send = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const result = await requestJSON<HandoffResult>('/api/a2a/handoff', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({source, id: selected, target})}, 60000);
      setDone(result);
      const text = `已把「${result.title}」交给 ${handoffNames[result.target]}。工作区仍是 ${result.workspace}。${result.note ? `${result.note}` : ''}请重新打开 ${handoffNames[result.target]}，打开标题以「继续：」开头的对话。`;
      notify({kind: 'ok', text});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '交接没有完成');
    } finally {setBusy(false);}
  };
  return <div className="tfPage tfContinuePage">
    {tools}
    <div className="tfContinuePanel" id="toolbox-panel-handoff" role="tabpanel" aria-labelledby="toolbox-tab-handoff">
    <header className="tfPageHead"><h1>继续对话</h1></header>
    <p className="tfContinueLead">把还没做完的对话交给另一个 Agent，并沿用同一个工作区。目前可以互转的是 Codex、Claude Code、WorkBuddy、WorkBuddyAI、Qoder、Pi 和 DeepSeek Harness。</p>
    <p className="tfHint">项目文件留在原地，原来的对话也不会删除。系统提示和开发者指令不会复制过去。</p>
    <div className="tfProviderTabs tfContinueAgents" role="radiogroup" aria-label="来源 Agent">
      {handoffAgents.map(agent => <button type="button" key={agent} id={`continue-agent-${agent}`} role="radio" aria-checked={source === agent} tabIndex={source === agent ? 0 : -1} onKeyDown={event => moveAgent(agent, event)} onClick={() => choose(agent)}><ProviderIcon provider={agent} size={22}/>{handoffNames[agent]}</button>)}
    </div>
    {!conversations && !error && <p className="tfHint" role="status">正在读取本机对话…</p>}
    {conversations && !conversations.length && <p className="tfHint">没有找到带工作区的对话。</p>}
    {!!conversations?.length && <ul className="tfLines tfContinueList" aria-label={`${handoffNames[source]} 的对话`}>
      {conversations.map(conversation => <li key={conversation.id} className={selected === conversation.id ? 'on' : ''}>
        <button type="button" className="tfLineMain" aria-pressed={selected === conversation.id} onClick={() => {setSelected(conversation.id); setDone(undefined);}}>
          <span className="tfRowText"><strong>{conversation.title}</strong><small>{place(conversation.workspace)} · {conversation.partial ? `${conversation.messages}+` : conversation.messages} 条 · {new Date(conversation.updatedAt).toLocaleString()}</small></span>
        </button>
      </li>)}
    </ul>}
    {current && <p className="tfHint">工作区 {current.workspace}</p>}
    <div className="tfContinueActions">
      <label>交给<select aria-label="目标 Agent" value={target} disabled={busy} onChange={event => {setTarget(event.target.value as HandoffAgent); setDone(undefined);}}>{destinations.map(item => <option key={item} value={item}>{handoffNames[item]}</option>)}</select></label>
      <button type="button" className="primary" disabled={busy || !selected} onClick={() => void send()}>{busy ? '正在交接…' : `交给${handoffNames[target]}`}</button>
    </div>
    {error && <p className="tfError" role="alert">{error}</p>}
    {done && <p className="tfContinueNote" role="status">已把「{done.title}」交给 {handoffNames[done.target]}。工作区仍是 {done.workspace}。{done.note ? `${done.note}` : ''}请重新打开 {handoffNames[done.target]}，打开标题以「继续：」开头的对话。</p>}
    </div>
  </div>;
}
