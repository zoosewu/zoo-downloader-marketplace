// Type-check every module against its types/ (the SDK).
//   node scripts/typecheck.mjs
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { modules } from './modules.mjs';

const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
for (const dir of modules()) {
  if (!existsSync(join(dir, 'tsconfig.json'))) continue;
  const run = spawnSync(process.execPath, [tsc, '-p', dir, '--noEmit', '--pretty', 'false'], { stdio: 'inherit' });
  if (run.status !== 0) process.exitCode = 1;
}
