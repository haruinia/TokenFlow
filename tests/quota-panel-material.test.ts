import {expect,it} from 'vitest';
import {quotaPanelMaterialOptions} from '../apps/desktop/src/quota-panel-material';

it('uses native macOS vibrancy with a transparent web surface, retaining an opaque fallback elsewhere',()=>{
 expect(quotaPanelMaterialOptions('darwin')).toMatchObject({transparent:true,backgroundColor:'#00000000',vibrancy:'popover',visualEffectState:'active',hasShadow:true});
 for(const platform of ['win32','linux'] as const){const material=quotaPanelMaterialOptions(platform);expect(material.backgroundColor).toBe('#202123');expect(material.transparent).toBeUndefined();expect(material.vibrancy).toBeUndefined();}
});
