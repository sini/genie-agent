// The local eval runner: one launch (an eval-request and its sender tier) evaluated by Nix inside bubblewrap, starting from an
// empty throwaway store, and reported as an eval-result.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";

export type Tier = "public" | "trusted";

// schemas/eval-request.json
export interface EvalRequest {
  repo: string;
  rev: string;
  attr: string;
  trusted: "yes" | "no";
}

// schemas/launch.json: what the launcher accepts. sender_tier is the thread's, from the supervisor.
export interface Launch {
  request: EvalRequest;
  sender_tier: Tier;
}

// schemas/eval-result.json
export interface EvalResult {
  exit: number;
  stdout_tail: string;
  stderr_tail: string;
  limit_hit: "none" | "oom" | "timeout" | "egress";
}

export interface RunOptions {
  timeoutMs?: number;
  // A local flake directory evaluated in place of github:<repo>/<rev>. Tests only.
  localFlake?: string;
}

export const TAIL_CHARS = 4096;

// The sender tier is the authenticated sender's; the request can only lower it (gate F1): only "yes" on a
// trusted tier runs trusted.
export const effectiveTier = ({ request, sender_tier }: Launch): Tier =>
  sender_tier === "trusted" && request.trusted === "yes" ? "trusted" : "public";

const tail = (s: string) => s.slice(-TAIL_CHARS);

const which = (name: string): string => {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = `${dir}/${name}`;
    if (dir && existsSync(p)) return realpathSync(p);
  }
  throw new Error(`${name} not found on PATH`);
};

// The model writes the request; nothing in it may reach Nix as anything but a github coordinate.
const coordinate = /^[A-Za-z0-9._-]+$/;

export function nixArgv(launch: Launch, flakeRef: string): string[] {
  const { request } = launch;
  const settings = {
    "pure-eval": "true",
    "allow-import-from-derivation": effectiveTier(launch) === "trusted" ? "true" : "false",
    builders: "",
    substituters: "",
    "accept-flake-config": "false",
  };
  const options = Object.entries(settings).flatMap(([k, v]) => ["--option", k, v]);
  const command =
    request.attr === "checks"
      ? ["flake", "check", "--no-build", flakeRef]
      : ["eval", `${flakeRef}#${request.attr}`];
  return [
    "--extra-experimental-features",
    "nix-command flakes",
    ...options,
    ...command,
    "--no-write-lock-file",
  ];
}

export async function runEval(launch: Launch, options: RunOptions = {}): Promise<EvalResult> {
  const { request } = launch;
  const [owner, name, ...rest] = request.repo.split("/");
  if (!options.localFlake && !(rest.length === 0 && [owner, name, request.rev].every((s) => coordinate.test(s ?? "")))) {
    throw new Error(`not a github coordinate: ${request.repo}/${request.rev}`);
  }
  const flakeRef = options.localFlake ? "path:/src" : `github:${request.repo}/${request.rev}`;
  const nix = which("nix");
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-eval-`);
  // ponytail: the whole host store is bound read-only for the nix binary's closure; bind only that
  // closure if this runner leaves the gVisor Job.
  const bwrap = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--clearenv",
    "--ro-bind", "/nix/store", "/nix/store",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind-try", "/etc/ssl/certs", "/etc/ssl/certs",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    // The throwaway store sits at a fixed jail path, so it never nests inside a host build dir.
    "--bind", tmp, "/work",
    ...(options.localFlake ? ["--ro-bind", options.localFlake, "/src"] : []),
    "--setenv", "HOME", "/work/home",
    "--setenv", "XDG_CACHE_HOME", "/work/cache",
    "--setenv", "NIX_PATH", "",
    "--setenv", "NIX_CONF_DIR", "/work/conf",
    "--setenv", "NIX_STORE_DIR", "/work/nix/store",
    "--setenv", "NIX_STATE_DIR", "/work/nix/var",
    "--setenv", "NIX_LOG_DIR", "/work/nix/log",
    "--setenv", "NIX_SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt",
    nix,
    ...nixArgv(launch, flakeRef),
  ];
  try {
    return await new Promise<EvalResult>((resolve, reject) => {
      const child = spawn(which("bwrap"), bwrap, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs ?? 120_000,
        killSignal: "SIGKILL",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout = tail(stdout + d)));
      child.stderr.on("data", (d) => (stderr = tail(stderr + d)));
      child.on("error", reject);
      // A killed child has no exit code; 124 is timeout(1)'s. E2 classifies limit_hit.
      child.on("close", (code) =>
        resolve({ exit: code ?? 124, stdout_tail: stdout, stderr_tail: stderr, limit_hit: "none" }),
      );
    });
  } finally {
    // Store paths are read-only; make them writable so the store can be deleted.
    await new Promise((r) => spawn("chmod", ["-R", "u+w", tmp]).on("close", r));
    rmSync(tmp, { recursive: true, force: true });
  }
}
