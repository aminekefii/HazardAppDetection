/* run.js — runs every *.test.js beside it, each in its own process so that one
 * test file's global browser stubs cannot leak into the next. */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.test.js')).sort();

let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(failed ? `\n${failed} of ${files.length} test file(s) FAILED` : `\nall ${files.length} test file(s) passed`);
process.exit(failed ? 1 : 0);
