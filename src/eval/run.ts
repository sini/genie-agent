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
  secrets?: "stub" | "none";
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
  // Bytes. The eval's own cgroup's memory.max, so an eval's OOM kill bounds the eval and never the runner
  // that reports on it. It needs a cgroup per eval (below): without one the runner refuses to run rather
  // than run the eval uncapped or capped together with itself.
  memoryMax?: number;
  // Optional CA bundle file override. Tests only.
  caBundle?: string;
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

// Generates a Nix wrapper expression to evaluate a NixOS configuration with agenix and sops-nix
// secret paths overridden to placeholder store files and placeholder values substituted (plan E5, design §5.7).
export function wrapperForNixOS(subpath: string): string {
  const targetAccess = subpath ? `extended.${subpath}` : "extended";
  return `host:
let
  placeholderFile = builtins.toFile "placeholder" "placeholder-secret\\n";
  placeholderStr = "<placeholder>";
  stubSecrets = secrets:
    if builtins.isAttrs secrets
    then builtins.mapAttrs (_: s: if builtins.isAttrs s then s // { path = placeholderFile; value = placeholderStr; } else s) secrets
    else secrets;
  extended =
    if host ? extendModules then
      host.extendModules {
        modules = [
          ({ lib ? null, ... }:
          let
            force = if lib ? mkForce then lib.mkForce else (x: x);
          in {
            age.secrets = builtins.mapAttrs (_: _: {
              path = force placeholderFile;
            }) (host.config.age.secrets or {});
            sops.secrets = builtins.mapAttrs (_: _: {
              path = force placeholderFile;
            }) (host.config.sops.secrets or {});
            sops.placeholder = builtins.mapAttrs (name: _:
              "<placeholder:\${name}>"
            ) (host.config.sops.secrets or {});
          })
        ];
      }
    else if host ? config then
      host // {
        config = host.config // {
          age = (host.config.age or {}) // {
            secrets = stubSecrets (host.config.age.secrets or {});
          };
          sops = (host.config.sops or {}) // {
            secrets = stubSecrets (host.config.sops.secrets or {});
            placeholder = (builtins.mapAttrs (name: _: "<placeholder:\${name}>") (host.config.sops.secrets or {})) // (host.config.sops.placeholder or {});
          };
        };
      }
    else
      host;
in
  ${targetAccess}`;
}

export function wrapperForTarget(): string {
  return `target:
let
  placeholderFile = builtins.toFile "placeholder" "placeholder-secret\\n";
  placeholderStr = "<placeholder>";
  stubSecrets = secrets:
    if builtins.isAttrs secrets
    then builtins.mapAttrs (_: s: if builtins.isAttrs s then s // { path = placeholderFile; value = placeholderStr; } else s) secrets
    else secrets;
in
  if builtins.isAttrs target && (target ? path || target ? file) then
    target // {
      path = placeholderFile;
      value = placeholderStr;
    }
  else if builtins.isAttrs target && target ? secrets then
    target // { secrets = stubSecrets target.secrets; }
  else if builtins.isAttrs target && target ? extendModules then
    target.extendModules {
      modules = [
        ({ lib ? null, ... }:
        let
          force = if lib ? mkForce then lib.mkForce else (x: x);
        in {
          age.secrets = builtins.mapAttrs (_: _: {
            path = force placeholderFile;
          }) (target.config.age.secrets or {});
          sops.secrets = builtins.mapAttrs (_: _: {
            path = force placeholderFile;
          }) (target.config.sops.secrets or {});
          sops.placeholder = builtins.mapAttrs (name: _:
            "<placeholder:\${name}>"
          ) (target.config.sops.secrets or {});
        })
      ];
    }
  else if builtins.isString target && builtins.match "^/run/(agenix|secrets)/.*" target != null then
    placeholderFile
  else
    target`;
}

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
  let command: string[];
  if (request.attr === "checks") {
    command = ["flake", "check", "--no-build", flakeRef];
  } else if (request.secrets === "stub") {
    const nixosMatch = request.attr.match(/^nixosConfigurations\.([^.]+)\.(.*)$/);
    if (nixosMatch) {
      const host = nixosMatch[1];
      const subpath = nixosMatch[2];
      command = [
        "eval",
        `${flakeRef}#nixosConfigurations.${host}`,
        "--apply",
        wrapperForNixOS(subpath),
      ];
    } else {
      command = [
        "eval",
        `${flakeRef}#${request.attr}`,
        "--apply",
        wrapperForTarget(),
      ];
    }
  } else {
    command = ["eval", `${flakeRef}#${request.attr}`];
  }
  return [
    "--extra-experimental-features",
    "nix-command flakes",
    ...options,
    ...command,
    "--no-write-lock-file",
  ];
}

// Candidate locations for the CA certificate bundle across NixOS, standard Linux, and container images.
export const CA_BUNDLE_CANDIDATES = [
  process.env.NIX_SSL_CERT_FILE,
  process.env.SSL_CERT_FILE,
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/ssl/certs/ca-bundle.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
];

// Resolves the CA bundle to the real target file (following symlinks into /nix/store or /etc/static),
// so bubblewrap can mount the resolved file directly without needing /etc/static in the jail.
export function resolveCaBundle(override?: string): string {
  const candidates = override ? [override] : CA_BUNDLE_CANDIDATES;
  for (const c of candidates) {
    if (c && existsSync(c)) {
      try {
        return realpathSync(c);
      } catch {
        return c;
      }
    }
  }
  return "/etc/ssl/certs/ca-certificates.crt";
}

// The whole environment of bwrap and of the Nix it runs: built from nothing, never from process.env, so
// nothing of the thread reaches the evaluation. Every path is the throwaway's or the jail's own.
export const JAIL_ENV: Record<string, string> = {
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
  // TLS for fetching the github coordinate: the resolved target file, not a symlink into /etc/static.
  NIX_SSL_CERT_FILE: resolveCaBundle(),
};

export async function runEval(launch: Launch, options: RunOptions = {}): Promise<EvalResult> {
  const { request } = launch;
  const [owner, name, ...rest] = request.repo.split("/");
  if (!options.localFlake && !(rest.length === 0 && [owner, name, request.rev].every((s) => coordinate.test(s ?? "")))) {
    throw new Error(`not a github coordinate: ${request.repo}/${request.rev}`);
  }
  const flakeRef = options.localFlake ? "path:/src" : `github:${request.repo}/${request.rev}`;
  const nix = which("nix");
  const caBundle = resolveCaBundle(options.caBundle);
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-eval-`);
  if (request.secrets === "stub") {
    const secretsDir = `${tmp}/secrets`;
    mkdirSync(secretsDir);
    writeFileSync(`${secretsDir}/placeholder`, "placeholder-secret\n");
  }
  // ponytail: the whole host store is bound read-only for the nix binary's closure; bind only that
  // closure if this runner leaves the gVisor Job.
  const bwrap = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--ro-bind", "/nix/store", "/nix/store",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    // E1.1: bind the resolved CA bundle file, not the /etc/ssl/certs symlink into /etc/static.
    "--ro-bind-try", caBundle, caBundle,
    "--ro-bind-try", caBundle, "/etc/ssl/certs/ca-certificates.crt",
    "--ro-bind-try", caBundle, "/etc/ssl/certs/ca-bundle.crt",
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
    if (options.memoryMax !== undefined) {
      if (!cg) throw new Error("memoryMax needs a cgroup per eval, and this runner's cgroup is not delegated to it");
      writeFileSync(`${cg}/memory.max`, String(options.memoryMax));
    }
    // In its own cgroup, bwrap is moved there before it runs, so every process of the eval is in it.
    const [command, args] = cg
      ? [which("sh"), ["-c", 'echo 0 > "$0/cgroup.procs" && exec "$@"', cg, which("bwrap"), ...bwrap]]
      : [which("bwrap"), bwrap];
    return await new Promise<EvalResult>((resolve, reject) => {
      const child = spawn(command, args, {
        env: {
          ...JAIL_ENV,
          NIX_SSL_CERT_FILE: caBundle,
        },
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
          oomKilled: oomCounted(evalOoms, oomBefore, oomAfter),
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

// Whether the OOM killer killed a process of the eval: by the eval cgroup's own count where it can be
// read (-1 otherwise), else by the whole cgroup's rising; null when neither can be read.
export const oomCounted = (evalOoms: number, before: number, after: number): boolean | null =>
  evalOoms >= 0 ? evalOoms > 0 : before < 0 || after < 0 ? null : after > before;

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
