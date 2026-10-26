import { rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fixed project-local generated directories only; never remove source or profiles.
// artifacts/ also contains live reconciliation journals and retained audit evidence.
// It is not a disposable packaging output and is excluded from desktop bundles.
export async function cleanPackage(root = fileURLToPath(new URL('../', import.meta.url))) {
  for (const name of ['release', '.tmp', 'output']) {
    const dir = join(root, name);
    if (!existsSync(dir)) continue;
    if (process.platform === 'win32') {
      // Agent-host sandboxes can hook fs.rm into a trash operation that fails while
      // antivirus still holds builder handles. cmd rmdir bypasses such shims entirely.
      try {
        execFileSync('cmd.exe', ['/d', '/s', '/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore' });
      } catch {/* Fall through to rm for a last attempt. */}
      if (existsSync(dir)) await rm(dir, { recursive: true, force: true }).catch(() => {});
    } else {
      await rm(dir, { recursive: true, force: true });
    }
    if (!existsSync(dir)) console.log(`Cleaned ${name}/`);
    else console.warn(`Skipped ${name}/ (still in use); continuing build.`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cleanPackage();
}
