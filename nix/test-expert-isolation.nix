# GI-13 VM oracle: what a tier sandbox can reach of the operator's ~/.claude, and whether the
# tier token reaches claude. Two nodes, both running nixosModules.default in local mode as `sini`:
#   probe: experts.herdrPackage is a probe that records what the genie-herdr@<tier> sandbox can
#          read and write (V0, V1, V1b, V2, V4, V5), then stays up as the unit's main process;
#   real:  the real herdr, with a probe `claude` that records sha256 of its CLAUDE_CODE_OAUTH_TOKEN,
#          driven the way CliHerdr.start drives it (V0, V3).
# Every cell reads a recorded value, never only a unit's success, and the run reports every cell
# before it fails, so one mutant shows which cells it reddens and which stay green.
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

  # A main process that stays up and stops on SIGTERM (it is PID 1 under PrivatePIDs, where a
  # signal with no handler is ignored).
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
      # Satisfy services.genie-agent.experts.herdrPackage's source-built check while remaining a fast probe script.
      src = ./.;
      overrideAttrs = _: probeHerdr;
    };

  probeClaude = pkgs.writeShellScriptBin "claude" ''
    if [ -n "''${CLAUDE_CODE_OAUTH_TOKEN+x}" ]; then
      t=$(printf %s "$CLAUDE_CODE_OAUTH_TOKEN" | ${coreutils}/sha256sum | ${coreutils}/cut -d' ' -f1)
    else
      t=unset
    fi
    printf 'tok=%s\ncfg=%s\n' "$t" "$CLAUDE_CONFIG_DIR" > "$CLAUDE_CONFIG_DIR/probe.tmp"
    ${coreutils}/mv "$CLAUDE_CONFIG_DIR/probe.tmp" "$CLAUDE_CONFIG_DIR/probe"
    exec ${coreutils}/sleep infinity
  '';

  tokens = {
    public = "gi13-public-setup-token";
    trusted = "gi13-trusted-setup-token";
  };

  node =
    { herdrPackage }:
    {
      imports = [ self.nixosModules.default ];
      virtualisation.memorySize = 1536;
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
          inherit herdrPackage;
          claudePackage = probeClaude;
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
    };
in
pkgs.testers.runNixOSTest {
  name = "genie-agent-expert-isolation";
  nodes = {
    probe = node { herdrPackage = probeHerdr; };
    real = node { herdrPackage = pkgs.herdr; };
  };
  testScript = { nodes, ... }: ''
    import shlex
    import time

    red = []

    def cell(name, ok, detail):
        if ok:
            print(f"CELL {name} GREEN: {detail}")
        else:
            print(f"CELL {name} RED: {detail}")
            red.append(name)

    def count(m, pattern, f):
        # Occurrences of a literal pattern; -f reads the pattern from a file so it is never printed.
        return int(m.succeed(f"{{ grep -o -F -f {pattern} {f} || true; }} | wc -l").strip())

    def has(m, line, f):
        return m.execute(f"grep -q -F -- '{line}' {f}")[0] == 0

    start_all()
    for m in (probe, real):
        m.wait_for_unit("multi-user.target")
    time.sleep(10)

    # V0: genie-herdr@<tier> is still the running main process 10 s after boot. Its mutant is
    # setsid restored AND PrivatePIDs dropped: under PrivatePIDs a restored setsid leaves the unit
    # active (measured), and PrivatePIDs has its own oracles (G0, V1b).
    for m in (probe, real):
        for tier in ("public", "trusted"):
            st = m.execute(f"systemctl is-active genie-herdr@{tier}")[1].strip()
            cell(f"V0 {m.name} {tier}", st == "active", f"genie-herdr@{tier} is {st}")

    # Probe node: one per-run marker per file in the operator's ~/.claude, generated in the VM, so a
    # cell about memory/x is not reddened by a read of settings.json.
    c = "${claudeHome}"
    probe.succeed(
        "for m in marker marker-settings marker-cred; do head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \\n' > /root/$m; done",
        f"cat /root/marker > {c}/memory/x; cat /root/marker-settings > {c}/settings.json; cat /root/marker-cred > {c}/.credentials.json",
        f"chown sini:users {c}/memory/x {c}/settings.json {c}/.credentials.json; chmod 600 {c}/memory/x {c}/settings.json {c}/.credentials.json",
        # an operator process outside every unit, in the host mount namespace
        "systemd-run --unit owner-sleep -p User=sini sleep infinity",
    )
    # Positive control, same instrument: the marker is in the host files.
    cell("control marker-on-host", count(probe, "/root/marker", f"{c}/memory/x") == 1, "marker present in memory/x on the host")
    # Drop the boot-time logs first, so the wait below can only see this run's.
    probe.succeed("rm -f ${stateDir}/probe-public.log ${stateDir}/probe-trusted.log")
    probe.succeed("systemctl restart genie-herdr@public genie-herdr@trusted")
    for tier in ("public", "trusted"):
        probe.wait_until_succeeds(f"grep -q 'probe done' ${stateDir}/probe-{tier}.log", timeout=60)
    pub = "${stateDir}/probe-public.log"
    tru = "${stateDir}/probe-trusted.log"
    # The probe logs, with the markers masked (they stay unprinted).
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

    # V3 (arm C): the real herdr, driven as CliHerdr.start drives it.
    herdr_bin = "${lib.getExe nodes.real.services.genie-agent.experts.herdrPackage}"
    disp_unit = real.succeed("systemctl cat genie-dispatcher@public")
    import re
    m_claude = re.search(r"--claude-bin\s+(\S+)", disp_unit)
    claude_cmd_args = f"--command {m_claude.group(1)}" if m_claude else ""
    h = f"setpriv --reuid=1000 --regid=100 --init-groups env HOME=${stateDir} XDG_RUNTIME_DIR=/run/user/1000 {herdr_bin} --session genie-public"
    jq = "${lib.getExe pkgs.jq}"
    base = real.succeed(f"{h} workspace create --cwd ${stateDir}/cwd-public --no-focus | {jq} -r .result.root_pane.pane_id").strip()
    pane = real.succeed(
        f"{h} pane split {base} --direction right --cwd ${stateDir}/cwd-public "
        f"--env CLAUDE_CONFIG_DIR=${stateDir}/claude-public --no-focus | {jq} -r .result.pane.pane_id"
    ).strip()
    # The probe claude records and then sleeps; it never reports ready, so agent start times out.
    print(real.execute(f"{h} agent start probe --kind claude --pane {pane} {claude_cmd_args} --timeout 15000 -- --probe")[1])
    print(real.execute(f"{h} pane read {pane}")[1])
    # Diagnostic, not a cell: does the token reach the pane's shell, and what PATH does it run with?
    real.execute(f"{h} pane run {pane} " + shlex.quote('printf "DIAG tokhash=%s\\n" "$(printf %s "$CLAUDE_CODE_OAUTH_TOKEN" | sha256sum | cut -c1-64)"; echo "DIAG PATH=$PATH"'))
    time.sleep(2)
    print(real.execute(f"{h} pane read {pane}")[1])
    recorded = real.execute("cat ${stateDir}/claude-public/probe")[1]
    print(f"probe claude record: {recorded!r}")
    want = real.succeed("printf %s ${tokens.public} | sha256sum | cut -d' ' -f1").strip()
    other = real.succeed("printf %s ${tokens.trusted} | sha256sum | cut -d' ' -f1").strip()
    cred = real.execute("test -e ${stateDir}/claude-public/.credentials.json")[0] == 0
    cell("V3", f"tok={want}" in recorded and other not in recorded
         and "cfg=${stateDir}/claude-public" in recorded and not cred,
         f"@public claude token hash matches its tier = {('tok=' + want) in recorded}; trusted hash present = {other in recorded}; .credentials.json in claudeDir = {cred}")

    # A clean stop under PrivatePIDs: the main process is PID 1 of its namespace.
    for m in (probe, real):
        t0 = time.monotonic()
        m.succeed("systemctl stop genie-herdr@public")
        elapsed = time.monotonic() - t0
        st = m.execute("systemctl show -p Result --value genie-herdr@public")[1].strip()
        cell(f"stop {m.name}", elapsed < 30 and st == "success", f"genie-herdr@public stopped in {elapsed:.1f}s, Result={st}")

    assert not red, f"RED cells: {red}"
  '';
}
