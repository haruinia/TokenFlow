import type {DirectApiSelection} from './api-direct-config.js';
import {claudeApiBaseURL} from './claude-api-direct.js';
import {claudeDesktopModel,claudeDesktopModelLimit} from '../../../apps/shared/claude-desktop-models.js';
import {nativeConflict} from './native-accounts.js';

/** Desktop's own third-party profile consumes Messages, not a TokenFlow alias.
 * Never rename a non-Claude route: no relay exists to translate it in direct mode. */
export function claudeDesktopApiProfile(selection:DirectApiSelection){
 const models=selection.models?.map(m=>m.id)??[selection.model];
 if(!models.length||models.length>claudeDesktopModelLimit||!models.includes(selection.model)||new Set(models).size!==models.length||models.some(m=>!claudeDesktopModel(m)))throw nativeConflict('Claude Desktop 直连需要已保存的 Claude 模型；其他模型请使用网关。');
 const url=new URL(selection.baseURL);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw nativeConflict('API 地址格式不支持 Claude Desktop 直连。');
 const families=new Set<string>();
 const ordered=[selection.model,...models.filter(m=>m!==selection.model)];
 return {inferenceGatewayApiKey:selection.apiKey,inferenceGatewayAuthScheme:'x-api-key',inferenceGatewayBaseUrl:claudeApiBaseURL(selection.baseURL),inferenceProvider:'gateway',
  inferenceModels:ordered.map(name=>{const family=name.match(/(?:^|[-/])(sonnet|opus|haiku|fable)(?:-|$)/i)?.[1]?.toLowerCase();const first=family&&!families.has(family);if(family)families.add(family);return {name,...(first?{anthropicFamilyTier:family,isFamilyDefault:true}:{})};}),
  coworkEgressAllowedHosts:['*'],disableDeploymentModeChooser:true};
}
