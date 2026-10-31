import {rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {cleanupRunningExecutables} from '../../../packages/core/src/file-cleanup-processes.js';
import type {FileCleanupOptions} from '../../../packages/core/src/file-cleanup.js';

type FolderProvider={getPath:(name:'downloads'|'desktop')=>string};
type CleanupShell={trashItem:(path:string)=>Promise<void>;showItemInFolder:(path:string)=>void};

export function desktopCleanupFiles(app:FolderProvider,shell:CleanupShell):Pick<FileCleanupOptions,'userFolders'|'trashItem'|'deleteItem'|'reveal'|'runningExecutables'>{
 // Minimal Linux desktops may not provide either optional Known Folder.
 const folder=(name:'downloads'|'desktop')=>{try{return app.getPath(name)||undefined;}catch{return undefined;}};
 return {
  runningExecutables:()=>cleanupRunningExecutables(),
  userFolders:{downloads:folder('downloads'),desktop:folder('desktop')},
  // Electron requires the native separator, especially for Windows Recycle Bin.
  trashItem:path=>shell.trashItem(resolve(path)),
  deleteItem:path=>rm(resolve(path),{recursive:true,force:false,maxRetries:2,retryDelay:100}),
  reveal:async path=>{shell.showItemInFolder(resolve(path));},
 };
}
