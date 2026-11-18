// src/index.ts
import { defineModule } from "zoo-module";
var API = "https://keep2share.cc/api/v2/";
var MAX_ROUNDS = 6;
async function call(zoo, method, body = {}) {
  const response = await fetch(API + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    return await response.json();
  } catch {
    throw zoo.fail(`Keep2Share ${method} answered HTTP ${response.status} without JSON`, {
      hint: "the site may be down or blocking this network; try again later"
    });
  }
}
var ok = (reply) => reply.status === "success";
var text = (value) => typeof value === "string" && value ? value : void 0;
function fileId(url, zoo) {
  const id = new URL(url).pathname.split("/")[2];
  if (!id) throw zoo.fail("this Keep2Share link has no file id", { hint: "copy the whole link of the file page" });
  return id;
}
function failure(reply, zoo) {
  const said = reply.message ? ` (${reply.message})` : "";
  switch (Number(reply.errorCode)) {
    case 20:
      return zoo.fail("file not found", { hint: "the file was deleted; ask the uploader for a new link" });
    case 21:
    case 42:
      return zoo.fail(`file is not available for download${said}`, { hint: "try again later" });
    case 22:
      return zoo.fail("file is blocked", { hint: "Keep2Share removed it; ask the uploader for a new link" });
    case 23:
      return zoo.fail("this link is a folder", { hint: "add the links of the files inside it" });
    case 43:
      return zoo.fail("only premium accounts can download this file", {
        hint: "enter a premium account in Settings > Site modules > Keep2Share"
      });
    case 70:
      return zoo.fail("wrong username or password", { hint: "check the account in Settings > Site modules > Keep2Share" });
    case 71:
      return zoo.fail("too many login attempts", { hint: "wait a while before trying again" });
    case 72:
    case 76:
    case 77:
      return zoo.fail(`Keep2Share refused the account${said}`, { hint: "log in on the website to see why" });
    default:
      return zoo.fail(`Keep2Share: ${reply.message || "request failed"} (code ${reply.errorCode ?? reply.code ?? "?"})`);
  }
}
async function loginRecaptcha(zoo) {
  const challenge = await call(zoo, "requestReCaptcha");
  const pageUrl = text(challenge.captcha_url);
  if (!ok(challenge) || !pageUrl) throw failure(challenge, zoo);
  const page = await (await fetch(pageUrl)).text();
  const siteKey = /sitekey["']?\s*[:=]\s*["']([\w-]{20,})["']/i.exec(page)?.[1];
  if (!siteKey) throw zoo.fail("Keep2Share asked for a reCAPTCHA this module cannot find", { hint: "log in on the website once, then try again" });
  const token = await zoo.captcha.recaptcha({ siteKey, pageUrl });
  return { re_captcha_challenge: String(challenge.challenge), re_captcha_response: token };
}
async function login(zoo) {
  const account = {
    username: zoo.credentials.placeholder("username"),
    password: zoo.credentials.placeholder("password")
  };
  let reply = await call(zoo, "login", account);
  if (!ok(reply) && Number(reply.errorCode) === 33) {
    reply = await call(zoo, "login", { ...account, ...await loginRecaptcha(zoo) });
  }
  const token = text(reply.auth_token);
  if (!ok(reply) || !token) throw failure(reply, zoo);
  return token;
}
async function imageCaptcha(zoo) {
  const challenge = await call(zoo, "requestCaptcha");
  const image = text(challenge.captcha_url);
  if (!ok(challenge) || !image) throw failure(challenge, zoo);
  return { captcha_challenge: String(challenge.challenge), captcha_response: await zoo.captcha.image(image) };
}
async function countdown(zoo, reply) {
  const seconds = Number(reply.time_wait) || 30;
  if (seconds > 600) {
    throw zoo.fail(`free downloads are used up; next one in ${Math.ceil(seconds / 60)} minutes`, {
      hint: "wait, or enter a premium account in Settings > Site modules > Keep2Share"
    });
  }
  await zoo.wait(seconds, "Keep2Share free download countdown");
}
var index_default = defineModule({
  async resolve(url, zoo) {
    const id = fileId(url, zoo);
    const auth = zoo.credentials.has("username") && zoo.credentials.has("password") ? { auth_token: await login(zoo) } : {};
    const file = await call(zoo, "getFileStatus", { id });
    if (!ok(file)) throw failure(file, zoo);
    if (file.is_folder) throw failure({ status: "error", errorCode: 23 }, zoo);
    if (file.is_available === false) throw failure({ status: "error", errorCode: 21 }, zoo);
    const name = text(file.name);
    const size = typeof file.size === "number" && file.size > 0 ? file.size : void 0;
    let free = false;
    let extra = {};
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reply = await call(zoo, "getUrl", { file_id: id, ...auth, ...extra });
      const link = text(reply.url);
      if (ok(reply) && link) {
        return { url: link, filename: name, size, ...free ? { maxConnections: 1 } : {} };
      }
      const key = text(reply.free_download_key);
      if (ok(reply) && key) {
        free = true;
        await countdown(zoo, reply);
        extra = { free_download_key: key };
        continue;
      }
      switch (Number(reply.errorCode)) {
        case 30:
        // captcha required
        case 31:
          free = true;
          extra = await imageCaptcha(zoo);
          continue;
        case 41:
          free = true;
          await countdown(zoo, reply);
          continue;
        default:
          throw failure(reply, zoo);
      }
    }
    throw zoo.fail("Keep2Share kept asking for captchas", { hint: "try again; if it keeps happening, open the link in a browser" });
  }
});
export {
  index_default as default
};
