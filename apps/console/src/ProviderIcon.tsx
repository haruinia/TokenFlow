import { Icon } from './Icons';

const icons:Record<string,string>={
 codex:'codex.ico',claude:'claude.ico',gemini:'gemini.png',antigravity:'antigravity.png',kimi:'kimi.ico',xai:'xai.svg',qoder:'qoder.png',workbuddy:'workbuddy.png',zcode:'zcode.png',zai:'zai.svg',doubao:'doubao.png',trae:'trae.png',cursor:'cursor.png',deepseek:'deepseek.svg',pi:'pi.svg',minimax:'minimax.png',qwen:'qwen.svg',
};

/** Provider marks bundled locally so navigation also works offline. */
export function ProviderIcon({provider,size=22}:{provider:string;size?:number}){
 const file=icons[provider==='workbuddy-ai'||provider==='workbuddy-overseas'?'workbuddy':provider==='qoder-ide'?'qoder':provider==='claude-desktop'||provider==='claude-manual'?'claude':provider==='zcode-bigmodel'?'zcode':provider];
 if(provider==='codex')return <span className="tfProviderIcon tfMonochromeMark" data-provider={provider} aria-hidden="true" style={{width:size,height:size,maskImage:`url(/provider-icons/${file})`,WebkitMaskImage:`url(/provider-icons/${file})`}}/>;
 return file?<img className="tfProviderIcon" src={`/provider-icons/${file}`} width={size} height={size} alt=""/>:provider==='api'?<Icon name="plug" size={size}/>:<span className="tfMark" aria-hidden="true">{provider[0]?.toUpperCase()}</span>;
}
