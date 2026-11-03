import {lstat} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import type {CleanupRule} from './file-cleanup-catalog.js';
const exists=async(path:string)=>{try{const stat=await lstat(path);return !stat.isSymbolicLink()&&stat.isFile();}catch{return false;}};
/** Recognized generated subdirectories only. Generic tmp/output/screenshots and versioned source files are not garbage. */
export async function generatedOutputRule(path:string):Promise<CleanupRule|undefined>{
 const name=basename(path),parent=dirname(path);
 const caches:Record<string,string>={'.pytest_cache':'pytest 测试缓存','.mypy_cache':'mypy 类型检查缓存','.ruff_cache':'Ruff 检查缓存','__pycache__':'Python 字节码缓存','.vite':'Vite 开发缓存','.eslintcache':'ESLint 缓存'};
 if(caches[name])return {path,name:`${basename(parent)} · ${caches[name]}`,category:'build',risk:'rebuildable',description:'开发或 AI 调试过程生成的可重建缓存；文件名不能证明由 AI 创建或已经闲置。',impact:'请先停止相关运行、测试与构建任务；下次执行会重新生成缓存。'};
 if(!['playwright-report','test-results','coverage'].includes(name))return;
 const project=await Promise.all(['package.json','pyproject.toml','Cargo.toml'].map(file=>exists(join(parent,file))));
 if(!project.some(Boolean))return;
 let verified=false;
 if(name==='playwright-report')verified=await exists(join(path,'index.html'));
 if(name==='test-results')verified=await exists(join(path,'.last-run.json'));
 if(name==='coverage')verified=(await Promise.all(['lcov.info','coverage-final.json','.coverage'].map(file=>exists(join(path,file))))).some(Boolean);
 if(!verified)return;
 return {path,name:`${basename(parent)} · ${name}`,category:'build',risk:'review',description:'已识别项目标记和测试工具输出标记，可能包含调试截图、录像、trace 或覆盖率报告。尚未判断是否仍需保留作为问题证据。',impact:'清理会移走测试和调试证据，重新运行测试可能生成不同结果；请确认问题已定位或报告已有备份。'};
}
