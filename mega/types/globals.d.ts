/**
 * The global Web APIs a zoo-downloader site module can use, on top of standard JavaScript.
 * Exactly these exist at runtime (a test keeps this file and the host in sync). Anything not
 * declared here, such as `document`, `window`, `localStorage`, `WebSocket`, `Blob`,
 * `XMLHttpRequest`, Node's `require`/`process` or Deno's `Deno`, does not exist.
 *
 * Use with `"lib": ["ES2023"]` and `"types": []` so the browser's lib.dom does not leak in.
 */

// ── Console ──

interface Console {
  log(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
declare var console: Console;

// ── Timers and scheduling ──

declare function setTimeout<A extends unknown[]>(callback: (...args: A) => void, ms?: number, ...args: A): number;
declare function setInterval<A extends unknown[]>(callback: (...args: A) => void, ms?: number, ...args: A): number;
declare function clearTimeout(id: number | undefined): void;
declare function clearInterval(id: number | undefined): void;
declare function queueMicrotask(callback: () => void): void;
declare function structuredClone<T>(value: T): T;

interface Performance {
  readonly timeOrigin: number;
  /** Milliseconds since the call started. */
  now(): number;
}
declare var performance: Performance;
declare var self: typeof globalThis;

// ── Encoding ──

declare function atob(data: string): string;
declare function btoa(data: string): string;

declare class TextEncoder {
  readonly encoding: "utf-8";
  encode(input?: string): Uint8Array;
  encodeInto(input: string, destination: Uint8Array): { read: number; written: number };
}

/** UTF-8 only. */
declare class TextDecoder {
  constructor(label?: "utf-8" | "utf8", options?: { fatal?: boolean });
  readonly encoding: "utf-8";
  readonly fatal: boolean;
  decode(input?: ArrayBuffer | ArrayBufferView): string;
}

// ── URL ──

declare class URL {
  constructor(url: string | URL, base?: string | URL);
  static canParse(url: string | URL, base?: string | URL): boolean;
  static parse(url: string | URL, base?: string | URL): URL | null;
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
  toJSON(): string;
}

declare class URLSearchParams {
  constructor(init?: string | Record<string, string> | Iterable<[string, string]> | URLSearchParams);
  readonly size: number;
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  forEach(callback: (value: string, key: string, parent: URLSearchParams) => void): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
  toString(): string;
}

// ── Events and cancellation ──

declare class DOMException extends Error {
  constructor(message?: string, name?: string);
}

declare class Event {
  constructor(type: string);
  readonly type: string;
  readonly target: EventTarget | null;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

declare class EventTarget {
  addEventListener(type: string, listener: ((event: Event) => void) | null, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: ((event: Event) => void) | null): void;
  dispatchEvent(event: Event): boolean;
}

declare class AbortSignal extends EventTarget {
  private constructor();
  readonly aborted: boolean;
  readonly reason: unknown;
  onabort: ((event: Event) => void) | null;
  throwIfAborted(): void;
  static abort(reason?: unknown): AbortSignal;
  /** Aborts with a `TimeoutError` after `ms`. */
  static timeout(ms: number): AbortSignal;
  static any(signals: Iterable<AbortSignal>): AbortSignal;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

// ── fetch ──

type HeadersInit = Headers | Record<string, string> | Iterable<[string, string]>;

declare class Headers {
  constructor(init?: HeadersInit);
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  /** Every `Set-Cookie` header separately (cookies are also kept for the call automatically). */
  getSetCookie(): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(callback: (value: string, key: string, parent: Headers) => void): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

/** String fields only (no files). Sent as multipart/form-data. */
declare class FormData {
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  entries(): IterableIterator<[string, string]>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

type BodyInit = string | URLSearchParams | FormData | ArrayBuffer | ArrayBufferView;

interface RequestInit {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | (string & {});
  headers?: HeadersInit;
  body?: BodyInit | null;
  /** `follow` (default) follows up to 20 redirects, each checked against allowDomains. */
  redirect?: "follow" | "manual" | "error";
  signal?: AbortSignal | null;
}

interface ResponseInit {
  status?: number;
  statusText?: string;
  headers?: HeadersInit;
}

/** Bodies are read whole (at most 16 MB); there is no streaming `body`. */
declare class Response {
  constructor(body?: BodyInit | null, init?: ResponseInit);
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Headers;
  /** The final URL, after redirects. */
  readonly url: string;
  readonly redirected: boolean;
  readonly type: "basic" | "default";
  readonly bodyUsed: boolean;
  text(): Promise<string>;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  clone(): Response;
  static json(data: unknown, init?: ResponseInit): Response;
  static error(): Response;
  static redirect(url: string | URL, status?: number): Response;
}

/**
 * Like the browser's fetch, minus CORS: you can read any response. Only hosts in manifest
 * `permissions.network.allowDomains` are reachable; others reject with a TypeError that says
 * what to add. Sends a browser User-Agent unless you set one.
 */
declare function fetch(input: string | URL | { url: string }, init?: RequestInit): Promise<Response>;

// ── crypto ──

interface SubtleCrypto {
  digest(algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512" | { name: string }, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
}

interface Crypto {
  getRandomValues<T extends Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | BigInt64Array | BigUint64Array>(array: T): T;
  randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
  /** Hashing only. */
  readonly subtle: SubtleCrypto;
}
declare var crypto: Crypto;

// ── HTML parsing (DOMParser; implemented by linkedom, no layout, no scripts) ──

interface DOMNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly parentNode: DOMNode | null;
  readonly parentElement: DOMElement | null;
  readonly childNodes: ArrayLike<DOMNode> & Iterable<DOMNode>;
  readonly firstChild: DOMNode | null;
  readonly lastChild: DOMNode | null;
  readonly nextSibling: DOMNode | null;
  readonly previousSibling: DOMNode | null;
  textContent: string | null;
}

interface DOMParentNode {
  readonly children: ArrayLike<DOMElement> & Iterable<DOMElement>;
  readonly firstElementChild: DOMElement | null;
  readonly lastElementChild: DOMElement | null;
  querySelector(selectors: string): DOMElement | null;
  querySelectorAll(selectors: string): ArrayLike<DOMElement> & Iterable<DOMElement>;
  getElementsByTagName(name: string): ArrayLike<DOMElement> & Iterable<DOMElement>;
  getElementsByClassName(names: string): ArrayLike<DOMElement> & Iterable<DOMElement>;
}

interface DOMElement extends DOMNode, DOMParentNode {
  readonly tagName: string;
  readonly localName: string;
  id: string;
  className: string;
  readonly classList: { contains(token: string): boolean; readonly length: number } & Iterable<string>;
  readonly attributes: ArrayLike<{ name: string; value: string }> & Iterable<{ name: string; value: string }>;
  readonly dataset: Record<string, string | undefined>;
  innerHTML: string;
  readonly outerHTML: string;
  readonly nextElementSibling: DOMElement | null;
  readonly previousElementSibling: DOMElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getAttributeNames(): string[];
  closest(selectors: string): DOMElement | null;
  matches(selectors: string): boolean;
}

interface DOMDocument extends DOMNode, DOMParentNode {
  readonly documentElement: DOMElement;
  readonly head: DOMElement;
  readonly body: DOMElement;
  title: string;
  getElementById(id: string): DOMElement | null;
}

declare class DOMParser {
  /** Parses HTML or XML. Scripts in it never run. */
  parseFromString(source: string, type: "text/html" | "text/xml" | "application/xml" | "image/svg+xml"): DOMDocument;
}
