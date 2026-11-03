import {cleanupCatalog} from './file-cleanup-catalog.js';
import {cleanupCheckTools} from '../../../apps/shared/file-cleanup-tools.js';

/** Reference paths are examples; actual existence and sizes come from the metadata scan. */
export function fileCleanupGuidance(home:string,platform:NodeJS.Platform,profile:string,env?:NodeJS.ProcessEnv){
 return {
  platform,home,scope:'默认检查常见位置及自选扫描位置；scan.scanScope 为 all 时还查找 scan.diskRoots 中所有可访问磁盘内的已知缓存、依赖和打包文件。实际目录见 scan.locations。跳过符号链接与系统运行目录，权限不足或达到上限会记入 warnings，不宣称覆盖所有文件。主要读取元数据；应用仅读取 Info.plist 的标识与版本，符合条件的安装包在大小和总量预算内做内容 SHA-256 比较。不读取凭据、源码或对话正文。',
  locations:cleanupCatalog(home,platform,profile,env).map(({path,name,risk,category})=>({path,name,risk,category})),
  defaults:[
   {tool:'npm',windows:'%LOCALAPPDATA%\\npm-cache',macOS:'~/.npm',linux:'~/.npm',override:'npm config get cache；npm_config_cache / NPM_CONFIG_CACHE'},
   {tool:'pnpm',windows:'%LOCALAPPDATA%\\pnpm\\store',macOS:'~/Library/pnpm/store',linux:'~/.local/share/pnpm/store',override:'优先 PNPM_HOME/store，其次 XDG_DATA_HOME/pnpm/store，再用系统默认位置；同时检查旧版 ~/.pnpm-store。磁盘或项目配置可另行覆盖，以 pnpm store path 为准'},
   {tool:'pip',windows:'%LOCALAPPDATA%\\pip\\Cache',macOS:'~/Library/Caches/pip',linux:'$XDG_CACHE_HOME/pip 或 ~/.cache/pip',override:'pip cache dir；PIP_CACHE_DIR'},
   {tool:'uv',windows:'%LOCALAPPDATA%\\uv\\cache',macOS:'$XDG_CACHE_HOME/uv 或 ~/.cache/uv',linux:'$XDG_CACHE_HOME/uv 或 ~/.cache/uv',override:'uv cache dir；UV_CACHE_DIR'},
   {tool:'Gradle',windows:'%USERPROFILE%\\.gradle\\caches',macOS:'~/.gradle/caches',linux:'~/.gradle/caches',override:'GRADLE_USER_HOME'},
   {tool:'Go 构建缓存',windows:'%LOCALAPPDATA%\\go-build',macOS:'~/Library/Caches/go-build',linux:'$XDG_CACHE_HOME/go-build 或 ~/.cache/go-build',override:'GOCACHE；off 不扫描。go env GOCACHE GOMODCACHE 核对配置文件覆盖；不自动扫描共享模块存储'},
   {tool:'Homebrew',windows:'不适用',macOS:'~/Library/Caches/Homebrew',linux:'本版本未自动扫描',override:'macOS 支持 HOMEBREW_CACHE；brew --cache 可核对实际位置'},
   {tool:'Puppeteer',windows:'%USERPROFILE%\\.cache\\puppeteer',macOS:'~/.cache/puppeteer',linux:'~/.cache/puppeteer',override:'PUPPETEER_CACHE_DIR 或项目配置；puppeteer-core 不管理同样的下载缓存'},
   {tool:'Playwright',windows:'%LOCALAPPDATA%\\ms-playwright',macOS:'~/Library/Caches/ms-playwright',linux:'$XDG_CACHE_HOME/ms-playwright 或 ~/.cache/ms-playwright',override:'PLAYWRIGHT_BROWSERS_PATH；0 表示项目内安装，不当作全局路径'},
   {tool:'Electron 应用缓存',windows:'%APPDATA%\\应用名\\Cache、Code Cache、GPUCache',macOS:'~/Library/Application Support/应用名/Cache、Code Cache、GPUCache',linux:'$XDG_CONFIG_HOME/应用名 或 ~/.config/应用名 下的缓存子目录',override:'候选目录，实际位置由应用决定；User、登录资料和应用根目录属于高风险资料，应在受保护数据确认页核对影响'},
   {tool:'Chromium 默认用户缓存',windows:'%LOCALAPPDATA%\\Chromium\\User Data\\Default\\Cache、Code Cache、GPUCache',macOS:'~/Library/Caches/Chromium/Default/Cache、Code Cache、GPUCache',linux:'$XDG_CACHE_HOME/chromium/Default 或 ~/.cache/chromium/Default 下的缓存子目录',override:'Linux 支持 XDG_CONFIG_HOME、XDG_CACHE_HOME、CHROME_CONFIG_HOME 的缓存目录映射；仅检查 Default。命令行自定义资料路径与其他用户配置需另行核对，不扫描历史、Cookie 或整个资料目录'},
  ],
  tools:cleanupCheckTools,
  artifactEvidence:{version:'bundle-metadata 来自应用 Info.plist；filename 仅为名称线索。发现更高版本不等于旧版本无用。',duplicates:'content-sha256 仅表示本次扫描的安装包内容相同，不证明需要删除哪一份；应用包没有做全内容相等证明。',bounds:'默认每个安装包最多比较 64 MiB，总比较预算 256 MiB；超限或未完整比较会提示。',generated:'检查明确的 Python/开发工具缓存，以及具有项目和工具标记的测试报告、截图录像产物。不凭通用 tmp、screenshots、output 名称认定垃圾。',running:'检查可读取的运行进程执行路径并禁用已知正在使用的项；权限、AppImage 挂载或解释器启动方式可能使检测不完整，仍须退出相关任务。'},
  guardrails:['默认路径不等于已存在或已扫描，不按示例估算磁盘占用。','环境覆盖只识别当前 TokenFlow 进程可见的绝对路径；空值、相对路径或磁盘根目录不作为覆盖。不会读取工具的凭据配置或执行清理命令；应用版本解码和运行进程路径查询仅用于识别与执行保护。缓存覆盖路径应以官方只读查询核对。','先 inspect_file_cleanup；需要新结果时 scan_file_cleanup，然后 inspect_file_cleanup 读取进度与结果；扫描异步且有边界。','受保护数据属于高风险项，用户可在清理确认页核对风险后决定；维修工具不得代为确认或删除。不能以最近修改时间断言依赖已闲置。','删除只允许用户在文件清理页中勾选并确认，维修工具不提供删除、任意路径或 shell 执行。','Windows 使用回收站；macOS 使用废纸篓；Linux 使用桌面环境提供的 Trash，精简系统或某些挂载卷可能不支持。回收失败只报告失败，不自动改为永久删除；永久删除需另行人工确认且不能从回收站恢复。','文件逻辑大小、移入回收站的大小与实际磁盘释放量不同；永久删除失败可能已处理部分文件，必须重新扫描。'],
  sources:[{name:'npm 缓存配置',url:'https://docs.npmjs.com/cli/v11/using-npm/config/#cache'},{name:'pnpm 共享存储',url:'https://pnpm.io/settings#storedir'},{name:'pip 缓存',url:'https://pip.pypa.io/en/stable/topics/caching/'},{name:'uv 缓存',url:'https://docs.astral.sh/uv/concepts/cache/'},{name:'Go 构建缓存',url:'https://go.dev/src/cmd/go/internal/cache/default.go'},{name:'Chromium 用户与缓存目录',url:'https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md'},{name:'Electron 系统目录',url:'https://www.electronjs.org/docs/latest/api/app#appgetpathname'},{name:'Puppeteer 配置',url:'https://pptr.dev/guides/configuration'},{name:'Playwright 浏览器',url:'https://playwright.dev/docs/browsers#managing-browser-binaries'}],
 };
}
