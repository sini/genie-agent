{
  # Reading a derivation's output during evaluation is import-from-derivation. builtin:buildenv
  # builds with no shell and no nixpkgs, so the fixture needs nothing from outside the store.
  outputs = _: {
    ifd = builtins.attrNames (
      builtins.readDir (derivation {
        name = "ifd-probe";
        system = "x86_64-linux";
        builder = "builtin:buildenv";
        manifest = "/dev/null";
        derivations = "";
      })
    );
  };
}
