// src/index.ts
import { defineModule } from "zoo-module";

// src/aes.ts
var SBOX = new Uint8Array(256);
var INV_SBOX = new Uint8Array(256);
{
  const rotl = (x, s) => (x << s | x >>> 8 - s) & 255;
  let p = 1;
  let q = 1;
  do {
    p = (p ^ p << 1 & 255 ^ (p & 128 ? 27 : 0)) & 255;
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 255;
    if (q & 128) q ^= 9;
    SBOX[p] = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 99;
  } while (p !== 1);
  SBOX[0] = 99;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
}
function mul(a, b) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = (a << 1 ^ (a & 128 ? 27 : 0)) & 255;
    b >>= 1;
  }
  return r;
}
function expand(key) {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t = w.slice(i - 4, i);
    if (i % 16 === 0) {
      t = Uint8Array.of(SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]);
      rcon = mul(rcon, 2);
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
  }
  return w;
}
function decryptBlock(rounds, block) {
  const s = new Uint8Array(block);
  const addRoundKey = (round) => {
    for (let i = 0; i < 16; i++) s[i] ^= rounds[round * 16 + i];
  };
  const invShiftAndSub = () => {
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[(c + r) % 4 * 4 + r] = INV_SBOX[t[c * 4 + r]];
  };
  addRoundKey(10);
  for (let round = 9; round >= 1; round--) {
    invShiftAndSub();
    addRoundKey(round);
    for (let c = 0; c < 4; c++) {
      const [a, b, d, e] = s.subarray(c * 4, c * 4 + 4);
      s[c * 4] = mul(a, 14) ^ mul(b, 11) ^ mul(d, 13) ^ mul(e, 9);
      s[c * 4 + 1] = mul(a, 9) ^ mul(b, 14) ^ mul(d, 11) ^ mul(e, 13);
      s[c * 4 + 2] = mul(a, 13) ^ mul(b, 9) ^ mul(d, 14) ^ mul(e, 11);
      s[c * 4 + 3] = mul(a, 11) ^ mul(b, 13) ^ mul(d, 9) ^ mul(e, 14);
    }
  }
  invShiftAndSub();
  addRoundKey(0);
  return s;
}
function decryptEcb(key, data) {
  const rounds = expand(key);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) out.set(decryptBlock(rounds, data.subarray(i, i + 16)), i);
  return out;
}
function decryptCbc(key, data) {
  const rounds = expand(key);
  const out = new Uint8Array(data.length);
  let previous = new Uint8Array(16);
  for (let i = 0; i < data.length; i += 16) {
    const block = data.subarray(i, i + 16);
    const plain = decryptBlock(rounds, block);
    for (let j = 0; j < 16; j++) out[i + j] = plain[j] ^ previous[j];
    previous = new Uint8Array(block);
  }
  return out;
}

// src/index.ts
var API = "https://g.api.mega.co.nz/cs";
var SITE = "https://mega.nz";
var WAIT_STEP = 600;
var DEFAULT_WAIT = 600;
var MAX_ROUNDS = 6;
var MAX_FILES = 1e3;
function fromB64(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").replace(/,/g, "");
  const raw = atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
var hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
function linkOf(url, zoo) {
  const parsed = new URL(url);
  const hash = decodeURIComponent(parsed.hash.slice(1));
  const [keyText = "", sub, subHandle] = hash.split("/");
  const path = parsed.pathname.match(/^\/(file|embed|folder)\/([A-Za-z0-9_-]{8})\/?$/);
  const bad = () => zoo.fail("this is not a whole MEGA link", { hint: "copy the link with its key, like https://mega.nz/file/<id>#<key>" });
  if (!path || !/^[A-Za-z0-9_-]+$/.test(keyText)) throw bad();
  const key = fromB64(keyText);
  if (path[1] !== "folder") {
    if (key.length !== 32) throw bad();
    return { kind: "file", handle: path[2], key };
  }
  if (key.length !== 16) throw bad();
  const link = { kind: "folder", handle: path[2], keyText, key };
  if (sub === "file" && subHandle) link.file = subHandle;
  if (sub === "folder" && subHandle) link.folder = subHandle;
  return link;
}
function fileKeys(key) {
  const aes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) aes[i] = key[i] ^ key[i + 16];
  const iv = new Uint8Array(16);
  iv.set(key.subarray(16, 24));
  return { aes, iv };
}
function nameOf(at, aes) {
  if (!at) return void 0;
  const raw = new TextDecoder().decode(decryptCbc(aes, fromB64(at))).replace(/\0+$/, "");
  if (!raw.startsWith("MEGA{")) return void 0;
  try {
    const name = JSON.parse(raw.slice(4)).n;
    return typeof name === "string" && name ? name : void 0;
  } catch {
    return void 0;
  }
}
var sequence = 1;
function apiError(code, zoo) {
  switch (code) {
    case -9:
      return zoo.fail("file not found", { hint: "it was deleted, or the link is wrong; ask the uploader for a new link" });
    case -16:
      return zoo.fail("MEGA has taken this file down", { hint: "it broke MEGA's terms; ask the uploader for another link" });
    case -11:
      return zoo.fail("MEGA does not allow access to this link", { hint: "the owner may have made it private" });
    case -17:
      return zoo.fail("the MEGA transfer quota is used up", { hint: "wait a few hours, or use a MEGA account with more quota" });
    case -2:
      return zoo.fail("MEGA did not accept the link", { hint: "check that the whole link, with its key, was copied" });
    default:
      return zoo.fail(`MEGA answered error ${code}`, { hint: "try again later" });
  }
}
async function api(command, zoo, folder) {
  for (let attempt = 1; ; attempt++) {
    const query = new URLSearchParams({ id: String(sequence++) });
    if (folder) query.set("n", folder);
    const response = await fetch(`${API}?${query}`, { method: "POST", body: JSON.stringify([command]) });
    if (!response.ok) throw zoo.fail(`MEGA answered HTTP ${response.status}`, { hint: "try again later" });
    const body = await response.json();
    const reply = Array.isArray(body) ? body[0] : body;
    const code = typeof reply === "number" ? reply : reply?.e;
    if (code === -3 && attempt < 4) {
      await new Promise((ok) => setTimeout(() => ok(), 1e3 * attempt));
      continue;
    }
    if (typeof code === "number" && code < 0) throw apiError(code, zoo);
    return reply;
  }
}
async function folderNodes(link, zoo) {
  const { f } = await api({ a: "f", c: 1, ca: 1, r: 1 }, zoo, link.handle);
  return f.map((node) => {
    const keyText = node.k?.split("/")[0].split(":")[1];
    const key = keyText ? decryptEcb(link.key, fromB64(keyText)) : void 0;
    const aes = key && (node.t === 0 ? fileKeys(key).aes : key);
    return { node, key, name: aes ? nameOf(node.a, aes) : void 0 };
  });
}
function filesUnder(entries, top) {
  const byHandle = new Map(entries.map((e) => [e.node.h, e]));
  const root = top ?? entries.find((e) => e.node.t === 1 && !byHandle.has(e.node.p))?.node.h;
  const files = [];
  for (const entry of entries) {
    if (entry.node.t !== 0) continue;
    const folder = [];
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
    if (inside || root === void 0) files.push({ entry, folder });
  }
  return files;
}
var clock = (s) => [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map((n, i) => i ? String(n).padStart(2, "0") : String(n)).join(":");
async function quotaWait(url, zoo) {
  const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
  if (response.status !== 509) {
    if (!response.ok) throw zoo.fail(`MEGA's storage server answered HTTP ${response.status}`, { hint: "try again later" });
    return 0;
  }
  const left = Number(response.headers.get("x-mega-time-left"));
  return Number.isFinite(left) && left > 0 ? Math.ceil(left) : DEFAULT_WAIT;
}
async function waitOut(seconds, zoo) {
  for (let left = seconds; left > 0; left -= WAIT_STEP) {
    await zoo.wait(Math.min(left, WAIT_STEP), `MEGA's free transfer quota is used up: ${clock(left)} until it is back`);
  }
}
var index_default = defineModule({
  async list(url, zoo) {
    const link = linkOf(url, zoo);
    if (link.kind === "file") {
      const info = await api({ a: "g", p: link.handle }, zoo);
      return [{ url, filename: nameOf(info.at, fileKeys(link.key).aes) ?? link.handle, size: info.s }];
    }
    const files = filesUnder(await folderNodes(link, zoo), link.folder);
    if (files.length > MAX_FILES) {
      throw zoo.fail(`this folder has ${files.length} files; at most ${MAX_FILES} can be added from one link`, {
        hint: "add its subfolders one at a time"
      });
    }
    const picked = link.file ? files.filter((f) => f.entry.node.h === link.file) : files;
    if (link.file && picked.length === 0) throw zoo.fail("file not found in the folder", { hint: "it was deleted or moved; open the folder link again" });
    return picked.map(({ entry, folder }) => ({
      url: `${SITE}/folder/${link.handle}#${link.keyText}/file/${entry.node.h}`,
      filename: entry.name ?? entry.node.h,
      size: entry.node.s,
      folder: folder.join("/") || void 0
    }));
  },
  async resolve(url, zoo) {
    const link = linkOf(url, zoo);
    let key;
    let ask;
    let folder;
    if (link.kind === "file") {
      key = link.key;
      ask = { a: "g", g: 1, ssl: 2, p: link.handle };
    } else {
      const files = filesUnder(await folderNodes(link, zoo), link.folder);
      const file = link.file ? files.find((f) => f.entry.node.h === link.file) : files.length === 1 ? files[0] : void 0;
      if (!file) {
        throw link.file ? zoo.fail("file not found in the folder", { hint: "it was deleted or moved; open the folder link again" }) : zoo.fail("this link is a folder", { hint: "add it in the add-download window to pick its files" });
      }
      if (!file.entry.key) throw zoo.fail("the folder key does not open this file", { hint: "copy the whole folder link again" });
      key = file.entry.key;
      ask = { a: "g", g: 1, ssl: 2, n: file.entry.node.h };
      folder = link.handle;
    }
    const { aes, iv } = fileKeys(key);
    for (let round = 1; ; round++) {
      const download = await api(ask, zoo, folder);
      if (!download.g) throw zoo.fail("MEGA gave no download link", { hint: "try again later" });
      const wait = await quotaWait(download.g, zoo);
      if (wait === 0) {
        return {
          url: download.g,
          filename: nameOf(download.at, aes),
          size: download.s,
          decrypt: { cipher: "aes-128-ctr", key: hex(aes), iv: hex(iv) }
        };
      }
      if (round === MAX_ROUNDS) {
        throw zoo.fail(`MEGA's free transfer quota is still used up (${clock(wait)} left)`, { hint: "try again later" });
      }
      await waitOut(wait, zoo);
    }
  }
});
export {
  index_default as default
};
