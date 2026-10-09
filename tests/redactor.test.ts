// The redactor's gating oracle: every credential shape is redacted and named, and clean text
// passes byte-identical. Run with `node --test tests/redactor.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, secretLineHashes } from "../src/redactor/index.ts";

// Token bodies are generated, never written down, so the repository holds no token-shaped
// literal for a secret scanner to flag.
function rand(n: number, alphabet: string, seed: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    s += alphabet[seed % alphabet.length];
  }
  return s;
}
const b62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const b64url = b62 + "-_";
const b64 = b62 + "+/";
const bech32 = "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L";
const keyBody = (seed: number) =>
  Array.from({ length: 4 }, (_, i) => rand(64, b64, seed + i)).join("\n");

const shapes: { kind: string; secret: string }[] = [
  { kind: "claude-oauth-token", secret: `sk-ant-oat01-${rand(95, b64url, 1)}AA` },
  { kind: "anthropic-api-key", secret: `sk-ant-api03-${rand(95, b64url, 2)}AA` },
  { kind: "github-pat", secret: `github_pat_${rand(22, b62, 3)}_${rand(59, b62, 4)}` },
  ...["ghp", "gho", "ghs", "ghu"].map((p, i) => ({
    kind: "github-token",
    secret: `${p}_${rand(36, b62, 10 + i)}`,
  })),
  {
    kind: "matrix-access-token",
    secret: `syt_${btoa("genie-bot").replace(/=+$/, "")}_${rand(20, b62, 5)}_${rand(6, b62, 6)}`,
  },
  {
    kind: "ssh-private-key",
    secret: `-----BEGIN OPENSSH PRIVATE KEY-----\n${keyBody(20)}\n-----END OPENSSH PRIVATE KEY-----`,
  },
  {
    kind: "pem-private-key",
    secret: `-----BEGIN PRIVATE KEY-----\n${keyBody(30)}\n-----END PRIVATE KEY-----`,
  },
  {
    kind: "pem-private-key",
    secret: `-----BEGIN RSA PRIVATE KEY-----\n${keyBody(40)}\n-----END RSA PRIVATE KEY-----`,
  },
  { kind: "age-secret-key", secret: `AGE-SECRET-KEY-1${rand(58, bech32, 7)}` },
];

for (const { kind, secret } of shapes) {
  test(`redacts ${kind} (${secret.slice(0, 14)})`, () => {
    const { text, hits } = redact(`here it is: ${secret} -- done`);
    assert.equal(text, `here it is: [redacted:${kind}] -- done`);
    assert.deepEqual(hits, [{ kind }]);
  });
}

for (const [label, input, expected] of [
  ["bearer", "Authorization: Bearer X", "Authorization: Bearer [redacted:generic-secret]"],
  ["assignment", "GARAGE_SECRET_KEY=X", "GARAGE_SECRET_KEY=[redacted:generic-secret]"],
  ["yaml", 'password: "X"', 'password: "[redacted:generic-secret]"'],
] as const) {
  test(`redacts a generic high-entropy secret (${label})`, () => {
    const secret = rand(40, b62, 8);
    const { text, hits } = redact(input.replace("X", secret));
    assert.equal(text, expected);
    assert.deepEqual(hits, [{ kind: "generic-secret" }]);
  });
}

test("redacts a truncated key block to the end of the text", () => {
  // An eval's stdout_tail can cut a key block before its END line.
  const { text, hits } = redact(`tail: -----BEGIN EC PRIVATE KEY-----\n${keyBody(50)}\nMIIE`);
  assert.equal(text, "tail: [redacted:pem-private-key]");
  assert.deepEqual(hits, [{ kind: "pem-private-key" }]);
});

test("redacts lines and words of a known secret file by hash", () => {
  const line = `db_url = postgres://genie:${rand(12, b62, 9)}@db`;
  const word = rand(24, b62, 10);
  const hashes = secretLineHashes(`{\n  ${line}\n${word}\n}\n`);
  const { text, hits } = redact(`config:\n    ${line}  \nthe value "${word}", ok\n}`, {
    secretFileHashes: hashes,
  });
  assert.equal(text, `config:\n[redacted:secret-file]\nthe value "[redacted:secret-file]", ok\n}`);
  assert.deepEqual(hits, [{ kind: "secret-file" }, { kind: "secret-file" }]);
});

// Everything a support answer legitimately carries: revs, store paths, hashes, token prose.
const clean = `Pin nixpkgs at e7439b6b14ad3cc35d05608ebca9bce01a25f5f8, narHash
sha256-gRZ/s8WQJ2CsXdhcDVQH34qxuL0MuMCOs3aBiK1Prsw=, store path
/nix/store/9krlzvny65gdc8s7kpb6lkx8cd02c25b-hello-2.12.1. The access token expires hourly;
set GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }} and a password: hunter2. Keys start with
sk-ant- or ghp_, and a key block opens with -----BEGIN but this one is prose.
The token count is 145408.\r\nunicode: déjà vu — ✓\n`;

test("clean control passes byte-identical", () => {
  const { text, hits } = redact(clean, { secretFileHashes: secretLineHashes("unrelated-secret\n") });
  assert.equal(text, clean);
  assert.deepEqual(hits, []);
});
