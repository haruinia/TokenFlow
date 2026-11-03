/** Shorten known upstream wording only; unknown quota names stay intact. */
export function quotaPanelLabel(label:string){
 return label.replace(/^Codex\s*·\s*/,'')
  .replace(/Claude and GPT models/gi,'Claude / GPT')
  .replace(/Gemini Models/gi,'Gemini')
  .replace(/Weekly Limit Remaining/gi,'每周')
  .replace(/Five Hour Limit Remaining/gi,'5 小时');
}
