{ pkgs, package }:

let
  extensionV2 = pkgs.writeTextDir "extension.ts" (
    builtins.replaceStrings [ "v1" ] [ "v2" ] (builtins.readFile ./extension.ts)
  );
  pyrightConfig = pkgs.writeText "pi-pocket-service-pyright.json" (
    builtins.toJSON {
      typeCheckingMode = "strict";
      pythonVersion = pkgs.python3.pythonVersion;
      extraPaths = [ "${pkgs.path}/nixos/lib/test-driver/src" ];
    }
  );
  test = pkgs.testers.runNixOSTest {
    name = "pi-pocket-service";

    nodes.machine =
      { lib, ... }:
      {
        imports = [ ../module.nix ];

        services.pi-pocket = {
          enable = true;
          inherit package;
          extensions = [ ./extension.ts ];
          access = "local";
        };

        specialisation = {
          updated.configuration.services.pi-pocket.extensions = lib.mkForce [
            "${extensionV2}/extension.ts"
          ];
          empty.configuration.services.pi-pocket.extensions = lib.mkForce [ ];
        };

        environment.etc = {
          "pi-pocket-test/v1.ts".source = ./extension.ts;
          "pi-pocket-test/v2.ts".source = "${extensionV2}/extension.ts";
        };

        environment.systemPackages = [
          pkgs.curl
          pkgs.jq
        ];
        virtualisation = {
          memorySize = 2048;
          cores = 2;
          diskSize = 4096;
        };
      };

    testScript = builtins.readFile ./service.py;
  };
in
test.overrideTestDerivation (old: {
  buildCommand = ''
    ${pkgs.basedpyright}/bin/basedpyright \
      --warnings \
      --project ${pyrightConfig} \
      --pythonpath ${pkgs.python3.interpreter} \
      ${./service.py}

    ${old.buildCommand}
  '';
})
