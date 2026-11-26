// KatFile (katfile.com), an XFileSharing site. A free download is two pages:
//   GET  /<id>[/<name>.html]                  the file page, with the `download1` form
//   POST the form with method_free=1          the speed page, whose a#dlink is the direct link
// No captcha and no countdown (WAIT_SECONDS is 0). The page also runs Cloudflare Turnstile, but
// only to skip the second page; without a token the form still goes to it.
//
// Free downloads are one per 120 minutes per IP: until then the POST answers a `download2`
// form whose red alert says "You have to wait 1 hour, 57 minutes, 8 seconds till next
// download" ("reached the download-limit" for the daily limit). The alert text is English
// whatever the page's language. The module tells the app how long (`retryAfter`): the app waits
// without a download slot, keeps the site's other downloads back, then tries them in order.
//
// The direct link (s<n>.katfile.com:<port>/d/...) needs no cookies or Referer. Free downloads
// get about 100 KB/s and the server ignores Range (200, the whole file): one connection, no
// resuming.
//
// A deleted or unknown id shows the "recommended files" page: no form, no message.
//
// Recorded from the live site 2026-11-22: tests/cassettes/deleted.json. The free download and the
// wait were tried by hand, not recorded yet (each try uses up the 2-hour free download).

import { defineModule, type Zoo } from 'zoo-module';

const PREMIUM = 'a KatFile premium account skips it, but this module does not log in yet';
/** Asked again after the wait it named: a few seconds more than it said. */
const SLACK = 5;

/** `https://[www.]katfile.com/<id>[/<name>.html]` → the file page. */
function pageOf(url: string, zoo: Zoo): string {
  const id = new URL(url).pathname.match(/^\/([a-z0-9]{12})(?:[/.]|$)/)?.[1];
  if (!id) throw zoo.fail('this is not a KatFile file link', { hint: 'copy the whole link, like https://katfile.com/<id>/<name>.html' });
  return `https://katfile.com/${id}`;
}

async function html(response: Response, zoo: Zoo): Promise<DOMDocument> {
  if (!response.ok) throw zoo.fail(`KatFile answered HTTP ${response.status}`, { hint: 'try again later' });
  return new DOMParser().parseFromString(await response.text(), 'text/html');
}

/** "1 hour, 57 minutes, 8 seconds" → seconds. */
function seconds(text: string): number {
  const size: Record<string, number> = { hour: 3600, minute: 60, second: 1 };
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)\s*(hour|minute|second)s?/gi)) total += Number(n) * size[unit.toLowerCase()];
  return total;
}

export default defineModule({
  async resolve(url, zoo) {
    const page = pageOf(url, zoo);
    const first = await html(await fetch(page), zoo);
    const form = first.querySelector('form#btn_download');
    if (!form || form.querySelector('input[name="op"]')?.getAttribute('value') !== 'download1') {
      throw zoo.fail('file not found', { hint: 'the file was deleted; ask the uploader for a new link' });
    }
    const body = new URLSearchParams();
    for (const input of form.querySelectorAll('input[type="hidden"]')) {
      const name = input.getAttribute('name');
      if (name) body.set(name, input.getAttribute('value') ?? '');
    }
    body.set('method_free', '1');
    const second = await html(await fetch(page, { method: 'POST', headers: { Referer: page }, body }), zoo);
    const link = second.querySelector('a#dlink')?.getAttribute('href');
    if (link) {
      return {
        url: new URL(link, page).href,
        filename: body.get('fname') || undefined,
        // Free downloads: one connection, which the server limits to about 100 KB/s.
        maxConnections: 1,
      };
    }

    const said = second.querySelector('.alert-danger strong')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const wait = said.match(/wait (.+?) till next download/i)?.[1];
    if (wait && seconds(wait) > 0) {
      throw zoo.fail(`KatFile allows one free download every 2 hours; the next one in ${wait}`, {
        hint: PREMIUM,
        retryAfter: seconds(wait) + SLACK,
      });
    }
    if (/download-limit/i.test(said)) throw zoo.fail('the daily KatFile free download limit is used up', { hint: `try again tomorrow; ${PREMIUM}` });
    if (said) throw zoo.fail(`KatFile: ${said.replace(/Download files instantly with Premium-account\.?$/i, '').trim()}`);
    throw zoo.fail('download link not found', { hint: 'the page layout may have changed; the module needs an update' });
  },
});
