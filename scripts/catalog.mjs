// Fill zoo-marketplace.json from the modules: version and apiVersion from each manifest.json,
// sha256 of its entry (what the app checks after downloading). Descriptions and the order are
// kept as written; a module missing from the catalog is added at the end.
//   node scripts/catalog.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { modules, readJson, root, sha256 } from './modules.mjs';

const file = join(root, 'zoo-marketplace.json');
const catalog = readJson(file);
const listed = new Map(catalog.modules.map((m) => [m.id, m]));

const entries = modules().map((dir) => {
  const manifest = readJson(join(dir, 'manifest.json'));
  const entry = readFileSync(join(dir, manifest.entry ?? 'dist/index.js'), 'utf8');
  const old = listed.get(manifest.id) ?? {};
  return {
    id: manifest.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    source: basename(dir),
    description: old.description ?? manifest.name,
    sha256: sha256(entry),
  };
});
const order = (m) => {
  const at = catalog.modules.findIndex((o) => o.id === m.id);
  return at < 0 ? Infinity : at;
};
const next = { ...catalog, modules: entries.sort((a, b) => order(a) - order(b)) };
const text = `${JSON.stringify(next, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== text) {
    console.error('zoo-marketplace.json is out of date: run pnpm catalog');
    process.exitCode = 1;
  }
} else {
  writeFileSync(file, text);
  console.log(`wrote ${file}`);
}
