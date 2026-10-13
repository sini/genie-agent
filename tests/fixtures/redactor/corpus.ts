// The credential-shape corpus (plan unit S7, design oracle 2): one planted case per credential this
// system holds, each with near-miss controls that must pass byte-identical. A case names the kinds
// its redaction reports; a control names none.
//
// Token bodies are generated, never written down, so the repository holds no token-shaped
// literal for a secret scanner to flag. Every value is synthetic.

// An LCG mod 2^31, in 32-bit integer arithmetic (a float product passes 2^53 and loses its low
// bits), drawing from the high bits, since the low bits of a power-of-two LCG cycle short.
export function rand(n: number, alphabet: string, seed: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    s += alphabet[(seed >>> 16) % alphabet.length];
  }
  return s;
}
export const b62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const b64url = b62 + "-_";
export const b64 = b62 + "+/";
export const bech32 = "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L";
const hex = "0123456789abcdef";
const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const bytes = (n: number, seed: number) => Buffer.from(rand(2 * n, hex, seed), "hex");

export interface Case {
  id: string;
  shape: string;
  input: string;
  expected: string; // the input itself for a control
  kinds: string[]; // empty for a control
}

// Synapse's access token (synapse/handlers/auth.py generate_access_token):
// syt_<unpadded base64 localpart>_<random_string(20), ascii letters>_<base62 crc32, width 6>.
const syt = (localpart: string, random: number, seed: number) =>
  `syt_${btoa(localpart).replace(/=+$/, "")}_${rand(random, b62, seed)}_${rand(6, b62, seed + 1)}`;

// `claude setup-token`, as CLAUDE_CODE_OAUTH_TOKEN holds it: sk-ant-oat01- and a base64url body.
const oat = (prefix: string, n: number, seed: number) => `${prefix}${rand(n, b64url, seed)}`;

// A fine-grained GitHub PAT: github_pat_ + 22 alnum + _ + 59 alnum.
const pat = (prefix: string, a: number, seed: number) =>
  `${prefix}${rand(a, b62, seed)}_${rand(59, b62, seed + 1)}`;

// xmsg's --fed-key is the PEM rcgen writes for an ed25519 leaf: ring's PKCS#8 v2 template
// (30 51 ... 04 20 <seed> 81 21 00 <public>), base64 wrapped at 64 columns. v1 is openssl's.
const pkcs8v2 = (seed: number) =>
  Buffer.concat([
    Buffer.from("3051020101300506032b657004220420", "hex"),
    bytes(32, seed),
    Buffer.from("812100", "hex"),
    bytes(32, seed + 1),
  ])
    .toString("base64")
    .replace(/.{64}/, "$&\n");
const pkcs8v1 = (seed: number) =>
  Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), bytes(32, seed)]).toString(
    "base64",
  );
const spki = (seed: number) =>
  Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes(32, seed)]).toString(
    "base64",
  );
const pem = (label: string, body: string) =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;

// Garage (src/model/key_table.rs Key::new): GK + hex of 12 random bytes, secret hex of 32 bytes.
const gk = (n: number, seed: number) => `GK${rand(n, hex, seed)}`;

const wrap = (s: string) => `here it is: ${s} -- done`;
const planted = (id: string, shape: string, input: string, expected: string, kinds: string[]) => ({
  id,
  shape,
  input,
  expected,
  kinds,
});
const control = (id: string, shape: string, value: string): Case => ({
  id,
  shape,
  input: wrap(value),
  expected: wrap(value),
  kinds: [],
});

const awsSecret = rand(40, b64, 141);
const garageSecret = rand(64, hex, 152);

export const corpus: Case[] = [
  planted(
    "matrix-1",
    "matrix",
    wrap(syt("genie", 20, 101)),
    wrap("[redacted:matrix-access-token]"),
    ["matrix-access-token"],
  ),
  planted(
    "matrix-2",
    "matrix",
    `Authorization: Bearer ${syt("genie-bot", 20, 103)}`,
    "Authorization: Bearer [redacted:matrix-access-token]",
    ["matrix-access-token"],
  ),
  control("matrix-c1", "matrix", syt("genie", 20, 105).replace(/^syt_/, "syx_")),
  control("matrix-c2", "matrix", syt("genie", 19, 107)),

  planted(
    "claude-1",
    "claude",
    `CLAUDE_CODE_OAUTH_TOKEN=${oat("sk-ant-oat01-", 95, 111)}AA`,
    "CLAUDE_CODE_OAUTH_TOKEN=[redacted:claude-oauth-token]",
    ["claude-oauth-token"],
  ),
  control("claude-c1", "claude", oat("sk-ant-oax01-", 95, 113)),
  control("claude-c2", "claude", oat("sk-ant-oat01-", 19, 115)),

  planted(
    "github-pat-1",
    "github-pat",
    wrap(pat("github_pat_", 22, 121)),
    wrap("[redacted:github-pat]"),
    ["github-pat"],
  ),
  control("github-pat-c1", "github-pat", pat("github_pa_", 22, 123)),
  control("github-pat-c2", "github-pat", `github_pat_${rand(21, b62, 125)}`),

  planted(
    "xmsg-leaf-1",
    "xmsg-leaf",
    wrap(pem("PRIVATE KEY", pkcs8v2(131))),
    wrap("[redacted:pem-private-key]"),
    ["pem-private-key"],
  ),
  planted(
    "xmsg-leaf-2",
    "xmsg-leaf",
    wrap(pkcs8v2(133)),
    wrap("[redacted:ed25519-private-key]"),
    ["ed25519-private-key"],
  ),
  planted(
    "xmsg-leaf-3",
    "xmsg-leaf",
    wrap(pkcs8v1(135)),
    wrap("[redacted:ed25519-private-key]"),
    ["ed25519-private-key"],
  ),
  control("xmsg-leaf-c1", "xmsg-leaf", pem("PUBLIC KEY", spki(137))),
  control("xmsg-leaf-c2", "xmsg-leaf", pkcs8v1(139).slice(0, 63)),

  planted(
    "longhorn-1",
    "longhorn",
    `AWS_ACCESS_KEY_ID: AKIA${rand(16, upper, 143)}`,
    "AWS_ACCESS_KEY_ID: [redacted:aws-access-key-id]",
    ["aws-access-key-id"],
  ),
  planted(
    "longhorn-2",
    "longhorn",
    `AWS_SECRET_ACCESS_KEY: ${awsSecret}`,
    "AWS_SECRET_ACCESS_KEY: [redacted:generic-secret]",
    ["generic-secret"],
  ),
  control("longhorn-c1", "longhorn", `AKIB${rand(16, upper, 145)}`),
  control("longhorn-c2", "longhorn", `AKIA${rand(15, upper, 147)}`),

  planted(
    "garage-1",
    "garage",
    `Key ID: ${gk(24, 151)}\nSecret key: ${garageSecret}`,
    "Key ID: [redacted:garage-key-id]\nSecret key: [redacted:garage-secret-key]",
    ["garage-key-id", "garage-secret-key"],
  ),
  planted(
    "garage-2",
    "garage",
    `export GARAGE_DEFAULT_ACCESS_KEY="${gk(32, 153)}"`,
    'export GARAGE_DEFAULT_ACCESS_KEY="[redacted:garage-key-id]"',
    ["garage-key-id"],
  ),
  planted(
    "garage-3",
    "garage",
    `AWS_SECRET_ACCESS_KEY=${rand(64, hex, 155)}`,
    "AWS_SECRET_ACCESS_KEY=[redacted:generic-secret]",
    ["generic-secret"],
  ),
  control("garage-c1", "garage", gk(23, 157)),
  control("garage-c2", "garage", `gk${rand(24, hex, 159)}`),
  control("garage-c3", "garage", `sha256 digest: ${rand(64, hex, 161)}`),
];
