// herdr does the lifecycle only (design §5.8): start a claude session in a new pane, close a pane,
// list the live agents. Messages never travel through it.
// Under GI-15 (Arm A), CliHerdr.start also runs the one-shot SO_PEERPIDFD + SCM_RIGHTS socketpair
// token handoff to genie-claude-shim before the shim enters the outer bwrap jail.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

export interface StartSpec {
  name: string;
  threadId?: string;
  // CLAUDE_CONFIG_DIR of the thread's token (row 17).
  configDir: string;
  // The thread's working copy directory, passed to genie-claude-shim via `--cwd` (K7).
  cwd: string;
  // Base non-repo directory for herdr workspace create & pane split (`${cfg.stateDir}/cwd-${tier}`, K7).
  paneCwd?: string;
  // claude's own arguments, after `--`.
  args: string[];
}

export interface HerdrAgent {
  pane: string;
  name?: string;
}

export interface Herdr {
  // Resolves to the new pane's id once claude is ready for input.
  start(spec: StartSpec): Promise<string>;
  close(pane: string): Promise<void>;
  list(): Promise<HerdrAgent[]>;
}

export type Run = (argv: string[], env: Record<string, string | undefined>) => Promise<string>;

const execRun: Run = (argv, env) =>
  new Promise((resolve, reject) =>
    execFile(argv[0], argv.slice(1), { env }, (err, stdout, stderr) =>
      // herdr prints its error object on stdout and exits 1.
      err ? reject(new Error(`${argv.join(" ")}: ${stdout}${stderr}`)) : resolve(stdout),
    ),
  );

// Unset so a command reaches the session it names and no other (Q2).
const scrubbed = ["HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];

export function parseTokenCredential(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    let s = line.trim();
    if (!s || s.startsWith("#")) continue;
    if (s.startsWith("export ")) s = s.slice("export ".length).trim();
    if (s.startsWith("CLAUDE_CODE_OAUTH_TOKEN=")) {
      s = s.slice("CLAUDE_CODE_OAUTH_TOKEN=".length).trim();
    }
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
    if (s) return s;
  }
  throw new Error("token credential file is empty");
}

const HANDOFF_SERVER_PY = `
import os, socket, struct, sys, time

SOL_SOCKET = 1
SO_PEERCRED = 17
SO_PEERPIDFD = 77

sock_path = sys.argv[1]
thread_id = sys.argv[2]
pane_cwd = sys.argv[3]
claude_shim = sys.argv[4]
accept_log = sys.argv[5]
expected_depth = int(sys.argv[6])

token = sys.stdin.buffer.read().decode("utf-8").rstrip("\\r\\n")
sys.stdin.close()

srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
old_umask = os.umask(0o177)
try:
    srv.bind(sock_path)
    os.chmod(sock_path, 0o600)
    srv.listen(1)
finally:
    os.umask(old_umask)

sys.stdout.write("LISTENING\\n")
sys.stdout.flush()

conn, _ = srv.accept()
ts_ns = time.time_ns()
try:
    os.unlink(sock_path)
except FileNotFoundError:
    pass
srv.close()

if accept_log:
    try:
        with open(accept_log, "a", encoding="utf-8") as f:
            f.write(f"thread={thread_id} ts_ns={ts_ns} sock={sock_path}\\n")
    except OSError:
        pass

pidfd = -1
try:
    ucred = conn.getsockopt(SOL_SOCKET, SO_PEERCRED, struct.calcsize("iii"))
    peer_pid, peer_uid, peer_gid = struct.unpack("iii", ucred)
    if peer_uid != os.getuid():
        sys.stderr.write(f"peer_uid mismatch: {peer_uid} != {os.getuid()}\\n")
        sys.exit(11)

    pidfd_bytes = conn.getsockopt(SOL_SOCKET, SO_PEERPIDFD, 4)
    pidfd = struct.unpack("i", pidfd_bytes)[0]

    with open(f"/proc/self/fdinfo/{pidfd}", "r", encoding="utf-8") as f:
        fdinfo = f.read()

    nspids = []
    for line in fdinfo.splitlines():
        if line.startswith("NSpid:"):
            nspids = line.split()[1:]
            break

    if expected_depth > 0 and len(nspids) != expected_depth:
        sys.stderr.write(f"NSpid depth mismatch: got {nspids} (expected depth {expected_depth})\\n")
        sys.exit(12)

    proc_pid = str(peer_pid)
    try:
        with open(f"/proc/{proc_pid}/cmdline", "rb") as f:
            raw_cmd = f.read()
        argv = [a.decode("utf-8", "replace") for a in raw_cmd.split(b"\\x00") if a]
    except OSError as e:
        sys.stderr.write(f"cmdline read failed: {e}\\n")
        sys.exit(13)

    if claude_shim:
        shim_idx = -1
        for idx in (0, 1, 2):
            if idx < len(argv) and argv[idx] == claude_shim:
                shim_idx = idx
                break
        if shim_idx < 0:
            sys.stderr.write(f"claudeShim {claude_shim!r} not at argv[0..2]: {argv[:5]!r}\\n")
            sys.exit(14)
        expected_tail = [
            "--token-sock", sock_path,
            "--thread-id", thread_id,
            "--cwd", pane_cwd,
            "--",
        ]
        actual_tail = argv[shim_idx + 1 : shim_idx + 1 + len(expected_tail)]
        if actual_tail != expected_tail:
            sys.stderr.write(f"argv tail mismatch: {actual_tail!r} != {expected_tail!r}\\n")
            sys.exit(15)

    cur_pid = proc_pid
    for _ in range(32):
        if not cur_pid or cur_pid == "0":
            break
        try:
            with open(f"/proc/{cur_pid}/status", "r", encoding="utf-8") as f:
                st = f.read()
        except OSError:
            break
        name = ""
        ppid = "0"
        cur_nspids = []
        for line in st.splitlines():
            if line.startswith("Name:"):
                name = line.split(":", 1)[1].strip()
            elif line.startswith("PPid:"):
                ppid = line.split(":", 1)[1].strip()
            elif line.startswith("NSpid:"):
                cur_nspids = line.split()[1:]
        if name in ("claude", ".claude-wrapped", "bwrap"):
            sys.stderr.write(f"forbidden ancestor Name={name} at pid={cur_pid}\\n")
            sys.exit(16)
        if len(cur_nspids) == 2 and cur_nspids[1] == "1":
            break
        cur_pid = ppid

    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        b.sendall((token + "\\n").encode("utf-8"))
    finally:
        b.close()
    try:
        socket.send_fds(conn, [b"\\x00"], [a.fileno()])
    finally:
        a.close()
    sys.stdout.write("HANDOFF_OK\\n")
    sys.stdout.flush()
finally:
    if pidfd >= 0:
        try:
            os.close(pidfd)
        except OSError:
            pass
    conn.close()
`;

export interface CliOptions {
  session: string;
  // Base non-repo directory for herdr workspace create & pane split (`${cfg.stateDir}/cwd-${tier}`, K7).
  cwdDir?: string;
  // Dispatcher state directory (`${cfg.stateDir}/dispatcher-${tier}`) for launch/, worktrees/, claude-threads/.
  stateDir?: string;
  // Credential file holding the tier's token (or CLAUDE_CODE_OAUTH_TOKEN=<tok>).
  tokenCredentialFile?: string;
  // Optional direct token resolver (for unit tests).
  resolveToken?: (threadId: string) => string;
  // Expected NSpid depth of the connecting shim (default 2: host PID ns -> genie-herdr@<tier> PID ns).
  expectedNspidDepth?: number;
  readyTimeoutMs?: number;
  herdr?: string;
  claude?: string;
  python?: string;
  run?: Run;
}

export class CliHerdr implements Herdr {
  private readonly o: CliOptions;
  private readonly env: Record<string, string | undefined>;
  // The pane every thread pane is split from: the server's first, looked up or created lazily and never closed.
  private basePane?: string;

  constructor(o: CliOptions) {
    this.o = o;
    this.env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !scrubbed.includes(k)),
    );
  }

  private async json(args: string[]): Promise<any> {
    const run = this.o.run ?? execRun;
    return JSON.parse(await run([this.o.herdr ?? "herdr", "--session", this.o.session, ...args], this.env));
  }

  private async ensureBasePane(shellCwd: string): Promise<string> {
    if (this.basePane) return this.basePane;
    const listed = await this.json(["pane", "list"]);
    const existing: string | undefined = listed.result.panes[0]?.pane_id;
    if (existing) {
      this.basePane = existing;
      return existing;
    }
    const created = await this.json(["workspace", "create", "--cwd", shellCwd, "--no-focus"]);
    const root: string = created.result.root_pane.pane_id;
    this.basePane = root;
    return root;
  }

  private hasTokenChannel(): boolean {
    return Boolean(this.o.stateDir && (this.o.tokenCredentialFile || this.o.resolveToken));
  }

  private loadToken(threadId: string): string {
    if (this.o.resolveToken) return this.o.resolveToken(threadId);
    if (!this.o.tokenCredentialFile) throw new Error("tokenCredentialFile is not configured");
    return parseTokenCredential(readFileSync(this.o.tokenCredentialFile, "utf8"));
  }

  private startHandoffServer(params: {
    sockPath: string;
    threadId: string;
    paneCwd: string;
    token: string;
  }): {
    ready: Promise<void>;
    done: Promise<void>;
    kill: () => void;
  } {
    const acceptLog = this.o.stateDir ? `${this.o.stateDir}/accept.log` : "";
    const expectedDepth = String(this.o.expectedNspidDepth ?? 2);
    const proc = spawn(
      this.o.python ?? "python3",
      [
        "-I",
        "-c",
        HANDOFF_SERVER_PY,
        params.sockPath,
        params.threadId,
        params.paneCwd,
        this.o.claude ?? "",
        acceptLog,
        expectedDepth,
      ],
      {
        env: { PATH: this.env.PATH ?? "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    proc.stdin.write(params.token);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";
    let onReady!: () => void;
    let onReadyErr!: (e: Error) => void;
    let readySettled = false;
    const ready = new Promise<void>((resolve, reject) => {
      onReady = () => {
        if (!readySettled) {
          readySettled = true;
          resolve();
        }
      };
      onReadyErr = (e: Error) => {
        if (!readySettled) {
          readySettled = true;
          reject(e);
        }
      };
    });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("LISTENING\n")) onReady();
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const done = new Promise<void>((resolve, reject) => {
      proc.on("error", (err) => {
        onReadyErr(err);
        reject(err);
      });
      proc.on("close", (code, sig) => {
        if (!readySettled) {
          onReadyErr(new Error(`handoff server exited before LISTENING (code=${code}, sig=${sig}): ${stderr}`));
        }
        if (code === 0 && stdout.includes("HANDOFF_OK\n")) {
          resolve();
        } else {
          reject(new Error(`token handoff rejected or failed (code=${code}, sig=${sig}): ${stderr.trim()}`));
        }
      });
    });
    // Prevent unhandled rejection if agent start fails first.
    done.catch(() => {});

    return {
      ready,
      done,
      kill: () => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
        }
      },
    };
  }

  async start(s: StartSpec): Promise<string> {
    // K7: herdr workspace create & pane split always use cwd-${tier}, never the thread's worktree.
    const shellCwd = this.o.cwdDir ?? s.paneCwd ?? s.cwd;
    const threadId = s.threadId ?? s.name;
    const useTokenChannel = this.hasTokenChannel();

    if (useTokenChannel && this.o.stateDir) {
      mkdirSync(`${this.o.stateDir}/worktrees/${threadId}`, { recursive: true, mode: 0o700 });
      mkdirSync(`${this.o.stateDir}/claude-threads/${threadId}`, { recursive: true, mode: 0o700 });
      mkdirSync(`${this.o.stateDir}/launch`, { recursive: true, mode: 0o700 });
    }

    const basePane = await this.ensureBasePane(shellCwd);
    // The config directory is not a secret, so it rides --env; the token never does (GI-15).
    const split = await this.json([
      "pane", "split", basePane, "--direction", "right", "--cwd", shellCwd,
      "--env", `CLAUDE_CONFIG_DIR=${s.configDir}`, "--no-focus",
    ]);
    const pane: string = split.result.pane.pane_id;

    if (!useTokenChannel) {
      try {
        await this.json([
          "agent", "start", s.name, "--kind", "claude", "--pane", pane,
          ...(this.o.claude ? ["--command", this.o.claude] : []),
          "--timeout", String(this.o.readyTimeoutMs ?? 60000), "--", ...s.args,
        ]);
      } catch (e) {
        await this.close(pane);
        throw e;
      }
      return pane;
    }

    const sockPath = `${this.o.stateDir}/launch/${randomUUID()}.sock`;
    const token = this.loadToken(threadId);
    const handoff = this.startHandoffServer({
      sockPath,
      threadId,
      paneCwd: s.cwd,
      token,
    });

    try {
      await handoff.ready;
      const shimArgs = [
        "--token-sock", sockPath,
        "--thread-id", threadId,
        "--cwd", s.cwd,
        "--",
        ...s.args,
      ];
      await Promise.all([
        this.json([
          "agent", "start", s.name, "--kind", "claude", "--pane", pane,
          ...(this.o.claude ? ["--command", this.o.claude] : []),
          "--timeout", String(this.o.readyTimeoutMs ?? 60000), "--", ...shimArgs,
        ]),
        handoff.done,
      ]);
    } catch (e) {
      handoff.kill();
      rmSync(sockPath, { recursive: false, force: true });
      await this.close(pane);
      throw e;
    } finally {
      handoff.kill();
      rmSync(sockPath, { recursive: false, force: true });
    }
    return pane;
  }

  // A pane that is already gone is closed; any other refusal throws.
  async close(pane: string): Promise<void> {
    try {
      await this.json(["pane", "close", pane]);
    } catch (e) {
      if (!String(e).includes('"code":"pane_not_found"')) throw e;
    }
  }

  async list(): Promise<HerdrAgent[]> {
    const r = await this.json(["agent", "list"]);
    return r.result.agents.map((a: { pane_id: string; name?: string }) => ({ pane: a.pane_id, name: a.name }));
  }
}
