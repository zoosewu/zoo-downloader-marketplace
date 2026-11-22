/**
 * zoo-downloader site module API, level 3 (manifest `apiVersion`).
 *
 * A site module is one ES module file whose default export is `defineModule({ resolve })`.
 * zoo-downloader calls `resolve` with a page URL the user pasted (one that matches the
 * manifest's `urlPatterns`) and downloads whatever direct URL it returns. Links that can hold
 * several files (a shared folder) also implement `list`, which the app calls first.
 *
 * Runtime facts that matter when writing one:
 * - Only `import ... from 'zoo-module'` is allowed. Bundle everything else into the one file.
 * - Globals are Web APIs (see globals.d.ts), not Node or Deno: no `fs`, `process`, `require`.
 * - `fetch` can only reach hosts listed in manifest `permissions.network.allowDomains`
 *   (subdomains included), never private or local addresses. Cookies persist for the call.
 * - Each call runs in a fresh JavaScript context: no state survives between calls.
 * - A call has 30 s of time (excluding `zoo.wait`, captchas and `zoo.ask`) and 128 MB of memory.
 *
 * @example
 * import { defineModule } from 'zoo-module';
 *
 * export default defineModule({
 *   async resolve(url, zoo) {
 *     const page = await fetch(url).then((r) => r.text());
 *     const doc = new DOMParser().parseFromString(page, 'text/html');
 *     const href = doc.querySelector('a.download')?.getAttribute('href');
 *     if (!href) throw zoo.fail('download link not found', { hint: 'the page layout may have changed' });
 *     return { url: new URL(href, url).href, filename: doc.title };
 *   },
 * });
 */
declare module "zoo-module" {
  /** What `resolve` returns: the direct download. */
  export interface Resolved {
    /** Absolute http(s) URL of the file itself. May contain credential placeholders. */
    url: string;
    /** File name to save as. Defaults to the name the server or URL gives. */
    filename?: string;
    /**
     * Headers for every download request (e.g. `Referer`). May contain credential placeholders.
     * If you set no `Cookie`, the cookies this call collected for `url` are sent.
     * Setting `User-Agent` replaces the app's own, for sites that only serve their own client:
     * @example
     * // Baidu Netdisk only serves pcs links to its client.
     * return { url: dlink, headers: { 'User-Agent': 'netdisk;7.42.0.5;PC;PC-Windows;10.0.22631;WindowsBaiduYunGuanJia' } };
     */
    headers?: Record<string, string>;
    /** Size in bytes, if the site tells you before downloading. */
    size?: number;
    /**
     * The most parallel connections the site tolerates. Downloads split a file across several
     * connections (8 by default); sites that throttle or ban that need a lower number.
     */
    maxConnections?: number;
    /**
     * The largest byte range the site serves in one request, in bytes (at least 65536).
     * Downloads fetch a file in ranges (10 MiB by default); sites that refuse larger ranges
     * with 403 need this.
     * @example
     * // Baidu Netdisk refuses ranges over about 4 MiB for non-members.
     * return { url: dlink, maxConnections: 4, maxSegmentSize: 4 * 1024 * 1024 };
     */
    maxSegmentSize?: number;
  }

  /** One file of a link that holds several; what `list` returns. */
  export interface Listed {
    /**
     * A URL for just this file, which `resolve` turns into its download. It must match the
     * manifest's `urlPatterns`; a `#fragment` is a good place for the file's identity because
     * matching and `fetch` ignore it. No credential placeholders: the app stores this URL.
     * @example `${shareUrl}#path=${encodeURIComponent(path)}`
     */
    url: string;
    /** The file's name. */
    filename: string;
    /** Size in bytes, if known. */
    size?: number;
    /** Folder inside the share, `/`-separated (`"photos/2024"`); leave out at the top. */
    folder?: string;
  }

  export interface SiteModule {
    /**
     * Turn a share page URL into a direct download. Throw (preferably `zoo.fail`) when it
     * cannot be done; the message is shown to the user.
     */
    resolve(url: string, zoo: Zoo): Resolved | Promise<Resolved>;
    /**
     * Only for links that can hold several files. Called when the user adds the link: every
     * file you return becomes a download of its own (the user picks which), resolved later by
     * `resolve` with the file's `url`. At most 1000 files. Same limits as `resolve`.
     * Without `list`, a link is one file.
     */
    list?(url: string, zoo: Zoo): Listed[] | Promise<Listed[]>;
  }

  /** `R` with any field `Resolved` does not have turned into an error message (the host rejects them). */
  type OnlyResolvedFields<R> = {
    [K in keyof R]: K extends keyof Resolved ? R[K] : `'${K & string}' is not a Resolved field (url, filename, headers, size, maxConnections, maxSegmentSize)`;
  };

  /** Marks the default export as a site module and type-checks it. Returns `module` unchanged. */
  export function defineModule<R extends Resolved>(module: {
    resolve(url: string, zoo: Zoo): OnlyResolvedFields<R> | Promise<OnlyResolvedFields<R>>;
    list?(url: string, zoo: Zoo): Listed[] | Promise<Listed[]>;
  }): SiteModule;

  /** Platform features that have no Web API equivalent. Passed to `resolve`. */
  export interface Zoo {
    /**
     * An error to throw, with an optional hint telling the user (or you, while developing)
     * what to do about it.
     * @example throw zoo.fail('file was deleted', { hint: 'ask the uploader for a new link' });
     */
    fail(message: string, options?: { hint?: string }): Error;

    /** Diagnostics; visible in the module test output and app logs. Same as `console`. */
    log: ZooLog;

    /** The user's credentials for this site, as placeholders only. */
    credentials: ZooCredentials;

    /** Ask the user to solve a captcha. Time spent here does not count against the limit. */
    captcha: ZooCaptcha;

    /**
     * Ask the user for something only they know, such as a share's extraction code, in a
     * dialog. Resolves with what they typed; throws if they decline. Ask one thing per call;
     * call it again for the next step. Time spent here does not count against the limit.
     * Needs `"apiVersion": 3`.
     *
     * With `remember: true` the app keeps the answer for this download: later calls for it
     * (retries, resuming, an expired link, the files of a listed share) get it back at once
     * without asking. If the answer turns out wrong, ask again with `error`: that always asks.
     * Captchas are never remembered; for values the user keeps for every download (an
     * account), declare manifest `permissions.credentials` instead.
     * @example
     * let code = new URL(url).searchParams.get('pwd')
     *   ?? (await zoo.ask({ id: 'pwd', message: { en: 'Extraction code', 'zh-TW': '提取碼' }, remember: true }));
     * if (!(await verify(code))) {
     *   code = await zoo.ask({ id: 'pwd', message: 'Extraction code', remember: true, error: 'Wrong code, try again' });
     * }
     */
    ask(question: ZooQuestion): Promise<string>;

    /**
     * Wait out a site countdown (e.g. "free users wait 30 seconds"). The app shows it; it does
     * not count against the time limit. At most 600 seconds per call to `wait`.
     * @example await zoo.wait(30, 'free download countdown');
     */
    wait(seconds: number, reason?: string): Promise<void>;
  }

  export interface ZooLog {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  }

  /**
   * Credentials the user entered for keys declared in manifest `permissions.credentials`.
   * You never see the values. `placeholder(key)` returns a stand-in string: put it anywhere in
   * a `fetch` URL, header or body (including `URLSearchParams` and `JSON.stringify` bodies) and
   * the real value is sent, encoded correctly for where it sits. If a response echoes a value
   * back, you see the placeholder instead. Do not transform placeholders (no `btoa`,
   * slicing or hashing): the result will not be recognized.
   */
  export interface ZooCredentials {
    /** Whether the user provided `key`. */
    has(key: string): boolean;
    /**
     * Stand-in for the value of `key`. Throws if the user did not provide it.
     * @example
     * const body = new URLSearchParams({
     *   login: zoo.credentials.placeholder('username'),
     *   password: zoo.credentials.placeholder('password'),
     * });
     * await fetch('https://site.example/login', { method: 'POST', body });
     */
    placeholder(key: string): string;
  }

  /** Text for the user: one string, or one per language (`{ en: '...', 'zh-TW': '...' }`). */
  export type ZooText = string | { [language: string]: string };

  export interface ZooQuestion {
    /** Names the question within this module (`pwd`): 1 to 64 letters, digits, `_` or `-`. */
    id: string;
    /** What to type, at most 300 characters. Line breaks are shown. */
    message: ZooText;
    /** Typed hidden. A remembered secret is kept only while the app runs, never saved. */
    secret?: boolean;
    /** Keep the answer for this download and give it again without asking. */
    remember?: boolean;
    /** Why the last answer did not work (shown above the field); always asks. */
    error?: ZooText;
  }

  export interface ZooCaptcha {
    /**
     * reCAPTCHA v2 on `pageUrl`. Resolves with the `g-recaptcha-response` token to submit.
     * Throws if the user declines.
     */
    recaptcha(options: { siteKey: string; pageUrl: string }): Promise<string>;
    /**
     * An image captcha. The image is fetched with this call's cookies, so captchas tied to the
     * session work. Resolves with the text the user typed; throws if they decline.
     */
    image(imageUrl: string): Promise<string>;
  }
}
