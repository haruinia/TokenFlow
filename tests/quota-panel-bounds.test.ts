import {expect,it} from 'vitest';
import {quotaPanelBounds} from '../apps/desktop/src/quota-panel-bounds.js';
it('anchors below a macOS menu bar, clamped to the display edge',()=>{
 expect(quotaPanelBounds({x:1370,y:0,width:20,height:24},{x:0,y:24,width:1440,height:876})).toEqual({x:1052,y:32,width:380,height:540});
});
it('opens above a bottom taskbar and stays on a negative-coordinate secondary screen',()=>{
 const bounds=quotaPanelBounds({x:-80,y:1040,width:24,height:40},{x:-1920,y:0,width:1920,height:1040});
 expect(bounds).toEqual({x:-388,y:492,width:380,height:540});
});
it('fits a small display and handles an unavailable tray anchor',()=>{
 const bounds=quotaPanelBounds({x:0,y:0,width:0,height:0},{x:500,y:300,width:320,height:480});
 expect(bounds).toEqual({x:508,y:308,width:304,height:464});
});
