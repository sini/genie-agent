// The gist action (plan A2, design §5.6): one `POST /gists` as genie-bot, with the token A1's
// broker read. A kind-dispatching Act hosts this beside A3's PR action.
//
// The gist is SECRET (`public: false`). A secret gist is unlisted, not private: anyone holding the
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
import type { Act } from "./index.ts";

export const README = "README.md";

export function gist(base = "https://api.github.com", timeoutMs = 30_000): Act {
  return async (p, token) => {
    if (p.kind !== "gist") throw new Error(`gist: cannot act on a ${p.kind} proposal`);
    if (p.body && README in p.files) throw new Error(`gist: the body and a file both claim ${README}`);
    const files = Object.fromEntries(Object.entries(p.files).map(([name, content]) => [name, { content }]));
    if (p.body) files[README] = { content: p.body };
    const res = await fetch(`${base}/gists`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ description: p.title, public: false, files }),
      signal: AbortSignal.timeout(timeoutMs),
    });
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
