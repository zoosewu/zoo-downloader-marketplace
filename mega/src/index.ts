// MEGA (mega.nz). Files are encrypted on MEGA's servers; the key is the part of the link after
// `#`, which never reaches MEGA. The module asks the API for a download URL and hands the key to
// the app (`decrypt`), which decrypts the bytes as they arrive.
//
// API: POST https://g.api.mega.co.nz/cs?id=<n>[&n=<folder>] with a JSON array of commands; the
// answer is an array, a negative number standing for an error (-9 not found, -16 blocked, ...).
//   {a:'g', g:1, ssl:2, p:<file>}       a public file: s (size), at (encrypted attributes), g (URL)
//   {a:'f', c:1, ca:1, r:1} + ?n=<folder> a public folder's nodes: h, p (parent), t (0 file,
//                                         1 folder), a (attributes), k ("<owner>:<key>"), s
//   {a:'g', g:1, ssl:2, n:<node>} + ?n=<folder>  a file inside a public folder
//
// Keys: a file key is 32 bytes = eight 32-bit words k; AES key = k[0..4] ^ k[4..8], CTR counter
// block = k[4], k[5], 0, 0 (MEGA's own `n` nonce, then a 64-bit block counter). Attributes are
// AES-CBC with the AES key and a zero IV: "MEGA" + JSON ({"n": name}) padded with zeros. A
// folder link's key (16 bytes) decrypts, by AES-ECB, the keys of its nodes.
//
// Free transfer quota: when an IP has used it up, the storage server answers 509 with
// X-MEGA-Time-Left (seconds). The module checks with a one-byte request before handing out a
// link and tells the app how long (`retryAfter`); the app waits without a download slot and holds
// the other MEGA downloads. When the quota runs out during a download, the app gets 509 and asks
// the module again: the same answer, and the download resumes where it stopped once it is back.
//
// Links: /file/<h>#<key>, /embed/<h>#<key>, /folder/<h>#<key>, and inside a folder
// /folder/<h>#<key>/file/<node> or /folder/<node>. The old #!<h>!<key> form is not handled: its
// path is the home page's.
//
// Recorded from the live site 2026-11-22: tests/cassettes/*.json (a file, a public folder without
// subfolders and a file in it; the quota wait has not been met live).

import { defineModule, type Listed, type Zoo } from 'zoo-module';
import { decryptCbc, decryptEcb } from './aes';

const API = 'https://g.api.mega.co.nz/cs';
const SITE = 'https://mega.nz';
/** When MEGA does not say how long the quota lasts. */
const DEFAULT_WAIT = 600;
/** The app takes at most this many files from one link. */
const MAX_FILES = 1000;

type Link =
  | { kind: 'file'; handle: string; key: Uint8Array }
  | { kind: 'folder'; handle: string; keyText: string; key: Uint8Array; file?: string; folder?: string };

interface Node {
  h: string;
  p: string;
  t: number;
  a?: string;
  k?: string;
  s?: number;
}

interface Download {
  g: string;
  s: number;
  at: string;
}

// ── encoding ──

function fromB64(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/,/g, '');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** What follows `#`, for the key: "key", "key/file/x", "key/folder/x". */
function linkOf(url: string, zoo: Zoo): Link {
  const parsed = new URL(url);
  const hash = decodeURIComponent(parsed.hash.slice(1));
  const [keyText = '', sub, subHandle] = hash.split('/');
  const path = parsed.pathname.match(/^\/(file|embed|folder)\/([A-Za-z0-9_-]{8})\/?$/);
  const bad = () =>
    zoo.fail('this is not a whole MEGA link', { hint: 'copy the link with its key, like https://mega.nz/file/<id>#<key>' });
  if (!path || !/^[A-Za-z0-9_-]+$/.test(keyText)) throw bad();
  const key = fromB64(keyText);
  if (path[1] !== 'folder') {
    if (key.length !== 32) throw bad();
    return { kind: 'file', handle: path[2], key };
  }
  if (key.length !== 16) throw bad();
  const link: Link = { kind: 'folder', handle: path[2], keyText, key };
  if (sub === 'file' && subHandle) link.file = subHandle;
  if (sub === 'folder' && subHandle) link.folder = subHandle;
  return link;
}

/** A 32-byte file key → AES key and CTR counter block. */
function fileKeys(key: Uint8Array): { aes: Uint8Array; iv: Uint8Array } {
  const aes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) aes[i] = key[i] ^ key[i + 16];
  const iv = new Uint8Array(16);
  iv.set(key.subarray(16, 24));
  return { aes, iv };
}

/** The name in a node's attributes, if they decrypt. */
function nameOf(at: string | undefined, aes: Uint8Array): string | undefined {
  if (!at) return undefined;
  const raw = new TextDecoder().decode(decryptCbc(aes, fromB64(at))).replace(/\0+$/, '');
  if (!raw.startsWith('MEGA{')) return undefined;
  try {
    const name = JSON.parse(raw.slice(4)).n;
    return typeof name === 'string' && name ? name : undefined;
  } catch {
    return undefined;
  }
}

// ── API ──

/** MEGA's request counter. Every call starts fresh, so recordings replay. */
let sequence = 1;

function apiError(code: number, zoo: Zoo): Error {
  switch (code) {
    case -9:
      return zoo.fail('file not found', { hint: 'it was deleted, or the link is wrong; ask the uploader for a new link' });
    case -16:
      return zoo.fail('MEGA has taken this file down', { hint: 'it broke MEGA\'s terms; ask the uploader for another link' });
    case -11:
      return zoo.fail('MEGA does not allow access to this link', { hint: 'the owner may have made it private' });
    case -17:
      return zoo.fail('the MEGA transfer quota is used up', { hint: 'wait a few hours, or use a MEGA account with more quota' });
    case -2:
      return zoo.fail('MEGA did not accept the link', { hint: 'check that the whole link, with its key, was copied' });
    default:
      return zoo.fail(`MEGA answered error ${code}`, { hint: 'try again later' });
  }
}

/** One API command; retries MEGA's "try again" (-3) a few times. */
async function api<T>(command: object, zoo: Zoo, folder?: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const query = new URLSearchParams({ id: String(sequence++) });
    if (folder) query.set('n', folder);
    const response = await fetch(`${API}?${query}`, { method: 'POST', body: JSON.stringify([command]) });
    if (!response.ok) throw zoo.fail(`MEGA answered HTTP ${response.status}`, { hint: 'try again later' });
    const body: unknown = await response.json();
    const reply = Array.isArray(body) ? body[0] : body;
    const code = typeof reply === 'number' ? reply : (reply as { e?: number })?.e;
    if (code === -3 && attempt < 4) {
      await new Promise<void>((ok) => setTimeout(() => ok(), 1000 * attempt));
      continue;
    }
    if (typeof code === 'number' && code < 0) throw apiError(code, zoo);
    return reply as T;
  }
}

// ── folders ──

/** A folder link's nodes, each with its decrypted key (32 bytes for files, 16 for folders). */
async function folderNodes(link: Extract<Link, { kind: 'folder' }>, zoo: Zoo) {
  const { f } = await api<{ f: Node[] }>({ a: 'f', c: 1, ca: 1, r: 1 }, zoo, link.handle);
  return f.map((node) => {
    const keyText = node.k?.split('/')[0].split(':')[1];
    const key = keyText ? decryptEcb(link.key, fromB64(keyText)) : undefined;
    const aes = key && (node.t === 0 ? fileKeys(key).aes : key);
    return { node, key, name: aes ? nameOf(node.a, aes) : undefined };
  });
}

type Entry = Awaited<ReturnType<typeof folderNodes>>[number];

/** Every file under `top` (the whole share by default), with its folder path from there. */
function filesUnder(entries: Entry[], top: string | undefined) {
  const byHandle = new Map(entries.map((e) => [e.node.h, e]));
  const root = top ?? entries.find((e) => e.node.t === 1 && !byHandle.has(e.node.p))?.node.h;
  const files: { entry: Entry; folder: string[] }[] = [];
  for (const entry of entries) {
    if (entry.node.t !== 0) continue;
    // Up to `root`, inclusive: the share's own folder is the top of the downloaded tree.
    const folder: string[] = [];
    let parent = byHandle.get(entry.node.p);
    let inside = false;
    while (parent) {
      folder.unshift(parent.name ?? parent.node.h);
      if (parent.node.h === root) {
        inside = true;
        break;
      }
      parent = byHandle.get(parent.node.p);
    }
    if (inside || root === undefined) files.push({ entry, folder });
  }
  return files;
}

// ── quota ──

const clock = (s: number) =>
  [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n, i) => (i ? String(n).padStart(2, '0') : String(n))).join(':');

/** Seconds of quota wait the storage server announces for `url`, or 0 when it serves now. */
async function quotaWait(url: string, zoo: Zoo): Promise<number> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (response.status !== 509) {
    if (!response.ok) throw zoo.fail(`MEGA's storage server answered HTTP ${response.status}`, { hint: 'try again later' });
    return 0;
  }
  const left = Number(response.headers.get('x-mega-time-left'));
  return Number.isFinite(left) && left > 0 ? Math.ceil(left) : DEFAULT_WAIT;
}


// ── the module ──

export default defineModule({
  async list(url, zoo) {
    const link = linkOf(url, zoo);
    if (link.kind === 'file') {
      // Name and size only: no download link, no quota spent.
      const info = await api<Download>({ a: 'g', p: link.handle }, zoo);
      return [{ url, filename: nameOf(info.at, fileKeys(link.key).aes) ?? link.handle, size: info.s }];
    }
    const files = filesUnder(await folderNodes(link, zoo), link.folder);
    if (files.length > MAX_FILES) {
      throw zoo.fail(`this folder has ${files.length} files; at most ${MAX_FILES} can be added from one link`, {
        hint: 'add its subfolders one at a time',
      });
    }
    // A file opened inside a folder is that file alone.
    const picked = link.file ? files.filter((f) => f.entry.node.h === link.file) : files;
    if (link.file && picked.length === 0) throw zoo.fail('file not found in the folder', { hint: 'it was deleted or moved; open the folder link again' });
    return picked.map(({ entry, folder }): Listed => ({
      url: `${SITE}/folder/${link.handle}#${link.keyText}/file/${entry.node.h}`,
      filename: entry.name ?? entry.node.h,
      size: entry.node.s,
      folder: folder.join('/') || undefined,
    }));
  },

  async resolve(url, zoo) {
    const link = linkOf(url, zoo);
    let key: Uint8Array;
    let ask: object;
    let folder: string | undefined;
    if (link.kind === 'file') {
      key = link.key;
      ask = { a: 'g', g: 1, ssl: 2, p: link.handle };
    } else {
      const files = filesUnder(await folderNodes(link, zoo), link.folder);
      const file = link.file ? files.find((f) => f.entry.node.h === link.file) : files.length === 1 ? files[0] : undefined;
      if (!file) {
        throw link.file
          ? zoo.fail('file not found in the folder', { hint: 'it was deleted or moved; open the folder link again' })
          : zoo.fail('this link is a folder', { hint: 'add it in the add-download window to pick its files' });
      }
      if (!file.entry.key) throw zoo.fail('the folder key does not open this file', { hint: 'copy the whole folder link again' });
      key = file.entry.key;
      ask = { a: 'g', g: 1, ssl: 2, n: file.entry.node.h };
      folder = link.handle;
    }
    const { aes, iv } = fileKeys(key);

    const download = await api<Download>(ask, zoo, folder);
    if (!download.g) throw zoo.fail('MEGA gave no download link', { hint: 'try again later' });
    const wait = await quotaWait(download.g, zoo);
    if (wait > 0) {
      // The app waits without a download slot and holds the other MEGA downloads meanwhile.
      throw zoo.fail(`MEGA's free transfer quota is used up; it is back in ${clock(wait)}`, {
        hint: 'a MEGA account with more transfer quota skips the wait',
        retryAfter: wait,
      });
    }
    return {
      url: download.g,
      filename: nameOf(download.at, aes),
      size: download.s,
      decrypt: { cipher: 'aes-128-ctr', key: hex(aes), iv: hex(iv) },
    };
  },
});
