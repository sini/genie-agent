{
  # Each attribute evaluates only when evaluation is impure. /dev/null exists inside the jail, so a
  # refusal of `file` is pure-eval's and not a missing path.
  outputs = _: {
    env =
      let
        home = builtins.getEnv "HOME";
      in
      assert home != "";
      home;
    file = builtins.readFile "/dev/null";
    nixpath = import <nixpkgs>;
    # Read whether or not evaluation is pure; pure-eval alone makes it "".
    secret = builtins.getEnv "GENIE_THREAD_SECRET";
  };
}
