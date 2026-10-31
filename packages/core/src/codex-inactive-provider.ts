/** Keep API history loadable when its route is inactive, without retaining a key. */
export const codexInactivePath='/codex/inactive/v1';
export const codexInactiveMessage='API 直连当前未启用。请在 TokenFlow 的本地 Agent 中选择 API 后继续此对话。';
export function codexInactiveProvider(name:string){
 return {name,base_url:`http://127.0.0.1:9527${codexInactivePath}`,wire_api:'responses',experimental_bearer_token:'tokenflow-inactive-provider',requires_openai_auth:false,supports_websockets:false,capabilities:{remote_compaction:'unsupported'}};
}
