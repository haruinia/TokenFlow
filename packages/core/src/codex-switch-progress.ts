export type SwitchStep={stage:string;label:string;done?:number;total?:number;startedAt:number};
export type ReportSwitchStep=(stage:string,label:string,done?:number,total?:number)=>void;
export class CodexSwitchProgress {
 current?:SwitchStep;
 readonly report:ReportSwitchStep=(stage,label,done,total)=>{this.current={stage,label,done,total,startedAt:this.current?.startedAt??Date.now()};};
 clear(){this.current=undefined;}
}
