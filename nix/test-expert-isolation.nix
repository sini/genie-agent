# GI-13 + GI-15 (v3.1, Arm A) VM oracle:
#   probe: experts.herdrPackage is a probe that records what the genie-herdr@<tier> sandbox can
#          read and write (V0, V1, V1b, V2, V4, V5), then stays up as the unit's main process;
#   real:  the real herdr + real claude (pkgs.claude-code) + genie-claude-shim outer bwrap jail +
#          SO_PEERPIDFD + SCM_RIGHTS socketpair token handoff, exercising V0, V3, V6.1–V6.11 and
#          verifying that all 12 GI-15 mutants turn their target cells RED.
{
  pkgs,
  nixpkgs,
  self,
}:
let
  inherit (nixpkgs) lib;
  coreutils = "${pkgs.coreutils}/bin";
  claudeHome = "/home/sini/.claude";
  stateDir = "/var/lib/genie-agent";

  idle = name: pkgs.writeShellScriptBin name "trap 'exit 0' TERM; ${coreutils}/sleep infinity & wait";

  probeHerdr =
    (pkgs.writeShellScriptBin "herdr" ''
        # argv: --session genie-<tier> server
      tier=''${2#genie-}
      c=${claudeHome}
      {
        echo "probe start tier=$tier"
        for f in memory/x settings.json .credentials.json; do
          if ${coreutils}/cat "$c/$f"; then echo "PROBE direct-read-ok $f"; else echo "PROBE direct-read-fail $f"; fi
        done
        if echo w >> "$c/memory/x"; then echo "PROBE direct-write-ok memory/x"; else echo "PROBE direct-write-fail memory/x"; fi
        n=0
        for d in /proc/[0-9]*; do
          n=$((n + 1))
          ${coreutils}/cat "$d/root$c/memory/x" && echo "PROBE proc-read-ok $d"
          echo p > "$d/root$c/agents/p" && echo "PROBE proc-write-ok agents $d"
          echo y > "$d/root$c/memory/y" && echo "PROBE proc-write-ok memory $d"
        done
        echo "PROBE proc-walked $n"
        echo "probe done"
      } > ${stateDir}/probe-$tier.log 2>&1
      trap 'exit 0' TERM
      ${coreutils}/sleep infinity & wait
    '')
    // {
      src = ./.;
      overrideAttrs = _: probeHerdr;
    };

  probeClaude = pkgs.writeScriptBin "probe-claude" ''
    #!${pkgs.python3}/bin/python3 -I
    import ctypes, hashlib, json, mmap, os, stat, struct, sys, time

    fd_str = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "")
    RESIDENT_TOKEN = b""
    tok_is_sock = False
    if fd_str:
        fd = int(fd_str)
        st = os.fstat(fd)
        tok_is_sock = stat.S_ISSOCK(st.st_mode)
        with os.fdopen(fd, "rb", closefd=True) as f:
            RESIDENT_TOKEN = f.read().strip()
    elif "CLAUDE_CODE_OAUTH_TOKEN" in os.environ:
        RESIDENT_TOKEN = os.environ["CLAUDE_CODE_OAUTH_TOKEN"].encode("utf-8")

    tok_hash = hashlib.sha256(RESIDENT_TOKEN).hexdigest() if RESIDENT_TOKEN else "unset"
    cfg_dir = os.environ.get("CLAUDE_CONFIG_DIR", "")

    # Keep multiple copies of RESIDENT_TOKEN in heap/locals so /proc/<pid>/mem scans find it if readable.
    HEAP_PAD = [RESIDENT_TOKEN * 64 for _ in range(16)]

    def get_outer_pid() -> int:
        with open("/proc/self/status", "r", encoding="utf-8") as sf:
            for line in sf:
                if line.startswith("NSpid:"):
                    return int(line.split()[1])
        return os.getpid()

    def scan_proc_mem(target_pid: int, needle: bytes) -> tuple[str, int]:
        try:
            with open(f"/proc/{target_pid}/maps", "r", encoding="utf-8") as mf:
                maps_lines = mf.readlines()
        except OSError as e:
            return f"maps_err:{e.errno}", 0
        try:
            mem_fd = os.open(f"/proc/{target_pid}/mem", os.O_RDONLY)
        except OSError as e:
            return f"mem_err:{e.errno}", 0
        hits = 0
        chunk_sz = 4 * 1024 * 1024
        ov = max(0, len(needle) - 1)
        try:
            for line in maps_lines:
                parts = line.split()
                if len(parts) < 2 or "r" not in parts[1]:
                    continue
                if len(parts) >= 6 and parts[5] in ("[vvar]", "[vvar_vclock]", "[vdso]", "[vsyscall]"):
                    continue
                start_s, end_s = parts[0].split("-")
                start, end = int(start_s, 16), int(end_s, 16)
                pos = start
                actual_ov = 0
                while pos < end:
                    to_read = min(chunk_sz, end - pos)
                    if to_read <= 0:
                        break
                    try:
                        chunk = os.pread(mem_fd, to_read, pos)
                    except OSError:
                        break
                    n = len(chunk)
                    if n <= 0:
                        break
                    hits += chunk.count(needle, max(0, actual_ov - ov))
                    if pos + n >= end:
                        break
                    adv = max(1, n - ov)
                    actual_ov = n - adv
                    pos += adv
        finally:
            os.close(mem_fd)
        return "ok", hits

    def try_process_vm_readv(maps_pid: int, syscall_pid: int, needle: bytes) -> tuple[str, int]:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.syscall.restype = ctypes.c_long
        libc.syscall.argtypes = [
            ctypes.c_long, ctypes.c_int,
            ctypes.c_void_p, ctypes.c_ulong,
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
        ]
        try:
            with open(f"/proc/{maps_pid}/maps", "r", encoding="utf-8") as mf:
                maps_lines = mf.readlines()
        except OSError as e:
            return f"maps_err:{e.errno}", 0

        class Iovec(ctypes.Structure):
            _fields_ = [("iov_base", ctypes.c_void_p), ("iov_len", ctypes.c_size_t)]

        buf = ctypes.create_string_buffer(65536)
        local_iov = Iovec(ctypes.cast(buf, ctypes.c_void_p), 65536)
        last_errno = 0
        hits = 0
        for line in maps_lines[:32]:
            parts = line.split()
            if len(parts) < 2 or "r" not in parts[1]:
                continue
            start_s, end_s = parts[0].split("-")
            start, end = int(start_s, 16), int(end_s, 16)
            sz = min(end - start, 65536)
            remote_iov = Iovec(ctypes.c_void_p(start), sz)
            rc = libc.syscall(310, syscall_pid, ctypes.byref(local_iov), 1, ctypes.byref(remote_iov), 1, 0)
            if rc < 0:
                last_errno = ctypes.get_errno()
            elif rc > 0:
                hits += buf.raw[:rc].count(needle)
        return (f"err:{last_errno}" if hits == 0 and last_errno else "ok"), hits

    def try_perf_stack(target_pid: int) -> tuple[int, int, int]:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.syscall.restype = ctypes.c_long
        libc.syscall.argtypes = [
            ctypes.c_long, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong
        ]
        attr = bytearray(128)
        flags_u64 = (1 << 5) | (1 << 6) # exclude_kernel | exclude_hv
        struct.pack_into("<IIQQQQQ", attr, 0, 1, 128, 1, 10000, 1 << 13, 0, flags_u64)
        struct.pack_into("<I", attr, 88, 8192)
        c_attr = (ctypes.c_char * 128).from_buffer(attr)
        fd = int(libc.syscall(298, ctypes.byref(c_attr), target_pid, -1, -1, 0))
        err = ctypes.get_errno() if fd < 0 else 0
        data_head = 0
        if fd >= 0:
            mm = mmap.mmap(fd, 9 * 4096, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE)
            t_end = time.monotonic() + 0.25
            while time.monotonic() < t_end:
                data_head = struct.unpack_from("<Q", mm, 1024)[0]
                if data_head > 0:
                    break
                time.sleep(0.01)
            mm.close()
            os.close(fd)
        return fd, err, data_head

    # Fork same-jail child to run V6.6 Arm 1, Arm 3, and Positive Control against parent (probeClaude)
    if "--run-v66-child" in sys.argv and cfg_dir:
        parent_outer_pid = get_outer_pid()
        parent_inner_pid = os.getpid()
        r_pipe, w_pipe = os.pipe()
        child_pid = os.fork()
        if child_pid == 0:
            os.close(r_pipe)
            # Positive control: fork our own grandchild holding canary-mem-control-0000
            ctrl_needle = b"canary-mem-control-" + b"0000"
            gc_r, gc_w = os.pipe()
            gc_pid = os.fork()
            if gc_pid == 0:
                os.close(gc_r)
                CTRL_PAD = [ctrl_needle * 64 for _ in range(8)]
                gc_outer = get_outer_pid()
                os.write(gc_w, f"{gc_outer}\n".encode("utf-8"))
                os.close(gc_w)
                time.sleep(10)
                os._exit(0)
            os.close(gc_w)
            gc_outer_pid = int(os.read(gc_r, 64).decode("utf-8").strip())
            os.close(gc_r)
            ctrl_status, ctrl_hits = scan_proc_mem(gc_outer_pid, ctrl_needle)
            os.kill(gc_pid, 9)
            os.waitpid(gc_pid, 0)

            arm1_mem_status, arm1_mem_hits = scan_proc_mem(parent_outer_pid, RESIDENT_TOKEN)
            arm1_vm_status, arm1_vm_hits = try_process_vm_readv(parent_outer_pid, parent_inner_pid, RESIDENT_TOKEN)
            perf_fd, perf_errno, perf_data_head = try_perf_stack(parent_inner_pid)

            res = {
                "ppid": parent_outer_pid,
                "ctrl_status": ctrl_status,
                "ctrl_hits": ctrl_hits,
                "arm1_mem_status": arm1_mem_status,
                "arm1_mem_hits": arm1_mem_hits,
                "arm1_vm_status": arm1_vm_status,
                "arm1_vm_hits": arm1_vm_hits,
                "perf_fd": perf_fd,
                "perf_errno": perf_errno,
                "perf_data_head": perf_data_head,
            }
            with open(os.path.join(cfg_dir, "v66-same-jail.json"), "w", encoding="utf-8") as f:
                json.dump(res, f)
            os.write(w_pipe, b"1")
            os.close(w_pipe)
            os._exit(0)
        else:
            os.close(w_pipe)
            # Spin CPU briefly so perf_event_open (when allowed under M-perf-allowed) records stack samples
            t_spin = time.monotonic() + 0.35
            acc = 0
            while time.monotonic() < t_spin:
                acc += len(HEAP_PAD[acc & 15])
            os.read(r_pipe, 1)
            os.close(r_pipe)
            os.waitpid(child_pid, 0)

    if cfg_dir:
        tmp = os.path.join(cfg_dir, "probe.tmp")
        dst = os.path.join(cfg_dir, "probe")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(f"tok={tok_hash}\ncfg={cfg_dir}\nsock={int(tok_is_sock)}\n")
        os.replace(tmp, dst)

    while True:
        time.sleep(60)
  '';

  gv1ClaudeStub = pkgs.writeScriptBin "claude" ''
    #!${pkgs.python3}/bin/python3 -I
    import hashlib, json, os, socket, stat, sys, time

    fd_str = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "")
    tok_bytes = b""
    tok_is_sock = False
    if fd_str:
        fd = int(fd_str)
        st = os.fstat(fd)
        tok_is_sock = stat.S_ISSOCK(st.st_mode)
        with os.fdopen(fd, "rb", closefd=True) as f:
            tok_bytes = f.read().strip()

    tok_hash = hashlib.sha256(tok_bytes).hexdigest() if tok_bytes else "unset"
    cfg_dir = os.environ.get("CLAUDE_CONFIG_DIR", "")
    cwd = os.getcwd()
    argv = list(sys.argv)

    session_id = ""
    is_resume = False
    for i, arg in enumerate(argv):
        if arg == "--session-id" and i + 1 < len(argv):
            session_id = argv[i + 1]
        elif arg == "--resume" and i + 1 < len(argv):
            session_id = argv[i + 1]
            is_resume = True

    if cfg_dir:
        probe_data = {
            "tok_hash": tok_hash,
            "tok_is_sock": tok_is_sock,
            "cwd": cwd,
            "cfg_dir": cfg_dir,
            "argv": argv,
            "session_id": session_id,
            "is_resume": is_resume,
        }
        tmp = os.path.join(cfg_dir, "gv1-probe.json.tmp")
        dst = os.path.join(cfg_dir, "gv1-probe.json")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(probe_data, f)
        os.replace(tmp, dst)

    sys.stdout.write("\x1b]0;✳ Claude Code\x07\n" + "─" * 40 + "\n❯ \n" + "─" * 40 + "\n")
    sys.stdout.flush()

    reg_sock_path = "/run/user/1000/xmsg/register.sock"
    if session_id and os.path.exists(reg_sock_path):
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(reg_sock_path)
            rf = s.makefile("r", encoding="utf-8")
            def call(obj):
                s.sendall((json.dumps(obj) + "\n").encode("utf-8"))
                line = rf.readline()
                return json.loads(line) if line else {}
            call({"harness": "claude", "name": session_id})
            while True:
                r = call({"action": "poll", "waitSecs": 30})
                if not r:
                    break
                if r.get("action") == "timeout":
                    continue
                if r.get("action") == "deliver":
                    mid = r["messageId"]
                    text = r.get("text", "")
                    call({"action": "ack", "messageId": mid})
                    try:
                        pkg = json.loads(text)
                        tid = pkg.get("thread_id", "unknown")
                    except Exception:
                        tid = "raw"
                    reply_payload = json.dumps({
                        "answer": f"gv1-ok:{tid}:resume={is_resume}:cwd={cwd}",
                        "confidence": 0.95,
                        "gaps": [],
                        "tier": "expert",
                    })
                    call({"action": "reply", "messageId": mid, "text": reply_payload})
        except Exception:
            pass

    while True:
        time.sleep(60)
  '';

  tokens = {
    public = "canary-public-token-0000";
    trusted = "canary-trusted-token-0000";
  };

  gv2TlsCerts =
    pkgs.runCommand "gv2-tls-certs"
      {
        nativeBuildInputs = [ pkgs.openssl ];
      }
      ''
        mkdir -p $out
        openssl req -x509 -newkey rsa:2048 -nodes \
          -keyout $out/key.pem -out $out/cert.pem \
          -days 3650 -subj "/CN=gv2-git.example.org" \
          -addext "subjectAltName=DNS:gv2-git.example.org,DNS:github.com,DNS:api.github.com,IP:198.18.0.1" \
          -addext "basicConstraints=critical,CA:TRUE" \
          -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign"
      '';

  gv2GitFixture =
    pkgs.runCommand "gv2-git-fixture"
      {
        nativeBuildInputs = [
          pkgs.git
          pkgs.gnutar
          pkgs.gzip
        ];
      }
      ''
        mkdir -p src $out $out/owner/repo/archive
        git init -b main src
        git -C src config user.email "gv2@example.org"
        git -C src config user.name "gv2"
        echo "gv2-readme-canary" > src/README.md
        ln -s /etc/passwd src/tracked-link
        cat > src/flake.nix << 'EOF'
        {
          outputs = _: {
            packages.x86_64-linux = {
              default = "gv2-eval-ok";
              ifd = builtins.attrNames (
                builtins.readDir (derivation {
                  name = "gv2-ifd-probe";
                  system = "x86_64-linux";
                  builder = "builtin:buildenv";
                  manifest = "/dev/null";
                  derivations = "";
                })
              );
            };
          };
        }
        EOF
        git -C src add README.md tracked-link flake.nix
        git -C src commit -m "gv2 fixture commit"
        git clone --bare src $out/fixture.git
        git -C $out/fixture.git update-server-info
        tar --exclude=.git -czf $out/owner/repo/archive/0123456789abcdef0123456789abcdef01234567.tar.gz src
      '';

  gv2ProbePy = pkgs.writeText "gv2_probe.py" ''
    import ctypes, errno, json, os, stat, sys

    class CapHeader(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]

    class CapData(ctypes.Structure):
        _fields_ = [
            ("effective", ctypes.c_uint32),
            ("permitted", ctypes.c_uint32),
            ("inheritable", ctypes.c_uint32),
        ]

    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    hdr = CapHeader(0x20080522, 0)
    dat = (CapData * 2)()
    libc.capset(ctypes.byref(hdr), ctypes.byref(dat))

    cfg = json.loads(sys.stdin.read())
    tid_a = cfg["tid_a"]
    tid_b = cfg["tid_b"]
    clone_path = cfg["clone_path"]
    agent_dir = cfg["agent_dir"]
    root_pids = cfg["root_pids"]
    root_fds = cfg["root_fds"]
    jail_a_pids = set(cfg["jail_a_pids"])

    status_map = {}
    for line in open("/proc/self/status", "r", encoding="utf-8"):
        if ":" in line:
            k, v = line.split(":", 1)
            status_map[k.strip()] = v.strip()

    self_nspids = [int(x) for x in status_map.get("NSpid", "").split() if x.isdigit()]
    self_uid = os.getuid()
    self_gid = os.getgid()
    self_cap_eff = status_map.get("CapEff", "")
    self_cap_prm = status_map.get("CapPrm", "")
    self_no_new_privs = status_map.get("NoNewPrivs", "")

    # B1: NSpid depth >= 2
    b1_ok = len(self_nspids) >= 2

    # B2: /run/credentials/**, /run/user/1000/xmsg/agent.sock, state/thread-gv2-B, state/thread-gv2-A/state.json absent (ENOENT)
    b2_targets = [
        "/run/credentials",
        "/run/credentials/genie-agent.service",
        "/run/credentials/genie-agent.service/model-key",
        "/run/credentials/genie-agent.service/broker-token",
        "/run/credentials/genie-agent.service/guard-out-key",
        "/run/credentials/genie-agent.service/s3-secret-key",
        "/run/genie-secrets/model-key",
        "/run/user/1000/xmsg/agent.sock",
        "/run/user/1000/xmsg/register.sock",
        f"/var/lib/genie-agent/state/{tid_b}",
        f"/var/lib/genie-agent/state/{tid_b}/state.json",
        f"/var/lib/genie-agent/state/{tid_b}/session",
        f"/var/lib/genie-agent/state/{tid_a}/state.json",
        f"/var/lib/genie-agent/state/{tid_a}/context.json",
        "/var/lib/genie-agent/mirrors",
        f"/var/lib/genie-agent/worktrees/{tid_b}",
    ]
    b2_results = {}
    for p in b2_targets:
        try:
            os.lstat(p)
            b2_results[p] = "EXISTS"
            continue
        except OSError as ex:
            err_name = errno.errorcode.get(ex.errno, str(ex.errno))
        try:
            fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK)
            os.close(fd)
            b2_results[p] = "OPEN_OK"
        except OSError as ex2:
            err_name2 = errno.errorcode.get(ex2.errno, str(ex2.errno))
            b2_results[p] = err_name if err_name == err_name2 else f"{err_name}/{err_name2}"
    b2_ok = all(v == "ENOENT" for v in b2_results.values())

    # B3: genie-root's environ, mem, root and every fd/<n> dereference denied
    b3_leaks = []
    b3_checked = 0
    for rpid in root_pids:
        if rpid in self_nspids or rpid in jail_a_pids:
            continue
        for sub in ("environ", "mem"):
            b3_checked += 1
            try:
                fd = os.open(f"/proc/{rpid}/{sub}", os.O_RDONLY | os.O_NONBLOCK)
                os.close(fd)
                b3_leaks.append(f"/proc/{rpid}/{sub}:open")
            except OSError:
                pass
        b3_checked += 1
        try:
            os.listdir(f"/proc/{rpid}/root")
            b3_leaks.append(f"/proc/{rpid}/root:listdir")
        except OSError:
            pass
        for fd_num in root_fds:
            b3_checked += 1
            fp = f"/proc/{rpid}/fd/{fd_num}"
            try:
                t = os.readlink(fp)
                b3_leaks.append(f"{fp}:readlink={t}")
            except OSError:
                pass
            try:
                fd = os.open(fp, os.O_RDONLY | os.O_NONBLOCK)
                os.close(fd)
                b3_leaks.append(f"{fp}:open")
            except OSError:
                pass
    b3_ok = len(b3_leaks) == 0 and b3_checked >= 6

    # B4: writes to /nix/store, /memory, worktree, and real agentDir fail with EROFS; session dir is writable
    def check_ro_create(p: str) -> str:
        try:
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.close(fd)
            try:
                os.unlink(p)
            except OSError:
                pass
            return "WRITABLE"
        except OSError as ex:
            return errno.errorcode.get(ex.errno, str(ex.errno))

    def check_ro_existing(p: str) -> str:
        try:
            fd = os.open(p, os.O_WRONLY)
            os.close(fd)
            return "WRITABLE"
        except OSError as ex:
            return errno.errorcode.get(ex.errno, str(ex.errno))

    b4_ro = {
        "nix_store": check_ro_create("/nix/store/.gv2-probe-w"),
        "memory_dir": check_ro_create("/memory/.gv2-probe-w"),
        "worktree_dir": check_ro_create(f"/var/lib/genie-agent/worktrees/{tid_a}/.gv2-probe-w"),
        "worktree_file": check_ro_existing(f"{clone_path}/README.md"),
        "agent_dir": check_ro_create(f"{agent_dir}/.gv2-probe-w"),
        "agent_models": check_ro_existing(f"{agent_dir}/models.json"),
        "state_root": check_ro_create("/var/lib/genie-agent/state/.gv2-probe-w"),
        "worktrees_root": check_ro_create("/var/lib/genie-agent/worktrees/.gv2-probe-w"),
    }
    sess_probe = f"/var/lib/genie-agent/state/{tid_a}/session/.gv2-probe-ok"
    try:
        with open(sess_probe, "w", encoding="utf-8") as sf:
            sf.write("ok\n")
        os.unlink(sess_probe)
        b4_sess_rw = "OK"
    except OSError as ex:
        b4_sess_rw = errno.errorcode.get(ex.errno, str(ex.errno))
    b4_ok = all(v == "EROFS" for v in b4_ro.values()) and b4_sess_rw == "OK"

    # B5 (C2): the jail's /proc lists no PID outside pi's own jail
    proc_pids = sorted(int(x) for x in os.listdir("/proc") if x.isdigit())
    allowed_pids = jail_a_pids | set(self_nspids)
    outside_pids = [p for p in proc_pids if p not in allowed_pids]
    b5_ok = len(outside_pids) == 0 and len(proc_pids) >= 2

    print(json.dumps({
        "uid": self_uid,
        "gid": self_gid,
        "cap_eff": self_cap_eff,
        "cap_prm": self_cap_prm,
        "no_new_privs": self_no_new_privs,
        "nspids": self_nspids,
        "b1_ok": b1_ok,
        "b2_ok": b2_ok,
        "b2_results": b2_results,
        "b3_ok": b3_ok,
        "b3_leaks": b3_leaks,
        "b3_checked": b3_checked,
        "b4_ok": b4_ok,
        "b4_ro": b4_ro,
        "b4_sess_rw": b4_sess_rw,
        "b5_ok": b5_ok,
        "proc_pids": proc_pids,
        "outside_pids": outside_pids,
    }))
  '';

  gv2EvalJailProbePy = pkgs.writeText "gv2-eval-jail-probe.py" ''
    import errno, json, os, resource, subprocess, sys

    cfg = json.loads(sys.stdin.read())
    root_host_pid = int(cfg["root_host_pid"])
    root_unit_pid = int(cfg["root_unit_pid"])
    sib_host_pid = int(cfg["sib_host_pid"])
    sib_unit_pid = int(cfg["sib_unit_pid"])

    try:
        self_status = open("/proc/self/status", "r", encoding="utf-8").read()
        nspids = []
        for line in self_status.splitlines():
            if line.startswith("NSpid:"):
                nspids = [int(x) for x in line.split()[1:] if x.isdigit()]
        self_status_ok = len(nspids) >= 2 and nspids[-1] >= 2 and "Uid:\t1000" in self_status
    except OSError:
        nspids = []
        self_status_ok = False

    def probe_pid(pid):
        if not pid:
            return {}
        out = {}
        for sub in ("environ", "mem", "root"):
            p = f"/proc/{pid}/{sub}"
            try:
                if sub == "root":
                    os.listdir(p)
                else:
                    fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK)
                    os.close(fd)
                out[sub] = "OK"
            except OSError as ex:
                out[sub] = errno.errorcode.get(ex.errno, str(ex.errno))
        return out

    root_res = probe_pid(1)
    max_pid = max(nspids[0] if nspids else 64, sib_unit_pid + 8, 64)
    jail_unit_pids = set(nspids[:1] + [os.getpid(), os.getppid()])
    bwrap_pid1_ok = False
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            for line in open(f"/proc/{d}/status", "r", encoding="utf-8"):
                if line.startswith("NSpid:"):
                    parts = [int(x) for x in line.split()[1:] if x.isdigit()]
                    if len(parts) >= 2 and parts[-1] in (1, 2):
                        jail_unit_pids.add(parts[0])
                    if len(parts) >= 2 and parts[-1] == 1:
                        comm = open(f"/proc/{d}/comm", "r", encoding="utf-8").read().strip()
                        if comm == "bwrap":
                            bwrap_pid1_ok = True
        except OSError:
            pass
    other_leaks = {}
    other_checked = 0
    for cand in range(2, max_pid + 16):
        if cand in jail_unit_pids:
            continue
        res = probe_pid(cand)
        other_checked += 1
        if any(v not in ("ENOENT", "EACCES") for v in res.values()):
            other_leaks[str(cand)] = res

    def try_kill(pid: int) -> str:
        try:
            os.kill(pid, 0)
            return "OK"
        except OSError as ex:
            return errno.errorcode.get(ex.errno, str(ex.errno))

    def try_prlimit(pid: int, lim: str = "6666:6666") -> int:
        r = subprocess.run(
            ["${pkgs.util-linux}/bin/prlimit", f"--pid={pid}", f"--nofile={lim}"],
            capture_output=True,
            text=True,
        )
        return r.returncode

    self_pid = os.getpid()
    self_kill = try_kill(self_pid)
    self_prlimit = try_prlimit(self_pid, "7777:7777")
    self_nofile = resource.getrlimit(resource.RLIMIT_NOFILE)[0]

    sib_unit_kill = try_kill(sib_unit_pid)
    sib_host_kill = try_kill(sib_host_pid)
    sib_unit_prlimit = try_prlimit(sib_unit_pid, "6666:6666")
    sib_host_prlimit = try_prlimit(sib_host_pid, "6666:6666")

    root_host_kill = try_kill(root_host_pid)
    root_host_prlimit = try_prlimit(root_host_pid, "6666:6666")
    root_unit_prlimit = try_prlimit(root_unit_pid, "6666:6666")

    print(json.dumps({
        "self_status_ok": self_status_ok,
        "bwrap_pid1_ok": bwrap_pid1_ok,
        "nspids": nspids,
        "root": root_res,
        "other_checked": other_checked,
        "other_leaks": other_leaks,
        "self_kill": self_kill,
        "self_prlimit": self_prlimit,
        "self_nofile": self_nofile,
        "sib_unit_kill": sib_unit_kill,
        "sib_host_kill": sib_host_kill,
        "sib_unit_prlimit": sib_unit_prlimit,
        "sib_host_prlimit": sib_host_prlimit,
        "root_host_kill": root_host_kill,
        "root_host_prlimit": root_host_prlimit,
        "root_unit_prlimit": root_unit_prlimit,
    }))
  '';

  gi15TestScripts = pkgs.writeTextDir "stub_api.py" ''
    import functools, http.server, json, os, socket, socketserver, ssl, subprocess, sys, threading, time, urllib.parse

    LOG_PATH = "/tmp/gi15-api-log.jsonl"
    V68_PATH = "/tmp/v68-results.json"
    XMSG_DIR = "/run/user/1000/xmsg"
    XMSG_SOCK = f"{XMSG_DIR}/agent.sock"
    REG_SOCK = f"{XMSG_DIR}/register.sock"
    HTTP_SOCK = f"{XMSG_DIR}/http.sock"

    subprocess.run(["${pkgs.iproute2}/bin/ip", "addr", "replace", "198.18.0.1/32", "dev", "lo"], check=True)

    class QuietGitHttpsHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory="${gv2GitFixture}", **kwargs)
        def log_message(self, *args):
            pass

    git_https_srv = http.server.ThreadingHTTPServer(("0.0.0.0", 18443), QuietGitHttpsHandler)
    git_ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    git_ssl_ctx.load_cert_chain("${gv2TlsCerts}/cert.pem", "${gv2TlsCerts}/key.pem")
    git_https_srv.socket = git_ssl_ctx.wrap_socket(git_https_srv.socket, server_side=True)
    threading.Thread(target=git_https_srv.serve_forever, daemon=True).start()

    gh_https_srv = http.server.ThreadingHTTPServer(("198.18.0.1", 443), QuietGitHttpsHandler)
    gh_https_srv.socket = git_ssl_ctx.wrap_socket(gh_https_srv.socket, server_side=True)
    threading.Thread(target=gh_https_srv.serve_forever, daemon=True).start()

    os.makedirs(XMSG_DIR, mode=0o700, exist_ok=True)
    os.chown("/run/user/1000", 1000, 100)
    os.chown(XMSG_DIR, 1000, 100)

    def bind_unix_sock(path: str) -> socket.socket:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(path)
        os.chown(path, 1000, 100)
        os.chmod(path, 0o600)
        s.listen(16)
        return s

    xmsg_srv = bind_unix_sock(XMSG_SOCK)
    reg_srv = bind_unix_sock(REG_SOCK)

    xmsg_cond = threading.Condition()
    reg_queues: dict[str, list[dict]] = {}
    reg_alive: set[str] = set()
    reg_gen: dict[str, int] = {}
    reg_polling: dict[str, int] = {}
    msg_sender: dict[str, str] = {}
    msg_replies: dict[str, list[dict]] = {}
    idem_map: dict[str, str] = {}
    msg_seq = 0

    def next_msg_id() -> str:
        global msg_seq
        msg_seq += 1
        return f"msg-{msg_seq}"

    def handle_reg_conn(conn: socket.socket):
        me = ""
        my_gen = 0
        try:
            rf = conn.makefile("r", encoding="utf-8")
            first = rf.readline()
            if not first:
                return
            init = json.loads(first)
            me = init.get("name") or init.get("session_id") or ""
            harness = init.get("harness", "svc")
            if me.startswith("genie-expert-"):
                tier = me.split("genie-expert-", 1)[1]
                hsock = f"/var/lib/genie-agent/herdr-session-{tier}/herdr.sock"
                t0 = time.monotonic()
                while not os.path.exists(hsock) and time.monotonic() - t0 < 5.0:
                    time.sleep(0.05)
            with xmsg_cond:
                my_gen = reg_gen.get(me, 0) + 1
                reg_gen[me] = my_gen
                reg_alive.add(me)
                reg_queues.setdefault(me, [])
                xmsg_cond.notify_all()
            addr = f"svc:{me}@test" if harness == "svc" else f"{me}@test"
            conn.sendall((json.dumps({"address": addr, "node": "test"}) + "\n").encode("utf-8"))

            while True:
                line = rf.readline()
                if not line:
                    break
                req = json.loads(line)
                act = req.get("action")
                if act == "poll":
                    wait_s = min(float(req.get("waitSecs", 5)), 1.5)
                    deadline = time.monotonic() + wait_s
                    delivered = None
                    with xmsg_cond:
                        reg_polling[me] = my_gen
                        xmsg_cond.notify_all()
                        while True:
                            if reg_gen.get(me) != my_gen:
                                break
                            q = reg_queues.get(me, [])
                            if q:
                                delivered = dict(q[0])
                                break
                            rem = deadline - time.monotonic()
                            if rem <= 0:
                                break
                            xmsg_cond.wait(rem)
                    if delivered is not None:
                        conn.sendall((json.dumps({"action": "deliver", **delivered}) + "\n").encode("utf-8"))
                    else:
                        conn.sendall((json.dumps({"action": "timeout"}) + "\n").encode("utf-8"))
                elif act == "ack":
                    mid = req.get("messageId", "")
                    with xmsg_cond:
                        q = reg_queues.get(me, [])
                        reg_queues[me] = [m for m in q if m.get("messageId") != mid]
                        xmsg_cond.notify_all()
                    conn.sendall((json.dumps({"status": "ok"}) + "\n").encode("utf-8"))
                elif act == "reply":
                    orig_id = req.get("messageId", "")
                    text = req.get("text", "")
                    with xmsg_cond:
                        rep_id = next_msg_id()
                        sender = msg_sender.get(orig_id, "supervisor")
                        if sender == "supervisor":
                            msg_replies.setdefault(orig_id, []).append({"text": text, "messageId": rep_id})
                        else:
                            reg_queues.setdefault(sender, []).append({
                                "messageId": rep_id,
                                "inReplyTo": orig_id,
                                "text": text,
                            })
                        xmsg_cond.notify_all()
                    conn.sendall((json.dumps({"messageId": rep_id}) + "\n").encode("utf-8"))
        except Exception:
            pass
        finally:
            if me:
                with xmsg_cond:
                    if reg_gen.get(me) == my_gen:
                        reg_alive.discard(me)
                        xmsg_cond.notify_all()
            try:
                conn.close()
            except Exception:
                pass

    def serve_reg():
        while True:
            try:
                c, _ = reg_srv.accept()
                threading.Thread(target=handle_reg_conn, args=(c,), daemon=True).start()
            except Exception:
                time.sleep(0.05)

    def handle_agent_conn(conn: socket.socket):
        try:
            rf = conn.makefile("r", encoding="utf-8")
            while True:
                line = rf.readline()
                if not line:
                    break
                req = json.loads(line)
                act = req.get("action")
                if act == "send":
                    raw_to = req.get("to", "")
                    to = raw_to.removeprefix("svc:").split("@")[0]
                    text = req.get("text", "")
                    key = req.get("idempotency_key", "")
                    with xmsg_cond:
                        if key and key in idem_map:
                            mid = idem_map[key]
                        else:
                            is_svc = raw_to.startswith("svc:") or to == "genie" or to.startswith("genie-expert-")
                            if not is_svc and to not in reg_alive:
                                conn.sendall((json.dumps({
                                    "status": "error",
                                    "error": "not_found",
                                    "detail": f"{to} is not registered",
                                }) + "\n").encode("utf-8"))
                                continue
                            mid = next_msg_id()
                            if key:
                                idem_map[key] = mid
                            msg_sender[mid] = "supervisor" if is_svc else "genie-expert-public"
                            reg_queues.setdefault(to, []).append({"messageId": mid, "text": text})
                            xmsg_cond.notify_all()
                    conn.sendall((json.dumps({"address": f"{to}@test", "message_id": mid}) + "\n").encode("utf-8"))
                elif act == "status":
                    name = req.get("name", "")
                    with xmsg_cond:
                        st = {
                            "gen": reg_gen.get(name, 0),
                            "polling": reg_polling.get(name, 0),
                            "alive": name in reg_alive,
                        }
                    conn.sendall((json.dumps(st) + "\n").encode("utf-8"))
                elif act == "reset":
                    name = req.get("name", "")
                    with xmsg_cond:
                        reg_queues[name] = []
                        xmsg_cond.notify_all()
                    conn.sendall((json.dumps({"status": "ok"}) + "\n").encode("utf-8"))
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def serve_agent():
        while True:
            try:
                c, _ = xmsg_srv.accept()
                threading.Thread(target=handle_agent_conn, args=(c,), daemon=True).start()
            except Exception:
                time.sleep(0.05)

    class UnixHttpServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        address_family = socket.AF_UNIX
        daemon_threads = True

    class XmsgHttpHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            if parsed.path == "/v1/recipients":
                with xmsg_cond:
                    recs = [
                        {"address": f"{r}@test"}
                        for r in sorted(reg_alive)
                        if not r.startswith("genie-expert-") and r != "genie"
                    ]
                body = json.dumps({"recipients": recs}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif parsed.path.startswith("/v1/messages/") and parsed.path.endswith("/replies"):
                parts = parsed.path.split("/")
                mid = urllib.parse.unquote(parts[3]) if len(parts) >= 5 else ""
                wait_s = min(float(qs.get("wait", ["5"])[0]), 30.0)
                deadline = time.monotonic() + wait_s
                with xmsg_cond:
                    while not msg_replies.get(mid):
                        rem = deadline - time.monotonic()
                        if rem <= 0:
                            break
                        xmsg_cond.wait(rem)
                    reps = list(msg_replies.get(mid, []))
                body = json.dumps(reps).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

    try:
        os.unlink(HTTP_SOCK)
    except FileNotFoundError:
        pass
    http_unix_srv = UnixHttpServer(HTTP_SOCK, XmsgHttpHandler)
    os.chown(HTTP_SOCK, 1000, 100)
    os.chmod(HTTP_SOCK, 0o600)
    threading.Thread(target=serve_reg, daemon=True).start()
    threading.Thread(target=serve_agent, daemon=True).start()
    threading.Thread(target=http_unix_srv.serve_forever, daemon=True).start()

    v68_step = 0
    lock = threading.Lock()

    def get_user_prompt(msgs):
        texts = []
        for m in msgs:
            if m.get("role") == "user":
                c = m.get("content")
                if isinstance(c, str):
                    t = c.strip()
                    if t and not t.startswith("<system-reminder>"):
                        texts.append(t)
                elif isinstance(c, list):
                    for blk in c:
                        if isinstance(blk, dict) and blk.get("type") == "text":
                            t = blk.get("text", "").strip()
                            if t and not t.startswith("<system-reminder>"):
                                texts.append(t)
        return texts[-1] if texts else ""

    def collect_tool_results(msgs):
        trs = []
        for m in msgs:
            c = m.get("content")
            if isinstance(c, list):
                for blk in c:
                    if isinstance(blk, dict) and blk.get("type") == "tool_result":
                        trs.append(blk)
        return trs

    def extract_openai_tool_outputs(msgs):
        outs = []
        for m in msgs:
            if m.get("role") == "tool":
                c = m.get("content", "")
                if isinstance(c, str):
                    outs.append(c)
                elif isinstance(c, list):
                    outs.append("".join(b.get("text", "") for b in c if isinstance(b, dict)))
                else:
                    outs.append(str(c))
        return outs

    oai_call_seq = 0

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/search":
                qs = urllib.parse.parse_qs(parsed.query)
                q = qs.get("q", [""])[0]
                body = json.dumps({
                    "results": [{
                        "title": f"GV2 Title for {q}",
                        "url": "https://example.org/gv2-search",
                        "content": f"gv2-search-result-canary:{q}",
                    }]
                }).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def do_PUT(self):
            length = int(self.headers.get("Content-Length", "0"))
            if length > 0:
                self.rfile.read(length)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            global v68_step, oai_call_seq
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8", "replace")
            try:
                body = json.loads(raw)
            except Exception:
                body = {}
            msgs = body.get("messages", [])
            prompt = get_user_prompt(msgs)
            trs = collect_tool_results(msgs)
            auth = self.headers.get("Authorization") or self.headers.get("authorization") or ""

            if self.path.startswith("/v1/chat/completions"):
                if not body.get("stream"):
                    resp_bytes = json.dumps({
                        "id": "chatcmpl_gv2_go",
                        "object": "chat.completion",
                        "choices": [{
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {
                                "role": "assistant",
                                "content": "{\"verdict\":\"pass\",\"reason\":\"clean\"}",
                            },
                        }],
                    }).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(resp_bytes)))
                    self.end_headers()
                    self.wfile.write(resp_bytes)
                    return

                tool_outs = extract_openai_tool_outputs(msgs)
                step = len(tool_outs)
                tc = None
                if prompt.startswith("gv2-turn-A:"):
                    if step == 0:
                        tc = ("read", {"path": "/memory/MEMORY.md"})
                    elif step == 1:
                        tc = ("clone", {"url": "https://gv2-git.example.org:18443/fixture.git"})
                    elif step == 2:
                        try:
                            cp = json.loads(tool_outs[1]).get("path", "/err")
                        except Exception:
                            cp = "/err"
                        tc = ("read", {"path": f"{cp}/README.md"})
                    elif step == 3:
                        try:
                            cp = json.loads(tool_outs[1]).get("path", "/err")
                        except Exception:
                            cp = "/err"
                        tc = ("read", {"path": f"{cp}/tracked-link"})
                    elif step == 4:
                        tc = ("web_search", {"query": "gv2-search-canary"})
                    elif step == 5 and prompt in ("gv2-turn-A:norm", "gv2-turn-A:m_eval_proc_mount"):
                        tc = ("eval", {
                            "repo": "owner/repo",
                            "rev": "0123456789abcdef0123456789abcdef01234567",
                            "attr": "packages.x86_64-linux.default",
                            "trusted": "no",
                            "secrets": "none",
                        })
                    elif step == 6 and prompt == "gv2-turn-A:norm":
                        tc = ("eval", {
                            "repo": "owner/repo",
                            "rev": "0123456789abcdef0123456789abcdef01234567",
                            "attr": "packages.x86_64-linux.ifd",
                            "trusted": "yes",
                            "secrets": "none",
                        })
                    elif (
                        (step == 5 and prompt not in ("gv2-turn-A:norm", "gv2-turn-A:m_eval_proc_mount"))
                        or (step == 6 and prompt == "gv2-turn-A:m_eval_proc_mount")
                        or (step == 7 and prompt == "gv2-turn-A:norm")
                    ):
                        try:
                            cp = json.loads(tool_outs[1]).get("path", "/err")
                        except Exception:
                            cp = f"err:{tool_outs[1]}"
                        ev_out = None
                        ev_ifd_out = None
                        if prompt in ("gv2-turn-A:norm", "gv2-turn-A:m_eval_proc_mount") and len(tool_outs) > 5:
                            try:
                                ev_out = json.loads(tool_outs[5])
                            except Exception:
                                ev_out = {"raw": tool_outs[5]}
                        if prompt == "gv2-turn-A:norm" and len(tool_outs) > 6:
                            try:
                                ev_ifd_out = json.loads(tool_outs[6])
                            except Exception:
                                ev_ifd_out = {"raw": tool_outs[6]}
                        ans_str = json.dumps({
                            "gv2": prompt,
                            "mem": tool_outs[0].splitlines()[0].strip() if tool_outs[0] else "",
                            "clone_path": cp,
                            "readme": tool_outs[2].strip(),
                            "link": tool_outs[3].strip(),
                            "search": tool_outs[4].strip(),
                            **({"eval": ev_out} if ev_out is not None else {}),
                            **({"eval_ifd": ev_ifd_out} if ev_ifd_out is not None else {}),
                        })
                        tc = ("reply", {
                            "answer": ans_str,
                            "confidence": 0.95,
                            "gaps": [],
                            "escalate_forced": "no",
                        })
                elif prompt.startswith("gv2-turn-B:"):
                    if step == 0:
                        tc = ("reply", {
                            "answer": f"gv2-B-ok:{prompt}",
                            "confidence": 0.95,
                            "gaps": [],
                            "escalate_forced": "no",
                        })

                with lock:
                    oai_call_seq += 1
                    cid = f"call_gv2_{oai_call_seq}"
                if tc is not None:
                    delta = {
                        "role": "assistant",
                        "tool_calls": [{
                            "index": 0,
                            "id": cid,
                            "type": "function",
                            "function": {
                                "name": tc[0],
                                "arguments": json.dumps(tc[1]),
                            },
                        }],
                    }
                    fin = "tool_calls"
                else:
                    delta = {"role": "assistant", "content": "done"}
                    fin = "stop"

                def mk_chunk(d, f_reason):
                    return "data: " + json.dumps({
                        "id": cid,
                        "object": "chat.completion.chunk",
                        "created": 0,
                        "model": body.get("model", "m"),
                        "choices": [{"index": 0, "delta": d, "finish_reason": f_reason}],
                    }) + "\n\n"

                sse_payload = (mk_chunk(delta, None) + mk_chunk({}, fin) + "data: [DONE]\n\n").encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(sse_payload)))
                self.end_headers()
                self.wfile.write(sse_payload)
                self.wfile.flush()
                return

            with lock:
                with open(LOG_PATH, "a", encoding="utf-8") as lf:
                    lf.write(json.dumps({
                        "path": self.path,
                        "auth": auth,
                        "prompt": prompt,
                        "tool_results": trs,
                        "ts": time.time(),
                    }) + "\n")

            content = [{"type": "text", "text": f"ACK:{prompt}"}]
            stop_reason = "end_turn"

            if prompt.startswith("v6-jail-suite"):
                if not trs:
                    content = [{
                        "type": "tool_use",
                        "id": "tu_v6_suite",
                        "name": "Bash",
                        "input": {
                            "command": "export GENIE_V6_SANDBOX_CONTROL=1; ${pkgs.python3}/bin/python3 -I /etc/genie-gi15-test/jail_suite.py"
                        },
                    }]
                    stop_reason = "tool_use"
                else:
                    content = [{"type": "text", "text": "SUITE_DONE"}]
                    stop_reason = "end_turn"
            elif prompt == "v68-rw":
                s_path = "/var/lib/genie-agent/claude-public/settings.json"
                c_path = "/var/lib/genie-agent/claude-public/.claude.json"
                z_path = "/var/lib/genie-agent/.zshenv"
                h_path = "/var/lib/genie-agent/.config/herdr/x"
                w_git = "/var/lib/genie-agent/dispatcher-public/worktrees/.git"
                w_b = "/var/lib/genie-agent/dispatcher-public/worktrees/thread-B/.claude/settings.json"
                if not trs:
                    content = [
                        {"type": "tool_use", "id": "r1", "name": "Read", "input": {"file_path": s_path}},
                        {"type": "tool_use", "id": "r2", "name": "Read", "input": {"file_path": c_path}},
                    ]
                    stop_reason = "tool_use"
                elif not any(t.get("tool_use_id", "").startswith("w") for t in trs):
                    content = [
                        {"type": "tool_use", "id": "w1", "name": "Write", "input": {"file_path": z_path, "content": "pwn\n"}},
                        {"type": "tool_use", "id": "w2", "name": "Write", "input": {"file_path": s_path, "content": "{}\n"}},
                        {"type": "tool_use", "id": "w3", "name": "Write", "input": {"file_path": c_path, "content": "{}\n"}},
                        {"type": "tool_use", "id": "w4", "name": "Write", "input": {"file_path": h_path, "content": "pwn\n"}},
                        {"type": "tool_use", "id": "w5", "name": "Write", "input": {"file_path": w_git, "content": "pwn\n"}},
                        {"type": "tool_use", "id": "w6", "name": "Write", "input": {"file_path": w_b, "content": "{}\n"}},
                    ]
                    stop_reason = "tool_use"
                else:
                    w_trs = [t for t in trs if t.get("tool_use_id", "").startswith("w")]
                    with open(V68_PATH, "w", encoding="utf-8") as wf:
                        json.dump(w_trs, wf)
                    content = [{"type": "text", "text": "V68_DONE"}]
                    stop_reason = "end_turn"
            elif prompt.startswith("v610-git"):
                if not trs:
                    content = [{
                        "type": "tool_use",
                        "id": "tu_v610",
                        "name": "Bash",
                        "input": {
                            "command": "${pkgs.python3}/bin/python3 -I /etc/genie-gi15-test/setup_v610_repo.py ."
                        },
                    }]
                    stop_reason = "tool_use"
                else:
                    content = [{"type": "text", "text": "V610_DONE"}]
                    stop_reason = "end_turn"

            if body.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                def sse(ev, data):
                    self.wfile.write(f"event: {ev}\ndata: {json.dumps(data)}\n\n".encode("utf-8"))
                sse("message_start", {
                    "type": "message_start",
                    "message": {
                        "id": "msg_gi15",
                        "type": "message",
                        "role": "assistant",
                        "model": body.get("model", "claude-sonnet-4-6"),
                        "content": [],
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": 10, "output_tokens": 1},
                    },
                })
                for idx, blk in enumerate(content):
                    if blk["type"] == "tool_use":
                        sse("content_block_start", {
                            "type": "content_block_start",
                            "index": idx,
                            "content_block": {"type": "tool_use", "id": blk["id"], "name": blk["name"], "input": {}},
                        })
                        sse("content_block_delta", {
                            "type": "content_block_delta",
                            "index": idx,
                            "delta": {"type": "input_json_delta", "partial_json": json.dumps(blk["input"])},
                        })
                        sse("content_block_stop", {"type": "content_block_stop", "index": idx})
                    else:
                        sse("content_block_start", {
                            "type": "content_block_start",
                            "index": idx,
                            "content_block": {"type": "text", "text": ""},
                        })
                        sse("content_block_delta", {
                            "type": "content_block_delta",
                            "index": idx,
                            "delta": {"type": "text_delta", "text": blk["text"]},
                        })
                        sse("content_block_stop", {"type": "content_block_stop", "index": idx})
                sse("message_delta", {
                    "type": "message_delta",
                    "delta": {"stop_reason": stop_reason, "stop_sequence": None},
                    "usage": {"output_tokens": 10},
                })
                sse("message_stop", {"type": "message_stop"})
                self.wfile.flush()
            else:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "id": "msg_gi15",
                    "type": "message",
                    "role": "assistant",
                    "model": body.get("model", "claude-sonnet-4-6"),
                    "content": content,
                    "stop_reason": stop_reason,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 10, "output_tokens": 10},
                }).encode("utf-8"))

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 18080), Handler)
    srv.serve_forever()
  '';

  jailSuitePy = pkgs.writeText "jail_suite.py" ''
    import errno, json, os, socket, stat, subprocess, time

    TOK_PUB = b"canary-public-token-" + b"0000"
    TOK_TRU = b"canary-trusted-token-" + b"0000"
    CFG_DIR = os.environ.get("CLAUDE_CONFIG_DIR", "/var/lib/genie-agent/claude-public")

    def get_nspids(pid_str: str) -> list[str]:
        try:
            with open(f"/proc/{pid_str}/status", "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("NSpid:"):
                        return line.split()[1:]
        except OSError:
            pass
        return []

    # 1. V6.1 jailed arm: sweep /proc/[0-9]*/environ
    v61_per_pid = {}
    v61_outer_readable = 0
    v61_inner_read = 0
    v61_ctrl_hits = 0
    v61_tok_hits = 0
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        nspids = get_nspids(entry)
        is_outer = len(nspids) == 1
        try:
            with open(f"/proc/{entry}/environ", "rb") as f:
                data = f.read()
            v61_per_pid[entry] = "read"
            if is_outer:
                v61_outer_readable += 1
            else:
                v61_inner_read += 1
            if b"GENIE_V6_SANDBOX_CONTROL=1" in data:
                v61_ctrl_hits += 1
            if TOK_PUB in data or TOK_TRU in data:
                v61_tok_hits += 1
        except PermissionError:
            v61_per_pid[entry] = "EACCES"
        except FileNotFoundError:
            v61_per_pid[entry] = "ENOENT"
        except OSError as e:
            v61_per_pid[entry] = f"ERR:{e.errno}"

    # 2. V6.2 jailed arm: sweep /proc/[0-9]*/fd/*
    v62_counts = {"reg": 0, "fifo": 0, "sock": 0, "chr": 0, "anon_inode": 0, "other": 0}
    v62_tok_hits = 0
    v62_sock_enxio = 0
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        fd_dir = f"/proc/{entry}/fd"
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        for fd_name in fds:
            p = f"{fd_dir}/{fd_name}"
            try:
                target = os.readlink(p)
            except OSError:
                target = ""
            try:
                st = os.stat(p)
            except OSError:
                continue
            m = st.st_mode
            if stat.S_ISFIFO(m):
                v62_counts["fifo"] += 1
                # Never open or read FIFOs
                continue
            elif stat.S_ISSOCK(m):
                v62_counts["sock"] += 1
                try:
                    sfd = os.open(p, os.O_RDONLY | os.O_NONBLOCK)
                    os.close(sfd)
                except OSError as e:
                    if e.errno == errno.ENXIO:
                        v62_sock_enxio += 1
            elif stat.S_ISCHR(m):
                v62_counts["chr"] += 1
            elif stat.S_ISREG(m):
                v62_counts["reg"] += 1
                try:
                    rfd = os.open(p, os.O_RDONLY | os.O_NONBLOCK)
                    try:
                        chunk = os.read(rfd, 256 * 1024)
                        if TOK_PUB in chunk or TOK_TRU in chunk:
                            v62_tok_hits += 1
                    finally:
                        os.close(rfd)
                except OSError:
                    pass
            elif "anon_inode" in target:
                v62_counts["anon_inode"] += 1
            else:
                v62_counts["other"] += 1

    # 3. V6.3 jailed arm: filesystem sweep
    v63_roots = ["/var/lib/genie-agent", "/var/lib/genie", "/run/credentials", "/run/genie-secrets", "/tmp"]
    v63_tok_hits = 0
    v63_files_scanned = 0
    for root in v63_roots:
        if not os.path.exists(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                if fp.endswith("jail-suite-report.json"):
                    continue
                try:
                    st = os.lstat(fp)
                    if not stat.S_ISREG(st.st_mode):
                        continue
                    with open(fp, "rb") as f:
                        data = f.read(256 * 1024)
                    v63_files_scanned += 1
                    if TOK_PUB in data or TOK_TRU in data:
                        v63_tok_hits += 1
                except OSError:
                    pass

    # 4. V6.7 direct herdr.sock reach + herdr CLI
    herdr_sock = "/var/lib/genie-agent/.config/herdr/sessions/genie-public/herdr.sock"
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(herdr_sock)
        v67_sock_err = "OK"
    except OSError as e:
        v67_sock_err = errno.errorcode.get(e.errno, str(e.errno))
    finally:
        s.close()

    r_cli = subprocess.run(["${lib.getExe pkgs.herdr}", "--session", "genie-public", "pane", "list"], capture_output=True, text=True)
    v67_cli_rc = r_cli.returncode

    # 5. V6.7b reach via /proc/<herdr-ns-pid>/root
    # Find an outer PID (NSpid depth == 1 in genie-herdr@public's /proc, e.g. PID 1 herdr server or parent shell)
    v67b_results = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        nspids = get_nspids(entry)
        if len(nspids) == 1:
            s2 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                s2.connect(f"/proc/{entry}/root{herdr_sock}")
                v67b_results[entry] = "OK"
            except OSError as e:
                v67b_results[entry] = errno.errorcode.get(e.errno, str(e.errno))
            finally:
                s2.close()

    # 6. V6.9 fsmonitor execution inside thread A's worktree
    cwd = os.getcwd()
    fsm_script = os.path.join(cwd, "fsm-hook.py")
    fsm_out = os.path.join(cwd, "fsm-report.json")
    fsm_lines = [
        "#!${pkgs.python3}/bin/python3 -I",
        "import errno, json, os, socket, sys",
        "TOK_PUB = b'canary-public-token-' + b'0000'",
        "TOK_TRU = b'canary-trusted-token-' + b'0000'",
        "nspids = []",
        "with open('/proc/self/status', 'r', encoding='utf-8') as sf:",
        "    for line in sf:",
        "        if line.startswith('NSpid:'):",
        "            nspids = line.split()[1:]",
        "env_hits = sum(1 for k, v in os.environ.items() if TOK_PUB.decode() in v or TOK_TRU.decode() in v)",
        "environ_hits = 0",
        "for e in os.listdir('/proc'):",
        "    if e.isdigit():",
        "        try:",
        "            d = open(f'/proc/{e}/environ', 'rb').read()",
        "            if TOK_PUB in d or TOK_TRU in d:",
        "                environ_hits += 1",
        "        except OSError:",
        "            pass",
        "hs = '/var/lib/genie-agent/.config/herdr/sessions/genie-public/herdr.sock'",
        "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
        "try:",
        "    s.connect(hs)",
        "    hs_state = 'VISIBLE'",
        "except OSError as ex:",
        "    hs_state = errno.errorcode.get(ex.errno, str(ex.errno))",
        "finally:",
        "    s.close()",
        "try:",
        "    os.listdir('/var/lib/genie-agent/dispatcher-public/launch')",
        "    launch_state = 'VISIBLE'",
        "except OSError as ex:",
        "    launch_state = errno.errorcode.get(ex.errno, str(ex.errno))",
        "outer_root_state = 'EACCES'",
        "for e in os.listdir('/proc'):",
        "    if e.isdigit():",
        "        try:",
        "            with open(f'/proc/{e}/status') as stf:",
        "                ns = [l.split()[1:] for l in stf if l.startswith('NSpid:')][0]",
        "            if len(ns) == 1:",
        "                os.listdir(f'/proc/{e}/root')",
        "                outer_root_state = 'VISIBLE'",
        "        except OSError as ex:",
        "            outer_root_state = errno.errorcode.get(ex.errno, str(ex.errno))",
        "            break",
        f"with open({repr(fsm_out)}, 'w', encoding='utf-8') as out:",
        "    json.dump({",
        "        'nspid_depth': len(nspids),",
        "        'nspids': nspids,",
        "        'env_hits': env_hits,",
        "        'environ_hits': environ_hits,",
        "        'herdr_sock': hs_state,",
        "        'launch_dir': launch_state,",
        "        'outer_root': outer_root_state,",
        "    }, out)",
        "sys.exit(1)",
    ]
    with open(fsm_script, "w", encoding="utf-8") as f:
        f.write("\n".join(fsm_lines) + "\n")
    os.chmod(fsm_script, 0o755)
    subprocess.run(["${pkgs.git}/bin/git", "init", "-q", cwd], check=False)
    subprocess.run(["${pkgs.git}/bin/git", "-C", cwd, "config", "core.fsmonitor", fsm_script], check=False)
    subprocess.run(["${pkgs.git}/bin/git", "-C", cwd, "--no-optional-locks", "status", "--short", "--ignore-submodules=dirty"], check=False)
    v69_report = {}
    if os.path.exists(fsm_out):
        with open(fsm_out, "r", encoding="utf-8") as f:
            v69_report = json.load(f)

    # 7. V6.11 xmsgSocket read-only bind check
    xmsg_sock = "/run/user/1000/xmsg/agent.sock"
    rm_res = subprocess.run(["${coreutils}/rm", xmsg_sock], capture_output=True, text=True)
    if rm_res.returncode == 0:
        v611_unlink_err = "OK"
        s_rep = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s_rep.bind(xmsg_sock)
        s_rep.close()
    else:
        try:
            os.unlink(xmsg_sock)
            v611_unlink_err = "OK"
            s_rep = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s_rep.bind(xmsg_sock)
            s_rep.close()
        except OSError as e:
            v611_unlink_err = errno.errorcode.get(e.errno, str(e.errno))

    report = {
        "v61": {
            "outer_readable": v61_outer_readable,
            "inner_read": v61_inner_read,
            "ctrl_hits": v61_ctrl_hits,
            "tok_hits": v61_tok_hits,
            "per_pid": v61_per_pid,
        },
        "v62": {
            "counts": v62_counts,
            "tok_hits": v62_tok_hits,
            "sock_enxio": v62_sock_enxio,
        },
        "v63": {
            "files_scanned": v63_files_scanned,
            "tok_hits": v63_tok_hits,
        },
        "v67": {
            "sock_err": v67_sock_err,
            "cli_rc": v67_cli_rc,
        },
        "v67b": v67b_results,
        "v69": v69_report,
        "v611": {
            "rm_rc": rm_res.returncode,
            "rm_stderr": rm_res.stderr.strip(),
            "unlink_err": v611_unlink_err,
        },
    }
    out_file = os.path.join(CFG_DIR, "jail-suite-report.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(report, f)

    # Hold while release-hold is absent (up to 15s) so herdr-namespace V6.1 & V6.2 can inspect live claude PID
    hold_flag = os.path.join(CFG_DIR, "hold-for-herdr-sweep")
    if os.path.exists(hold_flag):
        ready_flag = os.path.join(CFG_DIR, "jail-suite-ready")
        with open(ready_flag, "w", encoding="utf-8") as f:
            f.write(str(os.getppid()))
        t0 = time.monotonic()
        while os.path.exists(hold_flag) and time.monotonic() - t0 < 20.0:
            time.sleep(0.05)
  '';

  setupV610RepoPy = pkgs.writeText "setup_v610_repo.py" ''
    import os, subprocess, sys
    GIT = "${pkgs.git}/bin/git"
    TOUCH = "${coreutils}/touch"
    repo = os.path.abspath(sys.argv[1])
    mark = sys.argv[2] if len(sys.argv) > 2 else "/var/lib/genie-agent/.config/herdr/sessions/genie-public/v610-mark"
    os.makedirs(repo, exist_ok=True)
    subprocess.run([GIT, "init", "-q", "-b", "main", repo], check=True)
    subprocess.run([GIT, "-C", repo, "config", "user.email", "test@example.com"], check=True)
    subprocess.run([GIT, "-C", repo, "config", "user.name", "Test"], check=True)
    with open(os.path.join(repo, "README"), "w", encoding="utf-8") as f:
        f.write("v610\n")
    subprocess.run([GIT, "-C", repo, "add", "README"], check=True)
    subprocess.run([GIT, "-C", repo, "commit", "--allow-empty", "-q", "-m", "init"], check=True)
    subprocess.run([GIT, "-C", repo, "config", "core.repositoryformatversion", "1"], check=True)
    subprocess.run([GIT, "-C", repo, "config", "extensions.partialClone", "origin"], check=True)
    subprocess.run([GIT, "-C", repo, "config", "remote.origin.promisor", "true"], check=True)
    subprocess.run([GIT, "-C", repo, "config", "remote.origin.url", "ssh://x/y"], check=True)
    subprocess.run([GIT, "-C", repo, "config", "core.sshCommand", f"{TOUCH} {mark}; false"], check=True)
    subprocess.run([GIT, "-C", repo, "config", "branch.main.remote", "origin"], check=True)
    subprocess.run([GIT, "-C", repo, "config", "branch.main.merge", "refs/heads/main"], check=True)
    ref_dir = os.path.join(repo, ".git", "refs", "remotes", "origin")
    os.makedirs(ref_dir, exist_ok=True)
    with open(os.path.join(ref_dir, "main"), "w", encoding="utf-8") as f:
        f.write("1111111111111111111111111111111111111111\n")
  '';

  herdrV61V62Py = pkgs.writeText "herdr_v61_v62.py" ''
    import errno, json, os, stat

    TOK_PUB = b"canary-public-token-" + b"0000"
    TOK_TRU = b"canary-trusted-token-" + b"0000"

    def get_nspids(p):
        try:
            with open(f"/proc/{p}/status", "r", encoding="utf-8") as f:
                for l in f:
                    if l.startswith("NSpid:"):
                        return l.split()[1:]
        except OSError:
            pass
        return []

    def get_comm(p):
        try:
            return open(f"/proc/{p}/comm", "r", encoding="utf-8").read().strip()
        except OSError:
            return ""

    per_pid = {}
    depth2_read = 0
    ctrl_hits = 0
    tok_hits = 0
    claude_environ_read = False
    claude_cfg_found = False
    claude_tok_hits = 0

    fd_counts = {"reg": 0, "fifo": 0, "sock": 0, "chr": 0, "anon_inode": 0}
    fd_tok_hits = 0
    sock_enxio = 0

    for e in os.listdir("/proc"):
        if not e.isdigit():
            continue
        nspids = get_nspids(e)
        comm = get_comm(e)
        try:
            data = open(f"/proc/{e}/environ", "rb").read()
            per_pid[e] = "read"
            if len(nspids) == 1:
                depth2_read += 1
            if b"GENIE_V6_CONTROL=1" in data:
                ctrl_hits += 1
            if TOK_PUB in data or TOK_TRU in data:
                tok_hits += 1
            if "claude" in comm or b"CLAUDE_CODE_OAUTH_TOKEN" in data or (len(nspids) >= 2 and b"CLAUDE_CONFIG_DIR=" in data):
                claude_environ_read = True
                if b"CLAUDE_CONFIG_DIR=/var/lib/genie-agent/claude-public" in data:
                    claude_cfg_found = True
                if TOK_PUB in data or TOK_TRU in data:
                    claude_tok_hits += 1
        except PermissionError:
            per_pid[e] = "EACCES"
        except FileNotFoundError:
            per_pid[e] = "ENOENT"

        fd_dir = f"/proc/{e}/fd"
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        for fn in fds:
            fp = f"{fd_dir}/{fn}"
            try:
                target = os.readlink(fp)
                st = os.stat(fp)
            except OSError:
                continue
            m = st.st_mode
            if stat.S_ISFIFO(m):
                fd_counts["fifo"] += 1
                continue
            elif stat.S_ISSOCK(m):
                fd_counts["sock"] += 1
                try:
                    sfd = os.open(fp, os.O_RDONLY | os.O_NONBLOCK)
                    os.close(sfd)
                except OSError as ex:
                    if ex.errno == errno.ENXIO:
                        sock_enxio += 1
            elif stat.S_ISCHR(m):
                fd_counts["chr"] += 1
            elif stat.S_ISREG(m):
                fd_counts["reg"] += 1
                try:
                    rfd = os.open(fp, os.O_RDONLY | os.O_NONBLOCK)
                    try:
                        c = os.read(rfd, 256 * 1024)
                        if TOK_PUB in c or TOK_TRU in c:
                            fd_tok_hits += 1
                    finally:
                        os.close(rfd)
                except OSError:
                    pass
            elif "anon_inode" in target:
                fd_counts["anon_inode"] += 1

    print(json.dumps({
        "v61": {
            "depth2_read": depth2_read,
            "ctrl_hits": ctrl_hits,
            "tok_hits": tok_hits,
            "claude_environ_read": claude_environ_read,
            "claude_cfg_found": claude_cfg_found,
            "claude_tok_hits": claude_tok_hits,
        },
        "v62": {
            "counts": fd_counts,
            "tok_hits": fd_tok_hits,
            "sock_enxio": sock_enxio,
        },
    }))
  '';

  herdrV63Py = pkgs.writeText "herdr_v63.py" ''
    import errno, json, os, stat

    TOK_PUB = b"canary-public-token-" + b"0000"
    TOK_TRU = b"canary-trusted-token-" + b"0000"
    CTRLS = {
        "genie-agent": b"canary-fs-control-genie-agent-0000",
        "genie": b"canary-fs-control-genie-0000",
        "credentials": b"canary-fs-control-credentials-0000",
        "secrets": b"canary-fs-control-secrets-0000",
        "tmp": b"canary-fs-control-tmp-0000",
    }
    ctrl_hits = {k: 0 for k in CTRLS}
    tok_hits = 0

    for root in ["/var/lib/genie-agent", "/var/lib/genie", "/run/credentials", "/run/genie-secrets", "/tmp"]:
        if not os.path.exists(root):
            continue
        for dp, _dns, fns in os.walk(root):
            for fn in fns:
                fp = os.path.join(dp, fn)
                try:
                    st = os.lstat(fp)
                    if not stat.S_ISREG(st.st_mode):
                        continue
                    data = open(fp, "rb").read(256 * 1024)
                    if TOK_PUB in data or TOK_TRU in data:
                        tok_hits += 1
                    for k, needle in CTRLS.items():
                        if needle in data:
                            ctrl_hits[k] += 1
                except OSError:
                    pass

    def is_masked(p):
        try:
            entries = os.listdir(p)
            for e in entries:
                os.stat(os.path.join(p, e))
            return len(entries) == 0
        except OSError as ex:
            return ex.errno in (errno.EACCES, errno.ENOENT, errno.EPERM)

    masked = {
        "dispatcher_trusted": is_masked("/var/lib/genie-agent/dispatcher-trusted"),
        "claude_trusted": is_masked("/var/lib/genie-agent/claude-trusted"),
        "run_credentials": is_masked("/run/credentials"),
        "run_secrets": is_masked("/run/genie-secrets"),
    }
    print(json.dumps({"tok_hits": tok_hits, "ctrl_hits": ctrl_hits, "masked": masked}))
  '';

  driverPy = pkgs.writeText "driver.py" ''
    import ctypes, errno, fcntl, hashlib, json, os, pty, re, shutil, socket, stat, struct, subprocess, sys, termios, threading, time, uuid

    os.chdir("/tmp")
    CLEAN_PATH = "${pkgs.coreutils}/bin:${pkgs.git}/bin:${pkgs.python3}/bin:${pkgs.bubblewrap}/bin:/run/current-system/sw/bin"
    os.environ["PATH"] = CLEAN_PATH

    STATE_DIR = "/var/lib/genie-agent"
    TOK_PUB = "${tokens.public}"
    TOK_TRU = "${tokens.trusted}"
    HASH_PUB = hashlib.sha256(TOK_PUB.encode()).hexdigest()
    HASH_TRU = hashlib.sha256(TOK_TRU.encode()).hexdigest()

    red = []

    # Item 52: driver timing. Each cell prints its own elapsed time and the running total;
    # start, end, red exit, uncaught exception and SIGTERM (guest `timeout`) all print a total.
    # Lines are mirrored to /dev/kmsg so they appear live, guest-timestamped, on the serial log
    # even if the captured stdout is lost (best effort; printk may ratelimit bursts).
    import atexit, signal
    _T0 = time.monotonic()
    _T_LAST = [_T0]
    _TIMING_DONE = [False]
    try:
        _CONSOLE = open("/dev/kmsg", "w", encoding="utf-8", buffering=1)
    except OSError:
        _CONSOLE = None

    def timing(msg: str):
        line = f"[TIMING] {msg}"
        print(line, flush=True)
        if _CONSOLE is not None:
            try:
                _CONSOLE.write(line + "\n")
            except OSError:
                pass

    def timing_mark(label: str):
        now = time.monotonic()
        timing(f"{label} elapsed={now - _T_LAST[0]:.1f}s total={now - _T0:.1f}s")
        _T_LAST[0] = now

    _PID0 = os.getpid()

    def timing_end(reason: str):
        if _TIMING_DONE[0] or os.getpid() != _PID0:
            return
        _TIMING_DONE[0] = True
        timing(f"driver end reason={reason} total={time.monotonic() - _T0:.1f}s red={red}")

    def _on_sigterm(signum, frame):
        if os.getpid() != _PID0:
            # forked helper: keep default SIGTERM semantics
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            os.kill(os.getpid(), signal.SIGTERM)
            return
        timing_end("SIGTERM (guest timeout?)")
        os._exit(143)

    signal.signal(signal.SIGTERM, _on_sigterm)
    atexit.register(lambda: timing_end("exit"))
    timing(f"driver start wall={time.strftime('%Y-%m-%dT%H:%M:%S%z')}")

    def cell(name: str, ok: bool, detail: str):
        if ok:
            print(f"CELL {name} GREEN: {detail}", flush=True)
        else:
            print(f"CELL {name} RED: {detail}", flush=True)
            red.append(name)
        timing_mark(f"cell={name}")

    def get_unit_shim(tier: str) -> str:
        out = subprocess.check_output(["systemctl", "cat", f"genie-dispatcher@{tier}"], text=True)
        m = re.search(r"--claude-bin\s+(\S+)", out)
        assert m, f"missing --claude-bin in genie-dispatcher@{tier}"
        return m.group(1).strip("'\"")

    def get_herdr_bin(tier: str) -> str:
        out = subprocess.check_output(["systemctl", "cat", f"genie-herdr@{tier}"], text=True)
        m = re.search(r"ExecStart=(\S+)\s+--session", out)
        assert m, f"missing ExecStart herdr in genie-herdr@{tier}"
        return m.group(1).strip("'\"")

    def can_connect_unix(sock_path: str) -> bool:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.settimeout(0.2)
            s.connect(sock_path)
            return True
        except OSError:
            return False
        finally:
            s.close()

    def wait_for_herdr_ready(tier: str = "public", timeout_s: float = 10.0) -> str:
        host_mnt_ns = os.readlink("/proc/1/ns/mnt")
        sdir = f"{STATE_DIR}/herdr-session-{tier}"
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout_s:
            try:
                pid_s = subprocess.check_output(
                    ["systemctl", "show", "-p", "MainPID", "--value", f"genie-herdr@{tier}"],
                    text=True,
                ).strip()
                if pid_s.isdigit() and int(pid_s) > 0:
                    mnt_ns = os.readlink(f"/proc/{pid_s}/ns/mnt")
                    exe = os.readlink(f"/proc/{pid_s}/exe")
                    if (
                        mnt_ns != host_mnt_ns
                        and exe.endswith("/herdr")
                        and can_connect_unix(f"{sdir}/herdr.sock")
                        and can_connect_unix(f"{sdir}/herdr-client.sock")
                    ):
                        return pid_s
            except (OSError, subprocess.CalledProcessError):
                pass
            time.sleep(0.05)
        raise RuntimeError(f"genie-herdr@{tier} did not become ready within {timeout_s}s")

    def restart_herdr_and_wait(tier: str = "public") -> str:
        sdir = f"{STATE_DIR}/herdr-session-{tier}"
        subprocess.run(["systemctl", "stop", f"genie-herdr@{tier}"], check=True)
        for sock_fn in ("herdr.sock", "herdr-client.sock"):
            try:
                os.unlink(f"{sdir}/{sock_fn}")
            except FileNotFoundError:
                pass
        subprocess.run(["systemctl", "start", f"genie-herdr@{tier}"], check=True)
        return wait_for_herdr_ready(tier)

    def restart_stub_api_and_wait(timeout_s: float = 10.0) -> None:
        subprocess.run(["systemctl", "stop", "genie-stub-api"], check=True)
        for sock_fn in ("register.sock", "agent.sock", "http.sock"):
            try:
                os.unlink(f"/run/user/1000/xmsg/{sock_fn}")
            except FileNotFoundError:
                pass
        subprocess.run(["systemctl", "start", "genie-stub-api"], check=True)
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout_s:
            if all(
                can_connect_unix(f"/run/user/1000/xmsg/{s}")
                for s in ("register.sock", "agent.sock", "http.sock")
            ):
                return
            time.sleep(0.05)
        raise RuntimeError(f"genie-stub-api sockets did not accept connections within {timeout_s}s")

    def get_herdr_pid(tier: str) -> str:
        return wait_for_herdr_ready(tier)

    def herdr_cmd(tier: str, args: list[str], parse_json: bool = True):
        herdr_bin = get_herdr_bin(tier)
        herdr_pid = get_herdr_pid(tier)
        cmd = [
            "nsenter", "-t", herdr_pid, "-m",
            "setpriv", "--reuid=1000", "--regid=100", "--init-groups",
            "env", f"HOME={STATE_DIR}", "XDG_RUNTIME_DIR=/run/user/1000", f"PATH={CLEAN_PATH}",
            herdr_bin, "--session", f"genie-{tier}", *args,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"herdr {args} failed ({r.returncode}): {r.stdout} {r.stderr}")
        return json.loads(r.stdout) if parse_json else r.stdout

    def ensure_base_pane(tier: str, cwd: str) -> str:
        panes = herdr_cmd(tier, ["pane", "list"])["result"]["panes"]
        if panes:
            return panes[0]["pane_id"]
        ws = herdr_cmd(tier, ["workspace", "create", "--cwd", cwd, "--no-focus"])
        return ws["result"]["root_pane"]["pane_id"]

    def start_handoff_server(
        sock_path: str,
        thread_id: str,
        pane_cwd: str,
        claude_shim: str,
        token: str,
        accept_log: str = "",
        verify_peer: bool = True,
        unlink_on_accept: bool = True,
    ):
        SOL_SOCKET = 1
        SO_PEERCRED = 17
        SO_PEERPIDFD = 77
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            os.unlink(sock_path)
        except FileNotFoundError:
            pass
        srv.bind(sock_path)
        os.chown(sock_path, 1000, 100)
        os.chmod(sock_path, 0o600)
        srv.listen(1)
        result = {"ok": False, "err": ""}

        def serve():
            try:
                srv.settimeout(20.0)
                conn, _ = srv.accept()
                ts_ns = time.time_ns()
                if unlink_on_accept:
                    try:
                        os.unlink(sock_path)
                    except FileNotFoundError:
                        pass
                srv.close()
                if accept_log:
                    with open(accept_log, "a", encoding="utf-8") as af:
                        af.write(f"thread={thread_id} ts_ns={ts_ns} sock={sock_path}\n")
                ucred = conn.getsockopt(SOL_SOCKET, SO_PEERCRED, struct.calcsize("iii"))
                peer_pid, peer_uid, _ = struct.unpack("iii", ucred)
                pidfd_b = conn.getsockopt(SOL_SOCKET, SO_PEERPIDFD, 4)
                pidfd = struct.unpack("i", pidfd_b)[0]
                try:
                    with open(f"/proc/self/fdinfo/{pidfd}", "r", encoding="utf-8") as f:
                        fdinfo = f.read()
                    nspids = []
                    for line in fdinfo.splitlines():
                        if line.startswith("NSpid:"):
                            nspids = line.split()[1:]
                            break
                    if verify_peer:
                        if peer_uid != 1000:
                            result["err"] = f"uid={peer_uid}"
                            conn.close()
                            return
                        if len(nspids) != 2:
                            result["err"] = f"nspid_depth={len(nspids)} ({nspids})"
                            conn.close()
                            return
                        with open(f"/proc/{peer_pid}/cmdline", "rb") as cf:
                            argv = [a.decode("utf-8", "replace") for a in cf.read().split(b"\x00") if a]
                        shim_idx = -1
                        for idx in (0, 1, 2):
                            if idx < len(argv) and argv[idx] == claude_shim:
                                shim_idx = idx
                                break
                        if shim_idx < 0:
                            result["err"] = f"shim_not_in_argv:{argv[:4]}"
                            conn.close()
                            return
                    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
                    try:
                        b.sendall((token + "\n").encode("utf-8"))
                    finally:
                        b.close()
                    try:
                        socket.send_fds(conn, [b"1"], [a.fileno()])
                        result["ok"] = True
                    finally:
                        a.close()
                finally:
                    os.close(pidfd)
                    conn.close()
            except Exception as e:
                result["err"] = str(e)
                try:
                    srv.close()
                except Exception:
                    pass

        t = threading.Thread(target=serve, daemon=True)
        t.start()
        return t, result

    def launch_in_herdr(
        tier: str,
        thread_id: str,
        claude_args: list[str],
        shim_override: str | None = None,
        split_cwd_override: str | None = None,
        verify_peer: bool = True,
        unlink_on_accept: bool = True,
        finally_unlink: bool = True,
        timeout_ms: int = 8000,
    ):
        disp_dir = f"{STATE_DIR}/dispatcher-{tier}"
        cwd_dir = f"{STATE_DIR}/cwd-{tier}"
        cfg_dir = f"{STATE_DIR}/claude-{tier}"
        wt_dir = f"{disp_dir}/worktrees/{thread_id}"
        ct_dir = f"{disp_dir}/claude-threads/{thread_id}"
        launch_dir = f"{disp_dir}/launch"
        for d in (wt_dir, ct_dir, launch_dir):
            os.makedirs(d, mode=0o700, exist_ok=True)
            os.chown(d, 1000, 100)

        shell_cwd = split_cwd_override or cwd_dir
        base_pane = ensure_base_pane(tier, shell_cwd)
        split = herdr_cmd(tier, [
            "pane", "split", base_pane, "--direction", "right",
            "--cwd", shell_cwd,
            "--env", f"CLAUDE_CONFIG_DIR={cfg_dir}",
            "--no-focus",
        ])
        pane_id = split["result"]["pane"]["pane_id"]
        shim_bin = shim_override or get_unit_shim(tier)
        sock_path = f"{launch_dir}/{uuid.uuid4()}.sock"
        tok = TOK_PUB if tier == "public" else TOK_TRU
        accept_log = f"{disp_dir}/accept.log"
        t_srv, srv_res = start_handoff_server(
            sock_path=sock_path,
            thread_id=thread_id,
            pane_cwd=wt_dir,
            claude_shim=shim_bin,
            token=tok,
            accept_log=accept_log,
            verify_peer=verify_peer,
            unlink_on_accept=unlink_on_accept,
        )
        shim_args = [
            "--token-sock", sock_path,
            "--thread-id", thread_id,
            "--cwd", wt_dir,
            "--",
            *claude_args,
        ]
        try:
            # herdr agent start types the command into the pane; for one-shot -p or probeClaude it may return or time out
            herdr_bin = get_herdr_bin(tier)
            herdr_pid = get_herdr_pid(tier)
            agent_name = f"g-{uuid.uuid4().hex[:12]}"
            r_start = subprocess.run([
                "nsenter", "-t", herdr_pid, "-m",
                "setpriv", "--reuid=1000", "--regid=100", "--init-groups",
                "env", f"HOME={STATE_DIR}", "XDG_RUNTIME_DIR=/run/user/1000", f"PATH={CLEAN_PATH}",
                herdr_bin, "--session", f"genie-{tier}",
                "agent", "start", agent_name, "--kind", "claude",
                "--pane", pane_id, "--command", shim_bin, "--timeout", str(timeout_ms),
                "--", *shim_args,
            ], capture_output=True, text=True)
            t_srv.join(timeout=5.0)
            if verify_peer and not srv_res.get("ok"):
                print(f"DIAG launch_in_herdr {tier} {thread_id}: srv_res={srv_res} start_rc={r_start.returncode} start_err={r_start.stderr.strip()}", flush=True)
        finally:
            if finally_unlink:
                try:
                    os.unlink(sock_path)
                except FileNotFoundError:
                    pass
        return pane_id, srv_res

    def make_custom_shim(
        tier: str,
        name: str,
        real_claude_bin: str | None = None,
        pass_token_in_env: bool = False,
        skip_shim_unlink: bool = False,
        no_outer_bwrap: bool = False,
        bind_launch_into_jail: bool = False,
        sleep_before_connect: float = 0.0,
        writable_policy: bool = False,
        xmsg_rw: bool = False,
    ) -> str:
        orig_shim = get_unit_shim(tier)
        with open(orig_shim, "r", encoding="utf-8") as f:
            code = f.read()
        if real_claude_bin:
            code = re.sub(r"REAL_CLAUDE_BIN = .*", f"REAL_CLAUDE_BIN = {json.dumps(real_claude_bin)}", code)
        if sleep_before_connect > 0:
            code = code.replace(
                "s.connect(sock_path)",
                f"__import__('time').sleep({sleep_before_connect})\n        s.connect(sock_path)",
            )
        if skip_shim_unlink:
            code = code.replace("os.unlink(sock_path)", "pass")
        if pass_token_in_env:
            code = code.replace(
                'env["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"] = str(tok_fd)',
                'env["CLAUDE_CODE_OAUTH_TOKEN"] = os.fdopen(tok_fd, "r").read().strip()',
            )
        if bind_launch_into_jail:
            code = code.replace(
                '"--bind", wt_root, wt_root,',
                '"--bind", wt_root, wt_root,\n            "--bind", f"{DISP_STATE_DIR}/launch", f"{DISP_STATE_DIR}/launch",',
            )
        if writable_policy:
            # Make settings.json permissive and writable inside the jail
            perm_settings = f"{STATE_DIR}/cwd-{tier}/mutant-writable-settings-{name}.json"
            with open(perm_settings, "w", encoding="utf-8") as pf:
                json.dump({
                    "includeGitInstructions": False,
                    "permissions": {
                        "defaultMode": "bypassPermissions",
                        "allow": ["Read", "Edit", "Write", "Bash"],
                        "deny": [],
                    },
                    "sandbox": {"enabled": False},
                }, pf)
            os.chown(perm_settings, 1000, 100)
            os.chmod(perm_settings, 0o644)
            code = code.replace(
                '"--ro-bind", SETTINGS_JSON, f"{CLAUDE_DIR}/settings.json",',
                f'"--bind", {json.dumps(perm_settings)}, f"{{CLAUDE_DIR}}/settings.json",',
            )
            code = code.replace('"--remount-ro", STATE_DIR,', "")
        if xmsg_rw:
            code = code.replace(
                '*(["--ro-bind", XMSG_SOCKET, XMSG_SOCKET] if XMSG_SOCKET else []),',
                '*(["--bind", XMSG_SOCKET, XMSG_SOCKET] if XMSG_SOCKET else []),',
            )
        if no_outer_bwrap:
            code = code.replace(
                "os.execve(BWRAP_BIN, bwrap_argv, env)",
                "\n    ".join([
                    'ct_d = f"{DISP_STATE_DIR}/claude-threads/{thread_id}"',
                    'for src, fn in ((SETTINGS_JSON, "settings.json"), (CLAUDE_JSON, ".claude.json"), (EMPTY_JSON, ".config.json"), (CLAUDE_MD, "CLAUDE.md")):',
                    '    dst = os.path.join(ct_d, fn)',
                    '    if not os.path.exists(dst):',
                    '        open(dst, "wb").write(open(src, "rb").read())',
                    'env["CLAUDE_CONFIG_DIR"] = ct_d',
                    'os.chdir(worktree_cwd)',
                    'os.execve(REAL_CLAUDE_BIN, [REAL_CLAUDE_BIN, *claude_args], env)',
                ]),
            )
        dst = f"{STATE_DIR}/cwd-{tier}/shim-{name}.py"
        with open(dst, "w", encoding="utf-8") as f:
            f.write(code)
        os.chown(dst, 1000, 100)
        os.chmod(dst, 0o755)
        return dst

    def run_in_herdr_ns(tier: str, py_code: str) -> dict:
        pid = wait_for_herdr_ready(tier)
        r = subprocess.run([
            "nsenter", "-t", pid, "-m", "-p", "-n",
            "setpriv", "--reuid=1000", "--regid=100", "--init-groups",
            "env", f"HOME={STATE_DIR}", "XDG_RUNTIME_DIR=/run/user/1000",
            "${pkgs.python3}/bin/python3", "-I", "-c", py_code,
        ], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"run_in_herdr_ns failed: {r.stderr}")
        return json.loads(r.stdout)

    # =========================================================================
    # 1. V6.10 FIRST (thread A must be the first thread after genie-herdr@public starts, K7)
    # =========================================================================
    def eval_v6_10(mutant_root_in_worktree: bool = False) -> tuple[bool, str]:
        mark_host = f"{STATE_DIR}/herdr-session-public/v610-mark"
        ctrl_mark_host = f"{STATE_DIR}/herdr-session-public/v610-ctrl-mark"
        subprocess.run(["systemctl", "stop", "genie-herdr@public"], check=True)
        for fn in os.listdir(f"{STATE_DIR}/herdr-session-public"):
            fp = os.path.join(f"{STATE_DIR}/herdr-session-public", fn)
            if os.path.isdir(fp) and not os.path.islink(fp):
                shutil.rmtree(fp, ignore_errors=True)
            else:
                try:
                    os.unlink(fp)
                except FileNotFoundError:
                    pass
        subprocess.run(["systemctl", "start", "genie-herdr@public"], check=True)
        wait_for_herdr_ready("public")
        # Clear any stale workspace session state before starting first thread
        wt_a = f"{STATE_DIR}/dispatcher-public/worktrees/thread-v610"
        shutil.rmtree(wt_a, ignore_errors=True)
        os.makedirs(wt_a, mode=0o700, exist_ok=True)
        os.chown(wt_a, 1000, 100)
        v610_sess_id = str(uuid.uuid4())
        pane_id, srv_res = launch_in_herdr(
            "public",
            "thread-v610",
            ["-n", "genie-v610", "--session-id", v610_sess_id, "-p", "v610-git"],
            split_cwd_override=(wt_a if mutant_root_in_worktree else None),
            timeout_ms=6000,
        )
        # Wait for real claude to finish planting the repo in wt_a, send tu_v610 tool_result, and exit cleanly
        def v610_claude_proc_alive() -> bool:
            needle = v610_sess_id.encode("utf-8")
            for p_entry in os.listdir("/proc"):
                if not p_entry.isdigit():
                    continue
                try:
                    if needle in open(f"/proc/{p_entry}/cmdline", "rb").read():
                        return True
                except OSError:
                    pass
            return False

        t_v610 = time.monotonic()
        while time.monotonic() - t_v610 < 15.0:
            repo_ready = os.path.exists(os.path.join(wt_a, ".git", "refs", "remotes", "origin", "main"))
            log_done = (
                os.path.exists(f"{STATE_DIR}/stub-api.log")
                and '"tu_v610"' in open(f"{STATE_DIR}/stub-api.log", "r", encoding="utf-8", errors="replace").read()
            )
            if repo_ready and log_done and not v610_claude_proc_alive():
                break
            time.sleep(0.05)

        # Attach a herdr client in a PTY and wait >= 3 s (and until herdr's 5s session autosave writes session.json)
        session_json_host = f"{STATE_DIR}/herdr-session-public/session.json"
        def attach_herdr_client_and_wait(min_seconds: float, wait_for_session_json: bool):
            master_fd, slave_fd = pty.openpty()
            os.fchown(slave_fd, 1000, 100)
            os.fchmod(slave_fd, 0o620)
            fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 640, 384))
            att = subprocess.Popen(
                [
                    "nsenter", "-t", get_herdr_pid("public"), "-m", f"--wd={STATE_DIR}",
                    "setpriv", "--reuid=1000", "--regid=100", "--init-groups",
                    "env", "-i",
                    f"HOME={STATE_DIR}",
                    "XDG_RUNTIME_DIR=/run/user/1000",
                    "TERM=xterm-256color",
                    f"PATH={CLEAN_PATH}",
                    get_herdr_bin("public"), "--session", "genie-public",
                ],
                stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
                close_fds=True, start_new_session=True,
            )
            os.close(slave_fd)
            def _drain():
                while True:
                    try:
                        if not os.read(master_fd, 4096):
                            break
                    except OSError:
                        break
            threading.Thread(target=_drain, daemon=True).start()
            t_att = time.monotonic()
            saved_bytes = None
            while time.monotonic() - t_att < 10.0:
                if wait_for_session_json:
                    if os.path.exists(session_json_host) and os.path.getsize(session_json_host) > 0:
                        with open(session_json_host, "rb") as f:
                            saved_bytes = f.read()
                        if time.monotonic() - t_att >= min_seconds:
                            break
                else:
                    if time.monotonic() - t_att >= min_seconds:
                        break
                time.sleep(0.1)
            try:
                os.close(master_fd)
            except OSError:
                pass
            att.kill()
            att.wait(timeout=2.0)
            return saved_bytes

        saved_session_bytes = attach_herdr_client_and_wait(3.2, wait_for_session_json=True)

        # Restart genie-herdr@public and wait >= 3 s (restored workspace git refresh).
        # Preserve session.json across systemctl stop so KillMode=control-group killing child shells
        # during shutdown does not cause save_session_on_shutdown() to clear session.json.
        subprocess.run(["systemctl", "stop", "genie-herdr@public"], check=True)
        for sock_fn in ("herdr.sock", "herdr-client.sock"):
            try:
                os.unlink(f"{STATE_DIR}/herdr-session-public/{sock_fn}")
            except FileNotFoundError:
                pass
        if saved_session_bytes:
            with open(session_json_host, "wb") as f:
                f.write(saved_session_bytes)
            os.chown(session_json_host, 1000, 100)
            os.chmod(session_json_host, 0o600)
        subprocess.run(["systemctl", "start", "genie-herdr@public"], check=True)
        wait_for_herdr_ready("public")
        attach_herdr_client_and_wait(3.2, wait_for_session_json=False)

        mark_present = os.path.exists(mark_host)

        # Positive control: scratch repo with the same config, run git -C from herdr namespace
        scratch = "/tmp/v610-scratch-ctrl"
        run_in_herdr_ns("public", "\n".join([
            "import json, subprocess",
            f"subprocess.run(['${pkgs.python3}/bin/python3', '-I', '${setupV610RepoPy}', {repr(scratch)}, '/var/lib/genie-agent/.config/herdr/sessions/genie-public/v610-ctrl-mark'], check=True)",
            f"subprocess.run(['${pkgs.git}/bin/git', '-C', {repr(scratch)}, 'rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main'], capture_output=True)",
            "print(json.dumps({'done': True}))",
        ]))
        ctrl_present = os.path.exists(ctrl_mark_host)
        ok = (not mark_present) and ctrl_present
        return ok, f"v610-mark present={mark_present} (expected False); positive control mark present={ctrl_present} (expected True); session_saved={saved_session_bytes is not None}"

    cell("V6.10", *eval_v6_10(mutant_root_in_worktree=False))

    # =========================================================================
    # 2. V3: Real claude (@public and @trusted) + probeClaude (@public and @trusted)
    # =========================================================================
    # Reset genie-herdr@public cleanly after V6.10 without deleting the bind-mounted directory inode
    subprocess.run(["systemctl", "stop", "genie-herdr@public"], check=True)
    for fn in os.listdir(f"{STATE_DIR}/herdr-session-public"):
        fp = os.path.join(f"{STATE_DIR}/herdr-session-public", fn)
        if os.path.isdir(fp) and not os.path.islink(fp):
            shutil.rmtree(fp, ignore_errors=True)
        else:
            try:
                os.unlink(fp)
            except FileNotFoundError:
                pass
    subprocess.run(["systemctl", "start", "genie-herdr@public"], check=True)
    wait_for_herdr_ready("public")

    for tier, prompt_tag in (("public", "v3-public"), ("trusted", "v3-trusted")):
        launch_in_herdr(
            tier,
            f"thread-{prompt_tag}",
            ["-n", f"genie-{prompt_tag}", "--session-id", str(uuid.uuid4()), "-p", prompt_tag],
            timeout_ms=6000,
        )

    # Also launch probeClaude in both tiers (and keep public probeClaude alive for V6.6!)
    probe_shim_pub = make_custom_shim("public", "probe-pub", real_claude_bin="${probeClaude}/bin/probe-claude")
    probe_shim_tru = make_custom_shim("trusted", "probe-tru", real_claude_bin="${probeClaude}/bin/probe-claude")
    launch_in_herdr("public", "thread-probe-pub", ["--run-v66-child"], shim_override=probe_shim_pub, timeout_ms=4000)
    launch_in_herdr("trusted", "thread-probe-tru", ["--probe"], shim_override=probe_shim_tru, timeout_ms=4000)

    # Wait for API log and probe files
    pub_probe_file = f"{STATE_DIR}/dispatcher-public/claude-threads/thread-probe-pub/probe"
    tru_probe_file = f"{STATE_DIR}/dispatcher-trusted/claude-threads/thread-probe-tru/probe"
    for _ in range(60):
        if os.path.exists(pub_probe_file) and os.path.exists(tru_probe_file) and os.path.exists("/tmp/gi15-api-log.jsonl"):
            break
        time.sleep(0.1)

    with open("/tmp/gi15-api-log.jsonl", "r", encoding="utf-8") as f:
        api_entries = [json.loads(line) for line in f if line.strip()]
    pub_auth_ok = any(e.get("prompt") == "v3-public" and e.get("auth") == f"Bearer {TOK_PUB}" for e in api_entries)
    tru_auth_ok = any(e.get("prompt") == "v3-trusted" and e.get("auth") == f"Bearer {TOK_TRU}" for e in api_entries)
    pub_rec = open(pub_probe_file, "r", encoding="utf-8").read() if os.path.exists(pub_probe_file) else ""
    tru_rec = open(tru_probe_file, "r", encoding="utf-8").read() if os.path.exists(tru_probe_file) else ""
    cred_pub = os.path.exists(f"{STATE_DIR}/claude-public/.credentials.json")
    cred_tru = os.path.exists(f"{STATE_DIR}/claude-trusted/.credentials.json")
    v3_ok = (
        pub_auth_ok and tru_auth_ok
        and f"tok={HASH_PUB}" in pub_rec and HASH_TRU not in pub_rec and "sock=1" in pub_rec
        and f"tok={HASH_TRU}" in tru_rec and HASH_PUB not in tru_rec and "sock=1" in tru_rec
        and not cred_pub and not cred_tru
    )
    cell(
        "V3",
        v3_ok,
        f"pub_auth={pub_auth_ok} tru_auth={tru_auth_ok} pub_tok_match={'tok=' + HASH_PUB in pub_rec} tru_tok_match={'tok=' + HASH_TRU in tru_rec} cred={cred_pub or cred_tru}",
    )

    # =========================================================================
    # 3. Plant 5 positive control files for V6.3 before running V6 suite
    # =========================================================================
    with open(f"{STATE_DIR}/canary-fs-control-genie-agent-0000", "w", encoding="utf-8") as f:
        f.write("canary-fs-control-genie-agent-0000\n")
    os.chown(f"{STATE_DIR}/canary-fs-control-genie-agent-0000", 1000, 100)
    with open("/var/lib/genie/public-repos/canary-fs-control-genie-0000", "w", encoding="utf-8") as f:
        f.write("canary-fs-control-genie-0000\n")
    os.makedirs("/run/credentials", mode=0o755, exist_ok=True)
    with open("/run/credentials/canary-fs-control-credentials-0000", "w", encoding="utf-8") as f:
        f.write("canary-fs-control-credentials-0000\n")
    with open("/run/genie-secrets/canary-fs-control-secrets-0000", "w", encoding="utf-8") as f:
        f.write("canary-fs-control-secrets-0000\n")
    run_in_herdr_ns("public", "\n".join([
        "import json",
        "with open('/tmp/canary-fs-control-tmp-0000', 'w', encoding='utf-8') as f:",
        "    f.write('canary-fs-control-tmp-0000\\n')",
        "print(json.dumps({'ok': True}))",
    ]))

    # =========================================================================
    # 4. Run real claude inside outer bwrap jail for V6.1, V6.2, V6.3, V6.4, V6.7, V6.7b, V6.9, V6.11
    # =========================================================================
    def run_jail_suite(thread_id: str, shim_override: str | None = None, hold_for_herdr: bool = False):
        ct_dir = f"{STATE_DIR}/dispatcher-public/claude-threads/{thread_id}"
        os.makedirs(ct_dir, mode=0o700, exist_ok=True)
        os.chown(ct_dir, 1000, 100)
        rep_path = f"{ct_dir}/jail-suite-report.json"
        ready_path = f"{ct_dir}/jail-suite-ready"
        hold_path = f"{ct_dir}/hold-for-herdr-sweep"
        for p in (rep_path, ready_path, hold_path):
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass
        if hold_for_herdr:
            with open(hold_path, "w", encoding="utf-8") as f:
                f.write("1")
            os.chown(hold_path, 1000, 100)

        pane_holder = {}
        def bg():
            p_id, s_res = launch_in_herdr(
                "public",
                thread_id,
                ["-n", f"genie-{thread_id[:8]}", "--session-id", str(uuid.uuid4()), "-p", f"v6-jail-suite-{thread_id}"],
                shim_override=shim_override,
                timeout_ms=6000,
            )
            pane_holder["pane_id"] = p_id
            pane_holder["srv_res"] = s_res

        t = threading.Thread(target=bg, daemon=True)
        t.start()
        for _ in range(120):
            if os.path.exists(rep_path) and (not hold_for_herdr or os.path.exists(ready_path)):
                break
            time.sleep(0.1)
        if not os.path.exists(rep_path) and os.path.exists("/tmp/gi15-api-log.jsonl"):
            with open("/tmp/gi15-api-log.jsonl", "r", encoding="utf-8") as lf:
                print(f"DIAG api-log for {thread_id}:", lf.readlines()[-4:], flush=True)
        return t, pane_holder, rep_path, hold_path

    def herdr_v61_v62_sweep() -> dict:
        return run_in_herdr_ns("public", "exec(open('${herdrV61V62Py}').read())")

    def herdr_v63_sweep() -> dict:
        return run_in_herdr_ns("public", "exec(open('${herdrV63Py}').read())")

    xmsg_ino_before = os.stat("/run/user/1000/xmsg/agent.sock").st_ino
    t_suite, pane_holder, rep_path, hold_path = run_jail_suite("thread-A", hold_for_herdr=True)
    herdr_sweep = herdr_v61_v62_sweep()
    try:
        os.unlink(hold_path)
    except FileNotFoundError:
        pass
    t_suite.join(timeout=10.0)
    xmsg_ino_after = os.stat("/run/user/1000/xmsg/agent.sock").st_ino

    jail_rep = json.loads(open(rep_path, "r", encoding="utf-8").read())

    # Evaluate V6.1
    def eval_v6_1_from(h_v61: dict, j_v61: dict) -> tuple[bool, str]:
        ok = (
            h_v61["depth2_read"] >= 2
            and h_v61["ctrl_hits"] >= 1
            and h_v61["tok_hits"] == 0
            and h_v61["claude_environ_read"]
            and h_v61["claude_cfg_found"]
            and h_v61["claude_tok_hits"] == 0
            and j_v61["outer_readable"] == 0
            and j_v61["ctrl_hits"] >= 1
            and j_v61["tok_hits"] == 0
        )
        return ok, (
            f"herdr(depth2_read={h_v61['depth2_read']}, ctrl={h_v61['ctrl_hits']}, tok={h_v61['tok_hits']}, "
            f"claude_env={h_v61['claude_environ_read']}, cfg={h_v61['claude_cfg_found']}, claude_tok={h_v61['claude_tok_hits']}) "
            f"jail(outer_readable={j_v61['outer_readable']}, ctrl={j_v61['ctrl_hits']}, tok={j_v61['tok_hits']})"
        )

    cell("V6.1", *eval_v6_1_from(herdr_sweep["v61"], jail_rep["v61"]))

    # Evaluate V6.2
    h_v62 = herdr_sweep["v62"]
    j_v62 = jail_rep["v62"]
    v62_ok = (
        h_v62["tok_hits"] == 0
        and j_v62["tok_hits"] == 0
        and (h_v62["sock_enxio"] + j_v62["sock_enxio"]) >= 1
    )
    cell(
        "V6.2",
        v62_ok,
        f"herdr_fd_tok={h_v62['tok_hits']} jail_fd_tok={j_v62['tok_hits']} sock_enxio={h_v62['sock_enxio'] + j_v62['sock_enxio']} counts={h_v62['counts']}",
    )

    # Evaluate V6.3
    def eval_v6_3() -> tuple[bool, str]:
        h_v63 = herdr_v63_sweep()
        j_v63 = jail_rep["v63"]
        ch = h_v63["ctrl_hits"]
        m = h_v63["masked"]
        ok = (
            h_v63["tok_hits"] == 0
            and j_v63["tok_hits"] == 0
            and ch["genie-agent"] >= 1
            and ch["genie"] >= 1
            and ch["tmp"] >= 1
            and ch["credentials"] == 0
            and ch["secrets"] == 0
            and all(m.values())
        )
        return ok, f"herdr_tok={h_v63['tok_hits']} jail_tok={j_v63['tok_hits']} ctrls={ch} masked={m}"

    cell("V6.3", *eval_v6_3())

    # Evaluate V6.4 (herdr pane read scrollback sweep)
    pane_a = pane_holder.get("pane_id", "w1:p2")
    scrollback = herdr_cmd("public", ["pane", "read", pane_a], parse_json=False)
    v64_ctrl = "genie-claude-shim" in scrollback
    v64_tok = (TOK_PUB in scrollback) or (TOK_TRU in scrollback)
    cell("V6.4", v64_ctrl and not v64_tok, f"shim_in_scrollback={v64_ctrl} tok_in_scrollback={v64_tok}")

    # Evaluate V6.7
    def eval_v6_7_from(j_v67: dict) -> tuple[bool, str]:
        ok = j_v67["sock_err"] == "ENOENT" and j_v67["cli_rc"] != 0
        return ok, f"herdr_sock={j_v67['sock_err']} herdr_cli_rc={j_v67['cli_rc']}"

    cell("V6.7", *eval_v6_7_from(jail_rep["v67"]))

    # Evaluate V6.7b (with positive control from unjailed herdr namespace)
    herdr_ctrl_67b = run_in_herdr_ns("public", "\n".join([
        "import json, socket",
        "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
        "try:",
        "    s.connect('/proc/1/root/var/lib/genie-agent/.config/herdr/sessions/genie-public/herdr.sock')",
        "    rc = 0",
        "except OSError as e:",
        "    rc = e.errno",
        "finally:",
        "    s.close()",
        "print(json.dumps({'rc': rc}))",
    ]))
    j_v67b = jail_rep["v67b"]
    v67b_ok = (
        len(j_v67b) >= 1
        and all(v == "EACCES" for v in j_v67b.values())
        and herdr_ctrl_67b["rc"] == 0
    )
    cell("V6.7b", v67b_ok, f"jail_proc_root_connect={j_v67b} unjailed_control_rc={herdr_ctrl_67b['rc']}")

    # Evaluate V6.9
    def eval_v6_9_from(j_v69: dict) -> tuple[bool, str]:
        ok = (
            j_v69.get("nspid_depth", 0) >= 2
            and j_v69.get("env_hits") == 0
            and j_v69.get("environ_hits") == 0
            and j_v69.get("herdr_sock") == "ENOENT"
            and j_v69.get("launch_dir") == "ENOENT"
            and j_v69.get("outer_root") == "EACCES"
        )
        return ok, f"fsmonitor={j_v69}"

    cell("V6.9", *eval_v6_9_from(jail_rep["v69"]))

    # Evaluate V6.11
    def eval_v6_11_from(j_v611: dict, ino_before: int, ino_after: int) -> tuple[bool, str]:
        ok = (
            j_v611["unlink_err"] == "EROFS"
            and j_v611["rm_rc"] != 0
            and ino_before == ino_after
        )
        return ok, f"unlink_err={j_v611['unlink_err']} rm_rc={j_v611['rm_rc']} ino_before={ino_before} ino_after={ino_after}"

    cell("V6.11", *eval_v6_11_from(jail_rep["v611"], xmsg_ino_before, xmsg_ino_after))

    # =========================================================================
    # 5. V6.5: Concurrent Launch Window (Two Watchers + Liveness Bracket)
    # =========================================================================
    def eval_v6_5(mutant: str = "") -> tuple[bool, str]:
        for tier in ("public", "trusted"):
            alog = f"{STATE_DIR}/dispatcher-{tier}/accept.log"
            try:
                os.unlink(alog)
            except FileNotFoundError:
                pass

        stop_evt = threading.Event()
        jail_watch = {"t_first": 0, "t_last": 0, "hits": 0, "samples": 0}
        herdr_watch = {"t_first": 0, "t_last": 0, "hits": 0, "samples": 0}

        # Watcher 1: jailed watcher (polls launch/* with cat, ln, and connect+recv_fds)
        def run_jail_watcher():
            # When mutant binds launch/ into jail, the jailed watcher sees dispatcher-public/launch
            launch_dirs = (
                [f"{STATE_DIR}/dispatcher-public/launch", f"{STATE_DIR}/dispatcher-trusted/launch"]
                if mutant in ("M-no-peer-verify", "M-no-launch-isolation")
                else [f"/tmp/empty-jail-launch"]
            )
            pub_pid = get_herdr_pid("public")
            jail_watch["t_first"] = time.time_ns()
            while not stop_evt.is_set():
                jail_watch["samples"] += 1
                for ld in launch_dirs:
                    try:
                        entries = os.listdir(ld)
                    except OSError:
                        continue
                    for fn in entries:
                        fp = os.path.join(ld, fn)
                        if fn.endswith(".sock"):
                            # Run connect from a depth-3 bwrap jail child so SO_PEERPIDFD sees NSpid depth 3
                            r = subprocess.run([
                                "nsenter", "-t", pub_pid,
                                "-m", "-p", "-n",
                                "setpriv", "--reuid=1000", "--regid=100", "--init-groups",
                                "${pkgs.bubblewrap}/bin/bwrap", "--unshare-user", "--unshare-pid", "--bind", "/", "/", "--bind", "/proc", "/proc", "--",
                                "${pkgs.python3}/bin/python3", "-I", "-c",
                                "\n".join([
                                    "import os, socket",
                                    "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
                                    "try:",
                                    f"    s.connect({json.dumps(fp)})",
                                    "    msg, fds, _, _ = socket.recv_fds(s, 16, 1)",
                                    "    if fds:",
                                    "        tok = os.fdopen(fds[0], 'rb').read()",
                                    f"        if b'{TOK_PUB}' in tok or b'{TOK_TRU}' in tok:",
                                    "            print('HIT')",
                                    "finally:",
                                    "    s.close()",
                                ]),
                            ], capture_output=True, text=True)
                            if "HIT" in r.stdout:
                                jail_watch["hits"] += 1
                jail_watch["t_last"] = time.time_ns()
                time.sleep(0.01)
            jail_watch["t_last"] = time.time_ns()

        # Watcher 2: unjailed herdr-namespace watcher (stat + cat only, NEVER connect)
        def run_herdr_watcher():
            herdr_watch["t_first"] = time.time_ns()
            while not stop_evt.is_set():
                herdr_watch["samples"] += 1
                for ld in [f"{STATE_DIR}/dispatcher-public/launch", f"{STATE_DIR}/dispatcher-trusted/launch"]:
                    try:
                        entries = os.listdir(ld)
                    except OSError:
                        continue
                    for fn in entries:
                        fp = os.path.join(ld, fn)
                        try:
                            st = os.lstat(fp)
                            if stat.S_ISREG(st.st_mode):
                                data = open(fp, "rb").read()
                                if TOK_PUB.encode() in data or TOK_TRU.encode() in data:
                                    herdr_watch["hits"] += 1
                        except OSError:
                            pass
                herdr_watch["t_last"] = time.time_ns()
                time.sleep(0.005)
            herdr_watch["t_last"] = time.time_ns()

        tw1 = threading.Thread(target=run_jail_watcher, daemon=True)
        tw2 = threading.Thread(target=run_herdr_watcher, daemon=True)
        tw1.start()
        tw2.start()
        t_w_start = time.monotonic()
        while (jail_watch["samples"] == 0 or herdr_watch["samples"] == 0) and time.monotonic() - t_w_start < 5.0:
            time.sleep(0.005)

        shim_b = None
        verify_peer = True
        temp_tok_file = None
        if mutant == "M-no-shim-unlink":
            temp_tok_file = f"{STATE_DIR}/dispatcher-public/launch/transient.tok"
            with open(temp_tok_file, "w", encoding="utf-8") as tf:
                tf.write(TOK_PUB + "\n")
            os.chown(temp_tok_file, 1000, 100)
        elif mutant == "M-no-peer-verify":
            verify_peer = False
            shim_b = make_custom_shim("public", "m-no-peer", bind_launch_into_jail=True, sleep_before_connect=0.25)
        elif mutant == "M-no-launch-isolation":
            verify_peer = True
            shim_b = make_custom_shim("public", "m-no-iso", bind_launch_into_jail=True, sleep_before_connect=0.25)

        _, res_b = launch_in_herdr(
            "public",
            f"thread-B-{mutant or 'clean'}",
            ["-n", "genie-b", "--session-id", str(uuid.uuid4()), "-p", "v3-public"],
            shim_override=shim_b,
            verify_peer=verify_peer,
            timeout_ms=5000,
        )
        if temp_tok_file:
            try:
                os.unlink(temp_tok_file)
            except FileNotFoundError:
                pass
        _, res_c = launch_in_herdr(
            "trusted",
            f"thread-C-{mutant or 'clean'}",
            ["-n", "genie-c", "--session-id", str(uuid.uuid4()), "-p", "v3-trusted"],
            timeout_ms=5000,
        )
        t_post = time.time_ns()
        t_w_end = time.monotonic()
        while (jail_watch["t_last"] < t_post or herdr_watch["t_last"] < t_post) and time.monotonic() - t_w_end < 5.0:
            time.sleep(0.005)
        stop_evt.set()
        tw1.join(timeout=2.0)
        tw2.join(timeout=2.0)

        def parse_accept_ts(tier: str) -> int:
            p = f"{STATE_DIR}/dispatcher-{tier}/accept.log"
            if not os.path.exists(p):
                return 0
            lines = [l for l in open(p, "r", encoding="utf-8").read().splitlines() if "ts_ns=" in l]
            if not lines:
                return 0
            m = re.search(r"ts_ns=(\d+)", lines[-1])
            return int(m.group(1)) if m else 0

        ts_b = parse_accept_ts("public")
        ts_c = parse_accept_ts("trusted")
        bracket_ok = (
            ts_b > 0 and ts_c > 0
            and jail_watch["t_first"] <= ts_b <= ts_c <= jail_watch["t_last"]
            and herdr_watch["t_first"] <= ts_b <= ts_c <= herdr_watch["t_last"]
        )
        ok = (
            bracket_ok
            and jail_watch["hits"] == 0
            and herdr_watch["hits"] == 0
            and res_b.get("ok") is True
            and res_c.get("ok") is True
        )
        return ok, (
            f"bracket={bracket_ok} jail_hits={jail_watch['hits']} herdr_hits={herdr_watch['hits']} "
            f"b_ok={res_b.get('ok')} ({res_b.get('err')}) c_ok={res_c.get('ok')}"
        )

    cell("V6.5", *eval_v6_5())

    # =========================================================================
    # 6. V6.6: Process Memory (/proc/<pid>/mem, process_vm_readv, perf_event_open)
    # =========================================================================
    def eval_v6_6(tid_suffix: str = "clean") -> tuple[bool, str]:
        tid = f"thread-v66-{tid_suffix}"
        ct_dir = f"{STATE_DIR}/dispatcher-public/claude-threads/{tid}"
        shutil.rmtree(ct_dir, ignore_errors=True)
        launch_in_herdr("public", tid, ["--run-v66-child"], shim_override=probe_shim_pub, timeout_ms=4000)
        v66_json = f"{ct_dir}/v66-same-jail.json"
        for _ in range(60):
            if os.path.exists(v66_json):
                break
            time.sleep(0.1)
        same = json.loads(open(v66_json, "r", encoding="utf-8").read())

        # Arm 2: sibling thread B's jail child attempting to read probeClaude's outer PID in herdr namespace
        arm2 = run_in_herdr_ns("public", "\n".join([
            "import json, os, subprocess",
            "target_pid = 0",
            "for e in os.listdir('/proc'):",
            "    if e.isdigit():",
            "        try:",
            "            cmd = open(f'/proc/{e}/cmdline', 'rb').read()",
            "            if b'probe-claude' in cmd:",
            "                target_pid = int(e)",
            "                break",
            "        except OSError:",
            "            pass",
            "inner_code = 'import errno, json, os\\ntry:\\n    os.open(f\"/proc/' + str(target_pid) + '/mem\", os.O_RDONLY)\\n    st = \"OK\"\\nexcept OSError as ex:\\n    st = errno.errorcode.get(ex.errno, str(ex.errno))\\nprint(json.dumps({\"target_pid\": ' + str(target_pid) + ', \"arm2_mem\": st}))'",
            "r = subprocess.run([",
            "    '${pkgs.bubblewrap}/bin/bwrap', '--unshare-user', '--unshare-pid', '--bind', '/', '/', '--bind', '/proc', '/proc', '--',",
            "    '${pkgs.python3}/bin/python3', '-I', '-c', inner_code,",
            "], capture_output=True, text=True, check=True)",
            "print(r.stdout.strip())",
        ]))
        ok = (
            same["ctrl_hits"] >= 1
            and same["arm1_mem_hits"] == 0
            and same["arm1_mem_status"] != "ok"
            and same["arm1_vm_hits"] == 0
            and same["perf_fd"] < 0
            and same["perf_errno"] == errno.EPERM
            and same["perf_data_head"] == 0
            and arm2["arm2_mem"] == "EACCES"
        )
        return ok, f"same_jail={same} arm2={arm2}"

    cell("V6.6", *eval_v6_6("clean"))

    # =========================================================================
    # 6b. V6.6b: GT3 Arm A1 Dispatcher Node V8 & HANDOFF_SERVER_PY Memory Residency
    #            + C5 Cross-Tier /run/credentials Mount Isolation Measurement
    # =========================================================================
    def eval_v6_6b(mutant: str = "") -> tuple[bool, str]:
        tag = mutant or "clean"
        work_dir = f"/tmp/gt3-v66b-{tag}"
        shutil.rmtree(work_dir, ignore_errors=True)
        os.makedirs(work_dir, mode=0o755, exist_ok=True)
        os.chown(work_dir, 1000, 100)
        cred_dir = f"{work_dir}/creds"
        outside_dir = f"{work_dir}/outside"
        os.makedirs(cred_dir, mode=0o700, exist_ok=True)
        os.makedirs(outside_dir, mode=0o700, exist_ok=True)
        os.chown(cred_dir, 1000, 100)
        os.chown(outside_dir, 1000, 100)

        # C5 Part 2 live measurement: verify inside genie-dispatcher@public's mount namespace that
        # /run/credentials/genie-dispatcher@public.service/tier-token is readable by sini, whereas
        # /run/credentials/genie-dispatcher@trusted.service/tier-token is inaccessible (EACCES/ENOENT).
        host_mnt_ns = os.readlink("/proc/1/ns/mnt")

        def wait_for_dispatcher_ready(tier: str) -> str:
            unit = f"genie-dispatcher@{tier}"
            cred_rel = f"/run/credentials/{unit}.service/tier-token"
            last_diag = "none"
            for _ in range(200):
                pid_s = subprocess.check_output(
                    ["systemctl", "show", "-p", "MainPID", "--value", unit],
                    text=True,
                ).strip()
                if pid_s and pid_s != "0":
                    try:
                        mnt_ns = os.readlink(f"/proc/{pid_s}/ns/mnt")
                        exe = os.readlink(f"/proc/{pid_s}/exe")
                        comm = open(f"/proc/{pid_s}/comm", "r", encoding="utf-8").read().strip()
                        has_cred = os.path.exists(f"/proc/{pid_s}/root{cred_rel}")
                        last_diag = f"pid={pid_s} ns_diff={mnt_ns != host_mnt_ns} exe={exe} comm={comm} has_cred={has_cred}"
                        if (
                            mnt_ns != host_mnt_ns
                            and exe.endswith("/genie-dispatcher")
                            and has_cred
                        ):
                            return pid_s
                    except OSError as ex:
                        last_diag = f"pid={pid_s} err={ex}"
                time.sleep(0.05)
            raise RuntimeError(f"{unit} did not enter mount namespace and exec genie-dispatcher within 10s ({last_diag})")

        def probe_c5_ns(target_pid: str) -> dict:
            c5_probe = subprocess.run([
                "nsenter", "-t", target_pid, "-m",
                "setpriv", "--reuid=1000", "--regid=100", "--init-groups",
                "${pkgs.python3}/bin/python3", "-I", "-c",
                "\n".join([
                    "import errno, json, os",
                    "res = {}",
                    "for k, p in (('own', '/run/credentials/genie-dispatcher@public.service/tier-token'), ('other', '/run/credentials/genie-dispatcher@trusted.service/tier-token')):",
                    "    try:",
                    "        fd = os.open(p, os.O_RDONLY)",
                    "        os.close(fd)",
                    "        res[k] = 'OK'",
                    "    except OSError as ex:",
                    "        res[k] = errno.errorcode.get(ex.errno, str(ex.errno))",
                    "print(json.dumps(res))",
                ]),
            ], capture_output=True, text=True, check=True)
            return json.loads(c5_probe.stdout.strip())

        if not mutant:
            # Order 1: trusted already running, public stopped then started (the exact post-V2.3 order).
            subprocess.run(["systemctl", "start", "genie-dispatcher@trusted"], check=True)
            disp_tru_pid = wait_for_dispatcher_ready("trusted")
            subprocess.run(["systemctl", "stop", "genie-dispatcher@public"], check=True)
            subprocess.run(["systemctl", "start", "genie-dispatcher@public"], check=True)
            disp_pub_pid = wait_for_dispatcher_ready("public")
            c5_order1 = probe_c5_ns(disp_pub_pid)
            # Order 2: public already running in its mount namespace while trusted restarts on the host.
            subprocess.run(["systemctl", "restart", "genie-dispatcher@trusted"], check=True)
            disp_tru_pid = wait_for_dispatcher_ready("trusted")
            c5_order2 = probe_c5_ns(disp_pub_pid)
            c5_cross_tier = {
                "own": c5_order1.get("own") if c5_order1 == c5_order2 else f"{c5_order1.get('own')}/{c5_order2.get('own')}",
                "other": c5_order1.get("other") if c5_order1 == c5_order2 else f"{c5_order1.get('other')}/{c5_order2.get('other')}",
            }
        else:
            for tier in ("public", "trusted"):
                pid_chk = subprocess.check_output(
                    ["systemctl", "show", "-p", "MainPID", "--value", f"genie-dispatcher@{tier}"],
                    text=True,
                ).strip()
                if not pid_chk or pid_chk == "0":
                    subprocess.run(["systemctl", "start", f"genie-dispatcher@{tier}"], check=True)
            disp_pub_pid = wait_for_dispatcher_ready("public")
            disp_tru_pid = wait_for_dispatcher_ready("trusted")
            # M-c5-pre-ns-race forces the pre-apply_mount_namespace host mount namespace (what the old
            # `comm != "(sd-executor)"` loop entered when systemd-executor was still in PID 1's mount ns).
            c5_cross_tier = probe_c5_ns("1" if mutant == "M-c5-pre-ns-race" else disp_pub_pid)

        # Copy both tier-token credential files into cred_dir (`tier-token-public` & `tier-token-trusted`).
        cred_pub_copy = f"{cred_dir}/tier-token-public"
        cred_tru_copy = f"{cred_dir}/tier-token-trusted"
        shutil.copyfile(
            f"/proc/{disp_pub_pid}/root/run/credentials/genie-dispatcher@public.service/tier-token",
            cred_pub_copy,
        )
        shutil.copyfile(
            f"/proc/{disp_tru_pid}/root/run/credentials/genie-dispatcher@trusted.service/tier-token",
            cred_tru_copy,
        )
        for cp in (cred_pub_copy, cred_tru_copy):
            os.chown(cp, 1000, 100)
            os.chmod(cp, 0o400)
        subprocess.run(["systemctl", "stop", "genie-dispatcher@public", "genie-dispatcher@trusted"], check=True)

        with open("/etc/genie-gi15-test/herdr.ts", "r", encoding="utf-8") as f:
            herdr_ts = f.read()

        if mutant == "M-node-readfile":
            herdr_ts = herdr_ts.replace(
                'import { mkdirSync, rmSync } from "node:fs";',
                'import { mkdirSync, readFileSync, rmSync } from "node:fs";',
            ).replace(
                "const { credDir, credName } = this.resolveCredentialTarget(threadId, s);",
                'const { credDir, credName } = this.resolveCredentialTarget(threadId, s);\n    (globalThis as any).__GT3_MUTANT_LEAK = readFileSync(credDir + "/tier-token-" + credName, "utf8");',
            )
        elif mutant == "M-handoff-early-hold":
            herdr_ts = herdr_ts.replace(
                "zero_ba(_probe_tok)\n    del _probe_tok",
                "pass",
            )
        elif mutant == "M-empty-cred-accepted":
            herdr_ts = herdr_ts.replace(
                'raise ValueError("credential file contains no token")',
                "pass",
            )
        elif mutant == "M-cred-outside-dir":
            herdr_ts = herdr_ts.replace(
                'if (!rawId || rawId === "." || rawId === ".." || rawId.includes("/") || !TOKEN_ID_RE.test(rawId)) {',
                "if (!rawId) {",
            ).replace(
                'not c_name\n        or "/" in c_name\n        or c_name in (".", "..")\n        or not re.fullmatch(r"[A-Za-z0-9._-]+", c_name)',
                "not c_name",
            )

        herdr_ts_path = f"{work_dir}/herdr.ts"
        with open(herdr_ts_path, "w", encoding="utf-8") as f:
            f.write(herdr_ts)
        os.chown(herdr_ts_path, 1000, 100)

        empty_cred = f"{cred_dir}/tier-token-empty"
        with open(empty_cred, "w", encoding="utf-8") as f:
            f.write("# comment only\n   \n")
        os.chown(empty_cred, 1000, 100)
        os.chmod(empty_cred, 0o600)

        outside_cred = f"{outside_dir}/leaked-cred"
        with open(outside_cred, "w", encoding="utf-8") as f:
            f.write("CLAUDE_CODE_OAUTH_TOKEN=outside-secret\n")
        os.chown(outside_cred, 1000, 100)
        os.chmod(outside_cred, 0o600)

        runner_mjs = f"{work_dir}/run_gt3.mjs"
        with open(runner_mjs, "w", encoding="utf-8") as f:
            f.write("""
            import { execFile } from "node:child_process";
            import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync } from "node:fs";
            import { CliHerdr } from "./herdr.ts";

            const [
              herdrBin,
              shimPub,
              shimTru,
              credDir,
              outsideCred,
              stateDir,
              tag,
            ] = process.argv.slice(2);

            globalThis.__GT3_DISP_CTRL = ["GENIE_DISP", "MEM_CONTROL", "0000"].join("_").repeat(4);

            const tokPubHead = Buffer.from("canary-public-", "utf8");
            const tokPubTail = Buffer.from("token-0000", "utf8");
            const tokTruHead = Buffer.from("canary-trusted-", "utf8");
            const tokTruTail = Buffer.from("token-0000", "utf8");
            const dispCtrlHead = Buffer.from("GENIE_DISP_", "utf8");
            const dispCtrlTail = Buffer.from("MEM_CONTROL_0000", "utf8");

            function countSplitNeedle(buf, limit, head, tail, minIdx = 0) {
              let hits = 0;
              let idx = Math.max(0, minIdx);
              const totalLen = head.length + tail.length;
              while (idx <= limit - totalLen) {
                const pos = buf.indexOf(head, idx);
                if (pos === -1 || pos > limit - totalLen) break;
                if (buf.subarray(pos + head.length, pos + totalLen).equals(tail)) {
                  hits += 1;
                  idx = pos + totalLen;
                } else {
                  idx = pos + 1;
                }
              }
              return hits;
            }

            function scanRangeInChunks(start, end, chunk, needles, readAt) {
              const chunkSize = chunk.length;
              const overlaps = needles.map((nd) => Math.max(0, nd.head.length + nd.tail.length - 1));
              const maxOv = overlaps.reduce((a, b) => Math.max(a, b), 0);
              const hits = new Array(needles.length).fill(0);
              let chunksRead = 0;
              let readErrors = 0;
              let emptyReads = 0;
              let offset = start;
              let actualOv = 0;

              while (offset < end) {
                const rem = end - offset;
                const toRead = Number(rem > BigInt(chunkSize) ? BigInt(chunkSize) : rem);
                if (toRead <= 0) break;
                let n = 0;
                try {
                  n = readAt(offset, chunk, toRead);
                } catch {
                  readErrors += 1;
                  break;
                }
                if (n <= 0) {
                  emptyReads += 1;
                  break;
                }
                chunksRead += 1;
                for (let i = 0; i < needles.length; i++) {
                  const minIdx = Math.max(0, actualOv - overlaps[i]);
                  hits[i] += countSplitNeedle(chunk, n, needles[i].head, needles[i].tail, minIdx);
                }
                chunk.fill(0, 0, n);
                if (offset + BigInt(n) >= end) break;
                const adv = Math.max(1, n - maxOv);
                actualOv = n - adv;
                offset += BigInt(adv);
              }
              return { hits, chunksRead, readErrors, emptyReads };
            }

            // C7 + Q3 self-test on scanRangeInChunks (4 MiB boundary straddle + short-read boundary straddle)
            {
              const chunkSize = 4 * 1024 * 1024;
              const backing = Buffer.alloc(chunkSize + 4096);
              const straddleOffset = chunkSize - 7;
              tokPubHead.copy(backing, straddleOffset);
              tokPubTail.copy(backing, straddleOffset + tokPubHead.length);
              const scratch = Buffer.alloc(chunkSize);
              const fullScan = scanRangeInChunks(0n, BigInt(backing.length), scratch, [{ head: tokPubHead, tail: tokPubTail }], (off, buf, toRead) => {
                const pos = Number(off);
                const n = Math.min(toRead, backing.length - pos);
                backing.copy(buf, 0, pos, pos + n);
                return n;
              });
              backing.fill(0);
              if (fullScan.hits[0] !== 1 || fullScan.chunksRead !== 2) {
                throw new Error("C7 fullScan self-test failed: " + JSON.stringify(fullScan));
              }

              const shortBacking = Buffer.alloc(8192);
              const shortStraddle = 2000 - 7;
              tokPubHead.copy(shortBacking, shortStraddle);
              tokPubTail.copy(shortBacking, shortStraddle + tokPubHead.length);
              let calls = 0;
              const shortScan = scanRangeInChunks(0n, BigInt(shortBacking.length), scratch, [{ head: tokPubHead, tail: tokPubTail }], (off, buf, toRead) => {
                calls += 1;
                const pos = Number(off);
                const cap = calls === 1 ? 2000 : toRead;
                const n = Math.min(cap, shortBacking.length - pos);
                shortBacking.copy(buf, 0, pos, pos + n);
                return n;
              });
              shortBacking.fill(0);
              if (shortScan.hits[0] !== 1 || shortScan.chunksRead !== 2) {
                throw new Error("C7 shortScan self-test failed: " + JSON.stringify(shortScan));
              }
            }

            function scanPidMem(pid, runtimeNeedles = null) {
              const maps = readFileSync("/proc/" + pid + "/maps", "utf8").split("\\n");
              const fd = openSync("/proc/" + pid + "/mem", "r");
              const chunkSize = 4 * 1024 * 1024;
              const chunk = Buffer.alloc(chunkSize);
              const needles = [
                { head: tokPubHead, tail: tokPubTail },
                { head: tokTruHead, tail: tokTruTail },
                { head: dispCtrlHead, tail: dispCtrlTail },
              ];
              if (runtimeNeedles) {
                needles.push(
                  { head: runtimeNeedles.sockHead, tail: runtimeNeedles.sockTail },
                  { head: runtimeNeedles.tidHead, tail: runtimeNeedles.tidTail },
                );
              }

              let regions = 0;
              let pubHits = 0;
              let truHits = 0;
              let dispCtrlHits = 0;
              let sockHits = 0;
              let tidHits = 0;
              let readErrors = 0;
              let emptyReads = 0;
              try {
                for (const line of maps) {
                  if (!line) continue;
                  const parts = line.trim().split(/\\s+/);
                  if (parts.length < 2) continue;
                  const perms = parts[1];
                  const pathname = parts.length >= 6 ? parts.slice(5).join(" ") : "";
                  if (!perms.startsWith("r")) continue;
                  if (pathname === "[vvar]" || pathname === "[vvar_vclock]" || pathname === "[vdso]" || pathname === "[vsyscall]") continue;
                  if (pathname.startsWith("/nix/store/") && !perms.includes("w")) continue;
                  const [startHex, endHex] = parts[0].split("-");
                  const start = BigInt("0x" + startHex);
                  const end = BigInt("0x" + endHex);
                  if (end <= start) continue;
                  const res = scanRangeInChunks(start, end, chunk, needles, (off, buf, toRead) =>
                    readSync(fd, buf, 0, toRead, off),
                  );
                  pubHits += res.hits[0];
                  truHits += res.hits[1];
                  dispCtrlHits += res.hits[2];
                  if (runtimeNeedles) {
                    sockHits += res.hits[3];
                    tidHits += res.hits[4];
                  }
                  regions += res.chunksRead;
                  readErrors += res.readErrors;
                  emptyReads += res.emptyReads;
                }
              } finally {
                closeSync(fd);
              }
              return {
                regions,
                tokHits: pubHits + truHits,
                pubHits,
                truHits,
                dispCtrlHits,
                sockHits,
                tidHits,
                readErrors,
                emptyReads,
              };
            }

            function findHandoffChild(parentPid, sockPath, tid) {
              const sockMid = Math.floor(sockPath.length / 2);
              const tidMid = Math.floor(tid.length / 2);
              const runtimeNeedles = {
                sockHead: Buffer.from(sockPath.slice(0, sockMid), "utf8"),
                sockTail: Buffer.from(sockPath.slice(sockMid), "utf8"),
                tidHead: Buffer.from(tid.slice(0, tidMid), "utf8"),
                tidTail: Buffer.from(tid.slice(tidMid), "utf8"),
              };
              for (const entry of readdirSync("/proc")) {
                if (!/^\\d+$/.test(entry)) continue;
                const pid = Number(entry);
                if (pid === parentPid) continue;
                try {
                  const st = readFileSync("/proc/" + pid + "/status", "utf8");
                  const ppidMatch = st.match(/^PPid:\\s+(\\d+)/m);
                  if (!ppidMatch || Number(ppidMatch[1]) !== parentPid) continue;
                  const cmd = readFileSync("/proc/" + pid + "/cmdline").toString("utf8");
                  if (!cmd.includes(sockPath)) continue;
                  let openCredFds = 0;
                  for (const fdEntry of readdirSync("/proc/" + pid + "/fd")) {
                    try {
                      const target = readlinkSync("/proc/" + pid + "/fd/" + fdEntry);
                      if (target.startsWith(credDir) || target.includes("tier-token")) {
                        openCredFds += 1;
                      }
                    } catch {}
                  }
                  return { pid, mem: scanPidMem(pid, runtimeNeedles), openCredFds };
                } catch {}
              }
              return null;
            }

            function execHerdr(argv, env, probePath) {
              return new Promise((resolve, reject) => {
                execFile(argv[0], argv.slice(1), { env }, async (err, stdout, stderr) => {
                  if (err) {
                    if (argv.includes("agent") && argv.includes("start") && probePath) {
                      for (let i = 0; i < 20; i++) {
                        if (existsSync(probePath)) {
                          resolve(JSON.stringify({ id: "cli", result: { type: "agent_started" } }));
                          return;
                        }
                        await new Promise((r) => setTimeout(r, 50));
                      }
                    }
                    reject(new Error(argv.join(" ") + ": " + stdout + stderr));
                  } else {
                    resolve(stdout);
                  }
                });
              });
            }

            async function runTier(tier, shimBin) {
              const tid = "thread-v66b-" + tier + "-" + tag;
              const dispDir = stateDir + "/dispatcher-" + tier;
              const cwdDir = stateDir + "/cwd-" + tier;
              const cfgDir = stateDir + "/claude-" + tier;
              const wtDir = dispDir + "/worktrees/" + tid;
              const ctDir = dispDir + "/claude-threads/" + tid;
              const probePath = ctDir + "/probe";
              mkdirSync(wtDir, { recursive: true, mode: 0o700 });
              mkdirSync(ctDir, { recursive: true, mode: 0o700 });
              let duringDispMem = null;
              let pyAccept = null;

              const herdr = new CliHerdr({
                session: "genie-" + tier,
                cwdDir,
                stateDir: dispDir,
                credentialsDir: credDir,
                herdr: herdrBin,
                claude: shimBin,
                expectedNspidDepth: 2,
                readyTimeoutMs: 3500,
                run: async (argv, env) => {
                  if (argv[3] === "agent" && argv[4] === "start") {
                    const sockIdx = argv.indexOf("--token-sock");
                    const sockPath = sockIdx >= 0 ? argv[sockIdx + 1] : "";
                    duringDispMem = scanPidMem("self");
                    pyAccept = findHandoffChild(process.pid, sockPath, tid);
                  }
                  return execHerdr(argv, env, probePath);
                },
              });

              const pane = await herdr.start({
                name: "g-v66b-" + tier.slice(0, 3),
                threadId: tid,
                token: tier,
                configDir: cfgDir,
                cwd: wtDir,
                args: ["--probe"],
              });
              await herdr.close(pane).catch(() => {});
              if (typeof global.gc !== "function") throw new Error("expected --expose-gc");
              global.gc();
              const afterDispMem = scanPidMem("self");
              return { duringDispMem, afterDispMem, pyAccept, probePath };
            }

            const pubRes = await runTier("public", shimPub);
            const truRes = await runTier("trusted", shimTru);

            let splitCalled = false;
            let emptySplitCalled = false;
            let emptyRejected = false;
            let outsideSplitCalled = false;
            let outsideRejected = false;
            const badHerdr = new CliHerdr({
              session: "genie-public",
              cwdDir: stateDir + "/cwd-public",
              stateDir: stateDir + "/dispatcher-public",
              credentialsDir: credDir,
              herdr: herdrBin,
              claude: shimPub,
              expectedNspidDepth: 2,
              readyTimeoutMs: 3500,
              run: async (argv, env) => {
                if (argv[3] === "pane" && argv[4] === "split") {
                  splitCalled = true;
                }
                if (argv[3] === "agent" && argv[4] === "start") {
                  throw new Error("unexpected agent start reached for invalid credential");
                }
                return execHerdr(argv, env, "");
              },
            });
            splitCalled = false;
            try {
              await badHerdr.start({
                name: "g-v66b-empty",
                threadId: "thread-v66b-empty-" + tag,
                token: "empty",
                configDir: stateDir + "/claude-public",
                cwd: stateDir + "/dispatcher-public/worktrees/thread-v66b-empty-" + tag,
                args: ["--probe"],
              });
            } catch (e) {
              if (/credential error: credential file contains no token/.test(String(e))) emptyRejected = true;
            }
            emptySplitCalled = splitCalled;

            splitCalled = false;
            try {
              await badHerdr.start({
                name: "g-v66b-outside",
                threadId: "thread-v66b-outside-" + tag,
                token: outsideCred,
                configDir: stateDir + "/claude-public",
                cwd: stateDir + "/dispatcher-public/worktrees/thread-v66b-outside-" + tag,
                args: ["--probe"],
              });
            } catch (e) {
              if (/credential error: invalid/.test(String(e))) outsideRejected = true;
            }
            outsideSplitCalled = splitCalled;

            console.log(JSON.stringify({
              pub: pubRes,
              tru: truRes,
              emptyRejected,
              emptySplitCalled,
              outsideRejected,
              outsideSplitCalled,
            }));
            """)
        os.chown(runner_mjs, 1000, 100)

        shim_pub = make_custom_shim(
            "public",
            f"v66b-pub-{tag}",
            real_claude_bin="${probeClaude}/bin/probe-claude",
            sleep_before_connect=0.05,
        )
        shim_tru = make_custom_shim(
            "trusted",
            f"v66b-tru-{tag}",
            real_claude_bin="${probeClaude}/bin/probe-claude",
            sleep_before_connect=0.05,
        )

        # Symlink /var/lib/genie-agent/.config/herdr/sessions/genie-{public,trusted} -> herdr-session-{public,trusted}
        # in the host mount namespace for the duration of r_node, then clean up sessions_dir in finally.
        sessions_dir = f"{STATE_DIR}/.config/herdr/sessions"
        os.makedirs(sessions_dir, mode=0o700, exist_ok=True)
        for p_chown in (f"{STATE_DIR}/.config", f"{STATE_DIR}/.config/herdr", sessions_dir):
            os.chown(p_chown, 1000, 100)
        for tier in ("public", "trusted"):
            link_path = f"{sessions_dir}/genie-{tier}"
            if os.path.islink(link_path) or os.path.exists(link_path):
                if os.path.islink(link_path):
                    os.unlink(link_path)
                else:
                    shutil.rmtree(link_path, ignore_errors=True)
            os.symlink(f"{STATE_DIR}/herdr-session-{tier}", link_path)

        try:
            r_node = subprocess.run([
                "setpriv", "--reuid=1000", "--regid=100", "--init-groups",
                "env", f"HOME={STATE_DIR}", "XDG_RUNTIME_DIR=/run/user/1000", f"PATH={CLEAN_PATH}",
                "${pkgs.nodejs}/bin/node", "--expose-gc", runner_mjs,
                get_herdr_bin("public"),
                shim_pub,
                shim_tru,
                cred_dir,
                outside_cred,
                STATE_DIR,
                tag,
            ], capture_output=True, text=True)
        finally:
            shutil.rmtree(sessions_dir, ignore_errors=True)
            os.makedirs(sessions_dir, mode=0o700, exist_ok=True)
            os.chown(sessions_dir, 1000, 100)
            for tier in ("public", "trusted"):
                t_dir = f"{sessions_dir}/genie-{tier}"
                os.makedirs(t_dir, mode=0o700, exist_ok=True)
                os.chown(t_dir, 1000, 100)
        if r_node.returncode != 0:
            return False, f"node rc={r_node.returncode} stderr={r_node.stderr.strip()} stdout={r_node.stdout.strip()}"

        rep = json.loads(r_node.stdout.strip().splitlines()[-1])
        pub_probe = rep["pub"]["probePath"]
        tru_probe = rep["tru"]["probePath"]
        pub_rec = open(pub_probe, "r", encoding="utf-8").read() if os.path.exists(pub_probe) else ""
        tru_rec = open(tru_probe, "r", encoding="utf-8").read() if os.path.exists(tru_probe) else ""

        pub_d = rep["pub"]["duringDispMem"]
        pub_a = rep["pub"]["afterDispMem"]
        pub_py = rep["pub"]["pyAccept"]
        tru_d = rep["tru"]["duringDispMem"]
        tru_a = rep["tru"]["afterDispMem"]
        tru_py = rep["tru"]["pyAccept"]

        disp_ctrl_ok = (
            pub_d["dispCtrlHits"] >= 1
            and pub_a["dispCtrlHits"] >= 1
            and tru_d["dispCtrlHits"] >= 1
            and tru_a["dispCtrlHits"] >= 1
            and pub_d["regions"] >= 20
            and pub_d["emptyReads"] == 0
            and tru_d["emptyReads"] == 0
        )
        disp_tok_hits = (
            pub_d["tokHits"] + pub_a["tokHits"] + tru_d["tokHits"] + tru_a["tokHits"]
        )
        py_ctrl_ok = (
            pub_py is not None
            and tru_py is not None
            and pub_py["mem"]["regions"] >= 10
            and pub_py["mem"]["readErrors"] == 0
            and tru_py["mem"]["readErrors"] == 0
            and pub_py["mem"]["emptyReads"] == 0
            and tru_py["mem"]["emptyReads"] == 0
            and pub_py["mem"]["sockHits"] >= 1
            and pub_py["mem"]["tidHits"] >= 1
            and tru_py["mem"]["sockHits"] >= 1
            and tru_py["mem"]["tidHits"] >= 1
        )
        py_tok_hits = (
            (pub_py["mem"]["tokHits"] if pub_py else 999)
            + (tru_py["mem"]["tokHits"] if tru_py else 999)
        )
        py_open_fds = (
            (pub_py["openCredFds"] if pub_py else 999)
            + (tru_py["openCredFds"] if tru_py else 999)
        )
        tok_delivered_ok = (
            f"tok={HASH_PUB}" in pub_rec and "sock=1" in pub_rec
            and f"tok={HASH_TRU}" in tru_rec and "sock=1" in tru_rec
        )
        empty_ok = rep["emptyRejected"] is True and rep["emptySplitCalled"] is False
        outside_ok = rep["outsideRejected"] is True and rep["outsideSplitCalled"] is False
        c5_mount_ok = c5_cross_tier.get("own") == "OK" and c5_cross_tier.get("other") in ("ENOENT", "EACCES")

        ok = (
            disp_ctrl_ok
            and disp_tok_hits == 0
            and py_ctrl_ok
            and py_tok_hits == 0
            and py_open_fds == 0
            and tok_delivered_ok
            and empty_ok
            and outside_ok
            and c5_mount_ok
        )
        return ok, (
            f"disp_ctrl_ok={disp_ctrl_ok} disp_tok_hits={disp_tok_hits} "
            f"py_ctrl_ok={py_ctrl_ok} py_tok_hits={py_tok_hits} py_open_fds={py_open_fds} "
            f"tok_delivered_ok={tok_delivered_ok} empty_ok={empty_ok} outside_ok={outside_ok} "
            f"c5_cross_tier={c5_cross_tier}"
        )

    cell("V6.6b", *eval_v6_6b())


    # =========================================================================
    # 7. V6.8: Real claude in-process Read-then-Write refusal on 6 paths (O6)
    # =========================================================================
    def eval_v6_8(shim_override: str | None = None, tag: str = "clean") -> tuple[bool, str]:
        try:
            os.unlink("/tmp/v68-results.json")
        except FileNotFoundError:
            pass
        tracked = [
            f"{STATE_DIR}/.zshenv",
            f"{STATE_DIR}/claude-public/settings.json",
            f"{STATE_DIR}/claude-public/.claude.json",
        ]
        def file_hash(p: str) -> str:
            return hashlib.sha256(open(p, "rb").read()).hexdigest() if os.path.exists(p) else "ABSENT"

        before_hashes = {p: file_hash(p) for p in tracked}
        launch_in_herdr(
            "public",
            f"thread-v68-{tag}",
            ["-n", f"genie-v68-{tag}", "--session-id", str(uuid.uuid4()), "-p", "v68-rw"],
            shim_override=shim_override,
            timeout_ms=8000,
        )
        for _ in range(80):
            if os.path.exists("/tmp/v68-results.json"):
                break
            time.sleep(0.1)
        after_hashes = {p: file_hash(p) for p in tracked}
        w_trs = json.loads(open("/tmp/v68-results.json", "r", encoding="utf-8").read()) if os.path.exists("/tmp/v68-results.json") else []
        all_errored = len(w_trs) == 6 and all(t.get("is_error") is True for t in w_trs)
        no_unread_err = all("File has not been read yet" not in json.dumps(t) for t in w_trs)
        hashes_unchanged = (
            before_hashes == after_hashes
            and not os.path.exists(f"{STATE_DIR}/.config/herdr/x")
            and not os.path.exists(f"{STATE_DIR}/dispatcher-public/worktrees/.git")
            and not os.path.exists(f"{STATE_DIR}/dispatcher-public/worktrees/thread-B/.claude/settings.json")
        )
        ok = all_errored and no_unread_err and hashes_unchanged
        return ok, f"n={len(w_trs)} all_errored={all_errored} no_unread_err={no_unread_err} hashes_unchanged={hashes_unchanged}"

    cell("V6.8", *eval_v6_8())

    # =========================================================================
    # 7b. GV1: End-to-End Packaged genie-dispatcher@public VM Cell + N1 Migration
    # =========================================================================
    def scan_disp_pid_mem(target_pid: int, needles: list[bytes]) -> dict:
        with open(f"/proc/{target_pid}/maps", "r", encoding="utf-8") as mf:
            maps_lines = mf.readlines()
        mem_fd = os.open(f"/proc/{target_pid}/mem", os.O_RDONLY)
        chunk_sz = 4 * 1024 * 1024
        max_ov = max(max(0, len(nd) - 1) for nd in needles)
        hits = [0] * len(needles)
        regions = 0
        empty_reads = 0
        try:
            for line in maps_lines:
                parts = line.split()
                if len(parts) < 2 or not parts[1].startswith("r"):
                    continue
                pathname = " ".join(parts[5:]) if len(parts) >= 6 else ""
                if pathname in ("[vvar]", "[vvar_vclock]", "[vdso]", "[vsyscall]"):
                    continue
                if pathname.startswith("/nix/store/") and "w" not in parts[1]:
                    continue
                start_s, end_s = parts[0].split("-")
                start, end = int(start_s, 16), int(end_s, 16)
                pos = start
                actual_ov = 0
                while pos < end:
                    to_read = min(chunk_sz, end - pos)
                    if to_read <= 0:
                        break
                    try:
                        chunk = os.pread(mem_fd, to_read, pos)
                    except OSError:
                        break
                    n = len(chunk)
                    if n <= 0:
                        empty_reads += 1
                        break
                    regions += 1
                    for i, nd in enumerate(needles):
                        ov = max(0, len(nd) - 1)
                        hits[i] += chunk.count(nd, max(0, actual_ov - ov))
                    if pos + n >= end:
                        break
                    adv = max(1, n - max_ov)
                    actual_ov = n - adv
                    pos += adv
        finally:
            os.close(mem_fd)
        return {"regions": regions, "empty_reads": empty_reads, "hits": hits}

    def xmsg_agent_call(obj: dict) -> dict:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(10.0)
        try:
            s.connect("/run/user/1000/xmsg/agent.sock")
            s.sendall((json.dumps(obj) + "\n").encode("utf-8"))
            line = s.makefile("r", encoding="utf-8").readline()
            return json.loads(line) if line else {}
        finally:
            s.close()

    def xmsg_wait_replies(msg_id: str, wait_s: int = 25) -> list[dict]:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(float(wait_s + 5))
        try:
            s.connect("/run/user/1000/xmsg/http.sock")
            req = (
                f"GET /v1/messages/{msg_id}/replies?wait={wait_s} HTTP/1.1\r\n"
                "Host: localhost\r\n"
                "Connection: close\r\n\r\n"
            )
            s.sendall(req.encode("utf-8"))
            raw = b""
            while True:
                b = s.recv(4096)
                if not b:
                    break
                raw += b
            body = raw.split(b"\r\n\r\n", 1)[1].decode("utf-8", "replace") if b"\r\n\r\n" in raw else "[]"
            return json.loads(body)
        finally:
            s.close()

    def validate_journal_via_gx1(journal_path: str, tid: str) -> dict:
        r = subprocess.run([
            "${pkgs.nodejs}/bin/node",
            "--input-type=module",
            "-e",
            """
            import { readFileSync } from "node:fs";
            import { validateJournalEntry } from "/etc/genie-gi15-test/dispatcher/journal.ts";
            const [jPath, tid] = process.argv.slice(1);
            const j = JSON.parse(readFileSync(jPath, "utf8"));
            const entry = j.threads?.[tid] ?? null;
            const err = entry ? validateJournalEntry(tid, entry) : "missing_entry";
            console.log(JSON.stringify({ err, entry, tokens: j.tokens ?? {} }));
            """,
            journal_path,
            tid,
        ], capture_output=True, text=True, check=True)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def eval_gv1(mutant: str = "") -> tuple[bool, str]:
        tag = mutant or "clean"
        disp_dir = f"{STATE_DIR}/dispatcher-public"
        journal_path = f"{disp_dir}/journal.json"
        dropin_dir = "/run/systemd/system/genie-dispatcher@public.service.d"
        dropin_file = f"{dropin_dir}/m-gv1.conf"
        mutant_src_dir = f"{disp_dir}/mutant-no-n1"

        shim_path = get_unit_shim("public")
        gv1_shim = make_custom_shim("public", f"gv1-{tag}", real_claude_bin="${gv1ClaudeStub}/bin/claude")
        cat_out = subprocess.check_output(["systemctl", "cat", "genie-dispatcher@public"], text=True)
        m_exec = re.search(r"ExecStart=(\S+)\s+(--state-dir\s+.*)", cat_out)
        assert m_exec, "missing ExecStart in genie-dispatcher@public"
        orig_disp_bin = m_exec.group(1).strip()
        orig_flags = m_exec.group(2).strip()
        gv1_flags = re.sub(r"--claude-bin\s+\S+", f"--claude-bin {gv1_shim}", orig_flags)

        def close_extra_panes():
            try:
                panes = herdr_cmd("public", ["pane", "list"])["result"]["panes"]
                for p in panes[1:]:
                    herdr_cmd("public", ["pane", "close", p["pane_id"]])
            except Exception:
                pass

        def restart_and_wait_dispatcher() -> bool:
            prev_poll = xmsg_agent_call({"action": "status", "name": "genie-expert-public"}).get("polling", 0)
            xmsg_agent_call({"action": "reset", "name": "genie-expert-public"})
            subprocess.run(["systemctl", "restart", "genie-dispatcher@public"], check=True)
            t0 = time.monotonic()
            while time.monotonic() - t0 < 12.0:
                st = xmsg_agent_call({"action": "status", "name": "genie-expert-public"})
                if st.get("polling", 0) > prev_poll and st.get("alive"):
                    return True
                time.sleep(0.1)
            return False

        try:
            subprocess.run(["systemctl", "stop", "genie-dispatcher@public"], check=True)
            close_extra_panes()
            os.makedirs(dropin_dir, exist_ok=True)
            if os.path.exists(dropin_file):
                os.unlink(dropin_file)

            if mutant == "M-no-load-credential":
                with open(dropin_file, "w", encoding="utf-8") as f:
                    f.write(f"[Service]\nLoadCredential=\nExecStart=\nExecStart={orig_disp_bin} {gv1_flags}\n")
                subprocess.run(["systemctl", "daemon-reload"], check=True)
            elif mutant == "M-no-n1-migration":
                shutil.rmtree(mutant_src_dir, ignore_errors=True)
                shutil.copytree("/etc/genie-gi15-test/dispatcher", mutant_src_dir)
                for fn_mut in ("index.ts", "journal.ts"):
                    p_mut = f"{mutant_src_dir}/{fn_mut}"
                    txt_mut = open(p_mut, "r", encoding="utf-8").read()
                    assert "t.token === t.configDir" in txt_mut, f"N1 migration target not found in {fn_mut}"
                    txt_mut = re.sub(
                        r"if\s*\(\s*(?:t\s*&&\s*typeof\s+t\s*===\s*\"object\"\s*&&\s*)?t\.token\s*&&\s*t\.token\s*===\s*t\.configDir[\s\S]*?\)\s*\{",
                        "if (false) {",
                        txt_mut,
                        count=1,
                    )
                    with open(p_mut, "w", encoding="utf-8") as f:
                        f.write(txt_mut)
                for dp, dns, fns in os.walk(mutant_src_dir):
                    os.chown(dp, 1000, 100)
                    os.chmod(dp, 0o755)
                    for fn in fns:
                        fp = os.path.join(dp, fn)
                        os.chown(fp, 1000, 100)
                        os.chmod(fp, 0o644)
                with open(dropin_file, "w", encoding="utf-8") as f:
                    f.write(f"[Service]\nExecStart=\nExecStart=${pkgs.nodejs}/bin/node {mutant_src_dir}/main.ts {gv1_flags}\n")
                subprocess.run(["systemctl", "daemon-reload"], check=True)
            else:
                with open(dropin_file, "w", encoding="utf-8") as f:
                    f.write(f"[Service]\nExecStart=\nExecStart={orig_disp_bin} {gv1_flags}\n")
                subprocess.run(["systemctl", "daemon-reload"], check=True)

            if mutant != "M-no-n1-migration":
                # Step A: Fresh escalation over real xmsg socket
                tid1 = f"thread-gv1-1-{tag}"
                ctrl_q = f"gv1-positive-control-{tag}-0000"
                for p in (journal_path, f"{disp_dir}/worktrees/{tid1}", f"{disp_dir}/claude-threads/{tid1}"):
                    shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else (os.unlink(p) if os.path.exists(p) else None)

                if not restart_and_wait_dispatcher():
                    return False, "dispatcher failed to register and poll on step A"

                send1 = xmsg_agent_call({
                    "action": "send",
                    "to": "svc:genie-expert-public",
                    "text": json.dumps({"thread_id": tid1, "cleaned_question": ctrl_q}),
                })
                reps1 = xmsg_wait_replies(send1["message_id"], wait_s=8 if mutant == "M-no-load-credential" else 20)
                rep1_text = reps1[0]["text"] if reps1 else ""
                try:
                    rep1_json = json.loads(rep1_text)
                except Exception:
                    rep1_json = {}

                exp_cwd1 = f"{disp_dir}/worktrees/{tid1}"
                exp_ans1 = f"gv1-ok:{tid1}:resume=False:cwd={exp_cwd1}"
                reply1_ok = rep1_json.get("answer") == exp_ans1 and rep1_json.get("tier") == "expert"

                probe1_path = f"{disp_dir}/claude-threads/{tid1}/gv1-probe.json"
                probe1 = json.loads(open(probe1_path, "r", encoding="utf-8").read()) if os.path.exists(probe1_path) else {}
                probe1_ok = (
                    probe1.get("tok_is_sock") is True
                    and probe1.get("tok_hash") == HASH_PUB
                    and probe1.get("cwd") == exp_cwd1
                    and probe1.get("is_resume") is False
                )

                gx1_1 = validate_journal_via_gx1(journal_path, tid1) if os.path.exists(journal_path) else {"err": "no_journal", "entry": None}
                journal1_ok = (
                    gx1_1["err"] is None
                    and gx1_1["entry"] is not None
                    and gx1_1["entry"].get("token") == "tier-token"
                    and gx1_1["entry"].get("state") == "live"
                    and gx1_1["entry"].get("launched") is True
                )

                disp_pid = int(subprocess.check_output(
                    ["systemctl", "show", "-p", "MainPID", "--value", "genie-dispatcher@public"],
                    text=True,
                ).strip())
                mem_scan = scan_disp_pid_mem(
                    disp_pid,
                    [
                        TOK_PUB.encode("utf-8"),
                        TOK_TRU.encode("utf-8"),
                        ctrl_q.encode("utf-8"),
                    ],
                )
                disp_tok_hits = mem_scan["hits"][0] + mem_scan["hits"][1]
                disp_ctrl_hits = mem_scan["hits"][2]
                mem_ok = (
                    disp_tok_hits == 0
                    and disp_ctrl_hits >= 1
                    and mem_scan["regions"] >= 20
                    and mem_scan["empty_reads"] == 0
                )
                step_a_ok = reply1_ok and probe1_ok and journal1_ok and mem_ok
                if not step_a_ok:
                    return False, (
                        f"stepA failed: reply1_ok={reply1_ok} probe1_ok={probe1_ok} "
                        f"journal1_ok={journal1_ok} disp_tok_hits={disp_tok_hits} "
                        f"disp_ctrl_hits={disp_ctrl_hits} rep1={rep1_text!r}"
                    )
                if mutant == "M-no-load-credential":
                    return True, "stepA unexpectedly succeeded under M-no-load-credential"
                subprocess.run(["systemctl", "stop", "genie-dispatcher@public"], check=True)
                close_extra_panes()
            else:
                reply1_ok = probe1_ok = journal1_ok = mem_ok = True
                disp_tok_hits = 0
                disp_ctrl_hits = 1
                mem_scan = {"regions": 0}
                rep1_text = "skipped-stepA-for-n1-mutant"

            # Step B: Seed a legacy (2a86671-shaped) journal, restart the unit, and assert N1 migration resumes it

            tid_leg = f"thread-gv1-leg-{tag}"
            leg_uuid = "22222222-3333-4444-8555-666666666666"
            for p in (f"{disp_dir}/worktrees/{tid_leg}", f"{disp_dir}/claude-threads/{tid_leg}"):
                shutil.rmtree(p, ignore_errors=True)
            legacy_journal = {
                "version": 1,
                "threads": {
                    tid_leg: {
                        "session": leg_uuid,
                        "name": "genie-22222222",
                        "token": f"{STATE_DIR}/claude-public",
                        "configDir": f"{STATE_DIR}/claude-public",
                        "state": "parked",
                        "pane": None,
                        "launched": True,
                        "buffer": [],
                        "outstanding": [],
                        "lastReply": None,
                        "createdAt": 1700000000000,
                        "seq": 0,
                    }
                },
                "tokens": {
                    f"{STATE_DIR}/claude-public": {
                        "state": "available"
                    }
                },
            }
            with open(journal_path, "w", encoding="utf-8") as jf:
                json.dump(legacy_journal, jf)
            os.chown(journal_path, 1000, 100)
            os.chmod(journal_path, 0o600)

            if not restart_and_wait_dispatcher():
                return False, "dispatcher failed to register and poll on step B"

            send2 = xmsg_agent_call({
                "action": "send",
                "to": "svc:genie-expert-public",
                "text": json.dumps({"thread_id": tid_leg, "cleaned_question": "gv1-legacy-resume"}),
            })
            reps2 = xmsg_wait_replies(send2["message_id"], wait_s=8 if mutant else 20)
            rep2_text = reps2[0]["text"] if reps2 else ""
            try:
                rep2_json = json.loads(rep2_text)
            except Exception:
                rep2_json = {}

            exp_cwd2 = f"{disp_dir}/worktrees/{tid_leg}"
            exp_ans2 = f"gv1-ok:{tid_leg}:resume=True:cwd={exp_cwd2}"
            reply2_ok = rep2_json.get("answer") == exp_ans2 and rep2_json.get("tier") == "expert"

            probe2_path = f"{disp_dir}/claude-threads/{tid_leg}/gv1-probe.json"
            probe2 = json.loads(open(probe2_path, "r", encoding="utf-8").read()) if os.path.exists(probe2_path) else {}
            probe2_ok = (
                probe2.get("tok_is_sock") is True
                and probe2.get("tok_hash") == HASH_PUB
                and probe2.get("cwd") == exp_cwd2
                and probe2.get("is_resume") is True
                and probe2.get("session_id") == leg_uuid
            )

            gx1_2 = validate_journal_via_gx1(journal_path, tid_leg) if os.path.exists(journal_path) else {"err": "no_journal", "entry": None, "tokens": {}}
            n1_migrated_ok = (
                gx1_2["err"] is None
                and gx1_2["entry"] is not None
                and gx1_2["entry"].get("token") == "tier-token"
                and gx1_2["entry"].get("session") == leg_uuid
                and f"{STATE_DIR}/claude-public" not in gx1_2.get("tokens", {})
                and "tier-token" in gx1_2.get("tokens", {})
            )

            ok = (
                reply1_ok
                and probe1_ok
                and journal1_ok
                and mem_ok
                and reply2_ok
                and probe2_ok
                and n1_migrated_ok
            )
            return ok, (
                f"reply1_ok={reply1_ok} probe1_ok={probe1_ok} journal1_ok={journal1_ok} "
                f"disp_tok_hits={disp_tok_hits} disp_ctrl_hits={disp_ctrl_hits} regions={mem_scan['regions']} "
                f"reply2_ok={reply2_ok} probe2_ok={probe2_ok} n1_migrated_ok={n1_migrated_ok} "
                f"rep1={rep1_text!r} rep2={rep2_text!r}"
            )
        finally:
            if os.path.exists(dropin_file):
                os.unlink(dropin_file)
                subprocess.run(["systemctl", "daemon-reload"], check=False)
            shutil.rmtree(mutant_src_dir, ignore_errors=True)
            subprocess.run(["systemctl", "stop", "genie-dispatcher@public"], check=False)
            if os.path.exists(journal_path):
                os.unlink(journal_path)
            if os.path.exists(gv1_shim):
                os.unlink(gv1_shim)
            close_extra_panes()

    cell("GV1", *eval_gv1())

    # =========================================================================
    # 7c. GV2: End-to-end Tier 1 pi bwrap sandbox verification (GS2 §3a.2)
    # =========================================================================
    def make_matrix_envelope(tid: str, text: str, tier: str = "public") -> str:
        req_line = json.dumps({
            "sender": "alice",
            "sender_id": "@alice:example.org",
            "tier": tier,
            "text": text,
        })
        return f"[matrix] room=!gv2:example.org thread={tid} user=alice ({tier})\n\n<request>\n{req_line}\n</request>"

    def eval_gv2(mutant: str | None = None) -> tuple[bool, str]:
        tag = mutant.lower().replace("-", "_") if mutant else "norm"
        tid_a = f"thread-gv2-A-{tag}"
        tid_b = f"thread-gv2-B-{tag}"
        dropin_dir = "/run/systemd/system/genie-agent.service.d"
        dropin_file = f"{dropin_dir}/m-gv2.conf"
        mut_bwrap_path = f"{STATE_DIR}/gv2-mutant-bwrap"
        mut_cfg_path = f"{STATE_DIR}/gv2-mutant-config.json"

        cat_ga = subprocess.check_output(["systemctl", "cat", "genie-agent.service"], text=True)
        m_ga = re.search(r"ExecStart=(\S+)\s+--config\s+(\S+)", cat_ga)
        assert m_ga, "missing ExecStart in genie-agent.service"
        orig_root_bin = m_ga.group(1).strip()
        orig_cfg_path = m_ga.group(2).strip()

        def restart_and_wait_genie_agent() -> bool:
            prev_poll = xmsg_agent_call({"action": "status", "name": "genie"}).get("polling", 0)
            xmsg_agent_call({"action": "reset", "name": "genie"})
            subprocess.run(["systemctl", "reset-failed", "genie-agent.service"], check=False)
            subprocess.run(["systemctl", "restart", "genie-agent.service"], check=True)
            t0 = time.monotonic()
            while time.monotonic() - t0 < 15.0:
                st = xmsg_agent_call({"action": "status", "name": "genie"})
                if st.get("polling", 0) > prev_poll and st.get("alive"):
                    return True
                time.sleep(0.1)
            return False

        try:
            subprocess.run(["systemctl", "stop", "genie-agent.service"], check=True)
            for p in (
                f"{STATE_DIR}/state/{tid_a}",
                f"{STATE_DIR}/state/{tid_b}",
                f"{STATE_DIR}/worktrees/{tid_a}",
                f"{STATE_DIR}/worktrees/{tid_b}",
                mut_bwrap_path,
                mut_cfg_path,
            ):
                if os.path.isdir(p) and not os.path.islink(p):
                    shutil.rmtree(p, ignore_errors=True)
                elif os.path.lexists(p):
                    os.unlink(p)

            os.makedirs(dropin_dir, exist_ok=True)
            if os.path.exists(dropin_file):
                os.unlink(dropin_file)

            if mutant in ("M-no-pi-bwrap", "M-rw-worktree-or-agentdir", "M-expose-state-root"):
                mut_script = "\n".join([
                    "#!${pkgs.python3}/bin/python3 -I",
                    "import os, sys",
                    f"mutant = {mutant!r}",
                    'real_bwrap = "${pkgs.bubblewrap}/bin/bwrap"',
                    "argv = sys.argv[1:]",
                    "sep = argv.index('--')",
                    "b_flags = argv[:sep]",
                    "pi_cmd = argv[sep + 1:]",
                    "if mutant == 'M-no-pi-bwrap':",
                    "    env = {}",
                    "    cwd = None",
                    "    i = 0",
                    "    while i < len(b_flags):",
                    "        f = b_flags[i]",
                    "        if f == '--setenv':",
                    "            env[b_flags[i + 1]] = b_flags[i + 2]",
                    "            i += 3",
                    "        elif f == '--chdir':",
                    "            cwd = b_flags[i + 1]",
                    "            i += 2",
                    "        elif f in ('--ro-bind', '--ro-bind-try', '--bind'):",
                    "            i += 3",
                    "        elif f in ('--dev', '--proc', '--tmpfs', '--remount-ro'):",
                    "            i += 2",
                    "        else:",
                    "            i += 1",
                    "    if cwd:",
                    "        os.chdir(cwd)",
                    "    os.execve(pi_cmd[0], pi_cmd, env)",
                    "elif mutant == 'M-rw-worktree-or-agentdir':",
                    "    new_flags = []",
                    "    i = 0",
                    "    while i < len(b_flags):",
                    "        f = b_flags[i]",
                    "        if f == '--ro-bind' and i + 2 < len(b_flags):",
                    "            src, dst = b_flags[i + 1], b_flags[i + 2]",
                    "            if '/genie-pi-' in src or src.startswith('/var/lib/genie-agent/worktrees/'):",
                    "                new_flags.extend(['--bind', src, dst])",
                    "            else:",
                    "                new_flags.extend([f, src, dst])",
                    "            i += 3",
                    "        elif f == '--remount-ro' and i + 1 < len(b_flags) and b_flags[i + 1] == '/var/lib/genie-agent/worktrees':",
                    "            i += 2",
                    "        else:",
                    "            new_flags.append(f)",
                    "            i += 1",
                    "    os.execv(real_bwrap, [real_bwrap] + new_flags + ['--'] + pi_cmd)",
                    "elif mutant == 'M-expose-state-root':",
                    "    new_flags = []",
                    "    i = 0",
                    "    while i < len(b_flags):",
                    "        f = b_flags[i]",
                    "        if f == '--tmpfs' and i + 1 < len(b_flags) and b_flags[i + 1] == '/var/lib/genie-agent/state':",
                    "            new_flags.extend(['--ro-bind', '/var/lib/genie-agent/state', '/var/lib/genie-agent/state'])",
                    "            i += 2",
                    "        elif f == '--remount-ro' and i + 1 < len(b_flags) and b_flags[i + 1] == '/var/lib/genie-agent/state':",
                    "            i += 2",
                    "        else:",
                    "            new_flags.append(f)",
                    "            i += 1",
                    "    os.execv(real_bwrap, [real_bwrap] + new_flags + ['--'] + pi_cmd)",
                ]) + "\n"
                with open(mut_bwrap_path, "w", encoding="utf-8") as mf:
                    mf.write(mut_script)
                os.chown(mut_bwrap_path, 1000, 100)
                os.chmod(mut_bwrap_path, 0o755)

                cfg_obj = json.loads(open(orig_cfg_path, "r", encoding="utf-8").read())
                cfg_obj.setdefault("tier1", {}).setdefault("sandbox", {})["bwrap"] = mut_bwrap_path
                with open(mut_cfg_path, "w", encoding="utf-8") as cf:
                    json.dump(cfg_obj, cf)
                os.chown(mut_cfg_path, 1000, 100)
                os.chmod(mut_cfg_path, 0o644)

                with open(dropin_file, "w", encoding="utf-8") as df:
                    df.write(f"[Service]\nExecStart=\nExecStart={orig_root_bin} --config {mut_cfg_path}\n")
            elif mutant == "M-eval-proc-mount":
                mut_eval_bin_dir = f"{STATE_DIR}/gv2-mut-eval-bin"
                os.makedirs(mut_eval_bin_dir, exist_ok=True)
                os.chown(mut_eval_bin_dir, 1000, 100)
                os.chmod(mut_eval_bin_dir, 0o755)
                mut_eval_bwrap = f"{mut_eval_bin_dir}/bwrap"
                with open(mut_eval_bwrap, "w", encoding="utf-8") as mf:
                    mf.write("\n".join([
                        "#!${pkgs.python3}/bin/python3 -I",
                        "import os, sys",
                        'real_bwrap = "${pkgs.bubblewrap}/bin/bwrap"',
                        "argv = sys.argv[1:]",
                        "if '--unshare-all' in argv or '--unshare-ipc' in argv:",
                        "    new_argv = ['--unshare-pid']",
                        "    i = 0",
                        "    while i < len(argv):",
                        "        if argv[i] == '--bind' and i + 2 < len(argv) and argv[i + 1] == '/proc' and argv[i + 2] == '/proc':",
                        "            new_argv.extend(['--proc', '/proc'])",
                        "            i += 3",
                        "        else:",
                        "            new_argv.append(argv[i])",
                        "            i += 1",
                        "    argv = new_argv",
                        "os.execv(real_bwrap, [real_bwrap] + argv)",
                    ]) + "\n")
                os.chown(mut_eval_bwrap, 1000, 100)
                os.chmod(mut_eval_bwrap, 0o755)
                m_path = re.search(r'Environment="PATH=([^"]+)"', cat_ga)
                orig_path = m_path.group(1) if m_path else "/run/current-system/sw/bin"
                with open(dropin_file, "w", encoding="utf-8") as df:
                    df.write(f'[Service]\nEnvironment="PATH={mut_eval_bin_dir}:{orig_path}"\n')
            elif mutant == "M-no-unshare-pid":
                mut_eval_bin_dir = f"{STATE_DIR}/gv2-mut-eval-bin"
                os.makedirs(mut_eval_bin_dir, exist_ok=True)
                os.chown(mut_eval_bin_dir, 1000, 100)
                os.chmod(mut_eval_bin_dir, 0o755)
                mut_eval_bwrap = f"{mut_eval_bin_dir}/bwrap"
                with open(mut_eval_bwrap, "w", encoding="utf-8") as mf:
                    mf.write("\n".join([
                        "#!${pkgs.python3}/bin/python3 -I",
                        "import os, sys",
                        'real_bwrap = "${pkgs.bubblewrap}/bin/bwrap"',
                        "argv = [a for a in sys.argv[1:] if a != '--unshare-pid']",
                        "os.execv(real_bwrap, [real_bwrap] + argv)",
                    ]) + "\n")
                os.chown(mut_eval_bwrap, 1000, 100)
                os.chmod(mut_eval_bwrap, 0o755)
                cfg_obj = json.loads(open(orig_cfg_path, "r", encoding="utf-8").read())
                cfg_obj.setdefault("tier1", {}).setdefault("sandbox", {})["bwrap"] = mut_eval_bwrap
                with open(mut_cfg_path, "w", encoding="utf-8") as cf:
                    json.dump(cfg_obj, cf)
                os.chown(mut_cfg_path, 1000, 100)
                os.chmod(mut_cfg_path, 0o644)
                m_path = re.search(r'Environment="PATH=([^"]+)"', cat_ga)
                orig_path = m_path.group(1) if m_path else "/run/current-system/sw/bin"
                with open(dropin_file, "w", encoding="utf-8") as df:
                    df.write(
                        f'[Service]\nEnvironment="PATH={mut_eval_bin_dir}:{orig_path}"\n'
                        f"ExecStart=\nExecStart={orig_root_bin} --config {mut_cfg_path}\n"
                    )
            elif mutant == "M-no-protectproc":
                with open(dropin_file, "w", encoding="utf-8") as df:
                    df.write("[Service]\nPrivatePIDs=false\nProtectProc=default\n")

            subprocess.run(["systemctl", "daemon-reload"], check=True)
            if not restart_and_wait_genie_agent():
                return False, "genie-agent.service failed to register and poll on xmsg"

            # Step A: Launch sibling thread B first so both its state on disk and its live pi jail exist
            send_b = xmsg_agent_call({
                "action": "send",
                "to": "svc:genie",
                "text": make_matrix_envelope(tid_b, f"gv2-turn-B:{tag}"),
            })
            reps_b = xmsg_wait_replies(send_b["message_id"], wait_s=20)
            rep_b_raw = reps_b[0]["text"] if reps_b else ""
            b_ok = f"gv2-B-ok:gv2-turn-B:{tag}" in rep_b_raw

            # Step A: Positive turn on thread A (read /memory/MEMORY.md, clone HTTPS fixture, read README + tracked-link, web_search gv2-stub, real nix eval + IFD eval, reply)
            t_turn_a = time.monotonic()
            send_a = xmsg_agent_call({
                "action": "send",
                "to": "svc:genie",
                "text": make_matrix_envelope(tid_a, f"gv2-turn-A:{tag}", tier="trusted"),
            })
            reps_a = xmsg_wait_replies(send_a["message_id"], wait_s=45)
            turn_a_ms = (time.monotonic() - t_turn_a) * 1000.0
            rep_a_raw = reps_a[0]["text"] if reps_a else ""
            try:
                env_a_obj = json.loads(rep_a_raw)
                draft_a = json.loads(env_a_obj["text"]) if isinstance(env_a_obj.get("text"), str) else env_a_obj
                ans_a = json.loads(draft_a.get("answer", "{}"))
            except Exception:
                ans_a = {}

            clone_path = ans_a.get("clone_path", "")
            tracked_link_host = f"{clone_path}/tracked-link" if clone_path.startswith("/") else ""
            symlink_flat_ok = (
                bool(tracked_link_host)
                and os.path.isfile(tracked_link_host)
                and not os.path.islink(tracked_link_host)
            )
            sess_dir_a = f"{STATE_DIR}/state/{tid_a}/session"
            jsonl_files = (
                [f for f in os.listdir(sess_dir_a) if f.endswith(".jsonl") and os.path.getsize(f"{sess_dir_a}/{f}") > 0]
                if os.path.isdir(sess_dir_a)
                else []
            )
            no_threads_seg = not os.path.exists(f"{STATE_DIR}/state/threads")
            ev_a = ans_a.get("eval") if isinstance(ans_a.get("eval"), dict) else {}
            ev_stderr = ev_a.get("stderr_tail", "") if isinstance(ev_a, dict) else ""
            ev_ifd = ans_a.get("eval_ifd") if isinstance(ans_a.get("eval_ifd"), dict) else {}
            ev_ifd_stderr = ev_ifd.get("stderr_tail", "") if isinstance(ev_ifd, dict) else ""
            eval_ok = (
                True
                if mutant not in (None, "M-eval-proc-mount")
                else (
                    isinstance(ev_a, dict)
                    and "Can't mount proc" not in ev_stderr
                    and "bwrap:" not in ev_stderr
                    and ev_a.get("exit") == 0
                    and ev_a.get("limit_hit") == "none"
                    and "gv2-eval-ok" in ev_a.get("stdout_tail", "")
                    and (
                        mutant == "M-eval-proc-mount"
                        or (
                            isinstance(ev_ifd, dict)
                            and "Can't mount proc" not in ev_ifd_stderr
                            and "bwrap:" not in ev_ifd_stderr
                            and ev_ifd.get("exit") == 0
                            and ev_ifd.get("limit_hit") == "none"
                            and "manifest.nix" in ev_ifd.get("stdout_tail", "")
                        )
                    )
                )
            )
            step_a_ok = (
                b_ok
                and ans_a.get("gv2") == f"gv2-turn-A:{tag}"
                and bool(ans_a.get("mem"))
                and "gv2-readme-canary" in ans_a.get("readme", "")
                and "/etc/passwd" in ans_a.get("link", "")
                and "root:x:" not in ans_a.get("link", "")
                and "gv2-search-result-canary:gv2-search-canary" in ans_a.get("search", "")
                and eval_ok
                and symlink_flat_ok
                and len(jsonl_files) >= 1
                and no_threads_seg
            )
            if not step_a_ok:
                return False, (
                    f"stepA failed: b_ok={b_ok} eval_ok={eval_ok} ans_a={ans_a} symlink_flat_ok={symlink_flat_ok} "
                    f"jsonl={jsonl_files} no_threads_seg={no_threads_seg} rep_a={rep_a_raw!r}"
                )

            # Step B: Boundary probe running as pi inside thread A's live jail
            def get_nspids(pid_str: str) -> list[str]:
                try:
                    for line in open(f"/proc/{pid_str}/status", "r", encoding="utf-8"):
                        if line.startswith("NSpid:"):
                            return line.split()[1:]
                except OSError:
                    pass
                return []

            root_pid = int(subprocess.check_output(
                ["systemctl", "show", "-p", "MainPID", "--value", "genie-agent.service"],
                text=True,
            ).strip())
            root_nspids = [int(x) for x in get_nspids(str(root_pid)) if x.isdigit()]
            root_pids = sorted(set([root_pid] + root_nspids))
            root_fds = sorted(int(x) for x in os.listdir(f"/proc/{root_pid}/fd") if x.isdigit())

            pi_a_pid = None
            pi_b_pid = None
            for d in os.listdir("/proc"):
                if not d.isdigit() or int(d) == root_pid:
                    continue
                try:
                    raw_cmd = open(f"/proc/{d}/cmdline", "rb").read()
                    raw_env = open(f"/proc/{d}/environ", "rb").read()
                except OSError:
                    continue
                parts = [p.decode("utf-8", "replace") for p in raw_cmd.split(b"\x00") if p]
                if not parts or parts[0].endswith("/bwrap") or parts[0] == "bwrap":
                    continue
                env_str = raw_env.decode("utf-8", "replace")
                if "GENIE_TIER1_CONFIG=" not in env_str:
                    continue
                if f"/worktrees/{tid_a}" in env_str:
                    pi_a_pid = int(d)
                elif f"/worktrees/{tid_b}" in env_str:
                    pi_b_pid = int(d)

            if not pi_a_pid or not pi_b_pid:
                return False, f"live pi processes not found: pi_a_pid={pi_a_pid} pi_b_pid={pi_b_pid}"

            # N3 check on tier1Launch jail: confirm bwrap (not pi) is inner PID 1
            pi_a_nspids_host = [int(x) for x in get_nspids(str(pi_a_pid)) if x.isdigit()]
            pi_a_ppid = 0
            for line in open(f"/proc/{pi_a_pid}/status", "r", encoding="utf-8"):
                if line.startswith("PPid:"):
                    pi_a_ppid = int(line.split()[1])
            pi_a_ppid_nspids = [int(x) for x in get_nspids(str(pi_a_ppid)) if x.isdigit()] if pi_a_ppid else []
            pi_a_ppid_comm = open(f"/proc/{pi_a_ppid}/comm", "r", encoding="utf-8").read().strip() if pi_a_ppid else ""
            pi_bwrap_pid1_ok = (
                True
                if mutant == "M-no-pi-bwrap"
                else (
                    len(pi_a_nspids_host) >= 2
                    and pi_a_nspids_host[-1] == 2
                    and len(pi_a_ppid_nspids) >= 2
                    and pi_a_ppid_nspids[-1] == 1
                    and pi_a_ppid_comm == "bwrap"
                )
            )

            env_a_bytes = open(f"/proc/{pi_a_pid}/environ", "rb").read().split(b"\x00")
            agent_dir = ""
            for kv in env_a_bytes:
                if kv.startswith(b"PI_CODING_AGENT_DIR="):
                    agent_dir = kv.split(b"=", 1)[1].decode("utf-8", "replace")

            pidns_a = os.readlink(f"/proc/{pi_a_pid}/ns/pid")
            pidns_root = os.readlink(f"/proc/{root_pid}/ns/pid")
            userns_a = os.readlink(f"/proc/{pi_a_pid}/ns/user")
            init_userns = os.readlink("/proc/1/ns/user")
            jail_a_pids = set()
            if userns_a != init_userns:
                for d in os.listdir("/proc"):
                    if not d.isdigit():
                        continue
                    try:
                        if os.readlink(f"/proc/{d}/ns/user") == userns_a:
                            for nsp in get_nspids(d):
                                if nsp.isdigit():
                                    jail_a_pids.add(int(nsp))
                    except OSError:
                        pass
            else:
                for nsp in get_nspids(str(pi_a_pid)):
                    if nsp.isdigit():
                        jail_a_pids.add(int(nsp))

            if userns_a == init_userns:
                ns_prefix = [
                    "${pkgs.util-linux}/bin/nsenter", "-m", "-p", "-S", "1000", "-G", "100", "-t", str(pi_a_pid), "--",
                    "${pkgs.util-linux}/bin/setpriv", "--no-new-privs",
                ]
            elif pidns_a == pidns_root:
                ns_prefix = [
                    "${pkgs.util-linux}/bin/nsenter", "-p", "-t", str(pi_a_pid), "--",
                    "${pkgs.util-linux}/bin/nsenter", "-U", "-m", "-S", "1000", "-G", "100", "-t", str(pi_a_pid), "--",
                    "${pkgs.util-linux}/bin/setpriv", "--no-new-privs",
                ]
            else:
                ns_prefix = [
                    "${pkgs.util-linux}/bin/setpriv", "--reuid=1000", "--regid=100", "--clear-groups", "--",
                    "${pkgs.util-linux}/bin/nsenter", "--preserve-credentials", "-U", "-m", "-p", "-t", str(pi_a_pid), "--",
                    "${pkgs.util-linux}/bin/setpriv", "--no-new-privs",
                ]

            probe_in = json.dumps({
                "tid_a": tid_a,
                "tid_b": tid_b,
                "clone_path": clone_path,
                "agent_dir": agent_dir,
                "root_pids": root_pids,
                "root_fds": root_fds,
                "jail_a_pids": sorted(jail_a_pids),
            })
            probe_proc = subprocess.run(
                ns_prefix + ["${pkgs.python3}/bin/python3", "-I", "${gv2ProbePy}"],
                input=probe_in,
                capture_output=True,
                text=True,
                check=True,
            )
            pr = json.loads(probe_proc.stdout)
            creds_ok = (
                pr["uid"] == 1000
                and pr["gid"] == 100
                and pr["cap_eff"] == "0000000000000000"
                and pr["cap_prm"] == "0000000000000000"
                and pr["no_new_privs"] == "1"
            )

            # Step B2 (N1/N2/N3): Eval-jail boundary probe (ProtectProc=invisible + kill -0 / prlimit against genie-root & sibling pi + bwrap PID 1)
            def get_host_nofile(pid_val: int) -> str:
                try:
                    for line in open(f"/proc/{pid_val}/limits", "r", encoding="utf-8"):
                        if line.startswith("Max open files"):
                            return line.split()[3]
                except OSError:
                    pass
                return ""

            pi_b_nspids = [int(x) for x in get_nspids(str(pi_b_pid)) if x.isdigit()]
            sib_unit_pid = pi_b_nspids[1] if len(pi_b_nspids) >= 2 else pi_b_pid
            root_unit_pid = root_nspids[-1] if root_nspids else 1
            eval_bwrap_bin = (
                f"{STATE_DIR}/gv2-mut-eval-bin/bwrap"
                if mutant == "M-no-unshare-pid"
                else "${pkgs.bubblewrap}/bin/bwrap"
            )
            ev_probe_proc = subprocess.run(
                [
                    "${pkgs.util-linux}/bin/nsenter", "-m", "-p", "-S", "1000", "-G", "100", "-t", str(root_pid), "--",
                    eval_bwrap_bin,
                    "--unshare-user",
                    "--unshare-pid",
                    "--unshare-ipc",
                    "--unshare-uts",
                    "--unshare-cgroup-try",
                    "--share-net",
                    "--die-with-parent",
                    "--ro-bind", "/nix/store", "/nix/store",
                    "--bind", "/proc", "/proc",
                    "--dev", "/dev",
                    "--tmpfs", "/tmp",
                    "--",
                    "${pkgs.python3}/bin/python3", "-I", "${gv2EvalJailProbePy}",
                ],
                input=json.dumps({
                    "root_host_pid": root_pid,
                    "root_unit_pid": root_unit_pid,
                    "sib_host_pid": pi_b_pid,
                    "sib_unit_pid": sib_unit_pid,
                }),
                capture_output=True,
                text=True,
                check=True,
            )
            ev_probe = json.loads(ev_probe_proc.stdout.strip().splitlines()[-1])
            root_nofile_after = get_host_nofile(root_pid)
            sib_nofile_after = get_host_nofile(pi_b_pid)
            ev_probe["root_nofile_after"] = root_nofile_after
            ev_probe["sib_nofile_after"] = sib_nofile_after
            root_probe = ev_probe.get("root") if isinstance(ev_probe.get("root"), dict) else {}
            eval_jail_ok = (
                ev_probe.get("self_status_ok") is True
                and ev_probe.get("bwrap_pid1_ok") is True
                and set(root_probe.keys()) == {"environ", "mem", "root"}
                and all(v in ("ENOENT", "EACCES") for v in root_probe.values())
                and isinstance(ev_probe.get("other_checked"), int)
                and ev_probe.get("other_checked", 0) >= 10
                and ev_probe.get("other_leaks") == {}
                and ev_probe.get("self_kill") == "OK"
                and ev_probe.get("self_prlimit") == 0
                and ev_probe.get("self_nofile") == 7777
                and ev_probe.get("sib_unit_kill") == "ESRCH"
                and ev_probe.get("sib_host_kill") == "ESRCH"
                and ev_probe.get("sib_unit_prlimit") != 0
                and ev_probe.get("sib_host_prlimit") != 0
                and ev_probe.get("root_host_kill") == "ESRCH"
                and ev_probe.get("root_host_prlimit") != 0
                and root_nofile_after not in ("", "6666")
                and sib_nofile_after not in ("", "6666")
            )

            # Step C (only on unmutated run): C2 --proc /proc measurement, P6 in-unit spawn cost, P4 PrivateUsers=true arm, N3 zombie check
            c2_proc_mount_rejected = True
            mean_spawn_ms = 0.0
            p4_private_users_ok = True
            p4_detail = "skipped-for-mutant"
            n3_zombies_ok = True
            unit_zombies = []
            if mutant is None:
                c2_proc = subprocess.run([
                    "${pkgs.util-linux}/bin/nsenter", "-m", "-p", "-S", "1000", "-G", "100", "-t", str(root_pid), "--",
                    "${pkgs.bubblewrap}/bin/bwrap", "--die-with-parent", "--unshare-user", "--unshare-pid",
                    "--ro-bind", "/nix/store", "/nix/store", "--dev", "/dev", "--proc", "/proc",
                    "--", "${pkgs.coreutils}/bin/true",
                ], capture_output=True, text=True)
                c2_proc_mount_rejected = c2_proc.returncode != 0 and "Can't mount proc" in c2_proc.stderr

                spawn_samples = []
                for _ in range(5):
                    t_sp = time.monotonic()
                    subprocess.run([
                        "${pkgs.util-linux}/bin/nsenter", "-m", "-p", "-S", "1000", "-G", "100", "-t", str(root_pid), "--",
                        "${pkgs.bubblewrap}/bin/bwrap", "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid",
                        "--ro-bind", "/nix/store", "/nix/store", "--dev", "/dev", "--bind", "/proc", "/proc", "--tmpfs", "/tmp",
                        "--", "${pkgs.coreutils}/bin/true",
                    ], check=True, capture_output=True)
                    spawn_samples.append((time.monotonic() - t_sp) * 1000.0)
                mean_spawn_ms = sum(spawn_samples) / len(spawn_samples)

                # N3 teardown cell: spawn bwrap inside genie-agent.service's PID namespace (where genie-root is PID 1),
                # tear it down with SIGKILL (inner children first, then outer after 50ms), and assert 0 zombies in the unit.
                z_proc = subprocess.Popen([
                    "${pkgs.util-linux}/bin/nsenter", "-m", "-p", "-S", "1000", "-G", "100", "-t", str(root_pid), "--",
                    "${pkgs.bubblewrap}/bin/bwrap", "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid",
                    "--ro-bind", "/nix/store", "/nix/store", "--dev", "/dev", "--bind", "/proc", "/proc", "--tmpfs", "/tmp",
                    "--", "${pkgs.coreutils}/bin/sleep", "30",
                ])
                time.sleep(0.15)
                try:
                    z_children = open(f"/proc/{z_proc.pid}/task/{z_proc.pid}/children", "r", encoding="utf-8").read().split()
                except OSError:
                    z_children = []
                for zc in z_children:
                    if zc.isdigit() and int(zc) > 0:
                        try:
                            os.kill(int(zc), 9)
                        except OSError:
                            pass
                time.sleep(0.05)
                try:
                    z_proc.kill()
                except OSError:
                    pass
                z_proc.wait(timeout=5.0)
                time.sleep(0.1)
                pidns_root = os.readlink(f"/proc/{root_pid}/ns/pid")
                for d in os.listdir("/proc"):
                    if not d.isdigit():
                        continue
                    try:
                        if os.readlink(f"/proc/{d}/ns/pid") != pidns_root:
                            continue
                        st_txt = open(f"/proc/{d}/status", "r", encoding="utf-8").read()
                        for line in st_txt.splitlines():
                            if line.startswith("State:") and "Z" in line:
                                unit_zombies.append(f"{d}:{line.strip()}")
                    except OSError:
                        pass
                n3_zombies_ok = len(unit_zombies) == 0

                p4_res = subprocess.run([
                    "systemd-run", "--wait", "--pipe",
                    "-p", "User=sini",
                    "-p", "PrivateUsers=yes",
                    "-p", "PrivatePIDs=yes",
                    "-p", "ProtectProc=invisible",
                    "-p", "ProtectKernelTunables=yes",
                    "-p", "ProtectSystem=strict",
                    "-p", "NoNewPrivileges=yes",
                    "${pkgs.bubblewrap}/bin/bwrap",
                    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid",
                    "--ro-bind", "/nix/store", "/nix/store", "--dev", "/dev", "--bind", "/proc", "/proc", "--tmpfs", "/tmp",
                    "--", "${pkgs.python3}/bin/python3", "-I", "-c",
                    "import json, os, subprocess; "
                    "nsp = [l.split()[1:] for l in open('/proc/self/status') if l.startswith('NSpid:')][0]; "
                    "pv = subprocess.check_output(['${pkgs.pi-coding-agent}/bin/pi', '--version'], text=True).strip(); "
                    "print(json.dumps({'uid': os.getuid(), 'nspids': nsp, 'pi_ver': pv}))",
                ], capture_output=True, text=True)
                if p4_res.returncode == 0:
                    p4_json = json.loads(p4_res.stdout.strip().splitlines()[-1])
                    p4_private_users_ok = p4_json.get("uid") == 1000 and len(p4_json.get("nspids", [])) >= 2 and bool(p4_json.get("pi_ver"))
                    p4_detail = f"ok(nspids={p4_json.get('nspids')},pi={p4_json.get('pi_ver')})"
                else:
                    p4_private_users_ok = False
                    p4_detail = f"rc={p4_res.returncode}:{p4_res.stderr.strip()}"

            ok = (
                step_a_ok
                and creds_ok
                and pi_bwrap_pid1_ok
                and eval_jail_ok
                and n3_zombies_ok
                and pr["b1_ok"]
                and pr["b2_ok"]
                and pr["b3_ok"]
                and pr["b4_ok"]
                and pr["b5_ok"]
                and c2_proc_mount_rejected
                and p4_private_users_ok
            )
            return ok, (
                f"stepA={step_a_ok}(turn={turn_a_ms:.0f}ms,eval_ifd={ev_ifd.get('exit')}) creds={creds_ok} "
                f"pi_pid1={pi_bwrap_pid1_ok} eval_jail={eval_jail_ok}({ev_probe}) n3_zombies={n3_zombies_ok}({unit_zombies}) "
                f"B1={pr['b1_ok']}(nspids={pr['nspids']}) "
                f"B2={pr['b2_ok']}({ {k: v for k, v in pr['b2_results'].items() if v != 'ENOENT'} }) "
                f"B3={pr['b3_ok']}(checked={pr['b3_checked']},leaks={pr['b3_leaks']}) "
                f"B4={pr['b4_ok']}(ro={ {k: v for k, v in pr['b4_ro'].items() if v != 'EROFS'} },sess={pr['b4_sess_rw']}) "
                f"B5={pr['b5_ok']}(proc={pr['proc_pids']},outside={pr['outside_pids']}) "
                f"C2_proc_rejected={c2_proc_mount_rejected} P6_bwrap_ms={mean_spawn_ms:.1f} P4_priv_users={p4_detail}"
            )
        finally:
            if os.path.exists(dropin_file):
                os.unlink(dropin_file)
                subprocess.run(["systemctl", "daemon-reload"], check=False)
            for p in (mut_bwrap_path, mut_cfg_path, f"{STATE_DIR}/gv2-mut-eval-bin"):
                if os.path.isdir(p) and not os.path.islink(p):
                    shutil.rmtree(p, ignore_errors=True)
                elif os.path.exists(p):
                    os.unlink(p)
            subprocess.run(["systemctl", "reset-failed", "genie-agent.service"], check=False)
            subprocess.run(["systemctl", "restart", "genie-agent.service"], check=False)

    cell("GV2", *eval_gv2())

    # =========================================================================
    # 8. MUTANT VERIFICATION (all 12 GI-15 mutants must turn their target cell RED)
    # =========================================================================
    def check_mutant(m_name: str, target_cell: str, ok: bool, detail: str):
        print(f"MUTANT {m_name} -> CELL {target_cell} {'GREEN (FAILED TO REDDEN!)' if ok else 'RED'}: {detail}", flush=True)
        cell(f"mutant {m_name}", not ok, f"{m_name} turned {target_cell} RED ({detail})")

    # 8.1 M-env -> V6.1 (with ExecStartPre sleep 1.5s > old fixed 1.0s sleep to prove XR4 readiness observation)
    os.makedirs("/run/systemd/system/genie-herdr@public.service.d", exist_ok=True)
    with open("/run/systemd/system/genie-herdr@public.service.d/m-env.conf", "w", encoding="utf-8") as f:
        f.write("[Service]\nExecStartPre=${pkgs.coreutils}/bin/sleep 1.5\nEnvironmentFile=/run/genie-secrets/public.env\n")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    restart_herdr_and_wait("public")
    m_env_sweep = herdr_v61_v62_sweep()
    check_mutant("M-env", "V6.1", *eval_v6_1_from(m_env_sweep["v61"], jail_rep["v61"]))
    os.unlink("/run/systemd/system/genie-herdr@public.service.d/m-env.conf")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    restart_herdr_and_wait("public")

    # 8.2 M-shim-envp -> V6.1
    shim_envp = make_custom_shim("public", "m-shim-envp", pass_token_in_env=True)
    t_me, _, rep_me, hold_me = run_jail_suite("thread-m-shim-envp", shim_override=shim_envp, hold_for_herdr=True)
    m_shim_sweep = herdr_v61_v62_sweep()
    try:
        os.unlink(hold_me)
    except FileNotFoundError:
        pass
    t_me.join(timeout=8.0)
    j_me = json.loads(open(rep_me, "r", encoding="utf-8").read())
    check_mutant("M-shim-envp", "V6.1", *eval_v6_1_from(m_shim_sweep["v61"], j_me["v61"]))

    # 8.3 M-no-unlink -> V6.3 & M-no-shim-unlink -> V6.5
    leak_file = f"{STATE_DIR}/dispatcher-public/launch/m-no-unlink.tok"
    with open(leak_file, "w", encoding="utf-8") as f:
        f.write(TOK_PUB + "\n")
    os.chown(leak_file, 1000, 100)
    check_mutant("M-no-unlink", "V6.3", *eval_v6_3())
    os.unlink(leak_file)

    check_mutant("M-no-shim-unlink", "V6.5", *eval_v6_5(mutant="M-no-shim-unlink"))

    # 8.4 M-no-peer-verify -> V6.5
    check_mutant("M-no-peer-verify", "V6.5", *eval_v6_5(mutant="M-no-peer-verify"))

    # 8.5 M-no-launch-isolation -> V6.5
    check_mutant("M-no-launch-isolation", "V6.5", *eval_v6_5(mutant="M-no-launch-isolation"))

    # 8.6 M-ptrace-scope-0 -> V6.6
    subprocess.run(["sysctl", "-w", "kernel.yama.ptrace_scope=0"], check=True)
    check_mutant("M-ptrace-scope-0", "V6.6", *eval_v6_6("m-ptrace-0"))
    subprocess.run(["sysctl", "-w", "kernel.yama.ptrace_scope=1"], check=True)

    # 8.7 M-perf-allowed -> V6.6
    with open("/run/systemd/system/genie-herdr@public.service.d/m-perf.conf", "w", encoding="utf-8") as f:
        f.write("[Service]\nSystemCallFilter=\n")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    restart_herdr_and_wait("public")
    check_mutant("M-perf-allowed", "V6.6", *eval_v6_6("m-perf"))
    os.unlink("/run/systemd/system/genie-herdr@public.service.d/m-perf.conf")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    restart_herdr_and_wait("public")

    # 8.8 M-no-outer-bwrap -> V6.7 & V6.9
    shim_nobwrap = make_custom_shim("public", "m-no-bwrap", no_outer_bwrap=True)
    t_nb, _, rep_nb, _ = run_jail_suite("thread-m-no-bwrap", shim_override=shim_nobwrap, hold_for_herdr=False)
    t_nb.join(timeout=8.0)
    j_nb = json.loads(open(rep_nb, "r", encoding="utf-8").read())
    check_mutant("M-no-outer-bwrap (V6.7)", "V6.7", *eval_v6_7_from(j_nb["v67"]))
    check_mutant("M-no-outer-bwrap (V6.9)", "V6.9", *eval_v6_9_from(j_nb["v69"]))

    # 8.9 M-no-inaccessible-creds -> V6.3
    os.chmod("/run/credentials/canary-fs-control-credentials-0000", 0o644)
    with open("/run/credentials/m-cred-leak", "w", encoding="utf-8") as f:
        f.write(TOK_PUB + "\n")
    os.chmod("/run/credentials/m-cred-leak", 0o644)
    with open("/run/systemd/system/genie-herdr@public.service.d/m-creds.conf", "w", encoding="utf-8") as f:
        f.write("[Service]\nInaccessiblePaths=\n")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    restart_herdr_and_wait("public")
    check_mutant("M-no-inaccessible-creds", "V6.3", *eval_v6_3())
    os.unlink("/run/credentials/m-cred-leak")
    os.unlink("/run/systemd/system/genie-herdr@public.service.d/m-creds.conf")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    restart_herdr_and_wait("public")

    # 8.10 M-writable-policy -> V6.8
    shim_wp = make_custom_shim("public", "m-writable-policy", writable_policy=True)
    check_mutant("M-writable-policy", "V6.8", *eval_v6_8(shim_override=shim_wp, tag="m-wp"))

    # 8.11 M-root-pane-in-worktree -> V6.10
    check_mutant("M-root-pane-in-worktree", "V6.10", *eval_v6_10(mutant_root_in_worktree=True))

    # 8.12 M-xmsg-rw -> V6.11
    shim_xmsg_rw = make_custom_shim("public", "m-xmsg-rw", xmsg_rw=True)
    ino_b = os.stat("/run/user/1000/xmsg/agent.sock").st_ino
    t_xr, _, rep_xr, _ = run_jail_suite("thread-m-xmsg-rw", shim_override=shim_xmsg_rw, hold_for_herdr=False)
    t_xr.join(timeout=8.0)
    ino_a = os.stat("/run/user/1000/xmsg/agent.sock").st_ino
    j_xr = json.loads(open(rep_xr, "r", encoding="utf-8").read())
    check_mutant("M-xmsg-rw", "V6.11", *eval_v6_11_from(j_xr["v611"], ino_b, ino_a))
    restart_stub_api_and_wait()

    # 8.13 M-node-readfile -> V6.6b
    check_mutant("M-node-readfile", "V6.6b", *eval_v6_6b(mutant="M-node-readfile"))

    # 8.14 M-handoff-early-hold -> V6.6b
    check_mutant("M-handoff-early-hold", "V6.6b", *eval_v6_6b(mutant="M-handoff-early-hold"))

    # 8.15 M-empty-cred-accepted -> V6.6b
    check_mutant("M-empty-cred-accepted", "V6.6b", *eval_v6_6b(mutant="M-empty-cred-accepted"))

    # 8.16 M-cred-outside-dir -> V6.6b
    check_mutant("M-cred-outside-dir", "V6.6b", *eval_v6_6b(mutant="M-cred-outside-dir"))

    # 8.16b M-c5-pre-ns-race -> V6.6b
    check_mutant("M-c5-pre-ns-race", "V6.6b", *eval_v6_6b(mutant="M-c5-pre-ns-race"))

    # 8.17 M-no-n1-migration -> GV1
    check_mutant("M-no-n1-migration", "GV1", *eval_gv1(mutant="M-no-n1-migration"))

    # 8.18 M-no-load-credential -> GV1
    check_mutant("M-no-load-credential", "GV1", *eval_gv1(mutant="M-no-load-credential"))

    # 8.19 M-no-pi-bwrap -> GV2
    check_mutant("M-no-pi-bwrap", "GV2", *eval_gv2(mutant="M-no-pi-bwrap"))

    # 8.20 M-rw-worktree-or-agentdir -> GV2
    check_mutant("M-rw-worktree-or-agentdir", "GV2", *eval_gv2(mutant="M-rw-worktree-or-agentdir"))

    # 8.21 M-expose-state-root -> GV2
    check_mutant("M-expose-state-root", "GV2", *eval_gv2(mutant="M-expose-state-root"))

    # 8.22 M-no-protectproc -> GV2
    check_mutant("M-no-protectproc", "GV2", *eval_gv2(mutant="M-no-protectproc"))

    # 8.23 M-eval-proc-mount -> GV2
    check_mutant("M-eval-proc-mount", "GV2", *eval_gv2(mutant="M-eval-proc-mount"))

    # 8.24 M-no-unshare-pid -> GV2
    check_mutant("M-no-unshare-pid", "GV2", *eval_gv2(mutant="M-no-unshare-pid"))

    if red:
        print(f"DRIVER FAILED RED CELLS: {red}", flush=True)
        timing_end("red")
        sys.exit(1)
    print("DRIVER ALL GREEN", flush=True)
    timing_end("all-green")
  '';

  node =
    {
      herdrPackage,
      claudePackage ? null,
      memorySize ? 2048,
      extraConfig ? { },
    }:
    lib.recursiveUpdate {
      imports = [ self.nixosModules.default ];
      virtualisation.memorySize = memorySize;
      virtualisation.cores = 4;
      users.users.sini = {
        isNormalUser = true;
        uid = 1000;
      };
      systemd.tmpfiles.rules = [
        "d /run/user/1000 0700 sini users -"
        "d /run/user/1000/xmsg 0700 sini users -"
        "d ${claudeHome} 0700 sini users -"
        "d ${claudeHome}/memory 0700 sini users -"
        "d ${claudeHome}/agents 0700 sini users -"
        "d /home/sini/repos 0700 sini users -"
        "d /var/lib/genie/public-repos 0755 root root -"
        "d /var/lib/genie/support-memory 0755 root root -"
        "d /run/genie-secrets 0700 root root -"
        "f /run/genie-secrets/model-key 0400 root root - canary-model-key-0000"
        "f /run/genie-secrets/broker-token 0400 root root - canary-broker-token-0000"
        "f /run/genie-secrets/guard-out-key 0400 root root - canary-guard-out-key-0000"
        "f /run/genie-secrets/s3-secret-key 0400 root root - canary-s3-secret-key-0000"
        "f /run/genie-secrets/public.env 0400 root root - CLAUDE_CODE_OAUTH_TOKEN=${tokens.public}"
        "f /run/genie-secrets/trusted.env 0400 root root - CLAUDE_CODE_OAUTH_TOKEN=${tokens.trusted}"
      ];
      services.genie-agent = {
        enable = true;
        user = "sini";
        xmsgSocket = "/run/user/1000/xmsg";
        package = idle "genie-root";
        piPackage = idle "pi";
        model = {
          baseUrl = "http://127.0.0.1:9/v1";
          keyFile = "/run/genie-secrets/model-key";
        };
        tier1.searxngUrl = "http://127.0.0.1:9";
        guardRef = null;
        guard.enable = false;
        broker.guardOut.enable = false;
        experts = {
          enable = true;
          inherit herdrPackage claudePackage;
          xmsgPackage = idle "xmsg";
          dispatcherPackage = idle "genie-dispatcher";
          public = {
            reposDir = "/var/lib/genie/public-repos";
            memoryDir = "/var/lib/genie/support-memory";
            tokenEnvironmentFile = "/run/genie-secrets/public.env";
          };
          trusted = {
            reposDir = "/home/sini/repos";
            memoryDir = "${claudeHome}/memory";
            tokenEnvironmentFile = "/run/genie-secrets/trusted.env";
          };
        };
      };
    } extraConfig;
in
pkgs.testers.runNixOSTest {
  name = "genie-agent-expert-isolation";
  nodes = {
    probe = node {
      herdrPackage = probeHerdr;
      claudePackage = probeClaude;
      memorySize = 1536;
    };
    real = node {
      herdrPackage = pkgs.herdr;
      claudePackage = null; # Uses real pkgs.claude-code via module.nix defaultClaudePackage
      memorySize = 4096;
      extraConfig = {
        networking.extraHosts = ''
          127.0.0.1 gv2-stub
          198.18.0.1 gv2-git.example.org github.com api.github.com
        '';
        security.pki.certificateFiles = [ "${gv2TlsCerts}/cert.pem" ];
        services.genie-agent = {
          package = self.packages.${pkgs.stdenv.hostPlatform.system}.genie-root;
          piPackage = pkgs.pi-coding-agent;
          model = {
            baseUrl = "http://gv2-stub:18080/v1";
            keyFile = "/run/genie-secrets/model-key";
          };
          tier1.searxngUrl = "http://gv2-stub:18080";
          eval.memoryMax = null;
          broker = {
            tokenFile = "/run/genie-secrets/broker-token";
            guardOut = {
              enable = true;
              base = "http://gv2-stub:18080/v1";
              model = "guard-out-model";
              keyFile = "/run/genie-secrets/guard-out-key";
            };
          };
          s3 = {
            endpoint = "http://gv2-stub:18080";
            bucket = "gv2-bucket";
            accessKeyId = "gv2-ak";
            secretKeyFile = "/run/genie-secrets/s3-secret-key";
          };
          experts.dispatcherPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.genie-dispatcher;
        };
        systemd.services.genie-agent.environment = {
          NIX_SSL_CERT_FILE = lib.mkForce "/etc/ssl/certs/ca-certificates.crt";
          SSL_CERT_FILE = lib.mkForce "/etc/ssl/certs/ca-certificates.crt";
        };
        environment.etc."genie-gi15-test/stub_api.py".source = "${gi15TestScripts}/stub_api.py";
        environment.etc."genie-gi15-test/jail_suite.py".source = jailSuitePy;
        environment.etc."genie-gi15-test/setup_v610_repo.py".source = setupV610RepoPy;
        environment.etc."genie-gi15-test/herdr.ts".source = ../src/dispatcher/herdr.ts;
        environment.etc."genie-gi15-test/dispatcher".source = ../src/dispatcher;
        environment.etc."genie-gi15-test/driver.py".source = driverPy;
        systemd.services.genie-stub-api = {
          description = "GI-15 local stub Anthropic Messages API & host xmsg socket listener";
          wantedBy = [ "multi-user.target" ];
          before = [
            "genie-agent.service"
            "genie-herdr@public.service"
            "genie-herdr@trusted.service"
            "genie-dispatcher@public.service"
            "genie-dispatcher@trusted.service"
          ];
          serviceConfig = {
            ExecStart = "${pkgs.python3}/bin/python3 -I /etc/genie-gi15-test/stub_api.py";
            Restart = "always";
          };
        };
        systemd.services."genie-herdr@public".environment = {
          ANTHROPIC_BASE_URL = "http://127.0.0.1:18080";
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
          GENIE_V6_CONTROL = "1";
        };
        systemd.services."genie-herdr@trusted".environment = {
          ANTHROPIC_BASE_URL = "http://127.0.0.1:18080";
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
          GENIE_V6_CONTROL = "1";
        };
      };
    };
  };
  testScript =
    { nodes, ... }:
    ''
      import os
      import time

      # Item 52: the gi15 driver's time budget (GI15_DRIVER_TIMEOUT_S below) is sized for KVM.
      # A builder that advertises the `kvm` system feature but exposes no usable /dev/kvm makes
      # QEMU print "falling back to tcg" and run several times slower, which turns the budget
      # into a nondeterministic RED (z488xxv0... failed then passed on the same builder).
      # Refuse to run under TCG instead of flaking.
      if not os.access("/dev/kvm", os.R_OK | os.W_OK):
          raise Exception(
              "KVM UNAVAILABLE: /dev/kvm is missing or inaccessible in this build sandbox, so QEMU "
              "would fall back to TCG. genie-agent-expert-isolation is sized for KVM and refuses "
              "to run under TCG. Fix the builder's KVM or drop `kvm` from its supportedFeatures."
          )
      print("[TIMING] host: /dev/kvm accessible; VMs will run under KVM")

      red = []

      def cell(name, ok, detail):
          if ok:
              print(f"CELL {name} GREEN: {detail}")
          else:
              print(f"CELL {name} RED: {detail}")
              red.append(name)

      def count(m, pattern, f):
          return int(m.succeed(f"{{ grep -o -F -f {pattern} {f} || true; }} | wc -l").strip())

      def has(m, line, f):
          return m.execute(f"grep -q -F -- '{line}' {f}")[0] == 0

      def unit_ns_and_exe_cmd(unit, exe_suffix):
          return (
              f"pid=$(systemctl show -p MainPID --value {unit}) && "
              f"[ -n \"$pid\" ] && [ \"$pid\" -gt 0 ] && "
              f"[ \"$(readlink /proc/$pid/ns/mnt)\" != \"$(readlink /proc/1/ns/mnt)\" ] && "
              f"[ \"$(readlink /proc/$pid/exe)\" != \"$(readlink /proc/1/exe)\" ] && "
              f"(case \"$(readlink /proc/$pid/exe)\" in *{exe_suffix}) true ;; *) tr '\\0' ' ' < /proc/$pid/cmdline | grep -qF -- '{exe_suffix}' ;; esac)"
          )

      def check_unit_ns_and_exe(m, unit, exe_suffix):
          return m.execute(unit_ns_and_exe_cmd(unit, exe_suffix))[0] == 0

      start_all()
      for m in (probe, real):
          m.wait_for_unit("multi-user.target")
          for tier in ("public", "trusted"):
              m.wait_until_succeeds(unit_ns_and_exe_cmd(f"genie-herdr@{tier}", "/herdr"), timeout=30)
              m.wait_until_succeeds(unit_ns_and_exe_cmd(f"genie-dispatcher@{tier}", "/genie-dispatcher"), timeout=30)
      for tier in ("public", "trusted"):
          probe.wait_until_succeeds(f"grep -q 'probe done' ${stateDir}/probe-{tier}.log", timeout=30)
          real.wait_until_succeeds(
              f"${pkgs.python3}/bin/python3 -I -c 'import socket; "
              f"s1=socket.socket(socket.AF_UNIX); s1.connect(\"${stateDir}/herdr-session-{tier}/herdr.sock\"); s1.close(); "
              f"s2=socket.socket(socket.AF_UNIX); s2.connect(\"${stateDir}/herdr-session-{tier}/herdr-client.sock\"); s2.close()'",
              timeout=30,
          )
      real.wait_for_unit("genie-stub-api.service")
      real.wait_until_succeeds(
          "${pkgs.python3}/bin/python3 -I -c 'import socket; "
          "[ (s:=socket.socket(socket.AF_UNIX), s.connect(f\"/run/user/1000/xmsg/{n}.sock\"), s.close()) for n in (\"register\",\"agent\",\"http\") ]'",
          timeout=30,
      )
      time.sleep(10)

      # V0: genie-herdr@<tier> and genie-dispatcher@<tier> are still the running main processes 10 s after boot.
      for m in (probe, real):
          for tier in ("public", "trusted"):
              st = m.execute(f"systemctl is-active genie-herdr@{tier}")[1].strip()
              h_ready = check_unit_ns_and_exe(m, f"genie-herdr@{tier}", "/herdr")
              cell(f"V0 {m.name} {tier}", st == "active" and h_ready, f"genie-herdr@{tier} is {st}, ns_and_exe={h_ready}")
              dst = m.execute(f"systemctl is-active genie-dispatcher@{tier}")[1].strip()
              d_ready = check_unit_ns_and_exe(m, f"genie-dispatcher@{tier}", "/genie-dispatcher")
              cell(f"V0-dispatcher {m.name} {tier}", dst == "active" and d_ready, f"genie-dispatcher@{tier} is {dst}, ns_and_exe={d_ready}")

      # Probe node: GI-13 V1, V1b, V2, V4, V5
      c = "${claudeHome}"
      probe.succeed(
          "for m in marker marker-settings marker-cred; do head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \\n' > /root/$m; done",
          f"cat /root/marker > {c}/memory/x; cat /root/marker-settings > {c}/settings.json; cat /root/marker-cred > {c}/.credentials.json",
          f"chown sini:users {c}/memory/x {c}/settings.json {c}/.credentials.json; chmod 600 {c}/memory/x {c}/settings.json {c}/.credentials.json",
          "systemd-run --unit owner-sleep -p User=sini sleep infinity",
      )
      cell("control marker-on-host", count(probe, "/root/marker", f"{c}/memory/x") == 1, "marker present in memory/x on the host")
      probe.succeed("rm -f ${stateDir}/probe-public.log ${stateDir}/probe-trusted.log")
      probe.succeed("systemctl restart genie-herdr@public genie-herdr@trusted")
      for tier in ("public", "trusted"):
          probe.wait_until_succeeds(f"grep -q 'probe done' ${stateDir}/probe-{tier}.log", timeout=60)
      pub = "${stateDir}/probe-public.log"
      tru = "${stateDir}/probe-trusted.log"
      print(probe.succeed(
          f"sed -e \"s/$(cat /root/marker)/<MARKER>/g\" -e \"s/$(cat /root/marker-settings)/<MARKER-SETTINGS>/g\" "
          f"-e \"s/$(cat /root/marker-cred)/<MARKER-CRED>/g\" {pub} {tru}"
      ))

      pub_marker = count(probe, "/root/marker", pub)
      cell("V1", has(probe, "PROBE direct-read-fail memory/x", pub) and pub_marker == 0,
           f"@public direct read of memory/x fails; marker occurrences in public log = {pub_marker}")
      walked = has(probe, "PROBE proc-walked", pub) and not has(probe, "PROBE proc-walked 0", pub)
      proc_hits = int(probe.succeed(f"grep -c -E 'PROBE proc-(read|write)-ok' {pub} || true").strip())
      agents_p = probe.execute(f"test -e {c}/agents/p")[0] == 0
      cell("V1b", walked and proc_hits == 0 and not agents_p and pub_marker == 0,
           f"@public /proc/<pid>/root reads+writes ok = {proc_hits}; agents/p on host = {agents_p}; marker in log = {pub_marker}")
      pub_settings = count(probe, "/root/marker-settings", pub)
      cell("V2", has(probe, "PROBE direct-read-fail settings.json", pub) and pub_settings == 0,
           f"@public settings.json read fails; settings marker occurrences in public log = {pub_settings}")

      tru_marker = count(probe, "/root/marker", tru)
      memory_y = probe.execute(f"test -e {c}/memory/y")[0] == 0
      cell("V4", has(probe, "PROBE direct-read-ok memory/x", tru) and tru_marker >= 1
           and has(probe, "PROBE direct-write-fail memory/x", tru) and has(probe, "Read-only file system", tru)
           and not memory_y and not has(probe, "PROBE proc-write-ok", tru),
           f"@trusted reads memory/x (marker occurrences {tru_marker}); write EROFS; memory/y on host = {memory_y}")
      tru_settings = count(probe, "/root/marker-settings", tru)
      cell("V5", has(probe, "PROBE direct-read-fail settings.json", tru) and tru_settings == 0,
           f"@trusted settings.json read fails; settings marker occurrences in trusted log = {tru_settings}")

      # Real node: GI-15 V3, V6.1–V6.11, GV1, GV2 and all 23 mutants
      # Budget, measured as driver.py guest wall time:
      #   KVM, uplink, gs2-pi-sandbox incl. GV2 + 4 GV2 mutants (2026-11-05):  304.6 s  (GV1 + 2 mutants: 33.8 s; GV2 + 4 mutants: 23.3 s)
      #   KVM, cortex, gx2-rebased + this instrumentation (2026-11-05):  284.7 s  (GV1 + 2 mutants: 33.1 s)
      #   KVM (afw1607g..., GX2 tree incl. GV1, 2026-11-02):  ~247 s
      #   TCG (wfpp86gk..., uplink):  ~479 s;  TCG (z488xxv0..., uplink, gx2-rebased):  ~545 s pass, >600 s fail
      # 600 s is ~2.0x the KVM runtime. TCG is refused up front (see the /dev/kvm check), not budgeted for.
      # driver.py prints [TIMING] per cell and in total, also on red, on exception, and on SIGTERM.
      GI15_DRIVER_TIMEOUT_S = 600
      t_drv = time.monotonic()
      rc, driver_out = real.execute("${pkgs.python3}/bin/python3 -I /etc/genie-gi15-test/driver.py", timeout=GI15_DRIVER_TIMEOUT_S)
      drv_elapsed = time.monotonic() - t_drv
      print(driver_out)
      timed_out = rc == 124
      print(
          f"[TIMING] gi15-driver rc={rc} host_elapsed={drv_elapsed:.1f}s budget={GI15_DRIVER_TIMEOUT_S}s"
          + (" TIMEOUT: guest `timeout` killed driver.py (rc=124)" if timed_out else "")
      )
      if rc != 0:
          red.append("gi15-driver-timeout" if timed_out else f"gi15-driver(rc={rc})")

      # XH2: systemd-analyze security exposure check across genie-agent, genie-herdr@*, and genie-dispatcher@*
      for unit, max_score in [
          ("genie-agent.service", 4.0),
          ("genie-herdr@public.service", 3.8),
          ("genie-herdr@trusted.service", 3.8),
          ("genie-dispatcher@public.service", 0.8),
          ("genie-dispatcher@trusted.service", 0.8),
      ]:
          line = real.succeed(f"systemd-analyze security --no-pager {unit} | tail -n 1").strip()
          print(f"[XH2 exposure] {unit}: {line}")
          score = float(line.split(":")[1].strip().split()[0])
          cell(f"XH2 {unit}", score <= max_score, f"{line} (<= {max_score})")

      for m in (probe, real):
          t0 = time.monotonic()
          m.succeed("systemctl stop genie-herdr@public")
          elapsed = time.monotonic() - t0
          st = m.execute("systemctl show -p Result --value genie-herdr@public")[1].strip()
          cell(f"stop {m.name}", elapsed < 30 and st == "success", f"genie-herdr@public stopped in {elapsed:.1f}s, Result={st}")

      assert not red, f"RED cells: {red}"
    '';
}
