export type CleanupRisk='rebuildable'|'review'|'protected';
export type CleanupCategory='agent'|'package'|'build'|'application'|'project'|'artifact';
export type CleanupMethod='trash'|'delete';
export type CleanupScanScope='common'|'all';
export type CleanupEntry={
 id:string;name:string;path:string;category:CleanupCategory;risk:CleanupRisk;description:string;impact:string;
 artifact?:{basis:'bundle-metadata'|'content-sha256'|'filename';groupKey?:string;groupName?:string;bundleId?:string;version?:string;build?:string;newerPath?:string;sameVersionPath?:string;duplicateOf?:string};blockedReason?:string;
 bytes:number;files:number;modifiedAt?:string;complete:boolean;issue?:string;state:'ready'|'trashed'|'deleted'|'failed';
};
export type CleanupLocation=Pick<CleanupEntry,'name'|'path'|'category'|'risk'>;
export type CleanupSnapshot={
 scanId?:string;status:'idle'|'scanning'|'complete'|'cancelled'|'cleaning'|'failed';
 startedAt?:string;finishedAt?:string;current?:string;checked:number;planned:number;
 entries:CleanupEntry[];locations:CleanupLocation[];warnings:string[];projectRoots:string[];
 scanScope:CleanupScanScope;diskRoots:string[];walkedDirectories:number;
 platform:string;capabilities:{trash:boolean;delete:boolean;pickDirectory:boolean;reveal:boolean};
 result?:{method:CleanupMethod;moved:number;deleted:number;bytes:number;bytesIncomplete?:boolean;failed:number};
};
export const cleanupPresets=[
 {label:'分析本机缓存占用',prompt:'请先调用 inspect_file_cleanup 查看当前系统、缓存规则和扫描状态；尚未扫描时调用 scan_file_cleanup，再读取结果。按可重建缓存、需要确认、受保护数据分类，列出占用最大的路径、用途、影响与建议，区分文件大小和可实际释放空间。只读分析，不执行删除。'},
 {label:'核对跨平台缓存位置',prompt:'请调用 inspect_file_cleanup，根据本机操作系统、环境覆盖与 scan.locations 说明 npm、pnpm、pip、uv、Gradle、Go、Puppeteer、Playwright 和常见应用缓存的位置，并核对桌面、下载、应用与项目打包目录；比较 Windows、macOS、Linux 的常见默认路径。以扫描返回的实际路径为准，工具配置文件或命令行覆盖可能未被自动识别，可给出官方只读查询命令，但不执行命令。候选路径不代表已存在，未扫描不能编造占用；不要把应用资料、登录、会话或数据库当缓存删除。'},
 {label:'检查包管理器缓存',prompt:'请调用 inspect_file_cleanup 并按需要扫描，分析 npm、pnpm、pip、uv 与 Gradle 缓存。给出适合当前系统的常用只读检查命令，以及需人工确认的官方清理方式。优先用 pnpm store prune 处理未引用包，不整体删除共享存储；只说明方案，不运行清理命令。'},
 {label:'检查旧版本与调试产物',prompt:'请先 inspect_file_cleanup 并按需要扫描，检查旧版本应用、安装包内容重复、测试报告、截图录像与可重建调试缓存。版本较低、名称相似或修改较早都不代表无用；区分应用元数据和内容 SHA-256 证据，标明未完成比较及运行中保护。源码、会话、凭据、工作树和模型权重不要当垃圾。只读分析，由用户在清理页面选择。'},
 {label:'排查闲置项目依赖',prompt:'请读取文件清理扫描结果，分析扫描位置中找到的 node_modules 与 Python 虚拟环境。结合大小和修改时间提出待确认清单，但不能据此断言依赖已无用。说明恢复安装、锁文件和离线影响；可在扫描范围勾选扫描所有磁盘自动查找，或添加具体位置后扫描。只读分析，不删除项目源码或依赖。'},
] as const;
export const cleanupRiskLabels:Record<CleanupRisk,string>={rebuildable:'可重建缓存',review:'需要确认',protected:'受保护数据'};
export const cleanupCategoryLabels:Record<CleanupCategory,string>={agent:'AI Agent',package:'包管理器',build:'构建与下载',application:'应用缓存',project:'项目依赖',artifact:'应用与安装包'};
export function cleanupBytes(bytes:number){
 if(bytes<1024)return `${bytes} B`;
 const units=['KB','MB','GB','TB'];let value=bytes/1024,index=0;
 while(value>=1024&&index<units.length-1){value/=1024;index++;}
 return `${value>=100?value.toFixed(0):value.toFixed(1)} ${units[index]}`;
}
