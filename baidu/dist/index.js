// src/index.ts
import { defineModule } from "zoo-module";
var FOLDER = "/zoo-downloader";
var LINK_LIFETIME = 8 * 3600;
var PAN = "https://pan.baidu.com";
var WEB = "channel=chunlei&web=1&app_id=250528&clienttype=0";
var BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var CLIENT = "netdisk;7.42.0.5;PC;PC-Windows;10.0.22631;WindowsBaiduYunGuanJia";
var PAGE = 100;
var MAX_FILES = 1e3;
var CODE = {
  en: "Extraction code (\u63D0\u53D6\u7801) of this Baidu Netdisk share",
  "zh-TW": "\u9019\u500B\u767E\u5EA6\u7DB2\u76E4\u5206\u4EAB\u7684\u63D0\u53D6\u78BC",
  "zh-CN": "\u8FD9\u4E2A\u767E\u5EA6\u7F51\u76D8\u5206\u4EAB\u7684\u63D0\u53D6\u7801",
  ja: "\u3053\u306E\u767E\u5EA6\u7DB2\u76E4\u5171\u6709\u306E\u62BD\u51FA\u30B3\u30FC\u30C9\uFF08\u63D0\u53D6\u7801\uFF09"
};
var WRONG_CODE = { en: "Wrong extraction code", "zh-TW": "\u63D0\u53D6\u78BC\u4E0D\u6B63\u78BA", "zh-CN": "\u63D0\u53D6\u7801\u4E0D\u6B63\u786E", ja: "\u62BD\u51FA\u30B3\u30FC\u30C9\u304C\u9055\u3044\u307E\u3059" };
var isDir = (e) => Number(e.isdir) === 1;
function insideShare(path) {
  const parts = decodeURIComponent(path).split("/").filter(Boolean);
  if (/^sharelink\d+-\d+$/.test(parts[0] ?? "")) parts.shift();
  return parts.length ? parts.join("/") : void 0;
}
function shareOf(url, zoo) {
  const u = new URL(url);
  const fromPath = /^\/s\/1([\w-]+)/.exec(u.pathname)?.[1];
  const surl = fromPath ?? u.searchParams.get("surl") ?? void 0;
  if (!surl) throw zoo.fail("this is not a Baidu Netdisk share link", { hint: "copy the whole link, like https://pan.baidu.com/s/1...?pwd=..." });
  const path = /^#path=(.+)$/.exec(u.hash)?.[1];
  const folder = /^#list\/path=([^&]+)/.exec(u.hash)?.[1];
  return {
    surl,
    pwd: u.searchParams.get("pwd")?.trim() || void 0,
    path: path === void 0 ? void 0 : decodeURIComponent(path),
    folder: folder === void 0 ? void 0 : insideShare(folder)
  };
}
function failure(step, reply, zoo) {
  const said = reply.show_msg ? ` (${reply.show_msg})` : "";
  switch (reply.errno) {
    case -6:
      return zoo.fail("Baidu did not accept the login cookies", { hint: "copy BDUSS and STOKEN again from pan.baidu.com (Settings > Site modules > \u767E\u5EA6\u7F51\u76D8)" });
    case -9:
      return step === "verify" ? zoo.fail("wrong extraction code (\u63D0\u53D6\u7801)", { hint: "check the ?pwd= part of the link" }) : zoo.fail("the share needs an extraction code (\u63D0\u53D6\u7801)", { hint: "add it to the link: https://pan.baidu.com/s/1...?pwd=code" });
    case -62:
    case -63:
      return zoo.fail("Baidu wants a verification code for this share", { hint: "open the link in a browser once, then try again" });
    case -10:
    case 12:
      return zoo.fail(`your netdisk has no room to save the file${said}`, { hint: "free some space in your netdisk (the file is saved there before downloading)" });
    case 105:
    case 115:
    case 145:
      return zoo.fail(`the share is gone or blocked${said}`, { hint: "ask the sharer for a new link" });
    default:
      return zoo.fail(`Baidu Netdisk ${step} failed: errno ${reply.errno}${said}`);
  }
}
async function openShare(url, zoo) {
  if (!zoo.credentials.has("BDUSS") || !zoo.credentials.has("STOKEN")) {
    throw zoo.fail("Baidu Netdisk needs your login cookies", {
      hint: "in a browser logged in to pan.baidu.com, copy the BDUSS and STOKEN cookies into Settings > Site modules > \u767E\u5EA6\u7F51\u76D8"
    });
  }
  const { surl, pwd, path, folder } = shareOf(url, zoo);
  const sharePage = `${PAN}/s/1${surl}`;
  const login = `BDUSS=${zoo.credentials.placeholder("BDUSS")}; STOKEN=${zoo.credentials.placeholder("STOKEN")}`;
  let cookie = login;
  const web = async (path2, init = {}) => {
    const response = await fetch(PAN + path2, {
      method: init.method ?? (init.form ? "POST" : "GET"),
      headers: {
        "User-Agent": BROWSER,
        Cookie: cookie,
        Referer: sharePage,
        ...init.form ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}
      },
      body: init.form ? new URLSearchParams(init.form) : void 0
    });
    try {
      return await response.json();
    } catch {
      throw zoo.fail(`Baidu Netdisk answered HTTP ${response.status} without JSON`, { hint: "the site may be down or blocking this network; try again later" });
    }
  };
  let unlocked = false;
  const unlock = async (code) => {
    const verify = await web(`/share/verify?surl=${surl}&${WEB}`, { form: { pwd: code, vcode: "", vcode_str: "" } });
    if (verify.errno === -9) return false;
    if (verify.errno !== 0 || typeof verify.randsk !== "string") throw failure("verify", verify, zoo);
    cookie = `${login}; BDCLND=${verify.randsk}`;
    unlocked = true;
    return true;
  };
  const askForCode = async (wrong) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const error = wrong || attempt > 0 ? WRONG_CODE : void 0;
      let code;
      try {
        code = await zoo.ask({ id: "pwd", message: CODE, remember: true, error });
      } catch {
        throw failure(error ? "verify" : "share listing", { errno: -9 }, zoo);
      }
      if (await unlock(code.trim())) return;
    }
    throw failure("verify", { errno: -9 }, zoo);
  };
  if (pwd && !await unlock(pwd)) await askForCode(true);
  let share;
  const listDir = async (dir) => {
    const entries = [];
    for (let page = 1; ; page++) {
      const where = dir === void 0 ? "dir=&root=1" : `dir=${encodeURIComponent(dir)}&root=0`;
      const reply = await web(`/share/list?shorturl=${surl}&${where}&page=${page}&num=${PAGE}&order=time&desc=1&showempty=0&${WEB}`);
      if (reply.errno === -9 && !unlocked) {
        await askForCode(false);
        page--;
        continue;
      }
      if (reply.errno !== 0) throw failure("share listing", reply, zoo);
      if (dir === void 0 && page === 1) share = { id: reply.share_id, uk: reply.uk };
      const list = reply.list ?? [];
      entries.push(...list);
      if (list.length < PAGE) return entries;
    }
  };
  const top = await listDir();
  const at = async (path2) => {
    let entries = top;
    const parts = path2.split("/");
    for (const [i, name] of parts.entries()) {
      const entry = entries.find((e) => e.server_filename === name);
      if (!entry || i === parts.length - 1) return entry;
      if (!isDir(entry)) return void 0;
      entries = await listDir(entry.path);
    }
  };
  const gone = (path2) => zoo.fail(`${path2} is no longer in the share`, { hint: "the sharer may have removed or renamed it; add the link again" });
  const find = async (path2) => {
    if (path2 === void 0) {
      if (top.length === 1 && !isDir(top[0])) return top[0];
      throw zoo.fail(`this share holds ${top.length === 1 ? "a folder" : `${top.length} items`}`, {
        hint: "add the link in the add-download window to pick its files"
      });
    }
    const entry = await at(path2);
    if (!entry || isDir(entry)) throw gone(path2);
    return entry;
  };
  const start = async () => {
    if (folder === void 0) return { entries: top, folder: "" };
    const entry = await at(folder);
    if (!entry || !isDir(entry)) throw gone(folder);
    return { entries: await listDir(entry.path), folder };
  };
  const base = `${PAN}/s/1${surl}${pwd ? `?pwd=${encodeURIComponent(pwd)}` : ""}`;
  return { web, sharePage, login, cookie: () => cookie, share: () => share, listDir, find, start, path, base };
}
var index_default = defineModule({
  async list(url, zoo) {
    const s = await openShare(url, zoo);
    const files = [];
    const root = await s.start();
    const parent = root.folder.includes("/") ? root.folder.slice(0, root.folder.lastIndexOf("/") + 1) : "";
    const folders = [root];
    for (let next = folders.shift(); next; next = folders.shift()) {
      for (const entry of next.entries) {
        const inside = next.folder ? `${next.folder}/${entry.server_filename}` : entry.server_filename;
        if (isDir(entry)) {
          folders.push({ entries: await s.listDir(entry.path), folder: inside });
          continue;
        }
        if (files.length === MAX_FILES) {
          throw zoo.fail(`this share holds more than ${MAX_FILES} files`, { hint: "add its folders one by one, or ask the sharer for smaller shares" });
        }
        files.push({
          url: `${s.base}#path=${encodeURIComponent(inside)}`,
          filename: entry.server_filename,
          size: Number(entry.size),
          folder: next.folder.slice(parent.length) || void 0
        });
      }
    }
    return files;
  },
  async resolve(url, zoo) {
    const s = await openShare(url, zoo);
    const file = await s.find(s.path);
    const page = await (await fetch(s.sharePage, { headers: { "User-Agent": BROWSER, Cookie: s.cookie() } })).text();
    const bdstoken = /"bdstoken"\s*:\s*"([0-9a-f]{16,})"/.exec(page)?.[1];
    if (!/"loginstate"\s*:\s*1/.test(page) || !bdstoken) {
      throw failure("login", { errno: -6 }, zoo);
    }
    let mine = await s.web(`/api/list?dir=${encodeURIComponent(FOLDER)}&${WEB}`);
    if (mine.errno === -9) {
      const made = await s.web(`/api/create?a=commit&bdstoken=${bdstoken}&${WEB}`, { form: { path: FOLDER, isdir: "1", block_list: "[]" } });
      if (made.errno !== 0) throw failure("folder creation", made, zoo);
      mine = { errno: 0, list: [] };
    }
    if (mine.errno !== 0) throw failure("folder listing", mine, zoo);
    const now = Date.now() / 1e3;
    const entries = mine.list ?? [];
    const expired = entries.filter((e) => !isDir(e) && now - e.server_mtime > LINK_LIFETIME);
    if (expired.length) {
      const removed = await s.web(`/api/filemanager?opera=delete&async=0&onnest=fail&bdstoken=${bdstoken}&${WEB}`, {
        form: { filelist: JSON.stringify(expired.map((e) => e.path)) }
      });
      if (removed.errno !== 0) zoo.log.warn(`could not remove ${expired.length} old file(s) from ${FOLDER}: errno ${removed.errno}`);
    }
    const same = (e) => (file.md5 ? e.md5 === file.md5 : e.server_filename === file.server_filename) && Number(e.size) === Number(file.size);
    let saved = entries.find((e) => !expired.includes(e) && !isDir(e) && same(e));
    if (!saved) {
      const { id, uk } = s.share();
      const transfer = await s.web(`/share/transfer?shareid=${id}&from=${uk}&bdstoken=${bdstoken}&ondup=newcopy&async=1&${WEB}`, {
        form: { fsidlist: JSON.stringify([Number(file.fs_id)]), path: FOLDER }
      });
      if (transfer.errno !== 0) throw failure("saving to your netdisk", transfer, zoo);
      const to = transfer.extra?.list?.[0]?.to;
      saved = { ...file, path: to ?? `${FOLDER}/${file.server_filename}` };
    }
    const located = await fetch(`https://d.pcs.baidu.com/rest/2.0/pcs/file?method=locatedownload&app_id=250528&ver=4.0&path=${encodeURIComponent(saved.path)}`, {
      headers: { "User-Agent": CLIENT, Cookie: s.login }
    });
    const urls = await located.json();
    const link = urls.urls?.find((u) => u.url)?.url;
    if (!link) throw zoo.fail(`Baidu Netdisk gave no download link (${urls.error_code ?? located.status} ${urls.error_msg ?? ""})`.trim(), { hint: "try again later" });
    return {
      url: link,
      filename: file.server_filename,
      size: Number(file.size),
      headers: { "User-Agent": CLIENT },
      maxConnections: 4,
      maxSegmentSize: 4 * 1024 * 1024
    };
  }
});
export {
  index_default as default
};
