import { rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Fixed project-local generated directories only; never remove source or profiles.
// artifacts/ also contains live reconciliation journals and retained audit evidence.
// It is not a disposable packaging output and is excluded from desktop bundles.
export async function cleanPackage(root = fileURLToPath(new URL('../', import.meta.url))) {
  for (const name of ['release', '.tmp', 'output']) {
    await rm(join(root, name), { recursive: true, force: true });
    console.log(`Cleaned ${name}/`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cleanPackage();
}
