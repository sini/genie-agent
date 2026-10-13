{
  # Each attribute runs into one limit of the runner: memory, its own clock, or the network.
  outputs = _: {
    # A billion-element list held at once: several GiB, past any scope the oom cell sets.
    oom = builtins.length (builtins.genList (i: i) 1000000000);
    # Ten billion additions in flat memory: the clock runs out first.
    spin = builtins.foldl' (a: _: a + builtins.length (builtins.genList (j: j) 100000)) 0 (
      builtins.genList (i: i) 100000
    );
  };
}
