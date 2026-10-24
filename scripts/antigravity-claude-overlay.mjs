import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';

// Claude behind Antigravity accepts a narrower tool-name alphabet than Gemini.
// Patch only this translator; Gemini's generic util rules remain unchanged.
export function antigravityClaudeOverlay(replacements,patchDir,test=false){
 const directory='upstream/CLIProxyAPI/internal/translator/antigravity/claude';
 const replace=(file,changes)=>{
  const source=resolve(directory,file);let value=readFileSync(source,'utf8');
  for(const [from,to,count=1] of changes){if(value.split(from).length!==count+1)throw new Error('Antigravity Claude name boundary changed: '+file+' '+from);value=value.replaceAll(from,to);}
  const target=join(patchDir,file);writeFileSync(target,value);replacements[source]=target;
 };
 replace('antigravity_claude_request.go',[
  ['util.SanitizedFunctionNameMap(rawJSON)','antigravityFunctionNameMap(modelName, rawJSON)'],
  ['util.MapSanitizedFunctionName(functionNameMap,','mapAntigravityFunctionName(modelName, functionNameMap,',4],
 ]);
 replace('antigravity_claude_response.go',[
  ['util.DisambiguatedToolNameMap(originalRequestRawJSON)','antigravityToolNameMap(gjson.GetBytes(requestRawJSON, "model").String(), originalRequestRawJSON)',2],
  ['messageStartTemplate, _ = sjson.SetBytes(messageStartTemplate, "message.usage.input_tokens", promptTokenCount.Int())', `cachedTokens := gjson.GetBytes(rawJSON, "response.cpaUsageMetadata.cachedContentTokenCount").Int()
			messageStartTemplate, _ = sjson.SetBytes(messageStartTemplate, "message.usage.input_tokens", antigravityClaudeUncachedPromptTokens(promptTokenCount.Int(), cachedTokens))
			if cachedTokens > 0 {
				messageStartTemplate, _ = sjson.SetBytes(messageStartTemplate, "message.usage.cache_read_input_tokens", cachedTokens)
			}`],
  ['params.PromptTokenCount = usageResult.Get("promptTokenCount").Int() - params.CachedTokenCount', 'params.PromptTokenCount = antigravityClaudeUncachedPromptTokens(usageResult.Get("promptTokenCount").Int(), params.CachedTokenCount)'],
  ['params.CandidatesTokenCount = params.TotalTokenCount - params.PromptTokenCount - params.ThoughtsTokenCount', 'params.CandidatesTokenCount = params.TotalTokenCount - params.PromptTokenCount - params.CachedTokenCount - params.ThoughtsTokenCount'],
  ['usageOutputTokens = params.TotalTokenCount - params.PromptTokenCount', 'usageOutputTokens = params.TotalTokenCount - params.PromptTokenCount - params.CachedTokenCount'],
  ['"usage.input_tokens", promptTokens)', '"usage.input_tokens", antigravityClaudeUncachedPromptTokens(promptTokens, cachedTokens))'],
 ]);
 replacements[resolve(directory,'token_flow_tool_names.go')]=resolve('patches/cliproxy/antigravity_claude_tool_names.go');
 replacements[resolve(directory,'token_flow_usage.go')]=resolve('patches/cliproxy/antigravity_claude_usage.go');
 if(test){
  replacements[resolve(directory,'token_flow_tool_names_test.go')]=resolve('tests/sidecar/antigravity_claude_tool_names_test.go');
  replacements[resolve(directory,'token_flow_usage_test.go')]=resolve('tests/sidecar/antigravity_claude_usage_test.go');
 }
}
