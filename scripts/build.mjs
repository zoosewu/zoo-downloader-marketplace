// Bundle every module's src/index.ts into its dist/index.js, the file the app runs. The bundles
// are committed; --check only reports the ones that differ from their sources.
//   node scripts/build.mjs [--check]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundle, lf, modules } from './modules.mjs';

const check = process.argv.includes('--check');
for (const dir of modules()) {
  if (!existsSync(join(dir, 'src', 'index.ts'))) continue;
  const dist = join(dir, 'dist', 'index.js');
  if (!check) {
    await bundle(dir);
    console.log(`built ${dist}`);
  } else if (!existsSync(dist) || lf(readFileSync(dist, 'utf8')) !== lf(await bundle(dir, false))) {
    console.error(`${dist} is out of date: run pnpm build`);
    process.exitCode = 1;
  }
}
