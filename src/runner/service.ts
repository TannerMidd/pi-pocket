/**
 * `pi-pocket runner service`: keep the runner running as a systemd user service (Linux), a scheduled task
 * (Windows), or a launch agent (macOS).
 *
 * With nobody at the computer, nobody can answer the question before a session or a folder: the only way to approve
 * one is a code from an authenticator (`totp.ts`), typed in Pi Pocket. Installing a service and starting with
 * `--service` both refuse without one. Saved folders alone are not enough: a folder outside them could never be
 * approved. On macOS, permanent stops exit successfully so launchd does not restart them.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { windowsSystemProgram } from "./windows.ts";

/** The systemd user unit. */
export const UNIT = "pi-pocket-runner.service";
/** The Windows task, owned by the signed-in user. */
export const TASK = "Pi Pocket runner";
/** The macOS launch agent's label. */
export const LAUNCH_AGENT = "dev.pi-pocket.runner";

/** The server ended the link for good: starting it again would not help. */
export const STOPPED_BY_SERVER = 3;
/** `runner start --service` exits with this when no authenticator is set up. */
export const SERVICE_NEEDS_TOTP = 4;

/** What a service needs, and how to get it, when this computer has no authenticator. */
export const NEEDS_TOTP =
    "A service runs with nobody at this computer, so only a code from an authenticator app, typed in Pi Pocket, can approve its sessions and folders. Set one up first, in a terminal here:\n  pi-pocket runner totp setup\nThen run: pi-pocket runner service";

export const SERVICE_UNAVAILABLE =
    "The service command needs Linux with systemd, Windows, or macOS. Keep the runner open in a terminal, or use the Pi Pocket desktop app.";

/** Where the unit file goes: the user's systemd folder. */
export function unitPath(env: NodeJS.ProcessEnv = process.env): string {
    return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", UNIT);
}

export function launchAgentPath(home = homedir()): string {
    return join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT}.plist`);
}

export function launchAgentLog(home = homedir()): string {
    return join(home, "Library", "Logs", "pi-pocket-runner.log");
}

/** Whether this computer can run the service. */
export function canService(platform: NodeJS.Platform = process.platform): boolean {
    return (
        platform === "win32" ||
        platform === "darwin" ||
        (platform === "linux" && spawnSync("systemctl", ["--version"]).status === 0)
    );
}

function powershell(script: string, showOutput = false) {
    return spawnSync(
        windowsSystemProgram("powershell.exe"),
        [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
            windowsHide: true,
            ...(showOutput ? { stdio: "inherit" as const } : { encoding: "utf8" as const }),
        },
    );
}

function launchAgentTarget(): string {
    return `gui/${process.getuid!()}/${LAUNCH_AGENT}`;
}

/** Whether the service runs now. */
export function serviceActive(platform: NodeJS.Platform = process.platform): boolean {
    if (platform === "win32") {
        return (
            powershell(
                `$ErrorActionPreference = 'Stop'\nif ((Get-ScheduledTask -TaskName '${TASK}').State -eq 'Running') { exit 0 } else { exit 1 }`,
            ).status === 0
        );
    }

    if (platform === "darwin") {
        const result = spawnSync("launchctl", ["print", launchAgentTarget()], { encoding: "utf8" });

        return result.status === 0 && /^\s*state = running\s*$/m.test(result.stdout);
    }

    return (
        platform === "linux" &&
        spawnSync("systemctl", ["--user", "is-active", "--quiet", UNIT]).status === 0
    );
}

/** launchd cannot exclude particular failure codes from KeepAlive. Only permanent service stops become success. */
export function serviceExitCode(
    code: number,
    asService: boolean,
    platform: NodeJS.Platform = process.platform,
): number {
    return platform === "darwin" &&
        asService &&
        [STOPPED_BY_SERVER, SERVICE_NEEDS_TOTP].includes(code)
        ? 0
        : code;
}

/** The name shown by `runner status`. Keep the Linux name unchanged. */
export function serviceName(platform: NodeJS.Platform = process.platform): string {
    return platform === "win32"
        ? `scheduled task "${TASK}"`
        : platform === "darwin"
          ? `launch agent ${LAUNCH_AGENT}`
          : UNIT;
}

/** The terminal menu names the mechanism, including that Windows and macOS start only at sign-in. */
export function serviceMenu(platform: NodeJS.Platform = process.platform): {
    start: string;
    stop: string;
    detail: string;
} {
    const mechanism = platform === "win32" ? "scheduled task" : "launch agent";

    return platform === "linux"
        ? {
              start: "Run as a service",
              stop: "Stop the service",
              detail: "keep running with nobody here",
          }
        : {
              start: `Run at sign-in (${mechanism})`,
              stop: `Stop the ${mechanism}`,
              detail: "start when you sign in; needs an authenticator",
          };
}

/** The service commands' help. The Linux text stays the same. */
export function serviceHelp(platform: NodeJS.Platform = process.platform): string {
    if (platform === "win32") {
        return `  pi-pocket runner service
    Windows: register the "${TASK}" scheduled task, as your user without
    admin rights. Starts now and at sign-in. Needs an authenticator (totp setup)
    first. Approve sessions and folders with its code in Pi Pocket.
    View task history in Task Scheduler; runner output is not saved.
  pi-pocket runner service remove
    Stop and remove the scheduled task. Keep the saved link.`;
    }

    if (platform === "darwin") {
        return `  pi-pocket runner service
    macOS: install the ${LAUNCH_AGENT} launch agent. Starts now and at
    sign-in. Needs an authenticator (totp setup) first. Approve sessions and
    folders with its code in Pi Pocket.
    Logs: ~/Library/Logs/pi-pocket-runner.log
  pi-pocket runner service remove
    Stop and remove the launch agent. Keep the saved link.`;
    }

    return `  pi-pocket runner service
    Linux with systemd: keep the runner running as a user service, for a
    computer nobody sits at. Needs an authenticator (totp setup) first: with
    nobody here, only a code from it, typed in Pi Pocket, approves sessions.
  pi-pocket runner service remove
    Stop and remove the service. Keep the saved link.`;
}

// systemd expands `%` specifiers even inside quotes: `%%` is a literal `%`.
const quote = (value: string) => `"${value.replace(/(["\\])/g, "\\$1").replace(/%/g, "%%")}"`;

/**
 * The unit: this Node, this Pi Pocket, this link file, and this PATH (the tools sessions run find what this shell
 * finds). `noRestart`: exit codes after which starting again would not help.
 */
export function serviceUnit(options: {
    node: string;
    launcher: string;
    file: string;
    path: string;
    noRestart: readonly number[];
}): string {
    return [
        "[Unit]",
        "Description=Pi Pocket runner: run session tools on this computer",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        // `--service`: no terminal to ask on; it refuses to start without an authenticator.
        `ExecStart=${quote(options.node)} ${quote(options.launcher)} runner start --service --config ${quote(options.file)}`,
        `Environment=${quote(`PATH=${options.path}`)}`,
        "Restart=on-failure",
        "RestartSec=5",
        `RestartPreventExitStatus=${options.noRestart.join(" ")}`,
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
}

const xml = (value: string) =>
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

/** A launch agent with literal arguments, the installing shell's PATH, and a restart only after failure. */
export function servicePlist(options: {
    node: string;
    launcher: string;
    file: string;
    path: string;
    log: string;
}): string {
    const args = [
        options.node,
        options.launcher,
        "runner",
        "start",
        "--service",
        "--config",
        options.file,
    ];

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xml(LAUNCH_AGENT)}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((arg) => `        <string>${xml(arg)}</string>`).join("\n")}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xml(options.log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(options.log)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xml(options.path)}</string>
    </dict>
</dict>
</plist>
`;
}

// Literal PowerShell strings do not expand $, backticks, or double quotes. Double every single quote, including
// smart quotes: PowerShell also treats ‘, ’, ‚, and ‛ as string delimiters.
const psQuote = (value: string) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
// The task's Argument is a Windows command line, not PowerShell code. Quote each path for Node's argv parser.
const windowsQuote = (value: string) =>
    `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;

/** Register a per-user log-on task without elevation, then start it. All supplied values are literal arguments. */
export function serviceTaskScript(options: {
    node: string;
    launcher: string;
    file: string;
    home: string;
}): string {
    const args = `${windowsQuote(options.launcher)} runner start --service --config ${windowsQuote(options.file)}`;

    return [
        "$ErrorActionPreference = 'Stop'",
        `$taskName = ${psQuote(TASK)}`,
        '$user = "$env:USERDOMAIN\\$env:USERNAME"',
        `$action = New-ScheduledTaskAction -Execute ${psQuote(options.node)} -Argument ${psQuote(args)} -WorkingDirectory ${psQuote(options.home)}`,
        "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user",
        "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
        "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
        "$null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force",
        "Start-ScheduledTask -TaskName $taskName",
        "",
    ].join("\n");
}

/** Stop the task before deleting it; PowerShell must report any error. */
export function serviceTaskRemovalScript(): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$taskName = ${psQuote(TASK)}`,
        "Stop-ScheduledTask -TaskName $taskName",
        "Unregister-ScheduledTask -TaskName $taskName -Confirm:$false",
        "",
    ].join("\n");
}

/** `systemctl --user …`, its output shown; false when it failed. */
function systemctl(...args: string[]): boolean {
    return spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" }).status === 0;
}

/** Install only after the shared authenticator and stable-install checks. No platform can bypass them. */
export function installService(
    options: {
        node: string;
        launcher: string;
        file: string;
        path: string;
        home: string;
        authenticator: boolean;
    },
    platform: NodeJS.Platform = process.platform,
): string[] {
    if (!options.authenticator) {
        throw new Error(NEEDS_TOTP);
    }

    // npx's copy is a cache npm can clear: the service would stop starting.
    if (options.launcher.includes("_npx")) {
        throw new Error(
            "A service cannot use Pi Pocket from the npx cache. Install it with: npm install -g pi-pocket@latest\nThen run: pi-pocket runner service",
        );
    }

    const approval =
        "  Approve its sessions and folders in Pi Pocket with a code from your authenticator.";
    const remove = "  To stop and remove it: pi-pocket runner service remove";

    if (platform === "win32") {
        // A task starts in the home folder, not necessarily the shell's current folder.
        const result = powershell(
            serviceTaskScript({ ...options, file: resolve(options.file) }),
            true,
        );

        if (result.status !== 0) {
            throw new Error(
                `The scheduled task could not be registered or started. ${result.error?.message ?? "Check the PowerShell error above."} No other installation method was tried.`,
            );
        }

        return [
            `The runner's scheduled task "${TASK}" is installed. It starts now and when you sign in, as your user without admin rights.`,
            approval,
            `  View task history: Task Scheduler > Task Scheduler Library > ${TASK}. Runner output is not saved.`,
            remove,
        ];
    }

    if (platform === "darwin") {
        const plist = launchAgentPath(options.home);
        const log = launchAgentLog(options.home);

        mkdirSync(dirname(plist), { recursive: true });
        mkdirSync(dirname(log), { recursive: true });
        writeFileSync(plist, servicePlist({ ...options, file: resolve(options.file), log }));
        spawnSync("launchctl", ["bootout", launchAgentTarget()], { stdio: "ignore" });
        const result = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, plist], {
            stdio: "inherit",
        });

        if (result.status !== 0) {
            throw new Error(
                `The launch agent file is in ${plist}, but it could not be loaded. ${result.error?.message ?? "Check the launchctl error above."}`,
            );
        }

        return [
            `The runner's launch agent ${LAUNCH_AGENT} is installed. It starts now and when you sign in.`,
            approval,
            `  View logs: ${log}`,
            remove,
        ];
    }

    if (platform !== "linux") {
        throw new Error(SERVICE_UNAVAILABLE);
    }

    const unit = unitPath();

    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(
        unit,
        serviceUnit({
            ...options,
            // The service starts in the home folder: a relative path would name another file there.
            file: resolve(options.file),
            // The server removed this computer or its key is wrong, or no authenticator: starting again would not help.
            noRestart: [STOPPED_BY_SERVER, SERVICE_NEEDS_TOTP],
        }),
    );

    if (!systemctl("daemon-reload") || !systemctl("enable", "--now", UNIT)) {
        throw new Error(
            `The service file is in ${unit}, but the runner did not start. Check the error with: systemctl --user status ${UNIT}`,
        );
    }

    return [
        `The runner is running as ${UNIT}. It starts with your user session.`,
        approval,
        `  View logs: journalctl --user -u ${UNIT} -f`,
        `  To run while you are logged out: loginctl enable-linger ${process.env.USER ?? "$USER"}`,
    ];
}

/** Stop and remove only the service; keep the link and settings. */
export function removeService(
    file: string,
    platform: NodeJS.Platform = process.platform,
    home = homedir(),
): string {
    if (platform === "win32") {
        const result = powershell(serviceTaskRemovalScript(), true);

        if (result.status !== 0) {
            throw new Error(
                `The scheduled task could not be removed. ${result.error?.message ?? "Check the PowerShell error above."}`,
            );
        }
    } else if (platform === "darwin") {
        spawnSync("launchctl", ["bootout", launchAgentTarget()], { stdio: "ignore" });
        rmSync(launchAgentPath(home), { force: true });
    } else if (platform === "linux") {
        systemctl("disable", "--now", UNIT);
        rmSync(unitPath(), { force: true });
        systemctl("daemon-reload");
    } else {
        throw new Error(SERVICE_UNAVAILABLE);
    }

    return `Stopped and removed ${serviceName(platform)}. The saved link is still in ${file}.`;
}
