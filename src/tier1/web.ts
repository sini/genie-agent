// Tier 1's web tools (plan C1). A fetch resolves the name once, refuses any address inside the
// cluster or the host's networks, and connects to exactly the address it checked, so a second
// resolution cannot rebind it. Every result is screened by guard-in before the model sees it, on
// the supervisor's side of the bridge (Host.screen).
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import type { BlockList } from "node:net";
import {
  type Address,
  type PinOptions,
  type Resolver,
  pin,
  refusedList,
  systemResolver,
} from "../mirror/index.ts";

export { type Address, type PinOptions, type Resolver, pin, refusedList, systemResolver };

export interface FetchOptions extends PinOptions {
  resolve: Resolver;
  refused: BlockList;
  // Addresses let through the refusal. Tests only: production leaves it empty.
  exempt?: string[];
  maxBytes: number;
  timeoutMs: number;
}

const MAX_REDIRECTS = 3;

const textual = (type: string) => /^text\//.test(type) || /^application\/([\w.+-]*\+)?json$/.test(type);

type Response = { status: number; location?: string; type: string; body: Uint8Array; truncated: boolean };

function request(u: URL, a: Address, o: FetchOptions): Promise<Response> {
  const get = u.protocol === "https:" ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const req = get(
      u,
      {
        headers: { accept: "text/*, application/json" },
        timeout: o.timeoutMs,
        // The connection goes to the checked address; TLS still verifies the URL's name.
        lookup: (_host, opts, cb) => (opts.all ? cb(null, [a]) : cb(null, a.address, a.family)),
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if ((status >= 300 && status < 400) || !textual(type)) {
          res.destroy();
          return resolve({ status, location: typeof location === "string" ? location : undefined, type, body: new Uint8Array(), truncated: false });
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const done = (truncated: boolean) => {
          const body = new Uint8Array(size);
          let at = 0;
          for (const c of chunks) {
            body.set(c, at);
            at += c.length;
          }
          resolve({ status, type, body: body.subarray(0, o.maxBytes), truncated });
        };
        res.on("data", (c: Uint8Array) => {
          chunks.push(c);
          size += c.length;
          if (size > o.maxBytes) {
            res.destroy();
            done(true);
          }
        });
        res.on("end", () => done(false));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${o.timeoutMs} ms`)));
    req.on("error", reject);
  });
}

// HTML as its text: no scripts, styles, comments or tags, entities decoded, blank runs collapsed.
export function htmlToText(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(p|div|br|li|tr|h[1-6]|pre|section|article|header|footer|table|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(Number(e[1] === "x" || e[1] === "X" ? `0${e.slice(1)}` : e.slice(1))) : (entities[e.toLowerCase()] ?? m),
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The text at url, following at most three redirects, each one checked as the first was.
export async function fetchText(url: string, o: FetchOptions): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  for (let hop = 0; ; hop++) {
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`refused: only http and https URLs, not ${u.protocol}`);
    if (u.username || u.password) throw new Error("refused: credentials in the URL");
    const r = await request(u, await pin(u, o), o);
    if (r.status >= 300 && r.status < 400 && r.location) {
      if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
      u = new URL(r.location, u);
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    if (!textual(r.type)) throw new Error(`refused: content type ${r.type || "none"} is not text or JSON`);
    // ponytail: decoded as UTF-8 whatever the charset; honour the charset if a source needs it.
    const text = new TextDecoder().decode(r.body);
    const out = r.type === "text/html" ? htmlToText(text) : text;
    return r.truncated ? `${out}\n[truncated at ${o.maxBytes} bytes]` : out;
  }
}

// The top `n` SearXNG results for `query`, as title, url and snippet.
export async function search(searxngUrl: string, query: string, n: number, timeoutMs: number): Promise<string> {
  const url = `${searxngUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`search: HTTP ${res.status}`);
  const results = (await res.json())?.results;
  if (!Array.isArray(results)) throw new Error("search: the reply has no results list");
  if (results.length === 0) return "no results";
  return results
    .slice(0, n)
    .map((r: any) => `${r.title ?? ""}\n${r.url ?? ""}\n${r.content ?? ""}`)
    .join("\n\n");
}
