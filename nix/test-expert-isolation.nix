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
        try:
            for line in maps_lines:
                parts = line.split()
                if len(parts) < 2 or "r" not in parts[1]:
                    continue
                start_s, end_s = parts[0].split("-")
                start, end = int(start_s, 16), int(end_s, 16)
                size = min(end - start, 4 * 1024 * 1024)
                if size <= 0:
                    continue
                try:
                    chunk = os.pread(mem_fd, size, start)
                    hits += chunk.count(needle)
                except OSError:
                    pass
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

  tokens = {
    public = "canary-public-token-0000";
    trusted = "canary-trusted-token-0000";
  };

  gi15TestScripts = pkgs.writeTextDir "stub_api.py" ''
    import http.server, json, os, socket, sys, threading, time

    LOG_PATH = "/tmp/gi15-api-log.jsonl"
    V68_PATH = "/tmp/v68-results.json"
    XMSG_SOCK = "/run/user/1000/xmsg/agent.sock"

    # Set up host xmsg listener at /run/user/1000/xmsg/agent.sock owned by sini:users (1000:100)
    os.makedirs("/run/user/1000/xmsg", mode=0o700, exist_ok=True)
    os.chown("/run/user/1000", 1000, 100)
    os.chown("/run/user/1000/xmsg", 1000, 100)
    try:
        os.unlink(XMSG_SOCK)
    except FileNotFoundError:
        pass
    xmsg_srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    xmsg_srv.bind(XMSG_SOCK)
    os.chown(XMSG_SOCK, 1000, 100)
    os.chmod(XMSG_SOCK, 0o600)
    xmsg_srv.listen(8)

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

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            global v68_step
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

    def cell(name: str, ok: bool, detail: str):
        if ok:
            print(f"CELL {name} GREEN: {detail}", flush=True)
        else:
            print(f"CELL {name} RED: {detail}", flush=True)
            red.append(name)

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

    def get_herdr_pid(tier: str) -> str:
        return subprocess.check_output(
            ["systemctl", "show", "-p", "MainPID", "--value", f"genie-herdr@{tier}"],
            text=True,
        ).strip()

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
        pid = subprocess.check_output(
            ["systemctl", "show", "-p", "MainPID", "--value", f"genie-herdr@{tier}"],
            text=True,
        ).strip()
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
        time.sleep(1.5)
        # Clear any stale workspace session state before starting first thread
        wt_a = f"{STATE_DIR}/dispatcher-public/worktrees/thread-v610"
        shutil.rmtree(wt_a, ignore_errors=True)
        os.makedirs(wt_a, mode=0o700, exist_ok=True)
        os.chown(wt_a, 1000, 100)
        pane_id, srv_res = launch_in_herdr(
            "public",
            "thread-v610",
            ["-n", "genie-v610", "--session-id", str(uuid.uuid4()), "-p", "v610-git"],
            split_cwd_override=(wt_a if mutant_root_in_worktree else None),
            timeout_ms=6000,
        )
        # Wait for real claude to finish planting the repo in wt_a and exit cleanly
        for _ in range(80):
            if os.path.exists(os.path.join(wt_a, ".git", "refs", "remotes", "origin", "main")):
                break
            time.sleep(0.1)
        time.sleep(1.0)

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
        if saved_session_bytes:
            with open(session_json_host, "wb") as f:
                f.write(saved_session_bytes)
            os.chown(session_json_host, 1000, 100)
            os.chmod(session_json_host, 0o600)
        subprocess.run(["systemctl", "start", "genie-herdr@public"], check=True)
        time.sleep(1.0)
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
    time.sleep(1.5)

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
        time.sleep(0.05)

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
        time.sleep(0.05)
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
    # 8. MUTANT VERIFICATION (all 12 GI-15 mutants must turn their target cell RED)
    # =========================================================================
    def check_mutant(m_name: str, target_cell: str, ok: bool, detail: str):
        print(f"MUTANT {m_name} -> CELL {target_cell} {'GREEN (FAILED TO REDDEN!)' if ok else 'RED'}: {detail}", flush=True)
        cell(f"mutant {m_name}", not ok, f"{m_name} turned {target_cell} RED ({detail})")

    # 8.1 M-env -> V6.1
    os.makedirs("/run/systemd/system/genie-herdr@public.service.d", exist_ok=True)
    with open("/run/systemd/system/genie-herdr@public.service.d/m-env.conf", "w", encoding="utf-8") as f:
        f.write("[Service]\nEnvironmentFile=/run/genie-secrets/public.env\n")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "restart", "genie-herdr@public"], check=True)
    time.sleep(1.0)
    m_env_sweep = herdr_v61_v62_sweep()
    check_mutant("M-env", "V6.1", *eval_v6_1_from(m_env_sweep["v61"], jail_rep["v61"]))
    os.unlink("/run/systemd/system/genie-herdr@public.service.d/m-env.conf")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "restart", "genie-herdr@public"], check=True)
    time.sleep(1.0)

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
    subprocess.run(["systemctl", "restart", "genie-herdr@public"], check=True)
    time.sleep(1.0)
    check_mutant("M-perf-allowed", "V6.6", *eval_v6_6("m-perf"))
    os.unlink("/run/systemd/system/genie-herdr@public.service.d/m-perf.conf")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "restart", "genie-herdr@public"], check=True)
    time.sleep(1.0)

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
    subprocess.run(["systemctl", "restart", "genie-herdr@public"], check=True)
    time.sleep(1.0)
    check_mutant("M-no-inaccessible-creds", "V6.3", *eval_v6_3())
    os.unlink("/run/credentials/m-cred-leak")
    os.unlink("/run/systemd/system/genie-herdr@public.service.d/m-creds.conf")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "restart", "genie-herdr@public"], check=True)
    time.sleep(1.0)

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

    if red:
        print(f"DRIVER FAILED RED CELLS: {red}", flush=True)
        sys.exit(1)
    print("DRIVER ALL GREEN", flush=True)
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
        "f /run/genie-secrets/model-key 0400 root root - unused"
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
        environment.etc."genie-gi15-test/stub_api.py".source = "${gi15TestScripts}/stub_api.py";
        environment.etc."genie-gi15-test/jail_suite.py".source = jailSuitePy;
        environment.etc."genie-gi15-test/setup_v610_repo.py".source = setupV610RepoPy;
        environment.etc."genie-gi15-test/driver.py".source = driverPy;
        systemd.services.genie-stub-api = {
          description = "GI-15 local stub Anthropic Messages API & host xmsg socket listener";
          wantedBy = [ "multi-user.target" ];
          before = [
            "genie-herdr@public.service"
            "genie-herdr@trusted.service"
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
      import time

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

      start_all()
      for m in (probe, real):
          m.wait_for_unit("multi-user.target")
      real.wait_for_unit("genie-stub-api.service")
      time.sleep(10)

      # V0: genie-herdr@<tier> and genie-dispatcher@<tier> are still the running main processes 10 s after boot.
      for m in (probe, real):
          for tier in ("public", "trusted"):
              st = m.execute(f"systemctl is-active genie-herdr@{tier}")[1].strip()
              cell(f"V0 {m.name} {tier}", st == "active", f"genie-herdr@{tier} is {st}")
              dst = m.execute(f"systemctl is-active genie-dispatcher@{tier}")[1].strip()
              cell(f"V0-dispatcher {m.name} {tier}", dst == "active", f"genie-dispatcher@{tier} is {dst}")

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

      # Real node: GI-15 V3, V6.1–V6.11 and all 12 mutants
      rc, driver_out = real.execute("${pkgs.python3}/bin/python3 -I /etc/genie-gi15-test/driver.py", timeout=600)
      print(driver_out)
      if rc != 0:
          red.append("gi15-driver")

      for m in (probe, real):
          t0 = time.monotonic()
          m.succeed("systemctl stop genie-herdr@public")
          elapsed = time.monotonic() - t0
          st = m.execute("systemctl show -p Result --value genie-herdr@public")[1].strip()
          cell(f"stop {m.name}", elapsed < 30 and st == "success", f"genie-herdr@public stopped in {elapsed:.1f}s, Result={st}")

      assert not red, f"RED cells: {red}"
    '';
}
