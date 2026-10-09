// The output redactor (design §5.2 item 6): the last step before anything posts. It is a
// BACKSTOP. The guarantee is that credentials never enter a model context; this only catches
// what slipped through in a recognisable shape. Private prose is out of its reach by design.
import { createHash } from "node:crypto";

export interface Hit {
  kind: string;
}

export interface RedactOptions {
  // sha256 hex of normalized lines of known secret files, as produced by secretLineHashes.
  secretFileHashes?: Iterable<string>;
}

// One pattern per credential shape this system holds. Order matters: the specific shapes run
// before the generic one, so a known token is named by its kind.
const patterns: { kind: string; re: RegExp }[] = [
  // A key block runs to its END line, or to the end of the text when the output was truncated.
  {
    kind: "ssh-private-key",
    re: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?(?:-----END OPENSSH PRIVATE KEY-----|$)/g,
  },
  {
    kind: "pem-private-key",
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g,
  },
  { kind: "claude-oauth-token", re: /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/g },
  { kind: "anthropic-api-key", re: /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/g },
  { kind: "github-pat", re: /github_pat_[A-Za-z0-9_]{22,}/g },
  { kind: "github-token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  // Synapse: syt_<base64 localpart>_<20 random>_<6 crc>.
  { kind: "matrix-access-token", re: /syt_[A-Za-z0-9+/]+_[A-Za-z0-9]{20}_[A-Za-z0-9]{6}/g },
  { kind: "age-secret-key", re: /AGE-SECRET-KEY-1[0-9A-Z]{50,}/g },
];

// A value in a credential context (`Bearer x`, `token=x`, `SECRET_KEY: "x"`) is redacted when it
// is long and random enough. Bare high-entropy strings are left alone: git revs, store paths and
// narHashes are the substance of a Nix answer.
const generic =
  /\b(bearer|[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential)(?:[_-]?key)?s?)(["']?\s*[:=]\s*["']?|\s+)([A-Za-z0-9+/_.~=-]{16,})/gi;
const minEntropy = 3.0; // bits per char; random base62 of length 16+ sits near 3.7

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const normalize = (line: string) => line.trim().replace(/\s+/g, " ");
const minSecretLine = 8; // a secret file's `}` or blank line must not redact every `}` posted

// The hash set the redactor matches against, computed where the secret file is readable, so the
// redactor itself never holds the secret.
export function secretLineHashes(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(normalize)
    .filter((l) => l.length >= minSecretLine)
    .map(sha256);
}

// ponytail: windows are a whole line or a single word; a multi-word secret line quoted inside a
// longer line is missed. Add every contiguous word span if that shape turns up.
function redactKnown(text: string, known: Set<string>, hits: Hit[]): string {
  const hit = () => {
    hits.push({ kind: "secret-file" });
    return "[redacted:secret-file]";
  };
  return text
    .split(/(\r?\n)/)
    .map((line, i) => {
      if (i % 2 === 1) return line; // a separator
      const n = normalize(line);
      if (n.length >= minSecretLine && known.has(sha256(n))) return hit();
      return line.replace(/\S+/g, (word) => {
        const m = /^([\s"'`([{<]*)(.*?)([\s"'`)\]}>,;.:]*)$/.exec(word)!;
        return m[2].length >= minSecretLine && known.has(sha256(m[2])) ? m[1] + hit() + m[3] : word;
      });
    })
    .join("");
}

export function redact(text: string, opts: RedactOptions = {}): { text: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const known = new Set(opts.secretFileHashes ?? []);
  let out = known.size > 0 ? redactKnown(text, known, hits) : text;
  for (const { kind, re } of patterns) {
    out = out.replace(re, () => {
      hits.push({ kind });
      return `[redacted:${kind}]`;
    });
  }
  out = out.replace(generic, (all, key: string, sep: string, value: string) => {
    if (entropy(value) < minEntropy) return all;
    hits.push({ kind: "generic-secret" });
    return `${key}${sep}[redacted:generic-secret]`;
  });
  return { text: out, hits };
}
