/** Recognizable native environment snapshots, not arbitrary developer rules.
 * Used only for instructions recovered from an authenticated checkpoint, and
 * only when Codex supplies a fresh environment outside that checkpoint. These
 * snapshots enter the historical summary; they are never silently discarded. */
type Item=Record<string,unknown>;
const text=(item:Item)=>typeof item.content==='string'?item.content:Array.isArray(item.content)?item.content.map(part=>part&&typeof part==='object'&&'text' in part&&typeof part.text==='string'?part.text:'').join('\n'):'';
export function codexEnvironmentSnapshot(item:Item):boolean {
 if(item.role!=='developer')return false;
 const value=text(item).trimStart();
 return value.startsWith('You are Codex, an agent based on ')
  || value.startsWith('You are `/root`, the primary agent in a team of agents')
  || /^<(?:app-context|skills_instructions|model_switch|multi_agent_role|multi_agent_mode|codex_apps_client_time_context|codex_apps_open_page_instructions|codex_apps_page_skill_instructions|collaboration_mode|permissions|tools|recommended_plugins|turn_aborted|image_resize_notice)(?:>|\s)/.test(value);
}
export function codexRebuiltEnvironment(item:Item):boolean {
 if(!codexEnvironmentSnapshot(item))return false;
 const value=text(item).trimStart();
 return value.startsWith('You are Codex, an agent based on ')
  || /^<(?:app-context|skills_instructions)(?:>|\s)/.test(value);
}
