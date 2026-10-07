{
  config,
  lib,
  pkgs,
  utils,
  ...
}:
let
  cfg = config.services.pi-pocket;
  extensionNames = map builtins.baseNameOf cfg.extensions;
in
{
  options.services.pi-pocket = {
    enable = lib.mkEnableOption "Pi Pocket";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "Pi Pocket package to run.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "pi-pocket";
      description = ''
        User running Pi Pocket and its agents. The default user is created automatically.
        Set this to an existing user to reuse their Pi sign-ins and access their projects.
        Anyone with steering access can run commands as this user.
      '';
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "pi-pocket";
      description = "Service group. The default group is created automatically.";
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/pi-pocket";
      description = "Directory for the database, settings, uploads, and extensions.";
    };

    cwd = lib.mkOption {
      type = lib.types.path;
      default = cfg.dataDir;
      defaultText = lib.literalExpression "config.services.pi-pocket.dataDir";
      description = "Default directory for new sessions. Must exist and be accessible to the service user.";
    };

    access = lib.mkOption {
      type = lib.types.enum [
        "local"
        "lan"
        "cloudflare"
        "tailscale"
      ];
      default = "local";
      description = ''
        Access mode: loopback only, LAN, a Cloudflare quick tunnel, or Tailscale.
        Tailscale mode requires Tailscale to be connected separately.
      '';
    };

    host = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "127.0.0.1";
      description = "Listening address. Null lets the access mode choose the address.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8787;
      description = "TCP port to listen on.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the listening TCP port in the firewall.";
    };

    browser = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Browser executable. Null uses Pi Pocket's browser discovery.";
    };

    browserArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "--disable-dev-shm-usage" ];
      description = "Extra Chromium flags. Pi Pocket splits these on whitespace.";
    };

    extensions = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      example = lib.literalExpression "[ ./extensions/my-extension.ts ]";
      description = ''
        Drop-in extension files, copied under their original filenames. Files must have
        distinct names ending in .ts. The extensions directory is replaced on every
        service start, including when this list is empty: removed extensions disappear,
        and manual additions or live edits are discarded. Copies are writable and can
        be live-edited until the next restart. New extensions stay off until the owner
        turns them on in the app's Extensions sheet.
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        PI_POCKET_GUARD = "off";
      };
      description = "Additional environment variables. Do not put secrets here; they enter the Nix store.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/pi-pocket";
      description = "Runtime environment file for provider API keys or other secrets, in systemd EnvironmentFile format.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      example = lib.literalExpression "[ pkgs.nix pkgs.python3 ]";
      description = "Additional command-line tools available to the service and its agents.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.all (name: lib.hasSuffix ".ts" name) extensionNames;
        message = "services.pi-pocket.extensions must contain .ts files.";
      }
      {
        assertion = lib.length (lib.unique extensionNames) == lib.length extensionNames;
        message = "services.pi-pocket.extensions must have distinct filenames.";
      }
    ];

    users.users.pi-pocket = lib.mkIf (cfg.user == "pi-pocket") {
      isSystemUser = true;
      group = cfg.group;
      home = cfg.dataDir;
    };
    users.groups.pi-pocket = lib.mkIf (cfg.group == "pi-pocket") { };

    systemd.tmpfiles.settings.pi-pocket.${cfg.dataDir}.d = {
      mode = "0700";
      user = cfg.user;
      group = cfg.group;
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.pi-pocket = {
      description = "Pi Pocket";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      path = cfg.extraPackages;
      preStart = ''
        directory=${lib.escapeShellArg "${cfg.dataDir}/extensions"}
        rm -rf -- "$directory"
        mkdir -p -- "$directory"
        ${lib.concatMapStringsSep "\n" (source: ''
          install -m 0600 -- ${lib.escapeShellArg "${source}"} "$directory"/${lib.escapeShellArg (builtins.baseNameOf source)}
        '') cfg.extensions}
      '';
      environment = {
        HOME = config.users.users.${cfg.user}.home;
      }
      // lib.optionalAttrs (cfg.browser != null) { PI_POCKET_BROWSER = cfg.browser; }
      // lib.optionalAttrs (cfg.browserArgs != [ ]) {
        PI_POCKET_BROWSER_ARGS = lib.concatStringsSep " " cfg.browserArgs;
      }
      // cfg.environment;

      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.cwd;
        ExecStart = utils.escapeSystemdExecArgs (
          [
            (lib.getExe cfg.package)
            "--access"
            cfg.access
            "--port"
            (toString cfg.port)
            "--data"
            cfg.dataDir
            "--cwd"
            cfg.cwd
          ]
          ++ lib.optionals (cfg.host != null) [
            "--host"
            cfg.host
          ]
        );
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        Restart = "on-failure";
        RestartSec = 5;
        UMask = "0077";
      };
    };
  };
}
