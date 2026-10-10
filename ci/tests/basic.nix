{ lib, ... }:
let
  names = [
    "draft"
    "escalation"
    "eval-request"
    "eval-result"
    "launch"
    "proposal"
    "thread-state"
    "verdict"
  ];
  dir = ../../schemas;
in
{
  flake.tests.basic = {
    # The schema set is the contract list in src/index.ts, and every schema has a fixture
    # directory (the check `schemas` then requires valid and invalid cases in each).
    test-schema-set = {
      expr = {
        schemas = map (lib.removeSuffix ".json") (
          builtins.attrNames (lib.filterAttrs (n: t: t == "regular") (builtins.readDir dir))
        );
        fixtures = builtins.attrNames (builtins.readDir "${dir}/fixtures");
      };
      expected = {
        schemas = names;
        fixtures = names;
      };
    };
  };
}
