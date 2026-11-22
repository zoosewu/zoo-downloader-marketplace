// src/index.ts
import { defineModule } from "zoo-module";
var PREMIUM = "a KatFile premium account skips it, but this module does not log in yet";
function pageOf(url, zoo) {
  const id = new URL(url).pathname.match(/^\/([a-z0-9]{12})(?:[/.]|$)/)?.[1];
  if (!id) throw zoo.fail("this is not a KatFile file link", { hint: "copy the whole link, like https://katfile.com/<id>/<name>.html" });
  return `https://katfile.com/${id}`;
}
async function html(response, zoo) {
  if (!response.ok) throw zoo.fail(`KatFile answered HTTP ${response.status}`, { hint: "try again later" });
  return new DOMParser().parseFromString(await response.text(), "text/html");
}
function refusal(doc, zoo) {
  const said = doc.querySelector(".alert-danger strong")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const wait = said.match(/wait (.+?) till next download/i)?.[1];
  if (wait) return zoo.fail(`KatFile allows one free download every 2 hours; the next one in ${wait}`, { hint: `try again then; ${PREMIUM}` });
  if (/download-limit/i.test(said)) return zoo.fail("the daily KatFile free download limit is used up", { hint: `try again tomorrow; ${PREMIUM}` });
  if (said) return zoo.fail(`KatFile: ${said.replace(/Download files instantly with Premium-account\.?$/i, "").trim()}`);
  return zoo.fail("download link not found", { hint: "the page layout may have changed; the module needs an update" });
}
var index_default = defineModule({
  async resolve(url, zoo) {
    const page = pageOf(url, zoo);
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
    if (!link) throw refusal(second, zoo);
    return {
      url: new URL(link, page).href,
      filename: body.get("fname") || void 0,
      // Free downloads: one connection, which the server limits to about 100 KB/s.
      maxConnections: 1
    };
  }
});
export {
  index_default as default
};
