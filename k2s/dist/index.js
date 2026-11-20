// src/index.ts
import { defineModule } from "zoo-module";
var SITES = [
  { name: "Keep2Share", api: "https://keep2share.cc/api/v2/", files: "https://k2s.cc/file/", hosts: ["k2s.cc", "keep2share.cc"] },
  { name: "TezFiles", api: "https://tezfiles.com/api/v2/", files: "https://tezfiles.com/file/", hosts: ["tezfiles.com"] },
  { name: "FileBoom", api: "https://fboom.me/api/v2/", files: "https://fboom.me/file/", hosts: ["fboom.me"] }
];
var MAX_ROUNDS = 6;
var PAGE = 100;
var MAX_FILES = 1e3;
var ok = (reply) => reply.status === "success";
var text = (value) => typeof value === "string" && value ? value : void 0;
function linkOf(url, zoo) {
  const u = new URL(url);
  const site = SITES.find((s) => s.hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)));
  const [, kind, id] = u.pathname.split("/");
  if (!site || kind !== "file" && kind !== "folder" || !id) {
    throw zoo.fail("this is not a Keep2Share file or folder link", { hint: "copy the whole link, like https://k2s.cc/file/<id>/<name>" });
  }
  return { site, id, folder: kind === "folder" };
}
function api(site, zoo) {
  const call = async (method, body = {}) => {
    const response = await fetch(site.api + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    try {
      return await response.json();
    } catch {
      throw zoo.fail(`${site.name} ${method} answered HTTP ${response.status} without JSON`, {
        hint: "the site may be down or blocking this network; try again later"
      });
    }
  };
  const settings = `Settings > Site modules > Keep2Share`;
  const failure = (reply) => {
    const said = reply.message ? ` (${reply.message})` : "";
    switch (reply.errorCode) {
      case "captcha_need_wait":
      case "captcha_need_wait_daily":
        return zoo.fail(`${site.name} blocked logins from this network after wrong captchas${said}`, { hint: "wait before trying again" });
    }
    switch (Number(reply.errorCode)) {
      case 1:
      case 2:
        return zoo.fail(`${site.name}: the download limit of this account is used up${said}`, { hint: "wait until it resets, or use another account" });
      case 3:
        return zoo.fail(`${site.name}: free users cannot download a file this large${said}`, { hint: `enter a premium account in ${settings}` });
      case 10:
        return zoo.fail(`${site.name} did not accept the login`, { hint: "try again; if it keeps happening, log in on the website" });
      case 20:
        return zoo.fail("file not found", { hint: "the file was deleted; ask the uploader for a new link" });
      case 21:
      case 42:
        return zoo.fail(`file is not available for download${said}`, { hint: "it may be private or limited; try again later or ask the uploader" });
      case 22:
        return zoo.fail("file is blocked", { hint: `${site.name} removed it; ask the uploader for a new link` });
      case 23:
        return zoo.fail("this link is a folder", { hint: "add it in the add-download window to pick its files" });
      case 43:
        return zoo.fail("only premium accounts can download this file", { hint: `enter a premium account in ${settings}` });
      case 70:
        return zoo.fail("wrong username or password", { hint: `check the account in ${settings}` });
      case 71:
        return zoo.fail("too many login attempts", { hint: "wait a while before trying again" });
      case 72:
      case 73:
      case 74:
      case 75:
      case 76:
      case 77:
        return zoo.fail(`${site.name} refused the account${said}`, { hint: "log in on the website to see why" });
      default:
        return zoo.fail(`${site.name}: ${reply.message || "request failed"} (code ${reply.errorCode ?? reply.code ?? "?"})`);
    }
  };
  return { call, failure };
}
async function loginRecaptcha({ call, failure }, zoo) {
  const challenge = await call("requestReCaptcha");
  const pageUrl = text(challenge.captcha_url);
  if (!ok(challenge) || !pageUrl) throw failure(challenge);
  const page = await (await fetch(pageUrl)).text();
  const siteKey = /sitekey["']?\s*[:=]\s*["']([\w-]{20,})["']/i.exec(page)?.[1];
  if (!siteKey) throw zoo.fail("the login asked for a reCAPTCHA this module cannot find", { hint: "log in on the website once, then try again" });
  const token = await zoo.captcha.recaptcha({ siteKey, pageUrl });
  return { re_captcha_challenge: String(challenge.challenge), re_captcha_response: token };
}
async function session(k2s, zoo) {
  if (!zoo.credentials.has("username") || !zoo.credentials.has("password")) return {};
  const account = { username: zoo.credentials.placeholder("username"), password: zoo.credentials.placeholder("password") };
  let reply = await k2s.call("login", account);
  if (!ok(reply) && Number(reply.errorCode) === 33) {
    reply = await k2s.call("login", { ...account, ...await loginRecaptcha(k2s, zoo) });
  }
  const token = text(reply.auth_token);
  if (!ok(reply) || !token) throw k2s.failure(reply);
  return { auth_token: token };
}
async function imageCaptcha({ call, failure }, zoo) {
  const challenge = await call("requestCaptcha");
  const image = text(challenge.captcha_url);
  if (!ok(challenge) || !image) throw failure(challenge);
  return { captcha_challenge: String(challenge.challenge), captcha_response: await zoo.captcha.image(image) };
}
async function countdown(site, zoo, reply) {
  const seconds = Number(reply.time_wait) || 30;
  if (seconds > 600) {
    throw zoo.fail(`free downloads are used up; next one in ${Math.ceil(seconds / 60)} minutes`, {
      hint: "wait, or enter a premium account in Settings > Site modules > Keep2Share"
    });
  }
  await zoo.wait(seconds, `${site.name} free download countdown`);
}
async function folderFiles({ call, failure }, id) {
  const entries = [];
  for (let offset = 0; ; offset += PAGE) {
    const reply = await call("getFileStatus", { id, limit: PAGE, offset });
    if (!ok(reply)) throw failure(reply);
    const files = reply.files && typeof reply.files === "object" ? Object.values(reply.files) : [];
    entries.push(...files);
    if (files.length < PAGE) return entries;
  }
}
var index_default = defineModule({
  async list(url, zoo) {
    const { site, id } = linkOf(url, zoo);
    const k2s = api(site, zoo);
    const status = await k2s.call("getFileStatus", { id });
    if (!ok(status)) throw k2s.failure(status);
    const link = (e) => `${site.files}${e.id}/${encodeURIComponent(e.name)}`;
    if (!status.is_folder) {
      const name = text(status.name) ?? id;
      return [{ url: link({ id, name }), filename: name, size: Number(status.size) || void 0 }];
    }
    const files = [];
    const folders = [{ id, folder: "" }];
    for (let next = folders.shift(); next; next = folders.shift()) {
      for (const entry of await folderFiles(k2s, next.id)) {
        const inside = next.folder ? `${next.folder}/${entry.name}` : entry.name;
        if (entry.is_folder) {
          folders.push({ id: entry.id, folder: inside });
          continue;
        }
        if (files.length === MAX_FILES) {
          throw zoo.fail(`this folder holds more than ${MAX_FILES} files`, { hint: "add its subfolders one by one" });
        }
        files.push({ url: link(entry), filename: entry.name, size: Number(entry.size) || void 0, folder: next.folder || void 0 });
      }
    }
    return files;
  },
  async resolve(url, zoo) {
    const { site, id } = linkOf(url, zoo);
    const k2s = api(site, zoo);
    const file = await k2s.call("getFileStatus", { id });
    if (!ok(file)) throw k2s.failure(file);
    if (file.is_folder) throw k2s.failure({ status: "error", errorCode: 23 });
    if (file.is_available === false) throw k2s.failure({ status: "error", errorCode: 21 });
    const auth = await session(k2s, zoo);
    if (!auth.auth_token && file.isAvailableForFree === false) throw k2s.failure({ status: "error", errorCode: 43 });
    const name = text(file.name);
    const size = typeof file.size === "number" && file.size > 0 ? file.size : void 0;
    let free = false;
    let extra = {};
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reply = await k2s.call("getUrl", { file_id: id, ...auth, ...extra });
      const link = text(reply.url);
      if (ok(reply) && link) {
        return { url: link, filename: name, size, ...free ? { maxConnections: 1 } : {} };
      }
      const key = text(reply.free_download_key);
      if (ok(reply) && key) {
        free = true;
        await countdown(site, zoo, reply);
        extra = { free_download_key: key };
        continue;
      }
      switch (Number(reply.errorCode)) {
        case 30:
        // captcha required
        case 31:
          free = true;
          extra = await imageCaptcha(k2s, zoo);
          continue;
        case 40:
          extra = {};
          continue;
        case 41:
          free = true;
          await countdown(site, zoo, reply);
          continue;
        default:
          throw k2s.failure(reply);
      }
    }
    throw zoo.fail(`${site.name} kept asking for captchas`, { hint: "try again; if it keeps happening, open the link in a browser" });
  }
});
export {
  index_default as default
};
