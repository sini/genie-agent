{
  # Each attribute runs into one limit of the runner: memory, its own clock, or the network.
  outputs = _: {
    # A fetch from an address that never answers: the egress cell's packets to it are dropped.
    drop = builtins.fetchurl {
      url = "http://10.0.0.2/x";
      sha256 = "0000000000000000000000000000000000000000000000000000";
    };
    # A billion-element list held at once: several GiB, past any scope the oom cell sets.
    oom = builtins.length (builtins.genList (i: i) 1000000000);
    # Ten billion additions in flat memory: the clock runs out first.
    spin = builtins.foldl' (a: _: a + builtins.length (builtins.genList (j: j) 100000)) 0 (
      builtins.genList (i: i) 100000
    );
  };
}
