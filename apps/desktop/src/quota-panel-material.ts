import type {BrowserWindowConstructorOptions} from 'electron';

/** Native desktop blur is macOS-only. Other platforms keep an opaque surface. */
export function quotaPanelMaterialOptions(platform=process.platform):BrowserWindowConstructorOptions{
 return platform==='darwin'?{transparent:true,backgroundColor:'#00000000',vibrancy:'popover',visualEffectState:'active',roundedCorners:true,hasShadow:true}:{backgroundColor:'#202123'};
}
