// The local eval runner: one launch (an eval-request and its sender tier) evaluated by Nix inside bubblewrap, starting from an
// empty throwaway store, and reported as an eval-result.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";

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

// schemas/eval-result.json's limit_hit enum, which tests/eval-limits.test.ts holds equal to this.
export const LIMITS = ["none", "oom", "timeout", "egress", "unknown"] as const;

// schemas/eval-result.json
export interface EvalResult {
  exit: number;
  stdout_tail: string;
  stderr_tail: string;
  limit_hit: (typeof LIMITS)[number];
}

export interface RunOptions {
  timeoutMs?: number;
  // A local flake directory evaluated in place of github:<repo>/<rev>. Tests only.
  localFlake?: string;
  // The remote builders a trusted eval builds its IFD on (design §5.3), in Nix's `builders` syntax:
  // the launcher's deployment config, never the request. Unset, a trusted eval builds in its own store.
  builders?: string;
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

// The effective tier is the only thing that opens the trusted path; a public eval's argv is E1's.
export function nixArgv(launch: Launch, flakeRef: string, builders = ""): string[] {
  const { request } = launch;
  const trusted = effectiveTier(launch) === "trusted";
  const settings = {
    "pure-eval": "true",
    "allow-import-from-derivation": trusted ? "true" : "false",
    builders: trusted ? builders : "",
    substituters: "",
    "accept-flake-config": "false",
    // No indirect flake reference resolves: the global registry is a moving URL.
    "flake-registry": "",
    // Seconds. A network that drops packets is egress, not timeout: Nix's 5 download attempts at this
    // plus its backoff (~31 s measured) end inside the shortest runner deadline, the tests' 60 s.
    "connect-timeout": "5",
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

// The whole environment of bwrap and of the Nix it runs: built from nothing, never from process.env, so
// nothing of the thread reaches the evaluation. Every path is the throwaway's or the jail's own.
const JAIL_ENV: Record<string, string> = {
  // Nix reads its user registry and config under HOME and caches fetches under XDG_CACHE_HOME.
  HOME: "/work/home",
  XDG_CACHE_HOME: "/work/cache",
  // No search path: <nixpkgs> names nothing.
  NIX_PATH: "",
  // No nix.conf and no system registry: the conf dir is empty.
  NIX_CONF_DIR: "/work/conf",
  // The throwaway store.
  NIX_STORE_DIR: "/work/nix/store",
  NIX_STATE_DIR: "/work/nix/var",
  NIX_LOG_DIR: "/work/nix/log",
  // TLS for fetching the github coordinate.
  NIX_SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
};

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
    "--ro-bind", "/nix/store", "/nix/store",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind-try", "/etc/ssl/certs", "/etc/ssl/certs",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    // The throwaway store sits at a fixed jail path, so it never nests inside a host build dir.
    "--bind", tmp, "/work",
    ...(options.localFlake ? ["--ro-bind", options.localFlake, "/src"] : []),
    nix,
    ...nixArgv(launch, flakeRef, options.builders),
  ];
  const cg = evalCgroup();
  // The whole cgroup's count: the only one without an eval cgroup, and the fallback when systemd takes
  // back the controllers of a cgroup it writes but never delegated, which removes the eval's memory.events.
  const whole = cg ? cgroupParent : null;
  const oomBefore = oomKills(whole);
  try {
    // In its own cgroup, bwrap is moved there before it runs, so every process of the eval is in it.
    const [command, args] = cg
      ? [which("sh"), ["-c", 'echo 0 > "$0/cgroup.procs" && exec "$@"', cg, which("bwrap"), ...bwrap]]
      : [which("bwrap"), bwrap];
    return await new Promise<EvalResult>((resolve, reject) => {
      const child = spawn(command, args, {
        env: JAIL_ENV,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs ?? 120_000,
        killSignal: "SIGKILL",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout = tail(stdout + d)));
      child.stderr.on("data", (d) => (stderr = tail(stderr + d)));
      child.on("error", reject);
      // A killed child has no exit code; 124 is timeout(1)'s.
      child.on("close", (code, signal) => {
        const exit = code ?? 124;
        // bwrap reports a command killed by SIGKILL as 128 + 9.
        const sigkilled = signal === "SIGKILL" || code === 137;
        const evalOoms = cg ? oomKills(cg) : -1;
        const oomAfter = oomKills(whole);
        const limit_hit = limitHit({
          // Only this runner's own timeout sets `killed`; a kill from anywhere else leaves it false.
          deadline: child.killed,
          sigkilled,
          oomKilled: evalOoms >= 0 ? evalOoms > 0 : oomBefore < 0 || oomAfter < 0 ? null : oomAfter > oomBefore,
          fetchRefused: exit !== 0 && fetchRefused(stderr),
        });
        resolve({ exit, stdout_tail: stdout, stderr_tail: stderr, limit_hit });
      });
    });
  } finally {
    // Store paths are read-only; make them writable so the store can be deleted.
    await new Promise((r) => spawn("chmod", ["-R", "u+w", tmp]).on("close", r));
    rmSync(tmp, { recursive: true, force: true });
    // ponytail: a straggler still in the cgroup leaves it behind, empty once it exits.
    try {
      if (cg) rmdirSync(cg);
    } catch {}
  }
}

// What a backend observed of one finished eval, from which limit_hit is classified. The local runner
// fills it below; the k8s Job (E3) fills it from the Job's deadline, the pod's OOMKilled reason and the
// same Nix fetch error.
export interface LimitObservation {
  // The backend's own deadline killed the eval.
  deadline: boolean;
  // It was SIGKILLed, by the deadline or by anything else.
  sigkilled: boolean;
  // The kernel's OOM killer killed a process of the eval; null when that could not be read.
  oomKilled: boolean | null;
  // A fetch Nix needed failed for want of the network.
  fetchRefused: boolean;
}

// A SIGKILL that is neither the deadline nor a counted OOM kill is unknown: never oom, never none.
export const limitHit = (o: LimitObservation): EvalResult["limit_hit"] =>
  o.deadline ? "timeout" : o.sigkilled ? (o.oomKilled ? "oom" : "unknown") : o.fetchRefused ? "egress" : "none";

// Nix reports a failed download as curl's message and code; 6, 7 and 28 are the network refusing it
// (no name, no connection, no answer), where an HTTP error is the server's.
export const fetchRefused = (stderr: string): boolean => /unable to download '[^']*': .*\((6|7|28)\)/.test(stderr);

const ownCgroup = (): string =>
  `/sys/fs/cgroup${readFileSync("/proc/self/cgroup", "utf8").match(/^0::(.*)$/m)?.[1]}`;

// The OOM kills so far in an eval's cgroup (v2), else this process's; -1 when unreadable, so no eval is classified oom without it.
// ponytail: without a cgroup of its own (below) the count is the shared cgroup's, which bwrap and Nix
// inherit, so a concurrent eval's OOM kill can be read as this one's when this one was also SIGKILLed.
const oomKills = (cg?: string | null): number => {
  try {
    return Number(readFileSync(`${cg ?? ownCgroup()}/memory.events`, "utf8").match(/^oom_kill (\d+)$/m)?.[1] ?? -1);
  } catch {
    return -1;
  }
};

// A fresh cgroup for one eval, under this process's own when that is delegated to it (systemd
// Delegate=yes); null otherwise: a session scope, a container's read-only cgroupfs. cgroup v2 admits
// no process beside a child with controllers, so this process first moves to a leaf of its own, and
// back if the memory controller still cannot be enabled. Decided once per process, by writing: a systemd
// cgroup the user owns but was not delegated passes too, and systemd may disable its controllers mid-eval.
let cgroupParent: string | null | undefined;
const evalCgroup = (): string | null => {
  if (cgroupParent === undefined) {
    cgroupParent = null;
    const own = existsSync("/proc/self/cgroup") ? ownCgroup() : "";
    try {
      mkdirSync(`${own}/genie-runner`);
      writeFileSync(`${own}/genie-runner/cgroup.procs`, "0");
      writeFileSync(`${own}/cgroup.subtree_control`, "+memory");
      cgroupParent = own;
    } catch {
      try {
        writeFileSync(`${own}/cgroup.procs`, "0");
      } catch {}
    }
  }
  try {
    return cgroupParent && mkdtempSync(`${cgroupParent}/eval-`);
  } catch {
    return null;
  }
};
