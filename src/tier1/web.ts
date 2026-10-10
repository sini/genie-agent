// Tier 1's web tools (plan C1). A fetch resolves the name once, refuses any address inside the
// cluster or the host's networks, and connects to exactly the address it checked, so a second
// resolution cannot rebind it. Every result is screened by guard-in before the model sees it.
import { lookup } from "node:dns/promises";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Envelope, Verdict } from "../guard/verdict.ts";
import { verdictErrors } from "../guard/verdict.ts";

export type Address = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<Address[]>;

export const systemResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

// Loopback, this-network (0.0.0.0), RFC1918, CGNAT (the tailnet), link-local, ULA.
const refusedRanges = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

const family = (ip: string): "ipv4" | "ipv6" => (isIP(ip) === 6 ? "ipv6" : "ipv4");

// The refused addresses, plus the cluster's CIDRs. An IPv4-mapped IPv6 address is checked as its
// IPv4 address (BlockList does this).
export function refusedList(cluster: string[]): BlockList {
  const b = new BlockList();
  for (const cidr of [...refusedRanges, ...cluster]) {
    const [net, bits] = cidr.split("/");
    if (!isIP(net) || !/^\d+$/.test(bits ?? "")) throw new Error(`not a CIDR: ${cidr}`);
    b.addSubnet(net, Number(bits), family(net));
  }
  return b;
}

export interface FetchOptions {
  resolve: Resolver;
  refused: BlockList;
  // Addresses let through the refusal. Tests only: production leaves it empty.
  exempt?: string[];
  maxBytes: number;
  timeoutMs: number;
}

const MAX_REDIRECTS = 3;

// The checked address the request connects to.
async function pin(u: URL, o: FetchOptions): Promise<Address> {
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await o.resolve(host);
  if (addrs.length === 0) throw new Error(`${host} does not resolve`);
  for (const a of addrs) {
    if (!o.exempt?.includes(a.address) && o.refused.check(a.address, family(a.address)))
      throw new Error(`refused: ${host} resolves to ${a.address}, a private or cluster address`);
  }
  return addrs[0];
}

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

// guard-in's input for web content. svc:genie-guard's envelope names its sources; "web" is this one.
export type WebEnvelope = Omit<Envelope, "source"> & { source: "web" };
export type Screen = (e: WebEnvelope) => Promise<Verdict>;

// The text the model may see: the fetched text on allow, the guard's cleaned_text on rewrite.
// A reject, a reply that is not a verdict, or no reply at all withholds it.
export async function screened(screen: Screen, text: string): Promise<string> {
  const withheld = (why: string) => new Error(`web content withheld: ${why}`);
  let v: Verdict;
  try {
    v = await screen({ source: "web", history: [], content: { text } });
  } catch (e) {
    throw withheld(`the guard is unavailable (${e instanceof Error ? e.message : e})`);
  }
  if (verdictErrors(v).length) throw withheld("the guard's reply is not a verdict");
  if (v.verdict === "allow") return text;
  if (v.verdict === "rewrite") return v.cleaned_text;
  throw withheld("the guard rejected it");
}
