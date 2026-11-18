// What the scripts share: the module folders and how a module is bundled.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

export const root = resolve(import.meta.dirname, '..');

/** Module folders: those with a manifest.json. */
export function modules() {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'manifest.json')))
    .map((e) => join(root, e.name));
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Text as git stores it (LF), which is what the app downloads and hashes. */
export function lf(text) {
  return text.replace(/\r\n/g, '\n');
}

export function sha256(text) {
  return createHash('sha256').update(lf(text), 'utf8').digest('hex');
}

/** Bundle src/index.ts into dist/index.js (the module template's `pnpm build`). */
export async function bundle(dir, write = true) {
  const result = await build({
    // Paths in the bundle's comments are relative to the module, as with its own `pnpm build`.
    absWorkingDir: dir,
    entryPoints: [join(dir, 'src', 'index.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2023',
    external: ['zoo-module'],
    outfile: join(dir, 'dist', 'index.js'),
    write,
    logLevel: 'warning',
  });
  return result.outputFiles?.[0]?.text;
}
