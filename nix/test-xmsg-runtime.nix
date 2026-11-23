# The xmsg socket directory's lifecycle without linger: nothing starts at boot, a logged-out
# start fails as a dependency without creating /run/user/<uid>, login starts the preparation
# unit and the consumers (which register), logout stops them, and a second login re-attaches.
{
  pkgs,
  nixpkgs,
  self,
}:
let
  sockDir = "/run/user/1000/xmsg";
  regLog = "/var/lib/fake-xmsg/registrations";

  # A consumer stub: register once on agent.sock, then idle.
  consumer =
    name:
    pkgs.writeShellScriptBin name ''
      ${pkgs.python3}/bin/python3 -I -c '
      import os, socket
      s = socket.socket(socket.AF_UNIX)
      s.connect(os.environ["XMSG_AGENT_SOCK"])
      s.sendall(b"register ${name}\n")
      s.close()
      '
      # genie-agent runs with PrivatePIDs=, so this may be PID 1, which ignores an untrapped TERM.
      trap 'exit 0' TERM
      ${pkgs.coreutils}/bin/sleep infinity &
      wait
    '';

  # Stands in for a pinned xmsg daemon as an owner's user service. It never creates the
  # directory, so the directory's owner and mode are the preparation unit's.
  fakeXmsg = pkgs.writeScript "fake-xmsg" ''
    #!${pkgs.python3}/bin/python3 -I
    import os, socket, time
    d = "${sockDir}"
    while not os.path.isdir(d):
        time.sleep(0.2)
    path = d + "/agent.sock"
    if os.path.exists(path):
        os.unlink(path)
    srv = socket.socket(socket.AF_UNIX)
    srv.bind(path)
    srv.listen()
    while True:
        c, _ = srv.accept()
        line = c.makefile().readline().strip()
        c.close()
        if line:
            with open("${regLog}", "a") as f:
                f.write(line + "\n")
  '';

  consumers = [
    "genie-agent.service"
    "genie-guard.service"
  ];
  prep = "genie-xmsg-socket-dir.service";
  trigger = "user-runtime-dir@1000.service";
in
pkgs.testers.runNixOSTest {
  name = "genie-agent-xmsg-runtime";
  nodes.machine = {
    imports = [ self.nixosModules.default ];
    users.users.alice = {
      isNormalUser = true;
      uid = 1000;
      password = "foobar";
    };
    systemd.tmpfiles.rules = [
      "d /var/lib/fake-xmsg 0755 alice users -"
      "d /run/genie-secrets 0700 root root -"
      "f /run/genie-secrets/model-key 0400 root root - dummy-model-key"
    ];
    systemd.user.services.fake-xmsg = {
      wantedBy = [ "default.target" ];
      unitConfig.ConditionUser = "alice";
      serviceConfig.ExecStart = "${fakeXmsg}";
    };
    services.genie-agent = {
      enable = true;
      user = "alice";
      xmsgSocket = sockDir;
      package = consumer "genie-root";
      piPackage = consumer "pi";
      model = {
        baseUrl = "http://127.0.0.1:9/v1";
        keyFile = "/run/genie-secrets/model-key";
      };
      tier1.searxngUrl = "http://127.0.0.1:9";
      guardRef = "genie-guard@example.node";
      guard = {
        enable = true;
        package = consumer "genie-guard";
        ninferUrl = "http://127.0.0.1:9/v1";
      };
      broker.guardOut.enable = false;
    };
  };

  testScript = ''
    consumers = ${builtins.toJSON consumers}
    # Each unit's stub registers under its package's name.
    stub = {"genie-agent.service": "genie-root", "genie-guard.service": "genie-guard"}
    prep = "${prep}"
    trigger = "${trigger}"

    def show(unit, prop):
        return machine.succeed(f"systemctl show -P {prop} {unit}").strip()

    def registrations(name):
        return int(machine.succeed(f"grep -c '^register {name}$' ${regLog} || true").strip())

    def assert_stopped(when):
        for u in consumers + [prep]:
            state = show(u, "ActiveState")
            assert state == "inactive", f"{when}: {u} is {state}"
            assert show(u, "NRestarts") == "0", f"{when}: {u} restarted"

    machine.wait_for_unit("multi-user.target")

    with subtest("wiring is only .wants links: no unit or drop-in for the trigger"):
        for u in consumers + [prep]:
            machine.succeed(f"test -L /etc/systemd/system/{trigger}.wants/{u}")
        machine.fail(f"test -e /etc/systemd/system/{trigger}")
        machine.fail(f"test -e /etc/systemd/system/{trigger}.d")
        machine.fail("grep -l genie /etc/systemd/system/multi-user.target.wants/* 2>/dev/null")

    with subtest("boot without linger: consumers inactive, no restart loop"):
        machine.fail("test -e /var/lib/systemd/linger/alice")
        machine.fail("test -e /run/user/1000")
        machine.sleep(5)
        assert_stopped("boot")
        assert show(trigger, "ActiveState") == "inactive"

    with subtest("logged-out cell: a manual start fails as a dependency and creates nothing"):
        failures = []
        for u in consumers:
            rc, out = machine.execute(f"systemctl start {u} 2>&1")
            print(f"systemctl start {u}: rc={rc} {out!r}")
            if rc == 0:
                failures.append(f"{u}: systemctl start exited 0")
            journal = machine.succeed(f"journalctl -b --no-pager -u {u}")
            if "Dependency failed for" not in journal:
                failures.append(f"{u}: no 'Dependency failed' journal line")
            if machine.execute("test -e /run/user/1000")[0] == 0:
                failures.append(f"{u}: /run/user/1000 was created")
        machine.sleep(5)
        try:
            assert_stopped("logged out")
        except AssertionError as e:
            failures.append(str(e))
        assert not failures, f"logged-out cell RED: {failures}"

    def login():
        machine.wait_until_tty_matches("1", "login: ")
        machine.send_chars("alice\n")
        machine.wait_until_tty_matches("1", "Password: ")
        machine.send_chars("foobar\n")
        for u in [trigger, prep] + consumers:
            machine.wait_until_succeeds(f"systemctl is-active --quiet {u}", timeout=120)

    with subtest("login: preparation and consumers start, consumers register"):
        login()
        assert machine.succeed("stat -c '%U %a' ${sockDir}").strip() == "alice 700"
        assert show(prep, "Result") == "success"
        for u in consumers:
            name = stub[u]
            machine.wait_until_succeeds(f"grep -qx 'register {name}' ${regLog}", timeout=60)
            assert registrations(name) == 1, f"{name} registered {registrations(name)} times"

    with subtest("logout: consumers and preparation stop with the runtime dir"):
        machine.send_chars("exit\n")
        machine.wait_until_fails(f"systemctl is-active --quiet {trigger}", timeout=120)
        machine.fail("test -e /run/user/1000")
        assert_stopped("logout")

    with subtest("re-login: they re-attach"):
        login()
        for u in consumers:
            name = stub[u]
            machine.wait_until_succeeds(f"test $(grep -cx 'register {name}' ${regLog}) -eq 2", timeout=60)
        for u in consumers + [prep]:
            assert show(u, "NRestarts") == "0", f"{u} restarted"
  '';
}
