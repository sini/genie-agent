{
  outputs = _: {
    hello = "hi";
    # Long enough to read the evaluating process's environment while it runs.
    busy = builtins.length (builtins.genList (i: i) 10000000);
  };
}
