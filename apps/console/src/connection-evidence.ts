import type { AgentConnections } from '../../../packages/core/src/agent-connections';
import type { GatewayCall } from '../../../packages/core/src/gateway-activity';
import { isSourceSelectionAvailable, sourceSelectionState, sourceSelectionNotice, type AvailableSourceModels } from './source-options';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';

export type AgentTarget = Awaited<ReturnType<AgentConnections['status']>>[number]&{codexBridge?:{supported:boolean;connected:boolean;nativeAgentsSupported?:boolean;nativeAgentsConnected?:boolean;compatibilityEngineActive?:boolean;gatewayWorkersSupported?:boolean;gatewayWorkersConnected?:boolean;stage?:string;launchRequired:boolean};threadMigration?:import('../../../packages/core/src/codex-thread-migration').MigrationStatus};

export function connectionEvidence(target: AgentTarget, calls: GatewayCall[], sources: AvailableSourceModels,local?:LocalAgentSnapshot) {
  if (target.error) return {tone:'attention',label:'配置检查失败',detail:target.error};
  if (!target.connection) return {
    tone:'neutral',label:'未配置 · 安装未验证',
    detail:target.pids.length?'已发现运行进程，尚未验证版本和安装方式。':target.exists?'已发现配置文件，尚未验证客户端安装。':'可生成配置，尚未验证客户端安装。',
  };
  const selections=target.connection.selections??[target.connection];
  const unavailable=local?selections.some(item=>sourceSelectionState(local,item,sources)==='unavailable'):!selections.every(item=>isSourceSelectionAvailable(sources,item));
  if (unavailable) return {
    tone:'attention',label:'来源或模型不可用',
    detail:'此接入的来源或模型已不可用，请重新选择。原配置和备份已保留。',
  };
  if (target.connection.state === 'prepared' || target.configurationState !== 'configured') return {
    tone:'attention',label:'需要检查配置',
    detail:target.configurationState === 'missing'?'模型配置缺失，接入记录不代表已生效。':'配置已变化或写入未完成；保留备份，检查后再处理。',
  };
  const pending=local&&sourceSelectionNotice(local,selections,sources);
  if(pending)return {tone:'neutral',label:pending,detail:'原配置与已选模型保持不变。'};
  const call = calls.filter(c => c.keyId === target.connection!.keyId && (target.connection!.selections??[target.connection!]).some(item=>item.model===c.model) && c.startedAt >= target.connection!.createdAt)
    .sort((a,b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (call?.status >= 400) return {tone:'attention',label:`最近网关请求失败 · HTTP ${call.status}`,detail:call.error?.message??`${new Date(call.startedAt).toLocaleString()} · 此连接 Key 的请求结果。`};
  return {
    tone:'neutral',label:'已写入配置 · 待客户端验证',
    detail:call?`${new Date(call.startedAt).toLocaleString()} · 此 Key 网关请求返回 ${call.status}；仍需在客户端确认。`:'配置与备份已核对。请重启或选择模型，再在客户端发送消息确认。',
  };
}
