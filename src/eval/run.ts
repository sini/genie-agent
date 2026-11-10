// The local eval runner: one launch (an eval-request and its sender tier) evaluated by Nix inside bubblewrap, starting from an
// empty throwaway store, and reported as an eval-result.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BASELINE_ISOLATION, BWRAP_ISOLATION, usableBwrap } from "../isolation.ts";

const threadName = /^(?!.*\.\.)[A-Za-z0-9_$!][A-Za-z0-9._:$!-]*$/;

export type Tier = "public" | "trusted";

// schemas/eval-request.json
export interface EvalRequest {
  repo?: string;
  rev?: string;
  worktreeSubdir?: string;
  attr: string;
  apply?: string;
  trusted: "yes" | "no";
  secrets?: "stub" | "none";
}

// schemas/launch.json: what the launcher accepts. sender_tier is the thread's, from the supervisor.
export interface Launch {
  request: EvalRequest;
  sender_tier: Tier;
  thread?: string;
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
  bwrap?: string;
  onStatus?: (message: string) => void;
  // A local flake directory evaluated in place of github:<repo>/<rev>. Tests only.
  localFlake?: string;
  // Root directory of per-thread worktrees (<worktreeRoot>/<thread>/<subdir>) for worktreeSubdir evals (GC1 §2.2).
  worktreeRoot?: string;
  // The remote builders a trusted eval builds its IFD on (design §5.3), in Nix's `builders` syntax:
  // the launcher's deployment config, never the request. Unset, a trusted eval builds in its own store.
  builders?: string;
  // Bytes requested from the optional delegated cgroup adapter. Missing enforcement is reported.
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

const which = (name: string, resolve = true): string => {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = `${dir}/${name}`;
    if (dir && existsSync(p)) return resolve ? realpathSync(p) : p;
  }
  throw new Error(`${name} not found on PATH`);
};

// The model writes the request; nothing in it may reach Nix as anything but a github coordinate
// and a dotted attribute path (GX1 F2), or a confined relative worktreeSubdir (GC1 §2.2, F4).
const coordinate = /^[A-Za-z0-9._-]+$/;
export const ATTR_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)*$/;
export const WORKTREE_SUBDIR_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

export function resolveWorktreeSubdir(
  worktreeRoot: string,
  thread: string,
  subdir: string,
): string {
  if (!threadName.test(thread)) {
    throw new Error(`invalid thread for worktreeSubdir: ${thread}`);
  }
  if (!WORKTREE_SUBDIR_RE.test(subdir) || subdir.split("/").some((s) => s === "." || s === "..")) {
    throw new Error(`invalid worktreeSubdir: ${subdir}`);
  }
  const threadRoot = realpathSync(`${worktreeRoot}/${thread}`);
  const candidate = resolve(threadRoot, subdir);
  if (candidate !== threadRoot && !candidate.startsWith(`${threadRoot}/`)) {
    throw new Error(`worktreeSubdir escapes thread worktree: ${subdir}`);
  }
  const real = realpathSync(candidate);
  if (!real.startsWith(`${threadRoot}/`) && real !== threadRoot) {
    throw new Error(`worktreeSubdir symlink escapes thread worktree: ${subdir}`);
  }
  return real;
}

export function assertConfinedFlakeTree(flakeDir: string, subdir: string): void {
  const root = realpathSync(flakeDir);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const full = `${dir}/${name}`;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        const linkTarget = readlinkSync(full, "utf8");
        let linkReal = "";
        try {
          linkReal = realpathSync(full);
        } catch {}
        if (linkTarget.startsWith("/") || (linkReal !== root && !linkReal.startsWith(`${root}/`))) {
          throw new Error(`worktreeSubdir symlink escapes thread worktree: ${subdir}`);
        }
      } else if (st.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
}

// Generates a Nix wrapper expression to evaluate a NixOS configuration with agenix and sops-nix
// secret paths overridden to placeholder store files and placeholder values substituted (plan E5, design §5.7).
export function wrapperForNixOS(subpath: string): string {
  if (subpath !== "" && !ATTR_PATH_RE.test(subpath)) {
    throw new Error(`not an attr path: ${subpath}`);
  }
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
export function nixArgv(
  launch: Launch,
  flakeRef: string,
  builders = "",
): string[] {
  const { request } = launch;
  if (!ATTR_PATH_RE.test(request.attr)) {
    throw new Error(`not an attr path: ${request.attr}`);
  }
  if (request.apply !== undefined) {
    if (
      typeof request.apply !== "string" ||
      request.apply.length < 1 ||
      request.apply.length > 4096 ||
      request.apply.includes("\0")
    ) {
      throw new Error("invalid apply expression");
    }
    if (request.attr === "checks") {
      throw new Error("apply cannot be combined with attr === 'checks'");
    }
  }
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
    const targetRef = nixosMatch ? `${flakeRef}#nixosConfigurations.${nixosMatch[1]}` : `${flakeRef}#${request.attr}`;
    const stubExpr = nixosMatch ? wrapperForNixOS(nixosMatch[2]) : wrapperForTarget();
    const applyExpr =
      request.apply !== undefined ? `(__genie_x: (${request.apply}) ((${stubExpr}) __genie_x))` : stubExpr;
    command = ["eval", targetRef, "--apply", applyExpr];
  } else if (request.apply !== undefined) {
    command = ["eval", `${flakeRef}#${request.attr}`, "--apply", request.apply];
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

export interface BwrapArgvOptions {
  nix?: string;
  tmp: string;
  caBundle?: string;
  resolvConf?: string;
  etcHosts?: string;
  nsswitchConf?: string;
  localFlake?: string;
  builders?: string;
}

// Builds the bubblewrap argv for runEval. Extracted so unit tests (tests/eval-argv.test.ts) and
// production runEval share the single source of truth for namespace and mount flags (GS2 N1).
export function bwrapArgv(launch: Launch, flakeRef: string, opts: BwrapArgvOptions): string[] {
  const nix = opts.nix ?? "/nix/store/nix/bin/nix";
  const caBundle = opts.caBundle ?? resolveCaBundle();
  const resolvConf = opts.resolvConf ?? "/etc/resolv.conf";
  const etcHosts = opts.etcHosts ?? "/etc/hosts";
  const nsswitchConf = opts.nsswitchConf ?? "/etc/nsswitch.conf";
  return [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--share-net",
    "--die-with-parent",
    "--ro-bind", "/nix/store", "/nix/store",
    "--ro-bind-try", resolvConf, "/etc/resolv.conf",
    "--ro-bind-try", etcHosts, "/etc/hosts",
    "--ro-bind-try", nsswitchConf, "/etc/nsswitch.conf",
    // E1.1: bind the resolved CA bundle file, not the /etc/ssl/certs symlink into /etc/static.
    "--ro-bind-try", caBundle, caBundle,
    "--ro-bind-try", caBundle, "/etc/ssl/certs/ca-certificates.crt",
    "--ro-bind-try", caBundle, "/etc/ssl/certs/ca-bundle.crt",
    "--bind", "/proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    // The throwaway store sits at a fixed jail path, so it never nests inside a host build dir.
    "--bind", opts.tmp, "/work",
    ...(opts.localFlake ? ["--ro-bind", opts.localFlake, "/src"] : []),
    nix,
    ...nixArgv(launch, flakeRef, opts.builders),
  ];
}

export async function runEval(launch: Launch, options: RunOptions = {}): Promise<EvalResult> {
  const { request } = launch;
  if (!ATTR_PATH_RE.test(request.attr)) {
    throw new Error(`not an attr path: ${request.attr}`);
  }
  let boundFlake = options.localFlake;
  if (request.worktreeSubdir !== undefined) {
    if (request.repo !== undefined || request.rev !== undefined) {
      throw new Error("worktreeSubdir is mutually exclusive with repo and rev");
    }
    if (!options.worktreeRoot || !launch.thread) {
      throw new Error("worktreeSubdir requires worktreeRoot and thread");
    }
    const flakeDir = resolveWorktreeSubdir(options.worktreeRoot, launch.thread, request.worktreeSubdir);
    const flakeNix = `${flakeDir}/flake.nix`;
    const st = lstatSync(flakeNix, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.isSymbolicLink()) {
      throw new Error(`worktreeSubdir has no regular flake.nix: ${request.worktreeSubdir}`);
    }
    assertConfinedFlakeTree(flakeDir, request.worktreeSubdir);
    boundFlake = flakeDir;
  } else if (!boundFlake) {
    const [owner, name, ...rest] = (request.repo ?? "").split("/");
    if (!(rest.length === 0 && [owner, name, request.rev].every((s) => coordinate.test(s ?? "")))) {
      throw new Error(`not a github coordinate: ${request.repo ?? ""}/${request.rev ?? ""}`);
    }
  }
  const bwrapBin = usableBwrap(options.bwrap, ["--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"]);
  const flakeRef = boundFlake ? (bwrapBin ? "path:/src" : `path:${encodeURI(realpathSync(resolve(boundFlake))).replaceAll("#", "%23").replaceAll("?", "%3F")}`) : `github:${request.repo}/${request.rev}`;
  const nix = which("nix");
  const caBundle = resolveCaBundle(options.caBundle);
  const resolveEtc = (p: string): string => {
    try {
      return existsSync(p) ? realpathSync(p) : p;
    } catch {
      return p;
    }
  };
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-eval-`);
  mkdirSync(`${tmp}/conf`, { recursive: true });
  let resolvConf = resolveEtc("/etc/resolv.conf");
  if (!existsSync(resolvConf)) {
    resolvConf = `${tmp}/resolv.conf`;
    writeFileSync(resolvConf, "# sandbox\n");
  }
  const etcHosts = resolveEtc("/etc/hosts");
  const nsswitchConf = resolveEtc("/etc/nsswitch.conf");
  // The bwrap jail already isolates user/pid/ipc/uts/mount namespaces; disable Nix's inner
  // CLONE_NEWUSER build sandbox so local IFD builds do not write /proc/<inner_pid>/uid_map
  // against the outer-namespace /proc bind mount.
  if (bwrapBin) writeFileSync(`${tmp}/conf/nix.conf`, "sandbox = false\n");
  if (request.secrets === "stub") {
    const secretsDir = `${tmp}/secrets`;
    mkdirSync(secretsDir);
    writeFileSync(`${secretsDir}/placeholder`, "placeholder-secret\n");
  }
  // ponytail: the whole host store is bound read-only for the nix binary's closure; bind only that
  // closure if this runner leaves the gVisor Job.
  const bwrap = bwrapArgv(launch, flakeRef, {
    nix,
    tmp,
    caBundle,
    resolvConf,
    etcHosts,
    nsswitchConf,
    localFlake: boundFlake,
    builders: options.builders,
  });
  let cg = evalCgroup();
  if (options.memoryMax !== undefined && cg) {
    try { writeFileSync(`${cg}/memory.max`, String(options.memoryMax)); } catch {
      try { rmdirSync(cg); } catch {}
      cg = null;
    }
  }
  const report = options.onStatus ?? console.error;
  report(bwrapBin ? BWRAP_ISOLATION : BASELINE_ISOLATION);
  if (options.memoryMax !== undefined) report(`memory: requested=${options.memoryMax}, enforced=${cg ? options.memoryMax : "none (no delegated cgroup)"}, scope=evaluator and owned children; daemon/remote builders excluded`);
  // The whole cgroup's count: the only one without an eval cgroup, and the fallback when systemd takes
  // back the controllers of a cgroup it writes but never delegated, which removes the eval's memory.events.
  const whole = cg ? cgroupParent : null;
  const oomBefore = cg ? oomKills(whole) : -1;
  try {
    // In its own cgroup, bwrap is moved there before it runs, so every process of the eval is in it.
    const target = bwrapBin ?? nix;
    const targetArgs = bwrapBin ? bwrap : nixArgv(launch, flakeRef, options.builders);
    const [command, args] = cg
      ? [which("sh"), ["-c", 'echo 0 > "$0/cgroup.procs" && exec "$@"', cg, which("env", false), "-u", "SHLVL", target, ...targetArgs]]
      : [target, targetArgs];
    const environment = bwrapBin ? { ...JAIL_ENV, NIX_SSL_CERT_FILE: caBundle } : {
      HOME: `${tmp}/home`, XDG_CACHE_HOME: `${tmp}/cache`, XDG_CONFIG_HOME: `${tmp}/config`, XDG_STATE_HOME: `${tmp}/state`,
      NIX_PATH: "", NIX_CONF_DIR: `${tmp}/conf`, NIX_SSL_CERT_FILE: caBundle,
    };
    for (const dir of ["home", "cache", "config", "state"]) mkdirSync(`${tmp}/${dir}`, { recursive: true, mode: 0o700 });
    return await new Promise<EvalResult>((resolve, reject) => {
      const child = spawn(command, args, {
        env: environment,
        cwd: bwrapBin ? undefined : tmp,
        detached: !bwrapBin,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        const pid = child.pid;
        const kill = () => {
          if (!bwrapBin && pid !== undefined) {
            try { process.kill(-pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
          } else child.kill("SIGKILL");
        };
        let killedChild = false;
        if (pid !== undefined && process.platform === "linux") {
          try {
            const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/);
            for (const c of children) {
              const cpid = Number(c);
              if (cpid > 0) {
                try {
                  process.kill(cpid, "SIGKILL");
                  killedChild = true;
                } catch {}
              }
            }
          } catch {}
        }
        if (killedChild) {
          const t = setTimeout(() => {
            try {
              kill();
            } catch {}
          }, 50);
          (t as unknown as { unref?: () => void }).unref?.();
        } else {
          kill();
        }
      }, options.timeoutMs ?? 120_000);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout = tail(stdout + d)));
      child.stderr.on("data", (d) => (stderr = tail(stderr + d)));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      // A killed child has no exit code; 124 is timeout(1)'s.
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const exit = timedOut ? 124 : (code ?? 124);
        // bwrap reports a command killed by SIGKILL as 128 + 9.
        const sigkilled = timedOut || signal === "SIGKILL" || code === 137;
        const evalOoms = cg ? oomKills(cg) : -1;
        const oomAfter = cg ? oomKills(whole) : -1;
        const limit_hit = limitHit({
          // Only this runner's own timeout sets `timedOut`; a kill from anywhere else leaves it false.
          deadline: timedOut,
          sigkilled,
          oomKilled: cg ? oomCounted(evalOoms, oomBefore, oomAfter) : false,
          fetchRefused: exit !== 0 && fetchRefused(stderr),
        });
        resolve({ exit, stdout_tail: stdout, stderr_tail: stderr, limit_hit });
      });
    });
  } finally {
    // Store paths are read-only; make them writable so the store can be deleted.
    await new Promise((r) => spawn("chmod", ["-R", "u+w", tmp]).on("close", r).on("error", r));
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
  if (process.platform !== "linux") return null;
  if (cgroupParent === undefined) {
    cgroupParent = null;
    const rawOwn = existsSync("/proc/self/cgroup") ? ownCgroup() : "";
    const own = rawOwn.endsWith("/genie-runner") ? rawOwn.slice(0, -"/genie-runner".length) : rawOwn;
    try {
      mkdirSync(`${own}/genie-runner`, { recursive: true });
      writeFileSync(`${own}/genie-runner/cgroup.procs`, "0");
      for (const pid of readFileSync(`${own}/cgroup.procs`, "utf8").trim().split(/\s+/)) {
        if (pid) writeFileSync(`${own}/genie-runner/cgroup.procs`, pid);
      }
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
