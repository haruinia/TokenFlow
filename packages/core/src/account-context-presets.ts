import snapshot from './account-context-presets.json';
import {combineModelCapabilities,readModelCapabilities,type ModelCapabilities} from './model-capabilities.js';

/** Capacity hints only, never model discovery or account authorization. Exact
 * source + ID matching keeps e.g. Claude's direct and Antigravity windows separate. */
export function accountContextPreset(provider:string,model:string):ModelCapabilities|undefined{
 const id=model.startsWith(provider+'/')?model.slice(provider.length+1):model;
 const providers=snapshot.providers as Record<string,Record<string,number>>;
 const contextWindow=Object.hasOwn(providers,provider)&&Object.hasOwn(providers[provider],id)?providers[provider][id]:undefined;
 return contextWindow?{contextWindow}:undefined;
}
export function accountModelCapabilities(provider:string,model:{id:string;context_metadata_version?:number},previous?:ModelCapabilities){
 const live=readModelCapabilities(model),preset=accountContextPreset(provider,model.id);
 // Version 2 explicitly distinguishes current capacity from old registry defaults.
 // Older sidecars retain cached fields until their metadata can be refreshed.
 const discovered=model.context_metadata_version===2?live:{...previous,...live};
 return combineModelCapabilities(preset,discovered);
}
