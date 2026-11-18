// Every module's types/ is the SDK of one Zoo Downloader commit, named in sdk.json. Moving to a
// newer SDK (a new API level): `node scripts/sdk.mjs <commit or tag>`; then raise the modules'
// apiVersion where they use the new level.
//   node scripts/sdk.mjs            copy the SDK of sdk.json's ref into every module
//   node scripts/sdk.mjs <ref>      the same for <ref>, and remember it in sdk.json
//   node scripts/sdk.mjs --check    fail when a module's types/ differs from it
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { lf, modules, readJson, root } from './modules.mjs';

const FILES = ['zoo-module.d.ts', 'globals.d.ts', 'manifest.schema.json'];
const config = join(root, 'sdk.json');
const args = process.argv.slice(2);
const check = args.includes('--check');
const sdk = readJson(config);
const ref = args.find((a) => !a.startsWith('--')) ?? sdk.ref;

const files = {};
for (const name of FILES) {
  const url = `https://raw.githubusercontent.com/${sdk.repo}/${ref}/${sdk.path}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  files[name] = lf(await response.text());
}

for (const dir of modules()) {
  for (const [name, text] of Object.entries(files)) {
    const target = join(dir, 'types', name);
    if (check) {
      if (!existsSync(target) || lf(readFileSync(target, 'utf8')) !== text) {
        console.error(`${target} is not the SDK of ${sdk.repo}@${ref}: run pnpm sdk`);
        process.exitCode = 1;
      }
    } else {
      mkdirSync(join(dir, 'types'), { recursive: true });
      writeFileSync(target, text);
    }
  }
}
if (!check) {
  writeFileSync(config, `${JSON.stringify({ ...sdk, ref }, null, 2)}\n`);
  console.log(`types/ of every module is the SDK of ${sdk.repo}@${ref}`);
}
