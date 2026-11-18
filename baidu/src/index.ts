// Baidu Netdisk share links (pan.baidu.com/s/1<surl>?pwd=<code>), through the user's own account.
//
// The web API hands out download links for shared files only in encrypted form, so the file is
// saved into the user's netdisk (FOLDER) and the desktop client's download API gives a plain
// link for it. Recorded from the live site (tests/cassettes/, 2026-11-15 and 2026-11-17; the
// logged-in page and the link reply are trimmed to the fields read here, without account data):
//   - pcs download servers serve only the client's User-Agent, need no cookie, and refuse
//     ranges over about 4 MiB for non-members (403); links expire after 8 hours;
//   - non-members get ~15 KiB/s per connection and are cut off above 4 connections;
//   - a link keeps working after the file is deleted from the netdisk.
// Saved files are left for the download and cleaned up on later calls: anything in FOLDER
// saved more than LINK_LIFETIME ago has no live link any more. A download that outlives its
// link is resolved again by the app, which saves the file again if it is gone.
//
// Shares with several files or folders: `list` returns every file with the share URL plus
// `#path=<path inside the share>`; `resolve` downloads the file that path names.

import { defineModule, type Listed, type Zoo } from 'zoo-module';

const FOLDER = '/zoo-downloader';
const LINK_LIFETIME = 8 * 3600;
const PAN = 'https://pan.baidu.com';
const WEB = 'channel=chunlei&web=1&app_id=250528&clienttype=0';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CLIENT = 'netdisk;7.42.0.5;PC;PC-Windows;10.0.22631;WindowsBaiduYunGuanJia';
/** What share/list returns per page at most. */
const PAGE = 100;
/** The app takes at most this many files from one link. */
const MAX_FILES = 1000;

interface Reply {
  errno: number;
  show_msg?: string;
  [field: string]: unknown;
}

interface Entry {
  path: string;
  server_filename: string;
  size: number;
  isdir: number | string;
  server_mtime: number;
  fs_id: number | string;
  /** Baidu's content id: a saved copy has the same one as the shared file. */
  md5?: string;
}

const isDir = (e: Entry) => Number(e.isdir) === 1;

/** `/s/1<surl>` or `/share/init?surl=<surl>`; the API wants the surl without the leading 1. */
function shareOf(url: string, zoo: Zoo): { surl: string; pwd?: string; path?: string } {
  const u = new URL(url);
  const fromPath = /^\/s\/1([\w-]+)/.exec(u.pathname)?.[1];
  const surl = fromPath ?? u.searchParams.get('surl') ?? undefined;
  if (!surl) throw zoo.fail('this is not a Baidu Netdisk share link', { hint: 'copy the whole link, like https://pan.baidu.com/s/1...?pwd=...' });
  const path = /^#path=(.+)$/.exec(u.hash)?.[1];
  return { surl, pwd: u.searchParams.get('pwd') ?? undefined, path: path === undefined ? undefined : decodeURIComponent(path) };
}

/** The meaning of the errno values seen on these endpoints, with what the user can do. */
function failure(step: string, reply: Reply, zoo: Zoo): Error {
  const said = reply.show_msg ? ` (${reply.show_msg})` : '';
  switch (reply.errno) {
    case -6:
      return zoo.fail('Baidu did not accept the login cookies', { hint: 'copy BDUSS and STOKEN again from pan.baidu.com (Settings > Site modules > 百度网盘)' });
    case -9:
      return step === 'verify'
        ? zoo.fail('wrong extraction code (提取码)', { hint: 'check the ?pwd= part of the link' })
        : zoo.fail('the share needs an extraction code (提取码)', { hint: 'add it to the link: https://pan.baidu.com/s/1...?pwd=code' });
    case -62:
    case -63:
      return zoo.fail('Baidu wants a verification code for this share', { hint: 'open the link in a browser once, then try again' });
    case -10:
    case 12:
      return zoo.fail(`your netdisk has no room to save the file${said}`, { hint: 'free some space in your netdisk (the file is saved there before downloading)' });
    case 105:
    case 115:
    case 145:
      return zoo.fail(`the share is gone or blocked${said}`, { hint: 'ask the sharer for a new link' });
    default:
      return zoo.fail(`Baidu Netdisk ${step} failed: errno ${reply.errno}${said}`);
  }
}

/** A share opened with the user's login: its extraction code checked, ready to list. */
async function openShare(url: string, zoo: Zoo) {
  if (!zoo.credentials.has('BDUSS') || !zoo.credentials.has('STOKEN')) {
    throw zoo.fail('Baidu Netdisk needs your login cookies', {
      hint: 'in a browser logged in to pan.baidu.com, copy the BDUSS and STOKEN cookies into Settings > Site modules > 百度网盘',
    });
  }
  const { surl, pwd, path } = shareOf(url, zoo);
  const sharePage = `${PAN}/s/1${surl}`;
  const login = `BDUSS=${zoo.credentials.placeholder('BDUSS')}; STOKEN=${zoo.credentials.placeholder('STOKEN')}`;
  // The share's password cookie (BDCLND) goes with the login cookies once verified.
  let cookie = login;

  const web = async (path: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<Reply> => {
    const response = await fetch(PAN + path, {
      method: init.method ?? (init.form ? 'POST' : 'GET'),
      headers: {
        'User-Agent': BROWSER,
        Cookie: cookie,
        Referer: sharePage,
        ...(init.form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
      },
      body: init.form ? new URLSearchParams(init.form) : undefined,
    });
    try {
      return (await response.json()) as Reply;
    } catch {
      throw zoo.fail(`Baidu Netdisk answered HTTP ${response.status} without JSON`, { hint: 'the site may be down or blocking this network; try again later' });
    }
  };

  if (pwd) {
    const verify = await web(`/share/verify?surl=${surl}&${WEB}`, { form: { pwd, vcode: '', vcode_str: '' } });
    if (verify.errno !== 0 || typeof verify.randsk !== 'string') throw failure('verify', verify, zoo);
    cookie = `${login}; BDCLND=${verify.randsk}`;
  }

  /** One folder of the share, every page; the top when `dir` is missing. */
  let share: { id: unknown; uk: unknown } | undefined;
  const listDir = async (dir?: string): Promise<Entry[]> => {
    const entries: Entry[] = [];
    for (let page = 1; ; page++) {
      const where = dir === undefined ? 'dir=&root=1' : `dir=${encodeURIComponent(dir)}&root=0`;
      const reply = await web(`/share/list?shorturl=${surl}&${where}&page=${page}&num=${PAGE}&order=time&desc=1&showempty=0&${WEB}`);
      if (reply.errno !== 0) throw failure('share listing', reply, zoo);
      if (dir === undefined && page === 1) share = { id: reply.share_id, uk: reply.uk };
      const list = (reply.list as Entry[] | undefined) ?? [];
      entries.push(...list);
      if (list.length < PAGE) return entries;
    }
  };
  const top = await listDir();

  /** The file at `path` inside the share (`a/b.txt`), or the only file of a one-file share. */
  const find = async (path?: string): Promise<Entry> => {
    if (path === undefined) {
      if (top.length === 1 && !isDir(top[0])) return top[0];
      throw zoo.fail(`this share holds ${top.length === 1 ? 'a folder' : `${top.length} items`}`, {
        hint: 'add the link in the add-download window to pick its files',
      });
    }
    let entries = top;
    const parts = path.split('/');
    for (const [i, name] of parts.entries()) {
      const entry = entries.find((e) => e.server_filename === name);
      if (!entry) break;
      if (i === parts.length - 1) {
        if (!isDir(entry)) return entry;
        break;
      }
      entries = await listDir(entry.path);
    }
    throw zoo.fail(`${path} is no longer in the share`, { hint: 'the sharer may have removed or renamed it; add the link again' });
  };

  return { web, sharePage, login, cookie: () => cookie, share: () => share!, top, listDir, find, path, base: url.split('#')[0] };
}

export default defineModule({
  async list(url, zoo) {
    const s = await openShare(url, zoo);
    const files: Listed[] = [];
    // Breadth first, so the files at the top come first.
    const folders: { entries: Entry[]; folder: string }[] = [{ entries: s.top, folder: '' }];
    for (let next = folders.shift(); next; next = folders.shift()) {
      for (const entry of next.entries) {
        const inside = next.folder ? `${next.folder}/${entry.server_filename}` : entry.server_filename;
        if (isDir(entry)) {
          folders.push({ entries: await s.listDir(entry.path), folder: inside });
          continue;
        }
        if (files.length === MAX_FILES) {
          throw zoo.fail(`this share holds more than ${MAX_FILES} files`, { hint: 'add its folders one by one, or ask the sharer for smaller shares' });
        }
        files.push({
          url: `${s.base}#path=${encodeURIComponent(inside)}`,
          filename: entry.server_filename,
          size: Number(entry.size),
          folder: next.folder || undefined,
        });
      }
    }
    return files;
  },

  async resolve(url, zoo) {
    const s = await openShare(url, zoo);
    const file = await s.find(s.path);

    // Logged in? The page also carries bdstoken, which writes need.
    const page = await (await fetch(s.sharePage, { headers: { 'User-Agent': BROWSER, Cookie: s.cookie() } })).text();
    const bdstoken = /"bdstoken"\s*:\s*"([0-9a-f]{16,})"/.exec(page)?.[1];
    if (!/"loginstate"\s*:\s*1/.test(page) || !bdstoken) {
      throw failure('login', { errno: -6 }, zoo);
    }

    // FOLDER: create it, clean up old saves, reuse a recent save of the same file.
    let mine = await s.web(`/api/list?dir=${encodeURIComponent(FOLDER)}&${WEB}`);
    if (mine.errno === -9) {
      const made = await s.web(`/api/create?a=commit&bdstoken=${bdstoken}&${WEB}`, { form: { path: FOLDER, isdir: '1', block_list: '[]' } });
      if (made.errno !== 0) throw failure('folder creation', made, zoo);
      mine = { errno: 0, list: [] };
    }
    if (mine.errno !== 0) throw failure('folder listing', mine, zoo);
    const now = Date.now() / 1000;
    const entries = (mine.list as Entry[] | undefined) ?? [];
    const expired = entries.filter((e) => !isDir(e) && now - e.server_mtime > LINK_LIFETIME);
    if (expired.length) {
      const removed = await s.web(`/api/filemanager?opera=delete&async=0&onnest=fail&bdstoken=${bdstoken}&${WEB}`, {
        form: { filelist: JSON.stringify(expired.map((e) => e.path)) },
      });
      // Cleanup is a courtesy; the download does not depend on it.
      if (removed.errno !== 0) zoo.log.warn(`could not remove ${expired.length} old file(s) from ${FOLDER}: errno ${removed.errno}`);
    }
    // By content: a share can hold several files of the same name (recorded: five 看我.txt).
    const same = (e: Entry) => (file.md5 ? e.md5 === file.md5 : e.server_filename === file.server_filename) && Number(e.size) === Number(file.size);
    let saved = entries.find((e) => !expired.includes(e) && !isDir(e) && same(e));
    if (!saved) {
      const { id, uk } = s.share();
      const transfer = await s.web(`/share/transfer?shareid=${id}&from=${uk}&bdstoken=${bdstoken}&ondup=newcopy&async=1&${WEB}`, {
        form: { fsidlist: JSON.stringify([Number(file.fs_id)]), path: FOLDER },
      });
      if (transfer.errno !== 0) throw failure('saving to your netdisk', transfer, zoo);
      const to = (transfer.extra as { list?: { to?: string }[] } | undefined)?.list?.[0]?.to;
      saved = { ...file, path: to ?? `${FOLDER}/${file.server_filename}` };
    }

    // A plain link from the desktop client's API.
    const located = await fetch(`https://d.pcs.baidu.com/rest/2.0/pcs/file?method=locatedownload&app_id=250528&ver=4.0&path=${encodeURIComponent(saved.path)}`, {
      headers: { 'User-Agent': CLIENT, Cookie: s.login },
    });
    const urls = (await located.json()) as { urls?: { url?: string }[]; error_code?: number; error_msg?: string };
    const link = urls.urls?.find((u) => u.url)?.url;
    if (!link) throw zoo.fail(`Baidu Netdisk gave no download link (${urls.error_code ?? located.status} ${urls.error_msg ?? ''})`.trim(), { hint: 'try again later' });

    return {
      url: link,
      filename: file.server_filename,
      size: Number(file.size),
      headers: { 'User-Agent': CLIENT },
      maxConnections: 4,
      maxSegmentSize: 4 * 1024 * 1024,
    };
  },
});
