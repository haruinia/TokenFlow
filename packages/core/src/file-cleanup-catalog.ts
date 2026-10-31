import type {CleanupCategory,CleanupRisk} from '../../../apps/shared/file-cleanup.js';
import {cleanupPaths} from './file-cleanup-paths.js';

export type CleanupRule={path:string;name:string;category:CleanupCategory;risk:CleanupRisk;description:string;impact:string};
/** Explicit subdirectories only: never classify a whole application profile as a cache. */
export function cleanupCatalog(home:string,platform:NodeJS.Platform,profile:string,env:NodeJS.ProcessEnv=process.env):CleanupRule[]{
 const {path:{join,relative,isAbsolute,sep},value,envPath,local,config,cache:xdgCache,data:xdgData,appData}=cleanupPaths(home,platform,env);
 const rules:CleanupRule[]=[];
 const add=(path:string,name:string,category:CleanupCategory,risk:CleanupRisk,description:string,impact:string)=>rules.push({path,name,category,risk,description,impact});
 const cache=(path:string,name:string,category:CleanupCategory,description:string)=>add(path,name,category,'rebuildable',description,'请先关闭相关应用或安装任务；下次使用会重建或重新下载，离线时可能不可用。');
 const npm=envPath('npm_config_cache')??envPath('NPM_CONFIG_CACHE')??(platform==='win32'?join(local,'npm-cache'):join(home,'.npm'));
 cache(join(npm,'_cacache'),'npm 下载缓存','package','已下载的软件包缓存，不包含项目源码。');
 cache(join(npm,'_npx'),'npx 临时依赖','package','临时执行命令时下载的依赖。');
 cache(join(envPath('GRADLE_USER_HOME')??join(home,'.gradle'),'caches'),'Gradle 构建缓存','build','构建依赖与编译缓存。');
 const runtimes=[{name:'puppeteer',path:envPath('PUPPETEER_CACHE_DIR')??join(home,'.cache','puppeteer')},{name:'ms-playwright',path:value('PLAYWRIGHT_BROWSERS_PATH')==='0'?undefined:envPath('PLAYWRIGHT_BROWSERS_PATH')??(platform==='darwin'?join(home,'Library','Caches','ms-playwright'):platform==='win32'?join(local,'ms-playwright'):join(xdgCache,'ms-playwright'))},{name:'codex-runtimes',path:join(home,'.cache','codex-runtimes')}];
 for(const runtime of runtimes)if(runtime.path)add(runtime.path,`${runtime.name} 运行时`,'agent','review','浏览器或 Agent 下载的运行时文件。','清理后可能需要手动重新安装运行时；请先结束相关 Agent 和浏览器任务。');
 cache(envPath('UV_CACHE_DIR')??(platform==='win32'?join(local,'uv','cache'):join(xdgCache,'uv')),'uv 下载缓存','package','Python 软件包与构建下载缓存。');
 for(const tool of ['electron','electron-builder'])cache(platform==='darwin'?join(home,'Library','Caches',tool):platform==='win32'?join(local,tool,'Cache'):join(xdgCache,tool),`${tool} 构建下载缓存`,'build','桌面应用构建时下载的运行时或打包工具，可被 AI 调试反复使用；不包含项目源码。');
 const pnpmHome=envPath('PNPM_HOME'),xdgDataHome=envPath('XDG_DATA_HOME');
 const stores=[pnpmHome?join(pnpmHome,'store'):xdgDataHome?join(xdgDataHome,'pnpm','store'):platform==='darwin'?join(home,'Library','pnpm','store'):platform==='win32'?join(local,'pnpm','store'):join(xdgData,'pnpm','store')];
 stores.push(join(home,'.pnpm-store'));
 for(const path of stores)add(path,'pnpm 共享存储','package','protected','可能仍被多个项目引用的共享依赖。','优先使用 pnpm store prune 清理未引用包；整体清理可能影响多个项目，请先核对依赖与恢复方式。');
 for(const app of ['Claude','Qoder','Cursor','Code','Notion']){
  for(const folder of ['Cache','Code Cache','GPUCache'])cache(join(appData,app,folder),`${app} · ${folder}`,'application','应用生成的缓存子目录，不包含整个用户资料。');
 }
 // Chromium caches live under profiles, and use different roots on each OS.
 const chromiumData=join(envPath('CHROME_CONFIG_HOME')??config,'chromium');
 const chromiumRelative=relative(config,chromiumData);
 const linuxChromiumCache=!isAbsolute(chromiumRelative)&&chromiumRelative!=='..'&&!chromiumRelative.startsWith(`..${sep}`)?join(xdgCache,chromiumRelative):chromiumData;
 const chromiumCache=platform==='darwin'?join(home,'Library','Caches','Chromium'):platform==='win32'?join(local,'Chromium','User Data'):linuxChromiumCache;
 for(const folder of ['Cache','Code Cache','GPUCache'])cache(join(chromiumCache,'Default',folder),`Chromium · Default · ${folder}`,'application','Chromium 默认用户的缓存子目录，不包含历史、Cookie 或整个用户资料。');
 cache(join(appData,'Qoder','SharedClientCache'),'Qoder 共享客户端缓存','agent','Qoder 客户端生成的共享缓存。');
 add(join(appData,'Claude','vm_bundles'),'Claude 虚拟机镜像','agent','review','Claude 使用的虚拟机运行环境。','请先完全退出 Claude；再次使用相关功能可能需要联网重新下载镜像。');
 for(const app of ['Cursor','Code'])add(join(appData,app,'User'),`${app} 用户配置`,'application','protected','设置、工作区状态和编辑器数据。','清理会丢失配置和工作区状态，请先退出编辑器并备份。');
 for(const [folder,name] of [['sessions','Codex 历史会话'],['archived_sessions','Codex 归档会话']] as const)add(join(envPath('CODEX_HOME')??join(home,'.codex'),folder),name,'agent','protected','用户对话记录，无法通过重新下载恢复。','清理会删除历史对话，无法通过重新下载恢复，请先备份。');
 for(const filename of ['thread_history_1.sqlite','state_5.sqlite'])add(join(envPath('CODEX_HOME')??join(home,'.codex'),filename),'Codex 会话数据库','agent','protected','Codex 用于保存会话索引或历史的数据。','清理会丢失会话索引或历史，请先退出 Codex 并备份。');
 for(const [folder,name] of [['.claude','Claude Code 数据'],['.gemini','Gemini 数据'],['.openclaw','OpenClaw 数据']] as const)add(join(home,folder),name,'agent','protected','可能包含登录、配置、记忆或对话记录。','清理可能丢失登录、配置、记忆和对话；请先退出相关应用并备份。');
 add(join(profile,'codex-thread-backups'),'Codex 会话迁移备份','agent','review','TokenFlow 为旧对话迁移保存的备份。','移走后可能无法撤销旧会话迁移；请先确认不再需要恢复。');
 if(platform==='darwin'){
  cache(envPath('PIP_CACHE_DIR')??join(home,'Library','Caches','pip'),'pip 下载缓存','package','Python 软件包下载缓存。');
  cache(envPath('HOMEBREW_CACHE')??join(home,'Library','Caches','Homebrew'),'Homebrew 下载缓存','package','Homebrew 安装包与下载缓存。');
  cache(join(home,'Library','Arduino15','staging'),'Arduino 临时下载','build','Arduino 下载过程的临时安装文件。');
  add(join(home,'Library','Parallels','Downloads'),'Parallels 安装包','build','review','虚拟机安装过程中下载的文件。','请确认已完成安装且不再需要离线安装包。');
  add(join(home,'Library','Arduino15','packages'),'Arduino 工具链','build','review','已安装的开发板工具链，可能仍在使用。','清理后需要重新安装开发板支持包；无法自动判断是否闲置。');
 }else{
  cache(envPath('PIP_CACHE_DIR')??(platform==='win32'?join(local,'pip','Cache'):join(xdgCache,'pip')),'pip 下载缓存','package','Python 软件包下载缓存。');
 }
 if(value('GOCACHE')!=='off')cache(envPath('GOCACHE')??(platform==='darwin'?join(home,'Library','Caches','go-build'):platform==='win32'?join(local,'go-build'):join(xdgCache,'go-build')),'Go 构建缓存','build','Go 编译产物缓存，不包含共享模块存储；Go 配置文件中的自定义位置需用 go env GOCACHE 核对。');
 return rules;
}
