import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';

export function officialCatalogOverlay(replacements,dir){
 const patch=(path,change)=>{const source=resolve('upstream/CLIProxyAPI',path);const target=join(dir,'catalog-'+basename(path));const original=readFileSync(replacements[source]??source,'utf8').replace(/\r\n/g, '\n');writeFileSync(target,change(original));replacements[source]=target;};
 const replace=(text,from,to)=>{if(text.split(from).length!==2)throw Error('Official model hook changed: '+from.slice(0,90));return text.replace(from,to);};
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/token_flow_trae_native.go')]=resolve('patches/cliproxy/trae_native.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/token_flow_trae_web_search.go')]=resolve('patches/cliproxy/trae_web_search.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/token_flow_trae_web_pages.go')]=resolve('patches/cliproxy/trae_web_pages.go');
 patch('internal/runtime/executor/trae_executor.go',t=>{
  const native='auth != nil && auth.Metadata["access_token"] != nil && (auth.Metadata["base_url"] == nil || auth.Metadata["base_url"] == "") && auth.Attributes["base_url"] == ""';
  const converted='opts.SourceFormat != "" && opts.SourceFormat != sdktranslator.FormatOpenAI';
  t=replace(t,'streamResult, errStream := e.ExecuteStream(ctx, auth, req, opts)',`if ${native} && (${converted}) { return e.tokenFlowTraeAgentResponse(ctx,auth,req,opts) }
 streamResult, errStream := e.ExecuteStream(ctx, auth, req, opts)`);
  t=replace(t,'var apiKey, baseURL string',`if ${native} { if ${converted} { return e.tokenFlowTraeAgentResponseStream(ctx,auth,req,opts) }; return e.tokenFlowTraeNativeStream(ctx,auth,req) }
 var apiKey, baseURL string`);
  t=replace(t,'var lastID, lastModel string','var lastID, lastModel string\n var nativeTools = make(map[int]*traeNativeTool)');
  t=replace(t,'gj := gjson.Parse(data)','gj := gjson.Parse(data)\n accumulateTraeTools([]byte(data),nativeTools)');
  return replace(t,'if reasoningContentBuilder.Len() > 0 {','if calls:=completeTraeTools(nativeTools); len(calls)>0 {msgMap["tool_calls"]=calls; finishReason="tool_calls"}\n if reasoningContentBuilder.Len() > 0 {');
 });
 replacements[resolve('upstream/CLIProxyAPI/internal/runtime/executor/token_flow_xai_catalog.go')]=resolve('patches/cliproxy/xai_catalog.go');
 replacements[resolve('upstream/CLIProxyAPI/sdk/cliproxy/token_flow_zcode_picker.go')]=resolve('patches/cliproxy/zcode_picker.go');
 replacements[resolve('upstream/CLIProxyAPI/sdk/cliproxy/token_flow_official_catalog.go')]=resolve('patches/cliproxy/official_catalog.go');
 patch('sdk/cliproxy/service_executors.go',t=>replace(t,'s.coreManager.RegisterExecutor(executor.NewDoubaoExecutor(cfg))','// Retired: this adapter conflated Doubao with MarsCode/Trae.'));
 patch('sdk/cliproxy/service.go' ,t=>replace(t,'type Service struct {','type Service struct {\n officialCatalogMu sync.Mutex\n officialCatalog map[string]*officialCatalogEntry\n'));
 patch('sdk/cliproxy/service_models.go',t=>{
  for(const [provider,getter] of [['workbuddy','GetWorkBuddyModels'],['qoder','GetQoderModels'],['kimi','GetKimiModels'],['xai','GetXAIModels'],['zcode','GetZCodeModels'],['doubao','GetDoubaoModels'],['trae','GetTraeModels'],['claude','GetClaudeModels'],['antigravity','GetAntigravityModels']])t=replace(t,`models = registry.${getter}()`,`models = s.officialAccountModels(ctx, a, registry.${getter}())`);
  t=replace(t,'models = applyAntigravityFetchedModelCapabilities(models, s.fetchAntigravityModelCapabilityHintsForAuth(ctx, a))','// The official catalog includes both models and web-search capabilities.');
  return replace(t,'models = applyExcludedModels(models, excluded)\n\tcase "kimi":','models = applyExcludedModels(s.officialAccountModels(ctx, a, models), excluded)\n\tcase "kimi":');
 });
 patch('internal/api/server_options.go',t=>replace(t,'type serverOptionConfig struct {','type serverOptionConfig struct {\n modelRefreshHook func(context.Context,string,bool) map[string]any\n')+'\nfunc WithAccountModelRefreshHook(hook func(context.Context,string,bool) map[string]any) ServerOption { return func(cfg *serverOptionConfig) { cfg.modelRefreshHook=hook } }\n');
 patch('internal/api/server.go',t=>replace(t,'s.mgmt.SetConfigReloadHook(optionState.configReloadHook)','s.mgmt.SetConfigReloadHook(optionState.configReloadHook)\n s.mgmt.SetAccountModelRefreshHook(optionState.modelRefreshHook)'));
 patch('internal/api/handlers/management/handler.go',t=>replace(t,'type Handler struct {','type Handler struct {\n modelRefreshHook func(context.Context,string,bool) map[string]any\n')+'\nfunc (h *Handler) SetAccountModelRefreshHook(hook func(context.Context,string,bool) map[string]any) { h.modelRefreshHook=hook }\n');
 patch('internal/api/handlers/management/auth_files.go',t=>replace(replace(t,'result = append(result, entry)','if len(m.SupportedInputModalities)>0 { entry["supportedInputModalities"]=append([]string(nil),m.SupportedInputModalities...) }\n contextLength := m.ContextLength; if contextLength <= 0 { contextLength=m.InputTokenLimit }; if contextLength > 0 { entry["context_length"]=contextLength }\n\t\tresult = append(result, entry)'),'// Get models from registry','// Refresh through the service so aliases, exclusions and the scheduler stay consistent.\n var catalog map[string]any\n if h.modelRefreshHook != nil && c.Query("refresh") != "" { catalog=h.modelRefreshHook(c.Request.Context(),authID,c.Query("refresh")=="true") }\n // Get models from registry').replace('c.JSON(200, gin.H{"models": result})','c.JSON(200, gin.H{"models": result, "catalog": catalog})'));
 patch('sdk/cliproxy/builder.go',t=>replace(t,'api.WithPostAuthPersistHook(service.runtimeAuthSyncHook()),','api.WithPostAuthPersistHook(service.runtimeAuthSyncHook()),\n api.WithAccountModelRefreshHook(service.refreshOfficialAccountCatalog),'));
}
