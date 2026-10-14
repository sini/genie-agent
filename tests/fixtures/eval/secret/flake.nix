{
  # A fixture flake reading agenix and sops secrets (plan E5, design §5.7).
  #
  # In agenix / sops-nix configurations, secrets decrypt at activation time to /run/agenix/<name>
  # or /run/secrets/<name>. During pure evaluation, reading those paths fails because absolute
  # paths outside the store/flake are forbidden in pure eval mode.
  #
  # When secrets: "stub" is requested, the eval runner overrides agenix/sops paths with placeholder
  # files in the jail scratch and substitutes placeholder secret attrs, allowing pure evaluation.
  outputs = _: {
    # Agenix secret definition
    ageSecret = {
      file = ./database-password.age;
      path = "/run/agenix/database-password";
    };

    # Sops secret definition
    sopsSecret = {
      file = ./api-token.enc.yaml;
      path = "/run/secrets/api-token";
    };

    # Canonical NixOS configuration pattern (design §5.7, nixosConfigurations.<host>.config...):
    nixosConfigurations.laptop = {
      config = {
        age.secrets.database-password = {
          file = ./database-password.age;
          path = "/run/agenix/database-password";
        };
        sops.secrets.api-token = {
          file = ./api-token.enc.yaml;
          path = "/run/secrets/api-token";
        };
        services.db.password = builtins.readFile "/run/agenix/database-password";
        services.api.token = builtins.readFile "/run/secrets/api-token";
        services.api.tokenPlaceholder = "<placeholder:api-token>";
      };
      extendModules =
        {
          modules ? [ ],
        }:
        let
          overrides = map (m: m { lib = null; }) modules;
          merged = builtins.foldl' (acc: m: acc // m) { } overrides;
          ageSecrets = merged.age.secrets or { };
          sopsSecrets = merged.sops.secrets or { };
          sopsPlaceholder = merged.sops.placeholder or { };
          agePath = ageSecrets.database-password.path or "/run/agenix/database-password";
          sopsPath = sopsSecrets.api-token.path or "/run/secrets/api-token";
        in
        {
          config = {
            age.secrets.database-password = {
              file = ./database-password.age;
              path = agePath;
            };
            sops.secrets.api-token = {
              file = ./api-token.enc.yaml;
              path = sopsPath;
            };
            services.db.password = builtins.readFile agePath;
            services.api.token = builtins.readFile sopsPath;
            services.api.tokenPlaceholder = sopsPlaceholder.api-token or "<placeholder:api-token>";
          };
        };
    };
  };
}
