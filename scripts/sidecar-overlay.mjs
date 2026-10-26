import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { nativeImportOverlay } from './native-import-overlay.mjs';
import { workbuddyRegionOverlay } from './workbuddy-region-overlay.mjs';
import { providerLoginOverlay } from './provider-login-overlay.mjs';
import { officialCatalogOverlay } from './official-catalog-overlay.mjs';
import { antigravityClaudeOverlay } from './antigravity-claude-overlay.mjs';
export function sidecarOverlay(test=false){
// Build from maintained patches without rewriting the upstream checkout.
const patchDir=mkdtempSync(join(tmpdir(),'token-flow-sidecar-'));
const source=resolve('upstream/CLIProxyAPI/sdk/api/handlers/handlers.go');
const original=readFileSync(source,'utf8');
const anchor='meta := make(map[string]any)';
if(!original.includes(anchor))throw new Error('Upstream routing hook changed; inspect before building.');
const patched=join(patchDir,'handlers.go');
writeFileSync(patched,original.replace(anchor,anchor+'\n\tif ginCtx != nil {\n\t\tif selected := strings.TrimSpace(ginCtx.GetHeader("X-Token-Flow-Auth")); selected != "" {\n\t\t\tmeta[coreexecutor.PinnedAuthMetadataKey] = selected\n\t\t}\n\t\tif ginCtx.GetHeader("X-Token-Flow-Image-Generation") == "deny" {\n\t\t\tmeta["token_flow_disable_image_generation"] = true\n\t\t}\n\t}'));
const replacements={
 [resolve('upstream/CLIProxyAPI/internal/runtime/executor/agent_responses.go')]:resolve('patches/cliproxy/agent_responses.go'),
 [resolve('upstream/CLIProxyAPI/internal/runtime/executor/workbuddy_executor.go')]:resolve('patches/cliproxy/workbuddy_executor.go'),
 [source]:patched,
 [resolve('upstream/CLIProxyAPI/internal/runtime/executor/qoder_executor.go')]:resolve('patches/cliproxy/qoder_executor.go'),
 [resolve('upstream/CLIProxyAPI/internal/runtime/executor/helps/qoder_protocol.go')]:resolve('patches/cliproxy/qoder_protocol.go'),
};
// Only native Codex/Responses clients can receive auto-injected image tools.
// The gateway additionally disables injection for other configured receivers,
// including clients that also speak Responses. Keep caller-supplied tools intact.
for(const file of ['codex_executor_execute.go','codex_executor_stream.go','codex_websockets_execute.go','codex_websockets_stream.go']){
 const codexSource=resolve('upstream/CLIProxyAPI/internal/runtime/executor',file);
 const codexOriginal=readFileSync(codexSource,'utf8');
 const imageGuard='if e.cfg == nil || e.cfg.DisableImageGeneration == config.DisableImageGenerationOff {';
 if(codexOriginal.split(imageGuard).length!==2)throw new Error('Codex image injection boundary changed: '+file);
 const codexPatched=join(patchDir,file);
 writeFileSync(codexPatched,codexOriginal.replace(imageGuard,'if (responseFormat == sdktranslator.FormatOpenAIResponse || responseFormat == sdktranslator.FormatCodex) && opts.Metadata["token_flow_disable_image_generation"] != true && (e.cfg == nil || e.cfg.DisableImageGeneration == config.DisableImageGenerationOff) {'));
 replacements[codexSource]=codexPatched;
}
// Keep bounded pre-header recovery scoped to Antigravity inference only.
for(const [file,count] of [['antigravity_executor_execute.go',2],['antigravity_executor_stream.go',1]]){
 const agSource=resolve('upstream/CLIProxyAPI/internal/runtime/executor',file);
 const agOriginal=readFileSync(agSource,'utf8');
 if(agOriginal.split('httpClient.Do(httpReq)').length!==count+1)throw new Error('Antigravity request boundary changed: '+file);
 const agPatched=join(patchDir,file);
 writeFileSync(agPatched,agOriginal.replaceAll('httpClient.Do(httpReq)','antigravityDoWithReconnect(ctx, httpClient, httpReq)'));
 replacements[agSource]=agPatched;
}
replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/token_flow_antigravity_reconnect.go')]=resolve('patches/cliproxy/antigravity_reconnect.go');
// Keep the upstream response codec, including its incomplete/usage mapping.
providerLoginOverlay(replacements,patchDir);
workbuddyRegionOverlay(replacements,patchDir);
officialCatalogOverlay(replacements,patchDir);
nativeImportOverlay(replacements,patchDir);
antigravityClaudeOverlay(replacements,patchDir,test);
// An explicit finish reason must terminate even when reasoning used the entire
// budget before any visible text or tool call was emitted.
const responseSource=resolve('upstream/CLIProxyAPI/internal/translator/openai/openai/responses/openai_openai-responses_response.go');
const responseOriginal=readFileSync(responseSource,'utf8');
const emptyOutputGuard='if len(st.MsgItemAdded) == 0 && len(st.FuncItemAdded) == 0 {';
if(!responseOriginal.includes(emptyOutputGuard))throw new Error('Upstream response completion guard changed; inspect before building.');
const responsePatched=join(patchDir,'openai-responses-response.go');
// Reasoning can resume after text or tool deltas. Each segment must have a
// distinct ID so strict Responses clients can reconcile its summary deltas.
const reasoningId='st.ReasoningID = fmt.Sprintf("rs_%s_%d", st.ResponseID, idx)';
if(!responseOriginal.includes(reasoningId))throw new Error('Upstream reasoning ID changed; inspect before building.');
writeFileSync(responsePatched,responseOriginal
 .replace(emptyOutputGuard,'if len(st.MsgItemAdded) == 0 && len(st.FuncItemAdded) == 0 && st.FinishReason == "" {')
 .replace(reasoningId,'st.ReasoningID = fmt.Sprintf("rs_%s_%d_%d", st.ResponseID, idx, len(st.Reasonings))'));
replacements[responseSource]=responsePatched;
// Test files in a developer's checkout may already exist. Use the same destination
// names so the overlay replaces them rather than registering duplicate tests.
if(test){
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/token_flow_codex_claude_imagegen_test.go')]=resolve('tests/sidecar/codex_claude_imagegen_test.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/token_flow_trae_web_pages_test.go')]=resolve('tests/sidecar/trae_web_pages_test.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/token_flow_trae_web_search_test.go')]=resolve('tests/sidecar/trae_web_search_test.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/token_flow_trae_live_test.go')]=resolve('tests/sidecar/trae_native_live_test.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/token_flow_trae_native_test.go')]=resolve('tests/sidecar/trae_native_test.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/token_flow_antigravity_reconnect_test.go')]=resolve('tests/sidecar/antigravity_reconnect_test.go');
 // Official Qoder credentials require a real identity; keep the upstream success fixture synthetic.
 const qoderTestSource=resolve('upstream/CLIProxyAPI/internal/runtime/executor/qoder_executor_test.go');
 const qoderTestPatched=join(patchDir,'qoder_executor_test.go');
 const qoderTest=readFileSync(qoderTestSource,'utf8');
 const qoderFixture='"access_token": "test-qoder-token",';
 if(!qoderTest.includes(qoderFixture))throw new Error('Upstream Qoder test identity fixture changed.');
 writeFileSync(qoderTestPatched,qoderTest.replace(qoderFixture,qoderFixture+'\n\t\t\t"uid": "fixture-user",'));
 replacements[qoderTestSource]=qoderTestPatched;

 replacements[resolve('upstream/CLIProxyAPI/internal/api/handlers/management/provider_login_test.go')]=resolve('tests/sidecar/provider_login_test.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/auth/zcode/cli_polling_test.go')]=resolve('tests/sidecar/zcode_cli_polling_test.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/agent_contract_test.go')]=resolve('tests/sidecar/agent_contract_test.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/workbuddy_wire_test.go')]=resolve('tests/sidecar/workbuddy_wire_test.go');
 replacements[resolve('upstream/CLIProxyAPI/sdk/api/handlers/token_flow_pin_test.go')]=resolve('tests/sidecar-pin.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/qoder_claude_test.go')]=resolve('tests/sidecar/qoder_claude_test.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/helps/qoder_protocol_test.go')]=resolve('tests/sidecar/qoder_protocol_test.go');
}
const overlay=join(patchDir,'overlay.json');writeFileSync(overlay,JSON.stringify({Replace:replacements}));
return {overlay,close:()=>rmSync(patchDir,{recursive:true,force:true})};
}
