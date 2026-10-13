{
  # An indirect reference: it resolves only through a flake registry.
  inputs.nixpkgs.url = "nixpkgs";
  outputs = _: {
    resolved = "resolved";
  };
}
