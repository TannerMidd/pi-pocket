{
  description = "Pi Pocket";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";

    # Keep Intel macOS on the last supported nixpkgs branch.
    nixpkgs-x86_64-darwin.url = "github:nixos/nixpkgs?ref=nixpkgs-26.05-darwin";
  };

  outputs =
    inputs@{ flake-parts, nixpkgs-x86_64-darwin, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        { pkgs, system, ... }:
        let
          pi-pocket = pkgs.callPackage ./nix/package.nix { };
        in
        {
          _module.args.pkgs =
            if system == "x86_64-darwin" then
              import nixpkgs-x86_64-darwin { inherit system; }
            else
              import inputs.nixpkgs { inherit system; };

          packages = {
            default = pi-pocket;
            inherit pi-pocket;
          };

          devShells.default = pkgs.mkShell {
            inputsFrom = [ pi-pocket ];
            packages =
              with pkgs;
              [
                nodejs_24
                gitMinimal
                openssh
                ripgrep
                fd
                cloudflared
                nixfmt
              ]
              ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.chromium ];
          };

          checks.default = pi-pocket;
          formatter = pkgs.nixfmt;
        };
    };
}
