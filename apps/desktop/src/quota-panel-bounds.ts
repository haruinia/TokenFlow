type Rect={x:number;y:number;width:number;height:number};
/** Anchor to the menu bar or taskbar without overflowing a secondary display. */
export function quotaPanelBounds(anchor:Rect,area:Rect):Rect{
 const gap=8,width=Math.min(380,area.width-gap*2),height=Math.min(540,area.height-gap*2);
 const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
 const x=anchor.width?anchor.x+anchor.width/2-width/2:area.x+area.width-width-gap;
 const below=anchor.y+anchor.height+gap;
 const y=below+height<=area.y+area.height-gap?below:anchor.y-height-gap;
 return {x:Math.round(clamp(x,area.x+gap,area.x+area.width-width-gap)),y:Math.round(clamp(y,area.y+gap,area.y+area.height-height-gap)),width,height};
}
