// The gist action (plan A2, design §5.6): one `POST /gists` as genie-bot, with the token A1's
// broker read. A kind-dispatching Act hosts this beside A3's PR action.
//
// Gists default to SECRET (`public: false`); publishing requires explicit `public: true`. A secret gist is unlisted, not private: anyone holding the
// URL reads it, so guard-out judges it as a publication all the same. Its audience is the thread
// the URL is posted to, and unlisting keeps one asker's repro off genie-bot's public listing.
//
// The title is the description, a one-line field. The body is the gist's README.md, so it renders
// as markdown beside the files; an empty body adds no file, since GitHub refuses empty content.
//
// No retry: a non-2xx (a 403 or 429 carries its rate-limit headers into the message), a network
// error or a response without `html_url` throws, and the broker records it as not acted. The
// token is only ever in the Authorization header; a message that echoes it is scrubbed by the
// broker, which is the only thing the error reaches.
import {
  DEFAULT_BOT_LOGIN, GIST_READ_MAX_BYTES, GIST_METADATA_MAX_BYTES,
  ensureBotIdentity, normalizeGistId, type Act, type GistReadResult,
} from "./index.ts";

export const README = "README.md";

export interface GistOptions {
  botLogin?: string;
  forbiddenLogins?: string[];
}

export function gist(base = "https://api.github.com", timeoutMs = 30_000, opts: GistOptions = {}): Act {
  return async (p, token, _thread, verifiedIdentity) => {
    if (p.kind !== "gist") throw new Error(`gist: cannot act on a ${p.kind} proposal`);
    if (!token) throw new Error("gist: a credential is required");
    const pFiles = p.files ?? {};
    if (p.body && README in pFiles) throw new Error(`gist: the body and a file both claim ${README}`);
    if (opts.botLogin) {
      await ensureBotIdentity(base, token, opts.botLogin, opts.forbiddenLogins ?? [], timeoutMs, verifiedIdentity);
    }
    const files = Object.fromEntries(Object.entries(pFiles).map(([name, content]) => [name, { content }]));
    if (p.body) files[README] = { content: p.body };
    const res = await fetch(`${base}/gists`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ description: p.title, public: p.public === true, files }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error("gist: HTTP redirect refused");
    }
    const text = await res.text();
    if (!res.ok) {
      const limit = ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]
        .filter((h) => res.headers.has(h))
        .map((h) => `${h}=${res.headers.get(h)}`);
      throw new Error(`gist: HTTP ${res.status}${limit.length ? ` (${limit.join(", ")})` : ""}: ${text.slice(0, 200)}`);
    }
    let url: unknown;
    try {
      url = JSON.parse(text).html_url;
    } catch {}
    if (typeof url !== "string" || !url) throw new Error(`gist: HTTP ${res.status} without html_url`);
    return { url };
  };
}


async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const oversized = () => new Error(`gist: response exceeds ${maxBytes} bytes`);
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && BigInt(length) > BigInt(maxBytes)) {
    await response.body?.cancel();
    throw oversized();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw oversized();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function request(base: string, route: string, token: string, timeoutMs: number, maxBytes: number, method = "GET", payload?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "genie-agent" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (payload !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base.replace(/\/+$/, "")}${route}`, { method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("gist: HTTP redirect refused");
  }
  const text = await boundedText(response, maxBytes);
  if (!response.ok) throw new Error(`gist: HTTP ${response.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error("gist: invalid JSON response"); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("gist: malformed metadata");
  return value as Record<string, unknown>;
}
function canonicalMetadata(value: unknown, id: string): { data: Record<string, unknown>; url: string; owner: string | null } {
  const data = object(value);
  if (typeof data.id !== "string" || normalizeGistId(data.id) !== id || typeof data.html_url !== "string" || normalizeGistId(data.html_url) !== id || !data.html_url.startsWith("https://gist.github.com/")) throw new Error("gist: inconsistent canonical metadata");
  const canonical = new URL(data.html_url); canonical.hash = ""; canonical.search = "";
  const owner = data.owner === null ? null : object(data.owner).login;
  if (owner !== null && (typeof owner !== "string" || owner.length === 0)) throw new Error("gist: invalid owner metadata");
  return { data, url: canonical.toString(), owner: owner as string | null };
}

export function gistRead(base = "https://api.github.com", timeoutMs = 30_000, opts: GistOptions = {}): Act {
  return async (p, token, _thread, verifiedIdentity) => {
    if (p.kind !== "gist_read") throw new Error(`gist_read: cannot act on a ${p.kind} proposal`);
    if (token) {
      await ensureBotIdentity(
        base,
        token,
        opts.botLogin ?? DEFAULT_BOT_LOGIN,
        opts.forbiddenLogins ?? [],
        timeoutMs,
        verifiedIdentity,
      );
    }
    const id = normalizeGistId(p.id);
    const { data, url, owner } = canonicalMetadata(await request(base, `/gists/${id}`, token, timeoutMs, GIST_READ_MAX_BYTES), id);
    if (data.truncated === true || (data.truncated !== undefined && typeof data.truncated !== "boolean")) throw new Error("gist_read: truncated or malformed gist");
    if (data.description !== null && typeof data.description !== "string") throw new Error("gist_read: missing description");
    if (!Array.isArray(data.history) || data.history.length === 0) throw new Error("gist_read: missing revision");
    const revision = object(data.history[0]).version;
    if (typeof revision !== "string" || revision.length === 0) throw new Error("gist_read: missing revision");
    const entries = Object.entries(object(data.files));
    if (!entries.length) throw new Error("gist_read: missing files");
    const files = Object.fromEntries(entries.map(([name, raw]) => {
      const file = object(raw);
      if (file.truncated === true || (file.truncated !== undefined && typeof file.truncated !== "boolean") || typeof file.content !== "string" || (file.filename !== undefined && file.filename !== name)) throw new Error("gist_read: truncated or incomplete file");
      return [name, file.content];
    }));
    const gist: GistReadResult = { untrusted: true, id, url, description: data.description ?? "", owner, revision, files };
    if (new TextEncoder().encode(JSON.stringify(gist)).byteLength > GIST_READ_MAX_BYTES) throw new Error("gist_read: normalized result exceeds byte limit");
    return { url, gist };
  };
}

export function gistUpdate(base = "https://api.github.com", timeoutMs = 30_000, opts: GistOptions = {}): Act {
  return async (p, token, _thread, verifiedIdentity) => {
    if (p.kind !== "gist_update") throw new Error(`gist_update: cannot act on a ${p.kind} proposal`);
    if (!token) throw new Error("gist_update: a credential is required");
    const id = normalizeGistId(p.id);
    const login = await ensureBotIdentity(
      base,
      token,
      opts.botLogin ?? DEFAULT_BOT_LOGIN,
      opts.forbiddenLogins ?? [],
      timeoutMs,
      verifiedIdentity,
    );
    const { url, owner } = canonicalMetadata(await request(base, `/gists/${id}`, token, timeoutMs, GIST_METADATA_MAX_BYTES), id);
    if (owner === null || owner.toLowerCase() !== login.toLowerCase()) throw new Error("gist_update: target is not owned by the authenticated account");
    await request(base, `/gists/${id}`, token, timeoutMs, GIST_METADATA_MAX_BYTES, "PATCH", { ...(p.title === undefined ? {} : { description: p.title }), files: Object.fromEntries(Object.entries(p.files).map(([name, content]) => [name, { content }])) });
    return { url };
  };
}

export function gistComment(base = "https://api.github.com", timeoutMs = 30_000, opts: GistOptions = {}): Act {
  return async (p, token, _thread, verifiedIdentity) => {
    if (p.kind !== "gist_comment") throw new Error(`gist_comment: cannot act on a ${p.kind} proposal`);
    if (!token) throw new Error("gist_comment: a credential is required");
    const id = normalizeGistId(p.id);
    await ensureBotIdentity(
      base,
      token,
      opts.botLogin ?? DEFAULT_BOT_LOGIN,
      opts.forbiddenLogins ?? [],
      timeoutMs,
      verifiedIdentity,
    );
    const { url } = canonicalMetadata(await request(base, `/gists/${id}`, token, timeoutMs, GIST_METADATA_MAX_BYTES), id);
    const receipt = object(await request(base, `/gists/${id}/comments`, token, timeoutMs, GIST_METADATA_MAX_BYTES, "POST", { body: p.body }));
    if (typeof receipt.id !== "number" || !Number.isSafeInteger(receipt.id) || receipt.id <= 0) throw new Error("gist_comment: missing comment ID");
    return { url: `${url}#gistcomment-${receipt.id}` };
  };
}
