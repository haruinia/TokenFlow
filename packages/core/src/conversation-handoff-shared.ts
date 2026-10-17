export const handoffAgents = ['codex', 'claude', 'workbuddy', 'workbuddy-ai', 'qoder', 'pi', 'deepseek'] as const;
export type HandoffAgent = typeof handoffAgents[number];
export const handoffNames: Record<HandoffAgent, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  workbuddy: 'WorkBuddy',
  'workbuddy-ai': 'WorkBuddyAI',
  qoder: 'Qoder',
  deepseek: 'DeepSeek Harness',
  pi: 'Pi',
};
export type HandoffConversation = {
  id: string;
  agent: HandoffAgent;
  title: string;
  workspace: string;
  updatedAt: string;
  messages: number;
  partial: boolean;
};
export type HandoffResult = {
  source: HandoffAgent;
  target: HandoffAgent;
  title: string;
  workspace: string;
  messages: number;
  truncated: boolean;
  note?: string;
};
export function isHandoffAgent(value: string): value is HandoffAgent {
  return (handoffAgents as readonly string[]).includes(value);
}
