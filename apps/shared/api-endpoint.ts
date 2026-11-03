export type ApiProtocol='responses'|'chat'|'messages';

/** Keep source identities in routing IDs, not in fallback menu labels. */
export function apiModelDisplayName(value:string){
 return value.replace(/^api-[a-f0-9]{24}\//,'');
}

/** A version suffix alone cannot distinguish OpenAI protocols. */
export function protocolFromURL(value:string):ApiProtocol|undefined{
 try{
  const path=new URL(value.trim()).pathname.replace(/\/+$/,'');
  if(/\/chat\/completions$/.test(path))return 'chat';
  if(/\/responses$/.test(path))return 'responses';
  if(/\/(?:messages|anthropic)(?:\/v\d+)?$/.test(path))return 'messages';
 }catch{/* Invalid URLs are reported by the form validator. */}
 return undefined;
}

export function normalizeApiBaseURL(value:string){
 return value.trim().replace(/\/+$/,'').replace(/\/(?:chat\/completions|responses|messages|models)$/,'');
}

export type ApiModelRoute={protocol:ApiProtocol;baseURL:string;checkedAt?:string};

/** Bounded, same-origin candidates; never remove a tenant prefix. */
export function apiBaseCandidates(value:string,anthropicHint=false){
 const base=normalizeApiBaseURL(value),url=new URL(base),path=url.pathname.replace(/\/+$/,'');
 const candidates=[base];
 const unversioned=/\/v\d+$/.test(path)?base.replace(/\/v\d+$/,''):base;
 candidates.push(unversioned===base?`${base}/v1`:unversioned);
 if(anthropicHint&&!/\/anthropic(?:\/v\d+)?$/.test(path))candidates.push(`${unversioned}/anthropic`,`${unversioned}/anthropic/v1`);
 return [...new Set(candidates)];
}
export type RoutedApiSource={id:string;protocol:ApiProtocol;baseURL:string;modelRoutes?:Record<string,ApiModelRoute>};

/** Old sources retain their default route until their models are verified. */
export function apiModelRoute(source:RoutedApiSource,model:string):ApiModelRoute{
 const prefix=`api-${source.id}/`;
 const upstream=model.startsWith(prefix)?model.slice(prefix.length):model;
 const route=source.modelRoutes&&Object.hasOwn(source.modelRoutes,upstream)?source.modelRoutes[upstream]:{protocol:source.protocol,baseURL:source.baseURL};
 return {...route,baseURL:normalizeApiBaseURL(route.baseURL)};
}
