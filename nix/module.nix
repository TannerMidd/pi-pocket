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
  skillsDir =
    if cfg.skills == null then
      null
    else
      pkgs.linkFarm "pi-pocket-skills" (
        lib.imap0 (index: source: {
          # Pi keeps the first skill of each name; preserve the declared traversal order.
          name = lib.fixedWidthString (lib.stringLength (toString (lib.length cfg.skills))) "0" (
            toString index
          );
          path = source;
        }) cfg.skills
      );
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

    skills = lib.mkOption {
      type = lib.types.nullOr (lib.types.listOf lib.types.path);
      default = null;
      example = lib.literalExpression "[ ./skills/my-skill ./skills/collection ]";
      description = ''
        Skill directories or collections to expose in the service user's Pi skills
        directory (~/.pi/agent/skills, or skills under PI_CODING_AGENT_DIR). Each path
        gets its own link, preserving SKILL.md files and their supporting files.
        Null leaves unmanaged skills alone and removes a previously managed link.
        An empty list manages an empty skills directory. Changing the list replaces
        the whole managed directory link, so removed skills leave no stale links.
        Existing unmanaged directories are never overwritten: move them aside before
        opting in. This directory is shared with Pi CLI when using the same agent
        directory, and is read-only; use project skills for editable additions.
      '';
    };

    extensions = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      example = lib.literalExpression "[ ./extensions/my-extension.ts ]";
      description = ''
        Drop-in extension files, copied under their original filenames. Files must have
        distinct names ending in .ts, without line breaks. The .nix-managed-extensions
        file in the extensions directory tracks these copies. Each service start
        restores declared files and removes previously managed files no longer listed,
        including when this list is empty. Owner-created extensions are preserved;
        a new declaration colliding with an unmanaged file fails rather than overwrites
        it. Existing extensions directories must not be symlinks. Copies are writable
        and can be live-edited until the next service start. New extensions stay off
        until the owner turns them on in the app's Extensions sheet.
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
        assertion = lib.all (
          name: lib.hasSuffix ".ts" name && !(lib.hasInfix "\n" name) && !(lib.hasInfix "\r" name)
        ) extensionNames;
        message = "services.pi-pocket.extensions must contain .ts files without line breaks in their filenames.";
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
        agent_dir="''${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
        case "$agent_dir" in
          '~') agent_dir="$HOME" ;;
          '~/'*) agent_dir="$HOME/''${agent_dir#\~/}" ;;
        esac
        skills_dir="$agent_dir/skills"
        if [ -L "$skills_dir" ]; then
          # Recognize our store link even if its old target has been garbage-collected.
          case "$(readlink -- "$skills_dir")" in
            ${builtins.storeDir}/*-pi-pocket-skills) rm -- "$skills_dir" ;;
          esac
        fi
        ${lib.optionalString (cfg.skills != null) ''
          if [ -e "$skills_dir" ] || [ -L "$skills_dir" ]; then
            echo "Pi Pocket will not overwrite unmanaged skills at $skills_dir; move them aside before setting services.pi-pocket.skills." >&2
            exit 1
          fi
          mkdir -p -- "$agent_dir"
          ln -s -- ${skillsDir} "$skills_dir"
        ''}

        ${pkgs.bash}/bin/bash ${./manage-extensions.sh} \
          ${lib.escapeShellArgs (
            [ "${cfg.dataDir}/extensions" ]
            ++ lib.concatMap (source: [
              "${source}"
              (builtins.baseNameOf source)
            ]) cfg.extensions
          )}
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
