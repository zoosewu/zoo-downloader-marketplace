// src/index.ts
import { defineModule } from "zoo-module";
var PREMIUM = "a KatFile premium account skips it, but this module does not log in yet";
var WAIT_STEP = 600;
var SLACK = 5;
var MAX_ROUNDS = 3;
function pageOf(url, zoo) {
  const id = new URL(url).pathname.match(/^\/([a-z0-9]{12})(?:[/.]|$)/)?.[1];
  if (!id) throw zoo.fail("this is not a KatFile file link", { hint: "copy the whole link, like https://katfile.com/<id>/<name>.html" });
  return `https://katfile.com/${id}`;
}
async function html(response, zoo) {
  if (!response.ok) throw zoo.fail(`KatFile answered HTTP ${response.status}`, { hint: "try again later" });
  return new DOMParser().parseFromString(await response.text(), "text/html");
}
function seconds(text) {
  const size = { hour: 3600, minute: 60, second: 1 };
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)\s*(hour|minute|second)s?/gi)) total += Number(n) * size[unit.toLowerCase()];
  return total;
}
var clock = (s) => [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map((n, i) => i ? String(n).padStart(2, "0") : String(n)).join(":");
async function ask(page, zoo) {
  const first = await html(await fetch(page), zoo);
  const form = first.querySelector("form#btn_download");
  if (!form || form.querySelector('input[name="op"]')?.getAttribute("value") !== "download1") {
    throw zoo.fail("file not found", { hint: "the file was deleted; ask the uploader for a new link" });
  }
  const body = new URLSearchParams();
  for (const input of form.querySelectorAll('input[type="hidden"]')) {
    const name = input.getAttribute("name");
    if (name) body.set(name, input.getAttribute("value") ?? "");
  }
  body.set("method_free", "1");
  const second = await html(await fetch(page, { method: "POST", headers: { Referer: page }, body }), zoo);
  const link = second.querySelector("a#dlink")?.getAttribute("href");
  if (link) return { link: new URL(link, page).href, filename: body.get("fname") ?? "" };
  const said = second.querySelector(".alert-danger strong")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const wait = said.match(/wait (.+?) till next download/i)?.[1];
  if (wait && seconds(wait) > 0) return { wait: seconds(wait) };
  if (/download-limit/i.test(said)) throw zoo.fail("the daily KatFile free download limit is used up", { hint: `try again tomorrow; ${PREMIUM}` });
  if (said) throw zoo.fail(`KatFile: ${said.replace(/Download files instantly with Premium-account\.?$/i, "").trim()}`);
  throw zoo.fail("download link not found", { hint: "the page layout may have changed; the module needs an update" });
}
var index_default = defineModule({
  async resolve(url, zoo) {
    const page = pageOf(url, zoo);
    for (let round = 1; ; round++) {
      const answer = await ask(page, zoo);
      if ("link" in answer) {
        return {
          url: answer.link,
          filename: answer.filename || void 0,
          // Free downloads: one connection, which the server limits to about 100 KB/s.
          maxConnections: 1
        };
      }
      if (round === MAX_ROUNDS) {
        throw zoo.fail(`KatFile still asks to wait ${clock(answer.wait)} before the next free download`, { hint: `try again later; ${PREMIUM}` });
      }
      for (let left = answer.wait + SLACK; left > 0; left -= WAIT_STEP) {
        await zoo.wait(Math.min(left, WAIT_STEP), `KatFile allows one free download every 2 hours: ${clock(left)} left`);
      }
    }
  }
});
export {
  index_default as default
};
