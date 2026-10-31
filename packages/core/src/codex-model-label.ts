/** Picker labels only. Routing and native tool dispatch always use the slug. */
export function codexGatewayLabel(model:{slug:string;display_name?:unknown;tokenflow_source?:unknown}){
 const label=String(model.display_name??model.slug).replace(/^(?:TF|TokenFlow) · /,'');
 const source=typeof model.tokenflow_source==='string'&&model.tokenflow_source?model.tokenflow_source:
  label.includes(' · ')?label.split(' · ')[0]:model.slug.startsWith('api-')?'API 来源（未命名）':model.slug.split('/')[0];
 let name=label;
 for(const prefix of [source+' · ',source+'/'])if(name.startsWith(prefix)){name=name.slice(prefix.length);break;}
 return `${source}/${name}`;
}
