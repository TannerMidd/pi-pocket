// Runner autostart (`src/runner/service.ts`): systemd, Task Scheduler, launchd, and the shared authenticator guard.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { STOPPED_BY_SERVER } from "../src/runner/main.ts";
import {
    canService,
    installService,
    LAUNCH_AGENT,
    launchAgentLog,
    launchAgentPath,
    NEEDS_TOTP,
    SERVICE_NEEDS_TOTP,
    serviceExitCode,
    serviceHelp,
    serviceMenu,
    serviceName,
    servicePlist,
    serviceTaskRemovalScript,
    serviceTaskScript,
    serviceUnit,
    TASK,
    unitPath,
} from "../src/runner/service.ts";

const launcher = fileURLToPath(new URL("../bin/pi-pocket.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-pocket-service-test-"));

after(() => rmSync(root, { recursive: true, force: true }));

/** A link file without an authenticator. */
function linkFile(): string {
    const file = join(root, `runner-${Math.random().toString(36).slice(2)}.json`);

    writeFileSync(
        file,
        JSON.stringify({ server: "https://pocket.example.com", id: "x", name: "Build", key: "k" }),
        { mode: 0o600 },
    );

    return file;
}

const runner = (...args: string[]) =>
    spawnSync(process.execPath, [launcher, "runner", ...args], {
        encoding: "utf8",
        env: { ...process.env, PI_POCKET_RUNNER_CONFIG: "" },
        timeout: 30_000,
    });

describe("the runner service", () => {
    it("writes a unit that starts the runner as a service, and does not restart it when that cannot help", () => {
        const unit = serviceUnit({
            node: "/usr/bin/node",
            launcher: "/opt/pi pocket/bin/pi-pocket.js",
            file: "/home/me/.pi-pocket/runner.json",
            path: "/usr/bin:/bin",
            noRestart: [STOPPED_BY_SERVER, SERVICE_NEEDS_TOTP],
        });

        assert.match(
            unit,
            /^ExecStart="\/usr\/bin\/node" "\/opt\/pi pocket\/bin\/pi-pocket.js" runner start --service --config "\/home\/me\/.pi-pocket\/runner.json"$/m,
        );
        assert.match(unit, /^RestartPreventExitStatus=3 4$/m);
        assert.match(unit, /^Environment="PATH=\/usr\/bin:\/bin"$/m);
        assert.equal(
            unitPath({ XDG_CONFIG_HOME: "/x" }),
            "/x/systemd/user/pi-pocket-runner.service",
        );
    });

    it("writes a launch agent with XML-escaped values, literal arguments, and restart only on failure", () => {
        const options = {
            node: "/opt/Node & tools/<node>\"'",
            launcher: "/Applications/Pi & Pocket/<launcher>\"'.js",
            file: "/Users/O'Brien & me/<runner>\".json",
            path: '/opt/<bin>:/Users/O\'Brien & me/"tools"',
            log: "/Users/O'Brien & me/Library/Logs/<runner>\".log",
        };
        const plist = servicePlist(options);

        assert.match(plist, new RegExp(`<key>Label</key>\\s*<string>${LAUNCH_AGENT}</string>`));
        assert.match(
            plist,
            /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/Node &amp; tools\/&lt;node&gt;&quot;&apos;<\/string>\s*<string>\/Applications\/Pi &amp; Pocket\/&lt;launcher&gt;&quot;&apos;\.js<\/string>\s*<string>runner<\/string>\s*<string>start<\/string>\s*<string>--service<\/string>\s*<string>--config<\/string>\s*<string>\/Users\/O&apos;Brien &amp; me\/&lt;runner&gt;&quot;\.json<\/string>\s*<\/array>/,
        );
        assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
        assert.match(
            plist,
            /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
        );
        assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
        assert.match(
            plist,
            /<key>PATH<\/key>\s*<string>\/opt\/&lt;bin&gt;:\/Users\/O&apos;Brien &amp; me\/&quot;tools&quot;<\/string>/,
        );
        assert.match(
            plist,
            /<key>StandardOutPath<\/key>\s*<string>\/Users\/O&apos;Brien &amp; me\/Library\/Logs\/&lt;runner&gt;&quot;\.log<\/string>/,
        );
        assert.match(
            plist,
            /<key>StandardErrorPath<\/key>\s*<string>\/Users\/O&apos;Brien &amp; me\/Library\/Logs\/&lt;runner&gt;&quot;\.log<\/string>/,
        );
        assert.equal(
            launchAgentPath(root),
            join(root, "Library", "LaunchAgents", `${LAUNCH_AGENT}.plist`),
        );
        assert.equal(launchAgentLog(root), join(root, "Library", "Logs", "pi-pocket-runner.log"));
    });

    it("quotes Windows task paths literally and uses the current user at log-on without admin rights", () => {
        const script = serviceTaskScript({
            node: String.raw`C:\Users\O'Brien & me\Node\node.exe`,
            launcher: String.raw`C:\Users\O'Brien & me\Pi Pocket\pi-pocket.js`,
            file: String.raw`C:\Users\O'Brien & me\$config; $(throw 'bad')\runner.json`,
            home: String.raw`C:\Users\O'Brien & me`,
        });

        assert.match(script, /^\$ErrorActionPreference = 'Stop'$/m);
        assert.ok(script.includes(`$taskName = '${TASK}'`));
        assert.ok(script.includes('$user = "$env:USERDOMAIN\\$env:USERNAME"'));
        assert.ok(script.includes(String.raw`-Execute 'C:\Users\O''Brien & me\Node\node.exe'`));
        assert.ok(script.includes(String.raw`-WorkingDirectory 'C:\Users\O''Brien & me'`));
        const argument = script.match(/-Argument '((?:''|[^'])*)' -WorkingDirectory/);

        assert.ok(argument);
        assert.equal(
            argument[1]!.replace(/''/g, "'"),
            String.raw`"C:\Users\O'Brien & me\Pi Pocket\pi-pocket.js" runner start --service --config "C:\Users\O'Brien & me\$config; $(throw 'bad')\runner.json"`,
        );
        assert.match(script, /^\$trigger = New-ScheduledTaskTrigger -AtLogOn -User \$user$/m);
        assert.match(
            script,
            /^\$principal = New-ScheduledTaskPrincipal -UserId \$user -LogonType Interactive -RunLevel Limited$/m,
        );
        assert.doesNotMatch(script, /-RunLevel Highest|RunAs|AtStartup/);
        assert.match(script, /-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries/);
        assert.match(
            script,
            /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\) -RestartCount 3 -RestartInterval \(New-TimeSpan -Minutes 1\)/,
        );
        assert.match(
            script,
            /Register-ScheduledTask .* -Force\nStart-ScheduledTask -TaskName \$taskName/,
        );
    });

    it("also doubles smart single quotes, which PowerShell treats as string delimiters", () => {
        for (const quote of ["‘", "’", "‚", "‛"]) {
            const script = serviceTaskScript({
                node: String.raw`C:\O${quote}Brien\node.exe`,
                launcher: String.raw`C:\Apps${quote}Pi Pocket${quote}\pi-pocket.js`,
                file: String.raw`C:\runner${quote}; throw 'bad'; #.json`,
                home: String.raw`C:\O${quote}Brien`,
            });

            assert.ok(script.includes(String.raw`-Execute 'C:\O${quote}${quote}Brien\node.exe'`));
            assert.ok(script.includes(String.raw`-WorkingDirectory 'C:\O${quote}${quote}Brien'`));
            assert.ok(
                script.includes(
                    String.raw`-Argument '"C:\Apps${quote}${quote}Pi Pocket${quote}${quote}\pi-pocket.js" runner start --service --config "C:\runner${quote}${quote}; throw ''bad''; #.json"'`,
                ),
            );
        }
    });

    it("stops the Windows task before unregistering it, without a confirmation prompt", () => {
        const script = serviceTaskRemovalScript();

        assert.ok(script.includes(`$taskName = '${TASK}'`));
        assert.match(script, /^\$ErrorActionPreference = 'Stop'$/m);
        assert.match(
            script,
            /Stop-ScheduledTask -TaskName \$taskName\nUnregister-ScheduledTask -TaskName \$taskName -Confirm:\$false/,
        );
    });

    for (const platform of ["linux", "win32", "darwin"] as const) {
        it(`refuses to install without an authenticator on ${platform}, before any system changes`, () => {
            assert.throws(
                () =>
                    installService(
                        {
                            node: process.execPath,
                            launcher,
                            file: linkFile(),
                            path: process.env.PATH ?? "",
                            home: root,
                            authenticator: false,
                        },
                        platform,
                    ),
                { message: NEEDS_TOTP },
            );
        });

        it(`refuses an npx-cache install on ${platform}`, () => {
            assert.throws(
                () =>
                    installService(
                        {
                            node: process.execPath,
                            launcher: join(root, "_npx", "cache", "pi-pocket.js"),
                            file: linkFile(),
                            path: process.env.PATH ?? "",
                            home: root,
                            authenticator: true,
                        },
                        platform,
                    ),
                /A service cannot use Pi Pocket from the npx cache/,
            );
        });

        it(`uses the correct permanent-stop exit codes on ${platform}`, () => {
            for (const code of [STOPPED_BY_SERVER, SERVICE_NEEDS_TOTP]) {
                assert.equal(
                    serviceExitCode(code, true, platform),
                    platform === "darwin" ? 0 : code,
                );
                assert.equal(serviceExitCode(code, false, platform), code);
            }

            assert.equal(serviceExitCode(1, true, platform), 1);
            assert.equal(serviceExitCode(130, true, platform), 130);
        });
    }

    it("names the native mechanism in status, menu labels, and help", () => {
        assert.equal(canService("win32"), true);
        assert.equal(canService("darwin"), true);
        assert.equal(canService("freebsd"), false);
        assert.equal(serviceName("linux"), "pi-pocket-runner.service");
        assert.equal(serviceMenu("linux").start, "Run as a service");
        assert.equal(serviceMenu("linux").stop, "Stop the service");

        for (const [platform, mechanism] of [
            ["win32", "scheduled task"],
            ["darwin", "launch agent"],
        ] as const) {
            assert.ok(serviceName(platform).includes(mechanism));
            assert.ok(serviceMenu(platform).start.includes(mechanism));
            assert.ok(serviceMenu(platform).stop.includes(mechanism));
            assert.ok(serviceHelp(platform).includes(mechanism));
            assert.ok(serviceHelp(platform).includes("pi-pocket runner service remove"));
        }

        assert.match(serviceHelp("win32"), /Task Scheduler; runner output is not saved/);
        assert.match(serviceHelp("darwin"), /Logs: ~\/Library\/Logs\/pi-pocket-runner\.log/);
    });

    it("refuses to start as a service without an authenticator, with how to set one up", () => {
        const result = runner("start", "--service", "--config", linkFile());

        assert.equal(result.status, serviceExitCode(SERVICE_NEEDS_TOTP, true), result.stderr);
        assert.match(result.stderr, /authenticator/);
        assert.match(result.stderr, /pi-pocket runner totp setup/);
    });

    it(
        "refuses to install the service without an authenticator",
        {
            skip: !canService(),
        },
        () => {
            const result = runner("service", "--config", linkFile());

            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.match(result.stdout + result.stderr, /pi-pocket runner totp setup/);
        },
    );
});
