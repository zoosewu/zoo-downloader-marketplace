// Keep2Share and its sister sites through their public API v2 (https://github.com/keep2share/api):
// keep2share.cc / k2s.cc, tezfiles.com and fboom.me run the same API, each with its own files
// and accounts (the one account in the settings is tried on the site of the link).
//
// Every method is a POST with a JSON body; the session token travels in the body as
// `auth_token`. A download goes: getFileStatus (no account needed: a deleted, blocked,
// premium-only or folder link fails here, before any login or captcha) -> login if the user
// gave an account -> getUrl. Free downloads: getUrl -> captcha (30) -> getUrl with the answer,
// which hands out a free_download_key and a countdown -> wait -> getUrl with the key -> link.
//
// Links: /file/<id>[/<name>] for files and /folder/<id> for folders, on every host of a site
// (www. or not, http or https). getFileStatus on a folder's id lists its files, so `list`
// turns a folder into one link per file.
//
// Recorded from the live site: the free flow (tests/cassettes/free.json, 2026-11-15). Built from
// the documentation, to be recorded with real links and an account before trusting them:
// login, its reCAPTCHA page, premium links, folders, TezFiles and FileBoom.

import { defineModule, type Listed, type Zoo } from 'zoo-module';

interface Site {
  name: string;
  api: string;
  /** How its links start (`<files>/<id>/<name>`). */
  files: string;
  hosts: string[];
}

const SITES: Site[] = [
  { name: 'Keep2Share', api: 'https://keep2share.cc/api/v2/', files: 'https://k2s.cc/file/', hosts: ['k2s.cc', 'keep2share.cc'] },
  { name: 'TezFiles', api: 'https://tezfiles.com/api/v2/', files: 'https://tezfiles.com/file/', hosts: ['tezfiles.com'] },
  { name: 'FileBoom', api: 'https://fboom.me/api/v2/', files: 'https://fboom.me/file/', hosts: ['fboom.me'] },
];
/** Free accounts get a few countdowns at most; anything longer is a daily limit. */
const MAX_ROUNDS = 6;
/** Files of a folder per getFileStatus call. */
const PAGE = 100;
/** The app takes at most this many files from one link. */
const MAX_FILES = 1000;

interface Reply {
  status: string;
  code?: number;
  message?: string;
  errorCode?: number | string;
  [field: string]: unknown;
}

interface Entry {
  id: string;
  name: string;
  is_folder?: boolean;
  size?: number;
}

const ok = (reply: Reply) => reply.status === 'success';
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** The site, the id and whether the link names a folder: `https://[www.]k2s.cc/file/<id>[/<name>]`. */
function linkOf(url: string, zoo: Zoo): { site: Site; id: string; folder: boolean } {
  const u = new URL(url);
  const site = SITES.find((s) => s.hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)));
  const [, kind, id] = u.pathname.split('/');
  if (!site || (kind !== 'file' && kind !== 'folder') || !id) {
    throw zoo.fail('this is not a Keep2Share file or folder link', { hint: 'copy the whole link, like https://k2s.cc/file/<id>/<name>' });
  }
  return { site, id, folder: kind === 'folder' };
}

/** One site's API, failures told in its name. */
function api(site: Site, zoo: Zoo) {
  const call = async (method: string, body: Record<string, unknown> = {}): Promise<Reply> => {
    const response = await fetch(site.api + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      return (await response.json()) as Reply;
    } catch {
      throw zoo.fail(`${site.name} ${method} answered HTTP ${response.status} without JSON`, {
        hint: 'the site may be down or blocking this network; try again later',
      });
    }
  };

  const settings = `Settings > Site modules > Keep2Share`;
  /** The error to show for a failed reply, with what the user can do about it. */
  const failure = (reply: Reply): Error => {
    const said = reply.message ? ` (${reply.message})` : '';
    switch (reply.errorCode) {
      case 'captcha_need_wait':
      case 'captcha_need_wait_daily':
        return zoo.fail(`${site.name} blocked logins from this network after wrong captchas${said}`, { hint: 'wait before trying again' });
    }
    switch (Number(reply.errorCode)) {
      case 1:
      case 2:
        return zoo.fail(`${site.name}: the download limit of this account is used up${said}`, { hint: 'wait until it resets, or use another account' });
      case 3:
        return zoo.fail(`${site.name}: free users cannot download a file this large${said}`, { hint: `enter a premium account in ${settings}` });
      case 10:
        return zoo.fail(`${site.name} did not accept the login`, { hint: 'try again; if it keeps happening, log in on the website' });
      case 20:
        return zoo.fail('file not found', { hint: 'the file was deleted; ask the uploader for a new link' });
      case 21:
      case 42:
        return zoo.fail(`file is not available for download${said}`, { hint: 'it may be private or limited; try again later or ask the uploader' });
      case 22:
        return zoo.fail('file is blocked', { hint: `${site.name} removed it; ask the uploader for a new link` });
      case 23:
        return zoo.fail('this link is a folder', { hint: 'add it in the add-download window to pick its files' });
      case 43:
        return zoo.fail('only premium accounts can download this file', { hint: `enter a premium account in ${settings}` });
      case 70:
        return zoo.fail('wrong username or password', { hint: `check the account in ${settings}` });
      case 71:
        return zoo.fail('too many login attempts', { hint: 'wait a while before trying again' });
      case 72:
      case 73:
      case 74:
      case 75:
      case 76:
      case 77:
        return zoo.fail(`${site.name} refused the account${said}`, { hint: 'log in on the website to see why' });
      default:
        return zoo.fail(`${site.name}: ${reply.message || 'request failed'} (code ${reply.errorCode ?? reply.code ?? '?'})`);
    }
  };

  return { call, failure };
}

type Api = ReturnType<typeof api>;

/** The reCAPTCHA a login sometimes asks for, solved on the site's own captcha page. */
async function loginRecaptcha({ call, failure }: Api, zoo: Zoo): Promise<Record<string, string>> {
  const challenge = await call('requestReCaptcha');
  const pageUrl = text(challenge.captcha_url);
  if (!ok(challenge) || !pageUrl) throw failure(challenge);
  const page = await (await fetch(pageUrl)).text();
  const siteKey = /sitekey["']?\s*[:=]\s*["']([\w-]{20,})["']/i.exec(page)?.[1];
  if (!siteKey) throw zoo.fail('the login asked for a reCAPTCHA this module cannot find', { hint: 'log in on the website once, then try again' });
  const token = await zoo.captcha.recaptcha({ siteKey, pageUrl });
  return { re_captcha_challenge: String(challenge.challenge), re_captcha_response: token };
}

/** `{ auth_token }` for the user's account, or nothing without one. */
async function session(k2s: Api, zoo: Zoo): Promise<Record<string, string>> {
  if (!zoo.credentials.has('username') || !zoo.credentials.has('password')) return {};
  const account = { username: zoo.credentials.placeholder('username'), password: zoo.credentials.placeholder('password') };
  let reply = await k2s.call('login', account);
  if (!ok(reply) && Number(reply.errorCode) === 33) {
    reply = await k2s.call('login', { ...account, ...(await loginRecaptcha(k2s, zoo)) });
  }
  const token = text(reply.auth_token);
  if (!ok(reply) || !token) throw k2s.failure(reply);
  return { auth_token: token };
}

/** A text captcha for free downloads: the answer goes back with the next getUrl. */
async function imageCaptcha({ call, failure }: Api, zoo: Zoo): Promise<Record<string, string>> {
  const challenge = await call('requestCaptcha');
  const image = text(challenge.captcha_url);
  if (!ok(challenge) || !image) throw failure(challenge);
  return { captcha_challenge: String(challenge.challenge), captcha_response: await zoo.captcha.image(image) };
}

async function countdown(site: Site, zoo: Zoo, reply: Reply) {
  const seconds = Number(reply.time_wait) || 30;
  if (seconds > 600) {
    throw zoo.fail(`free downloads are used up; next one in ${Math.ceil(seconds / 60)} minutes`, {
      hint: 'wait, or enter a premium account in Settings > Site modules > Keep2Share',
    });
  }
  await zoo.wait(seconds, `${site.name} free download countdown`);
}

/** The files of a folder, every page (the API returns them as an array or an object). */
async function folderFiles({ call, failure }: Api, id: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const reply = await call('getFileStatus', { id, limit: PAGE, offset });
    if (!ok(reply)) throw failure(reply);
    const files = reply.files && typeof reply.files === 'object' ? (Object.values(reply.files) as Entry[]) : [];
    entries.push(...files);
    if (files.length < PAGE) return entries;
  }
}

export default defineModule({
  async list(url, zoo) {
    const { site, id } = linkOf(url, zoo);
    const k2s = api(site, zoo);
    const status = await k2s.call('getFileStatus', { id });
    if (!ok(status)) throw k2s.failure(status);
    const link = (e: Entry) => `${site.files}${e.id}/${encodeURIComponent(e.name)}`;
    if (!status.is_folder) {
      const name = text(status.name) ?? id;
      return [{ url: link({ id, name }), filename: name, size: Number(status.size) || undefined }];
    }

    // Breadth first, so the files at the top come first; subfolders keep their names.
    const files: Listed[] = [];
    const folders = [{ id, folder: '' }];
    for (let next = folders.shift(); next; next = folders.shift()) {
      for (const entry of await folderFiles(k2s, next.id)) {
        const inside = next.folder ? `${next.folder}/${entry.name}` : entry.name;
        if (entry.is_folder) {
          folders.push({ id: entry.id, folder: inside });
          continue;
        }
        if (files.length === MAX_FILES) {
          throw zoo.fail(`this folder holds more than ${MAX_FILES} files`, { hint: 'add its subfolders one by one' });
        }
        files.push({ url: link(entry), filename: entry.name, size: Number(entry.size) || undefined, folder: next.folder || undefined });
      }
    }
    return files;
  },

  async resolve(url, zoo) {
    const { site, id } = linkOf(url, zoo);
    const k2s = api(site, zoo);

    const file = await k2s.call('getFileStatus', { id });
    if (!ok(file)) throw k2s.failure(file);
    if (file.is_folder) throw k2s.failure({ status: 'error', errorCode: 23 });
    if (file.is_available === false) throw k2s.failure({ status: 'error', errorCode: 21 });
    const auth = await session(k2s, zoo);
    // Without an account, a premium-only file fails now rather than after a captcha.
    if (!auth.auth_token && file.isAvailableForFree === false) throw k2s.failure({ status: 'error', errorCode: 43 });
    const name = text(file.name);
    const size = typeof file.size === 'number' && file.size > 0 ? file.size : undefined;

    // Premium accounts get the link at once; free ones go through captcha and countdown.
    let free = false;
    let extra: Record<string, string> = {};
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reply = await k2s.call('getUrl', { file_id: id, ...auth, ...extra });
      const link = text(reply.url);
      if (ok(reply) && link) {
        return { url: link, filename: name, size, ...(free ? { maxConnections: 1 } : {}) };
      }
      const key = text(reply.free_download_key);
      if (ok(reply) && key) {
        free = true;
        await countdown(site, zoo, reply);
        extra = { free_download_key: key };
        continue;
      }
      switch (Number(reply.errorCode)) {
        case 30: // captcha required
        case 31: // wrong answer: a new captcha
          free = true;
          extra = await imageCaptcha(k2s, zoo);
          continue;
        case 40: // the free download key expired: start over
          extra = {};
          continue;
        case 41: // countdown still running
          free = true;
          await countdown(site, zoo, reply);
          continue;
        default:
          throw k2s.failure(reply);
      }
    }
    throw zoo.fail(`${site.name} kept asking for captchas`, { hint: 'try again; if it keeps happening, open the link in a browser' });
  },
});
