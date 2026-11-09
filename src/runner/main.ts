/**
 * `pi-pocket runner`: lets a Pi Pocket server run sessions' tools on this computer.
 *
 * It starts Earendil's pi-env daemon here and connects out to the server over a WebSocket, so this computer needs no
 * open port, SSH, or provider key. The server sends pi-env requests (read a file, run a command); the daemon answers.
 * The link survives drops of any length (`protocol.ts`): the daemon keeps running, its answers wait here, and both
 * sides send again what the other missed.
 *
 * In a terminal, plain `pi-pocket runner` opens a menu: start, link, settings, saved folders, approved sessions,
 * unlink, help. Each of those is also a command for scripts, which never asks:
 *
 *   pi-pocket runner start                  run with the saved link (also used by a program that runs the runner)
 *   pi-pocket runner link <server> <code>   link this computer, with a code from Menu > Runners
 *   pi-pocket runner settings [name value]  show or change a setting: stop-asking on|off, totp-days 1|7|14|30|never,
 *                                           http allow|refuse, network allow|refuse, downloads <folder>|default
 *   pi-pocket runner status                 show the link and its settings
 *   pi-pocket runner folders [--json]       list saved folders; `folders remove <folder>` removes one
 *   pi-pocket runner sessions [--json]      list approved sessions; `sessions revoke <id>|all` revokes
 *   pi-pocket runner totp setup|off|status  the authenticator; turning it off needs a code from it
 *   pi-pocket runner service [remove]       run as a service, task, or launch agent; needs the authenticator
 *   pi-pocket runner unlink                 delete the link file: the link and all runner settings, the
 *                                           authenticator, saved folders, and approved sessions
 *
 * Each session needs a permission on this computer (`approvals.ts`), which the runner checks on each request
 * (`request-gate.ts`). The runner asks its person: on its terminal, or through a program that runs it
 * (`--confirm-via stdio`); or a code from an authenticator (`totp.ts`) approves from Pi Pocket. Plain HTTP to the
 * server is refused unless it is this computer or a device of this computer's tailnet, or the person allowed it
 * (`transport.ts`).
 *
 * It exits with `STOPPED_BY_SERVER` when the server ends the link for good (the computer was removed, its key is
 * wrong): the desktop app does not start it again then.
 */
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { Agent, fetch as undiciFetch } from "undici";
import { createInterface } from "node:readline";
import { createInterface as createQuestions } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { pocketVersion } from "../server/versions.ts";
import {
    accent,
    bold,
    choose,
    type Choice,
    dim,
    green,
    interactive,
    onKeys,
    qrLines,
    restoreTerminal,
    yellow,
} from "../launcher/term.ts";
import { authenticatorLink, checkCode, newSecret, type TotpState } from "./totp.ts";
import { LINK_CODE_PATH } from "./protocol.ts";
import {
    Runner,
    type RunnerLinkFile,
    type RunnerSettings,
    RunnerStopped,
    type SessionAnswer,
    type SessionQuestion,
} from "./runner.ts";
import { activityLine } from "./activity.ts";
import { broadFolder, realFolder, sameFolder } from "./folders.ts";
import { checkTransport, pinnedLookup, refusal, unsafe } from "./transport.ts";
import { checkTools, toolsStatus } from "./tools.ts";
import {
    canService,
    installService,
    NEEDS_TOTP,
    removeService,
    SERVICE_NEEDS_TOTP,
    SERVICE_UNAVAILABLE,
    serviceActive,
    serviceExitCode,
    serviceHelp,
    serviceMenu,
    serviceName,
    STOPPED_BY_SERVER,
} from "./service.ts";

const HELP = `pi-pocket runner: run session tools on this computer.

A Pi Pocket server keeps Pi, models, provider keys, and session history. Sessions
you start on this computer read and write files and run commands here, as your
user account. Only link a server you trust.

In a terminal, run pi-pocket runner for a menu. For scripts:

  pi-pocket runner start
    Run with the saved link while this terminal or the desktop app is open.
  pi-pocket runner link <server> <code> [--allow-http]
    Link this computer. Get a code in Pi Pocket: Menu > Runners > Link a computer.
    --allow-http also allows plain HTTP to that server (only on a network you trust).
  pi-pocket runner settings [--json]
    Show the settings. Change one with: pi-pocket runner settings <name> <value>
      stop-asking on|off   Approve new sessions in saved folders without a
                           question (default: off). A folder without
                           permission always asks.
      totp-days 1|7|14|30|never
                           How long a session approved with an authenticator
                           code lasts after its last use (default: 7)
      confirm on|off       The same as stop-asking off|on
      http allow|refuse    Plain HTTP to a server that is not this computer or
                           on your tailnet (default: refuse)
      network allow|refuse Sessions' browsers use this computer's network
                           (default: allow)
      downloads <folder>|default
                           Where sessions' browser downloads go, in a folder
                           per session (default: the temporary folder)
  pi-pocket runner status
    Show the link and its settings.
  pi-pocket runner folders [--json]
    Show saved folders, one per line, or a JSON array for a program that runs
    the runner, such as the desktop app.
  pi-pocket runner folders remove <folder>
    Ask again for future sessions there. Approved sessions keep their approval.
  pi-pocket runner sessions [--json]
    Show approved sessions: id, folder, who, how approved, and when each expires.
  pi-pocket runner sessions revoke <id>|all [--json]
    Remove a session's approval. Its next request asks again.
  pi-pocket runner totp setup|status [--json]
  pi-pocket runner totp off <code> [--json]
    An authenticator app (TOTP) lets you approve sessions and folders, and
    change these settings, from Pi Pocket with a 6-digit code. Set it up here.
    Turning it off needs a code. Lost your authenticator? Unlink this computer
    (pi-pocket runner unlink, or Unlink in a program that runs the runner, such
    as the desktop app), then link it again.
${serviceHelp()}
  pi-pocket runner unlink
    Delete the saved link and all runner settings, including the authenticator,
    saved folders, and approved sessions. No code is needed. Linking again needs
    a new link code from Menu > Runners. Also remove this computer there.

Options:
  --config FILE       Link file (default: ~/.pi-pocket/runner.json)
  --confirm-via stdio For a program that runs the runner, such as the desktop
                      app: ask through stdin and stdout, and say on stdout
                      when sessions work here (PI-POCKET-ACTIVITY)
  -h, --help          Show this help

Environment:
  PI_POCKET_RUNNER_CONFIG   Link file, unless --config is set
  PI_POCKET_RUNNER_DAEMON   Use this pi-env daemon instead of the packaged one

Plain HTTP is used only to this computer, or to a device on your tailnet as
Tailscale reports it. Anything else needs https://, or "http allow".`;

type Link = RunnerLinkFile;

/** The exit code when the server ended the link for good: starting it again would not help. */
export { STOPPED_BY_SERVER } from "./service.ts";
/** What the desktop app reads on stdout: a question (`CONFIRM`), and that it no longer stands (`CONFIRM-END`). */
const CONFIRM_LINE = "PI-POCKET-CONFIRM";
const CONFIRM_END_LINE = "PI-POCKET-CONFIRM-END";

const UNLINKED =
    "Deleted the saved link and all runner settings from this computer, including the authenticator, saved folders, and approved sessions.\nTo link again, get a new link code in Pi Pocket: Menu > Runners > Link a computer.\nIn Pi Pocket, also remove this computer from Menu > Runners to stop its runner and cancel its key.";

/** A problem the person can fix and try again: the menu says it and goes on, the commands stop. */
class Problem extends Error {}

function fail(message: string): never {
    restoreTerminal();
    console.error(`pi-pocket runner: ${message}`);
    process.exit(1);
}

function log(line: string): void {
    const time = new Date().toLocaleTimeString([], { hour12: false });

    for (const each of line.split("\n")) {
        console.log(`[${time}] ${each}`);
    }
}

/** Take `--name value` out of `args`; undefined when absent. */
function option(args: string[], name: string, example: string): string | undefined {
    const at = args.indexOf(name);

    if (at < 0) {
        return undefined;
    }

    const value = args[at + 1];

    if (value === undefined || value.startsWith("--")) {
        fail(`${name} needs a value. Example: ${name} ${example}`);
    }

    args.splice(at, 2);

    return value;
}

// ─── The link file ──────────────────────────────────────────────────────

function readLink(file: string): Link | undefined {
    if (!existsSync(file)) {
        return undefined;
    }

    try {
        const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Link>;

        if (
            typeof value.server === "string" &&
            typeof value.id === "string" &&
            typeof value.name === "string" &&
            typeof value.key === "string"
        ) {
            return value as Link;
        }
    } catch {
        // Below.
    }

    throw new Problem(
        `${file} is not a valid link file. Move or remove it, then link this computer again.`,
    );
}

function writeLink(file: string, link: Link): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;

    writeFileSync(temp, `${JSON.stringify(link, null, "\t")}\n`, { mode: 0o600 });
    renameSync(temp, file);

    try {
        chmodSync(file, 0o600);
    } catch {
        // Windows: the file is in the person's own profile.
    }
}

/**
 * The settings with their defaults filled in; `downloads` undefined is the temporary folder. The authenticator and
 * approved sessions are not settings a new link keeps.
 */
type FullSettings = {
    confirm: boolean;
    allowHttp: boolean;
    network: boolean;
    downloads: string | undefined;
    folders: string[];
    totpDays: number | null;
};

function settingsOf(link: Link | undefined): FullSettings {
    return {
        confirm: link?.settings?.confirm !== false,
        allowHttp: link?.settings?.allowHttp === true,
        network: link?.settings?.network !== false,
        downloads: link?.settings?.downloads,
        folders: link?.settings?.folders ?? [],
        totpDays: link?.settings?.totpDays === undefined ? 7 : link.settings.totpDays,
    };
}

const WRONG_CODE = "That code is wrong or used. Try the next one.";

/** `--json` commands print their errors on stdout as JSON, for programs that run the runner. */
function failWith(json: boolean, message: string): never {
    if (json) {
        restoreTerminal();
        console.log(JSON.stringify({ ok: false, error: message }));
        process.exit(1);
    }

    fail(message);
}

function daysLine(days: number | null): string {
    return days === null ? "never" : String(days);
}

/** A downloads folder as the person typed it: `~` is the home folder, a relative one is from here. */
function downloadsFolder(typed: string): string {
    const folder = typed.trim();

    return folder === "~" || folder.startsWith("~/")
        ? join(homedir(), folder.slice(1))
        : resolve(folder);
}

/** Where downloads go, as the settings say it. */
function downloadsLine(settings: FullSettings): string {
    return settings.downloads ?? "default (the temporary folder)";
}

/** Change settings in the link file, keeping the rest. */
function changeSettings(file: string, change: RunnerSettings): Link {
    const saved = readLink(file);

    if (saved === undefined) {
        throw new Problem("This computer is not linked yet. Link it first.");
    }

    const next = { ...saved, settings: { ...saved.settings, ...change } };

    writeLink(file, next);

    return next;
}

// ─── Linking ────────────────────────────────────────────────────────────

/** The server's address as given: http(s) only, without a trailing slash. */
function serverAddress(given: string): string {
    let url: URL;

    try {
        url = new URL(given.includes("://") ? given : `http://${given}`);
    } catch {
        throw new Problem(
            `"${given}" is not a server address. Enter an address such as https://pocket.example.com.`,
        );
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Problem(
            `"${given}" is not an HTTP address. Use http:// or https:// (example: https://pocket.example.com).`,
        );
    }

    url.search = "";
    url.hash = "";

    return url.toString().replace(/\/+$/, "");
}

/** Whether a Pi Pocket server answers at `server`: its `/api/pocket/info`. */
async function checkServer(server: string): Promise<void> {
    let response: Response;

    try {
        response = await fetch(`${server}/api/pocket/info`, {
            signal: AbortSignal.timeout(10_000),
        });
    } catch (error) {
        throw new Problem(
            `Could not reach ${server} (${(error as Error).message}). Check the address and network, then try again.`,
        );
    }

    const info = (await response.json().catch(() => undefined)) as { name?: unknown } | undefined;

    if (!response.ok || info?.name !== "pi-pocket") {
        throw new Problem(
            `Pi Pocket did not answer at ${server} (HTTP ${String(response.status)}). Use the address that opens Pi Pocket in your browser.`,
        );
    }
}

/** Trade a one-time code for this computer's link to `server`. */
async function redeem(server: string, code: string, settings: RunnerSettings): Promise<Link> {
    let response: Response;
    // Over plain HTTP to this computer or a tailnet device: only to the addresses checked (`pinnedLookup`).
    const lookup = pinnedLookup(await checkTransport(server, settings.allowHttp === true));
    const dispatcher = lookup === undefined ? undefined : new Agent({ connect: { lookup } });

    try {
        response = (await undiciFetch(`${server}${LINK_CODE_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-pocket": "1" },
            body: JSON.stringify({ code: code.trim() }),
            signal: AbortSignal.timeout(15_000),
            ...(dispatcher === undefined ? {} : { dispatcher }),
        })) as unknown as Response;
    } catch (error) {
        throw new Problem(
            `Could not reach ${server} (${(error as Error).message}). Check the address and network, then try again.`,
        );
    }

    const text = await response.text();

    if (!response.ok) {
        let message = text;

        try {
            message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
            // As it is.
        }

        // The server's message says what to do (a new code in Menu → Runners); say it only when it does not.
        throw new Problem(
            message
                ? `${server} did not accept the code: ${message}`
                : `${server} did not accept the code (${response.statusText}). Get a new one in Menu > Runners > Link a computer.`,
        );
    }

    let got: { id?: unknown; name?: unknown; key?: unknown } = {};

    try {
        got = JSON.parse(text) as typeof got;
    } catch {
        // Below.
    }

    if (typeof got.id !== "string" || typeof got.name !== "string" || typeof got.key !== "string") {
        throw new Problem(
            `${server} returned an invalid link. Check the server address, then make a new code in Menu > Runners.`,
        );
    }

    return { server, id: got.id, name: got.name, key: got.key, settings };
}

/** What linking trusts, said where people link (the Runners sheet and the desktop app say it too). */
const TRUST =
    "This computer will trust the server fully. Sessions started here run commands and change\nfiles as your user, with everything you can reach. Nothing runs in a sandbox.";

/** `pi-pocket runner link <server> <code>`: no questions; plain HTTP only where `transport.ts` allows it. */
async function link(file: string, args: string[]): Promise<void> {
    // `--allow-http`: the person allowed plain HTTP to this server (the desktop app's switch); kept with the link.
    const allow = args.includes("--allow-http");
    const [given, code] = args.filter((arg) => arg !== "--allow-http");

    if (given === undefined || code === undefined) {
        fail(
            "Enter a server address and a one-time code.\nExample: pi-pocket runner link https://pocket.example.com ABCD-EFGH-JKLM\nIn a terminal, pi-pocket runner walks you through it.",
        );
    }

    try {
        const server = serverAddress(given);
        const previous = existsSync(file) ? readLink(file) : undefined;
        const saved = settingsOf(previous);
        // Plain HTTP was allowed for that server only: another server needs --allow-http again.
        const sameServer = previous !== undefined && previous.server === server;
        const kept = allow
            ? { ...saved, allowHttp: true }
            : { ...saved, allowHttp: sameServer && saved.allowHttp };
        const transport = await checkTransport(server, kept.allowHttp);

        if (!transport.ok) {
            throw new Problem(refusal(server, transport));
        }

        const got = await redeem(server, code, kept);

        writeLink(file, got);
        console.log(`Linked "${got.name}" to ${got.server}.`);
        console.log(TRUST.replace(/\n/g, " "));
        console.log(`Link file: ${file}. It contains this computer's key. Do not share it.`);
        console.log("To start the runner, run: pi-pocket runner start");
    } catch (error) {
        fail((error as Error).message);
    }
}

// ─── Settings ───────────────────────────────────────────────────────────

/** The settings, one per line, as `settings` prints them and the desktop app reads them. */
function settingsLines(settings: FullSettings, totp: boolean): string[] {
    return [
        `confirm ${settings.confirm ? "on" : "off"}`,
        `http ${settings.allowHttp ? "allow" : "refuse"}`,
        `network ${settings.network ? "allow" : "refuse"}`,
        `downloads ${settings.downloads ?? "default"}`,
        `stop-asking ${settings.confirm ? "off" : "on"}`,
        `totp-days ${daysLine(settings.totpDays)}`,
        `totp ${totp ? "on" : "off"}`,
    ];
}

/** The settings for programs: the same names as the server's Runners uses. */
function settingsJson(link: Link): Record<string, unknown> {
    const settings = settingsOf(link);

    return {
        stopAsking: !settings.confirm,
        totpDays: settings.totpDays,
        allowHttp: settings.allowHttp,
        network: settings.network,
        downloads: settings.downloads ?? null,
        totp: link.settings?.totp !== undefined,
    };
}

/** `pi-pocket runner settings [name value]`: show the settings, or change one. */
function settingsCommand(file: string, args: string[]): void {
    const json = args.includes("--json");
    const [name, value] = args.filter((arg) => arg !== "--json");

    const done = (text: string) => {
        console.log(
            json ? JSON.stringify({ ok: true, settings: settingsJson(readLink(file)!) }) : text,
        );
    };

    try {
        if (name === undefined) {
            const saved = readLink(file);

            if (saved === undefined) {
                throw new Problem("This computer is not linked yet. Link it first.");
            }

            console.log(
                json
                    ? JSON.stringify(settingsJson(saved))
                    : settingsLines(settingsOf(saved), saved.settings?.totp !== undefined).join(
                          "\n",
                      ),
            );

            return;
        }

        if ((name === "confirm" || name === "stop-asking") && (value === "on" || value === "off")) {
            const confirm = name === "confirm" ? value === "on" : value === "off";

            changeSettings(file, { confirm });
            done(
                confirm
                    ? "This computer asks before each new session starts here."
                    : "New sessions in saved folders are approved without a question. A folder without permission still asks.",
            );

            return;
        }

        if (name === "totp-days" && ["1", "7", "14", "30", "never"].includes(value ?? "")) {
            const days = value === "never" ? null : Number(value);

            changeSettings(file, { totpDays: days });
            done(
                days === null
                    ? "Sessions approved with an authenticator code do not expire."
                    : `Sessions approved with an authenticator code expire ${days} ${days === 1 ? "day" : "days"} after their last use.`,
            );

            return;
        }

        if (name === "http" && (value === "allow" || value === "refuse")) {
            changeSettings(file, { allowHttp: value === "allow" });
            done(
                value === "allow"
                    ? "Plain HTTP to this server is allowed. Anyone on the network can read this computer's key and its commands."
                    : "Plain HTTP is used only to this computer or a device on your tailnet.",
            );

            return;
        }

        if (name === "network" && (value === "allow" || value === "refuse")) {
            changeSettings(file, { network: value === "allow" });
            done(
                value === "allow"
                    ? "Sessions' browsers open their connections from this computer: they reach what it reaches, including its localhost and local network."
                    : "Sessions' browsers cannot open pages through this computer.",
            );

            return;
        }

        if (name === "downloads" && value !== undefined && value.trim() !== "") {
            const folder = value === "default" ? undefined : downloadsFolder(value);

            changeSettings(file, { downloads: folder });
            done(
                folder === undefined
                    ? "Sessions' browser downloads go to this computer's temporary folder, in pi-pocket-downloads/<session>/. The system can clear it on restart: move files to keep."
                    : `Sessions' browser downloads go to ${join(folder, "<session>")}, each session to its own folder only. A running runner uses it once it reconnects.`,
            );

            return;
        }

        throw new Problem(
            "Use: pi-pocket runner settings stop-asking on|off, totp-days 1|7|14|30|never, http allow|refuse, network allow|refuse, or downloads <folder>|default",
        );
    } catch (error) {
        failWith(json, (error as Error).message);
    }
}

// ─── Authenticator (TOTP) ───────────────────────────────────────────────

const TOTP_USE =
    "Use: pi-pocket runner totp setup, pi-pocket runner totp status, or pi-pocket runner totp off <code> [--json]";

/** One line of stdin at a time, for `--json` setup from a program that runs the runner. */
function stdinLines(): { next: () => Promise<string | undefined>; close: () => void } {
    const lines = createInterface({ input: process.stdin });
    const iterator = lines[Symbol.asyncIterator]();

    return {
        next: async () => {
            const got = await iterator.next();

            return got.done === true ? undefined : String(got.value);
        },
        close: () => lines.close(),
    };
}

/**
 * Make a secret, show it, and save it only after one correct code: this proves the authenticator works and that the
 * person is at this computer. With `--json`: a `{ secret, link }` line, then one code per stdin line, each answered
 * with `{ ok }`.
 */
async function totpSetup(file: string, saved: Link, json: boolean): Promise<void> {
    if (saved.settings?.totp !== undefined) {
        throw new Problem(
            "An authenticator is already set up. To replace it, turn it off first: pi-pocket runner totp off <code>",
        );
    }

    if (!json && !interactive) {
        throw new Problem(
            "Set up the authenticator in a terminal, or add --json in a program that runs the runner.",
        );
    }

    const secret = newSecret();
    const link = authenticatorLink(secret, saved.name);
    const state: TotpState = { secret };
    const input = json ? stdinLines() : undefined;

    if (json) {
        console.log(JSON.stringify({ secret, link }));
    } else {
        console.log("");
        console.log(
            "  Scan this code with your authenticator app, or open the link on this device:",
        );
        console.log("");

        for (const line of await qrLines(link)) {
            console.log(`  ${line}`);
        }

        console.log("");
        console.log(`  ${link}`);
        console.log(dim(`  Or enter this key by hand: ${secret}`));
        console.log("");
    }

    try {
        for (let tries = 0; tries < 5; tries++) {
            const code = json
                ? await input!.next()
                : await ask("Code from your authenticator (empty to cancel)");

            if (code === undefined || code.trim() === "") {
                throw new Problem("Cancelled. No authenticator was saved.");
            }

            if (checkCode(state, code.trim())) {
                changeSettings(file, { totp: { secret, lastStep: state.lastStep! } });
                console.log(
                    json
                        ? JSON.stringify({ ok: true, totp: true })
                        : green(
                              "  Authenticator set up. Pi Pocket can now approve sessions and folders, and change settings, with a code.",
                          ),
                );

                return;
            }

            console.log(
                json ? JSON.stringify({ ok: false, error: WRONG_CODE }) : `  ${WRONG_CODE}`,
            );
        }

        throw new Problem("Too many wrong codes. No authenticator was saved. Run the setup again.");
    } finally {
        input?.close();
    }
}

/** `pi-pocket runner totp setup|status|off <code>`: set up and turned off only here. */
async function totpCommand(file: string, args: string[]): Promise<void> {
    const json = args.includes("--json");
    const [action, code, extra] = args.filter((arg) => arg !== "--json");

    try {
        const saved = readLink(file);

        if (saved === undefined) {
            throw new Problem("This computer is not linked yet. Link it first.");
        }

        const totp = saved.settings?.totp;

        if (action === "status" && code === undefined) {
            const locked = (totp?.lockedUntil ?? 0) > Date.now();

            console.log(
                json
                    ? JSON.stringify({
                          totp: totp !== undefined,
                          locked,
                          ...(locked ? { lockedUntil: totp!.lockedUntil } : {}),
                      })
                    : totp === undefined
                      ? "No authenticator set up. Set it up with: pi-pocket runner totp setup"
                      : `Authenticator set up.${locked ? ` Codes are refused until ${new Date(totp.lockedUntil!).toLocaleTimeString()} after too many wrong ones.` : ""}`,
            );

            return;
        }

        if (action === "setup" && code === undefined) {
            await totpSetup(file, saved, json);

            return;
        }

        if (action === "off" && extra === undefined) {
            if (totp === undefined) {
                console.log(
                    json
                        ? JSON.stringify({ ok: true, totp: false })
                        : "No authenticator is set up.",
                );

                return;
            }

            const given =
                code ?? (interactive && !json ? await ask("Code from your authenticator") : "");

            if (given.trim() === "") {
                throw new Problem(
                    "Turning the authenticator off needs a code: pi-pocket runner totp off <code>. Lost your authenticator? Unlink this computer (pi-pocket runner unlink), then link it again.",
                );
            }

            const state = structuredClone(totp);

            if (!checkCode(state, given.trim())) {
                // The failure counts toward the lockout.
                changeSettings(file, { totp: state });

                throw new Problem(WRONG_CODE);
            }

            changeSettings(file, { totp: undefined });
            console.log(
                json
                    ? JSON.stringify({ ok: true, totp: false })
                    : "Authenticator turned off. Sessions and settings are approved only on this computer now.",
            );

            return;
        }

        throw new Problem(TOTP_USE);
    } catch (error) {
        failWith(json, (error as Error).message);
    }
}

// ─── Approved sessions ──────────────────────────────────────────────────

function sessionRows(link: Link) {
    const now = Date.now();

    return (link.settings?.sessions ?? []).map((session) => {
        const expiresAt = session.ttlMs === null ? null : session.idleAt + session.ttlMs;

        return {
            id: session.id,
            folder: session.folder,
            person: session.person,
            approvedBy: session.approvedBy,
            approvedAt: session.approvedAt,
            expiresAt,
            expired: expiresAt !== null && expiresAt <= now,
        };
    });
}

const HOW = { computer: "at this computer", automatic: "without a question", totp: "with a code" };

function sessionLine(row: ReturnType<typeof sessionRows>[number]): string {
    const until =
        row.expiresAt === null
            ? "no expiry"
            : `${row.expired ? "expired" : "expires"} ${new Date(row.expiresAt).toLocaleString()}`;

    return `${row.id}  ${row.folder}  ${row.person}, approved ${HOW[row.approvedBy]}, ${until}`;
}

/** `pi-pocket runner sessions [--json]` and `sessions revoke <id>|all`: no code needed to remove access. */
function sessionsCommand(file: string, args: string[]): void {
    const json = args.includes("--json");
    const rest = args.filter((arg) => arg !== "--json");

    try {
        const saved = readLink(file);

        if (saved === undefined) {
            throw new Problem("This computer is not linked yet. Link it first.");
        }

        const rows = sessionRows(saved);

        if (rest.length === 0) {
            console.log(
                json
                    ? JSON.stringify(rows)
                    : rows.map(sessionLine).join("\n") ||
                          "No approved sessions. A session asks for approval on its first request.",
            );

            return;
        }

        if (rest.length === 2 && rest[0] === "revoke") {
            const id = rest[1]!;

            if (id !== "all" && !rows.some((row) => row.id === id)) {
                throw new Problem(
                    `No approved session "${id}". Run pi-pocket runner sessions to see the list.`,
                );
            }

            const kept =
                id === "all" ? [] : (saved.settings?.sessions ?? []).filter((s) => s.id !== id);

            changeSettings(file, { sessions: kept });
            console.log(
                json
                    ? JSON.stringify({ ok: true, revoked: rows.length - kept.length })
                    : `Revoked ${rows.length - kept.length} ${rows.length - kept.length === 1 ? "session" : "sessions"}. The next request of each asks again.`,
            );

            return;
        }

        throw new Problem(
            "Use: pi-pocket runner sessions [--json], or pi-pocket runner sessions revoke <id>|all [--json]",
        );
    } catch (error) {
        failWith(json, (error as Error).message);
    }
}

// ─── Allowed folders ────────────────────────────────────────────────────

async function removeFolder(file: string, folder: string): Promise<void> {
    const folders = readLink(file)?.settings?.folders ?? [];
    const matches = await Promise.all(folders.map((saved) => sameFolder(saved, resolve(folder))));

    if (!matches.some(Boolean)) {
        throw new Problem(
            `No allowed folder matches "${folder}". Run pi-pocket runner folders to see the list.`,
        );
    }

    changeSettings(file, { folders: folders.filter((_, index) => !matches[index]) });
}

/** List or remove only: a folder can be added only by allowing a local question. */
async function foldersCommand(file: string, args: string[]): Promise<void> {
    try {
        if (args.length === 0 || (args.length === 1 && args[0] === "--json")) {
            const folders = readLink(file)?.settings?.folders ?? [];
            const home = await realFolder(homedir());
            const lines = await Promise.all(
                folders.map(async (folder) =>
                    broadFolder(await realFolder(folder), home)
                        ? `${folder} (ignored: a root, the home folder, or a folder that contains it is never saved)`
                        : folder,
                ),
            );

            console.log(
                args[0] === "--json"
                    ? JSON.stringify(folders)
                    : lines.join("\n") || "No saved folders yet.",
            );

            return;
        }

        if (args.length === 2 && args[0] === "remove" && !args[1]!.startsWith("--")) {
            await removeFolder(file, args[1]!);
            console.log(
                `Removed "${args[1]}". Running sessions keep running; new sessions there can ask again.`,
            );

            return;
        }

        throw new Problem(
            "Use: pi-pocket runner folders [--json], or pi-pocket runner folders remove <folder> [--config FILE]",
        );
    } catch (error) {
        failWith(args.includes("--json"), (error as Error).message);
    }
}

async function foldersMenu(file: string): Promise<void> {
    for (;;) {
        const folders = readLink(file)?.settings?.folders ?? [];

        if (folders.length === 0) {
            console.log("  No saved folders yet.");

            return;
        }

        const picked = await choose(
            "Allowed folders",
            [
                ...folders.map((folder) => ({
                    label: folder,
                    detail: "remove: ask again for future sessions",
                })),
                { label: "Back", detail: "" },
            ],
            folders.length,
            { clear: true },
        );

        if (picked === undefined || picked === folders.length) {
            return;
        }

        await removeFolder(file, folders[picked]!);
        console.log("  Removed. Sessions that run there keep running.");
    }
}

async function sessionsMenu(file: string): Promise<void> {
    for (;;) {
        const saved = readLink(file);
        const rows = saved === undefined ? [] : sessionRows(saved);

        if (rows.length === 0) {
            console.log("  No approved sessions.");

            return;
        }

        const picked = await choose(
            "Approved sessions",
            [
                ...rows.map((row) => ({
                    label: `${row.person}: ${row.folder}`,
                    detail: `revoke; ${row.expiresAt === null ? "no expiry" : `${row.expired ? "expired" : "expires"} ${new Date(row.expiresAt).toLocaleString()}`}`,
                })),
                { label: "Revoke all", detail: "each session asks again on its next request" },
                { label: "Back", detail: "" },
            ],
            rows.length + 1,
            { clear: true },
        );

        if (picked === undefined || picked === rows.length + 1) {
            return;
        }

        const kept =
            picked === rows.length
                ? []
                : (saved!.settings?.sessions ?? []).filter((s) => s.id !== rows[picked]!.id);

        changeSettings(file, { sessions: kept });
        console.log("  Revoked. The next request asks again.");
    }
}

// ─── Asking before sessions ─────────────────────────────────────────────

/** In words: what would start, by whom, where. */
function describe(question: SessionQuestion): string {
    if (question.kind === "pi-preview") {
        return `${question.person} wants to see your Pi session "${question.title}" (its last messages and model).\n  Server: ${question.server}\n  Folder: ${question.folder}`;
    }

    const action = question.expired
        ? `continue a session whose approval expired`
        : question.kind === "move"
          ? `move a session to ${question.folder}`
          : `start ${question.kind === "fork" ? "a copy of a session" : "a new session"} on this computer`;
    const permission =
        question.permission === "folder" ? "\n  This folder has no permission yet." : "";

    return `${question.person} wants to ${action}.${permission}\n  Server: ${question.server}\n  Folder: ${question.folder}\n  The session can read and change files and run commands as you, also outside this folder.`;
}

/** Ask on this terminal, with the arrow keys; one question at a time. */
function terminalAsker(): (question: SessionQuestion) => Promise<SessionAnswer> {
    let queue = Promise.resolve();

    return (question) => {
        const answer = queue.then(async (): Promise<SessionAnswer> => {
            if (question.signal.aborted) {
                return { allow: false, reason: "Nobody answered in time." };
            }

            process.stdout.write("\x07");
            console.log("");
            console.log(yellow(`  ${describe(question)}`));

            if (question.broad) {
                console.log(
                    yellow(
                        "  This folder holds everything in it. Saving it would allow sessions in all of it.",
                    ),
                );
            }

            console.log("");

            const picked = await choose(
                "Allow it?",
                [
                    {
                        label: "Deny",
                        detail:
                            question.kind === "pi-preview"
                                ? "the session stays private"
                                : "the session does not start",
                    },
                    {
                        label: question.broad ? "Allow this session only" : "Allow",
                        detail:
                            question.kind === "pi-preview"
                                ? "show its last messages and model; nothing is changed"
                                : question.broad
                                  ? "this folder holds everything in it; nothing is saved"
                                  : question.permission === "folder"
                                    ? "save this folder and approve this session"
                                    : "approve this session",
                    },
                ],
                0,
                { signal: question.signal, clear: true },
            );

            return picked === 1
                ? { allow: true }
                : {
                      allow: false,
                      reason: question.signal.aborted
                          ? "Nobody answered in time."
                          : "The person at this computer denied it.",
                  };
        });

        queue = answer.then(
            () => {},
            () => {},
        );

        return answer;
    };
}

/**
 * Ask through the desktop app: a `PI-POCKET-CONFIRM` line on stdout, the answer as a JSON line on stdin, and a
 * `PI-POCKET-CONFIRM-END` line when the question no longer stands.
 */
function stdioAsker(): (question: SessionQuestion) => Promise<SessionAnswer> {
    const waiting = new Map<number, (answer: SessionAnswer) => void>();
    let next = 1;

    createInterface({ input: process.stdin }).on("line", (line) => {
        try {
            const got = JSON.parse(line) as { id?: unknown; allow?: unknown };

            if (typeof got.id === "number" && typeof got.allow === "boolean") {
                waiting.get(got.id)?.(
                    got.allow
                        ? { allow: true }
                        : { allow: false, reason: "The person at this computer denied it." },
                );
            }
        } catch {
            // Not an answer.
        }
    });

    return (question) => {
        if (question.signal.aborted) {
            return Promise.resolve({ allow: false, reason: "Nobody answered in time." });
        }

        const id = next++;

        return new Promise<SessionAnswer>((resolve) => {
            const done = (answer: SessionAnswer) => {
                waiting.delete(id);
                // Keep the end notice until the runner has saved the answer. The app refreshes its folder list then.
                resolve(answer);
            };

            const ended = () => {
                console.log(`${CONFIRM_END_LINE} ${JSON.stringify({ id })}`);
                done({ allow: false, reason: "Nobody answered in time." });
            };

            waiting.set(id, done);
            question.signal.addEventListener("abort", ended, { once: true });
            console.log(
                `${CONFIRM_LINE} ${JSON.stringify({
                    id,
                    server: question.server,
                    computer: question.computer,
                    person: question.person,
                    folder: question.folder,
                    kind: question.kind,
                    ...(question.title === undefined ? {} : { title: question.title }),
                    broad: question.broad,
                    permission: question.permission,
                    expired: question.expired,
                    session: question.session,
                    totp: question.totp,
                    expiresInMs: question.expiresInMs,
                })}`,
            );
        });
    };
}

// ─── Running ────────────────────────────────────────────────────────────

/** Run with the saved link until stopped, asking on this terminal or through the desktop app. */
async function serve(
    file: string,
    via: "terminal" | "stdio" | "none",
    asService = false,
): Promise<void> {
    let saved: Link | undefined;

    try {
        saved = readLink(file);
    } catch (error) {
        fail((error as Error).message);
    }

    if (saved === undefined) {
        // A service of an unlinked computer cannot start again by itself: the code says so, as for one removed.
        console.error("This computer is not linked. In a terminal, run: pi-pocket runner");
        process.exit(serviceExitCode(STOPPED_BY_SERVER, asService));
    }

    // A service has nobody to ask: without an authenticator, nothing could ever be approved (`service.ts`).
    if (asService && saved.settings?.totp === undefined) {
        console.error(NEEDS_TOTP);
        process.exit(serviceExitCode(SERVICE_NEEDS_TOTP, asService));
    }

    const ask = via === "terminal" ? terminalAsker() : via === "stdio" ? stdioAsker() : undefined;
    const runner = new Runner({
        link: saved,
        version: pocketVersion(),
        ...(process.env.PI_POCKET_RUNNER_DAEMON === undefined
            ? {}
            : { daemon: process.env.PI_POCKET_RUNNER_DAEMON }),
        log,
        // Read each time: `settings` from another terminal (or the desktop app) applies without a restart.
        settings: () => {
            try {
                return readLink(file)?.settings ?? {};
            } catch {
                return saved.settings ?? {};
            }
        },
        saveSettings: (change) => {
            changeSettings(file, change);
        },
        ...(ask === undefined ? {} : { ask }),
        // For the program that runs it: whether sessions work here, and in which folders (`activity.ts`).
        ...(via === "stdio" ? { activity: (state) => console.log(activityLine(state)) } : {}),
    });
    let stopping = false;

    const stop = () => {
        if (stopping) {
            process.exit(130);
        }

        stopping = true;
        restoreTerminal();
        log("Stopping the runner and its commands.");
        void runner.stop();
        setTimeout(() => process.exit(0), 3000).unref();
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    // In a terminal the keys are raw (for the questions): Ctrl+C arrives as a key, not a signal.
    if (via === "terminal" && interactive) {
        onKeys((key) => key === "ctrl-c" && stop());
    }

    const current = settingsOf(saved);

    log(`pi-pocket runner ${pocketVersion()}: "${saved.name}", for ${saved.server}`);
    log(
        via === "none"
            ? "Nobody can answer questions here. Sessions are approved only with an authenticator code from Pi Pocket, or without a question in saved folders when stop-asking is on."
            : current.confirm
              ? "Asks before a new session starts here."
              : "Approves new sessions in saved folders without a question.",
    );

    if (via === "terminal") {
        log("Press Ctrl+C to stop.");
    }

    runner.start();

    try {
        await runner.finished;
    } catch (error) {
        restoreTerminal();

        if (error instanceof RunnerStopped) {
            console.error(`pi-pocket runner: ${error.message}`);
            process.exit(serviceExitCode(STOPPED_BY_SERVER, asService));
        }

        throw error;
    }
}

async function status(file: string): Promise<string> {
    const saved = readLink(file);
    const tools = toolsStatus(await checkTools(), process.platform);

    if (saved === undefined) {
        return `This computer is not linked.\nIn a terminal, run pi-pocket runner to link it.\n${tools}`;
    }

    const settings = settingsOf(saved);

    return [
        `Runner: Pi Pocket ${pocketVersion()}`,
        `Computer: ${saved.name}`,
        `Server: ${saved.server}`,
        `Link file: ${file}`,
        tools,
        `Stop asking on new sessions: ${settings.confirm ? "off" : "on"}`,
        `Session expiry with a code: ${settings.totpDays === null ? "no expiry" : `${settings.totpDays} days`}`,
        `Authenticator: ${saved.settings?.totp === undefined ? "not set up" : "set up"}`,
        `Approved sessions: ${saved.settings?.sessions?.length ?? 0}`,
        `Plain HTTP: ${settings.allowHttp ? "allowed to this server" : "only to this computer or your tailnet"}`,
        `Share the network with browsers: ${settings.network ? "on" : "off"}`,
        `Browser downloads: ${downloadsLine(settings)}`,
        ...(serviceActive() ? [`Service: ${serviceName()} (running)`] : []),
    ].join("\n");
}

// ─── The service ────────────────────────────────────────────────────────

/** Install or remove the platform's service (`service.ts`), keeping the saved link. */
function service(file: string, args: string[]): void {
    if (!canService()) {
        fail(SERVICE_UNAVAILABLE);
    }

    try {
        if (args[0] === "remove") {
            console.log(removeService(file));

            return;
        }

        const saved = readLink(file);

        if (saved === undefined) {
            fail("This computer is not linked. In a terminal, run: pi-pocket runner");
        }

        const messages = installService({
            node: process.execPath,
            launcher: realpathSync(process.argv[1] ?? ""),
            file,
            path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            home: homedir(),
            authenticator: saved.settings?.totp !== undefined,
        });

        for (const message of messages) {
            console.log(message);
        }
    } catch (error) {
        fail((error as Error).message);
    }
}

// ─── The menu ───────────────────────────────────────────────────────────

/**
 * Read one line on the terminal, out of raw mode (so it echoes and edits as usual), then back: the menus' keys go on
 * where they were. An empty answer is the person going back.
 */
async function ask(question: string): Promise<string> {
    restoreTerminal();
    process.stdin.setEncoding("utf8");
    const lines = createQuestions({ input: process.stdin, output: process.stdout });

    try {
        return (await lines.question(`  ${question}: `)).trim();
    } finally {
        lines.close();
    }
}

/** Link through questions: the address, a check, the code. Undefined when the person gave up. */
async function linkInteractively(file: string): Promise<Link | undefined> {
    console.log("");
    console.log(bold("  Link this computer"));
    console.log(yellow(`  ${TRUST.replace(/\n/g, "\n  ")}`));
    console.log(dim("  Empty answer to go back."));
    console.log("");

    let server = "";
    let settings: FullSettings = settingsOf(undefined);

    while (server === "") {
        const given = await ask(
            "Server address, as you open Pi Pocket in a browser (example: https://pocket.example.com)",
        );

        if (given === "") {
            return undefined;
        }

        try {
            server = serverAddress(given);

            const transport = await checkTransport(server, false);

            if (!transport.ok) {
                console.log("");
                console.log(yellow(`  ${unsafe(server, transport).replace(/\n/g, "\n  ")}`));
                console.log("");

                const picked = await choose(
                    "Plain HTTP to this server?",
                    [
                        {
                            label: "Enter another address",
                            detail: "https://, or one on your tailnet",
                        },
                        { label: "Allow plain HTTP", detail: "only on a network you trust" },
                    ],
                    0,
                    { clear: true },
                );

                if (picked !== 1) {
                    server = "";
                    continue;
                }

                settings = { ...settings, allowHttp: true };
            } else if (transport.why === "tailscale") {
                console.log(dim(`  ${server} is on your tailnet: plain HTTP is safe there.`));
            }

            await checkServer(server);
        } catch (error) {
            if (!(error instanceof Problem)) {
                throw error;
            }

            console.log(`  ${error.message.replace(/\n/g, "\n  ")}`);
            server = "";
        }
    }

    console.log(green(`  Found Pi Pocket at ${server}.`));
    console.log("");
    console.log("  In Pi Pocket, open Menu > Runners > Link a computer, name this computer,");
    console.log("  and choose Get a link code.");
    console.log(dim("  The code works once, for 10 minutes."));

    for (;;) {
        const code = await ask("One-time code (example: ABCD-EFGH-JKLM)");

        if (code === "") {
            return undefined;
        }

        try {
            const got = await redeem(server, code, settings);

            writeLink(file, got);
            console.log(green(`  Linked "${got.name}" to ${got.server}.`));
            console.log(
                dim(`  Link file: ${file}. It contains this computer's key. Do not share it.`),
            );

            return got;
        } catch (error) {
            if (!(error instanceof Problem)) {
                throw error;
            }

            console.log(`  ${error.message.replace(/\n/g, "\n  ")}`);
        }
    }
}

/** The settings, each toggled with Enter, until Back. */
async function settingsMenu(file: string): Promise<void> {
    let at = 0;

    for (;;) {
        const settings = settingsOf(readLink(file));
        const picked = await choose(
            "Runner settings",
            [
                {
                    label: `Stop asking on new sessions: ${settings.confirm ? "off" : "on"}`,
                    detail: settings.confirm
                        ? "each new session asks first"
                        : "sessions in saved folders are approved without a question",
                },
                {
                    label: `Session expiry with a code: ${settings.totpDays === null ? "no expiry" : `${settings.totpDays} days`}`,
                    detail: "1, 7, 14, 30 days, or no expiry",
                },
                {
                    label: `Authenticator: ${readLink(file)?.settings?.totp === undefined ? "set up" : "turn off"}`,
                    detail: "approve sessions from Pi Pocket with a code",
                },
                {
                    label: `Allow plain HTTP: ${settings.allowHttp ? "on" : "off"}`,
                    detail: settings.allowHttp
                        ? "to this server, on any network"
                        : "only this computer and your tailnet",
                },
                {
                    label: `Share the network with browsers: ${settings.network ? "on" : "off"}`,
                    detail: settings.network
                        ? "sessions' browsers browse from here"
                        : "sessions' browsers cannot open pages",
                },
                {
                    label: `Browser downloads: ${downloadsLine(settings)}`,
                    detail: "a folder per session",
                },
                { label: "Back", detail: "" },
            ],
            at,
            { clear: true },
        );

        if (picked === undefined || picked === 6) {
            return;
        }

        at = picked;

        if (picked === 0) {
            changeSettings(file, { confirm: !settings.confirm });
        } else if (picked === 1) {
            const days = [1, 7, 14, 30, null];
            const chosen = await choose(
                "Session expiry with a code",
                days.map((value) => ({
                    label:
                        value === null ? "No expiry" : `${value} ${value === 1 ? "day" : "days"}`,
                    detail: "after the session's last use",
                })),
                Math.max(0, days.indexOf(settings.totpDays)),
                { clear: true },
            );

            if (chosen !== undefined) {
                changeSettings(file, { totpDays: days[chosen]! });
            }
        } else if (picked === 2) {
            const saved = readLink(file)!;

            try {
                if (saved.settings?.totp === undefined) {
                    await totpSetup(file, saved, false);
                } else {
                    const code = await ask("Code from your authenticator");
                    const state = structuredClone(saved.settings.totp);

                    if (code === "") {
                        continue;
                    }

                    if (checkCode(state, code)) {
                        changeSettings(file, { totp: undefined });
                        console.log("  Authenticator turned off.");
                    } else {
                        changeSettings(file, { totp: state });
                        console.log(`  ${WRONG_CODE}`);
                    }
                }
            } catch (error) {
                if (!(error instanceof Problem)) {
                    throw error;
                }

                console.log(`  ${error.message}`);
            }
        } else if (picked === 3) {
            changeSettings(file, { allowHttp: !settings.allowHttp });
        } else if (picked === 4) {
            changeSettings(file, { network: !settings.network });
        } else {
            const typed = await ask("Downloads folder (default for the temporary folder)");

            if (typed !== "") {
                changeSettings(file, {
                    downloads: typed === "default" ? undefined : downloadsFolder(typed),
                });
            }
        }
    }
}

/** `pi-pocket runner` in a terminal: what is linked, and a menu of what to do. */
async function menu(file: string): Promise<void> {
    console.log("");
    console.log(`  ${accent("π")} ${bold("Pi Pocket runner")} ${dim(pocketVersion())}`);
    console.log(dim("  Run session tools on this computer, for a Pi Pocket server you trust."));

    for (;;) {
        let saved: Link | undefined;

        try {
            saved = readLink(file);
        } catch (error) {
            fail((error as Error).message);
        }

        console.log("");
        console.log(
            saved === undefined
                ? `  ${yellow("Not linked yet.")}`
                : `  Linked as ${bold(saved.name)} to ${saved.server}`,
        );
        console.log("");

        const serviceLabels = serviceMenu();
        const choices: (Choice & { run: () => Promise<boolean> })[] =
            saved === undefined
                ? [
                      {
                          label: "Link this computer",
                          detail: "with a code from Menu > Runners",
                          run: async () => {
                              await linkInteractively(file);

                              return false;
                          },
                      },
                      {
                          label: "Help",
                          detail: "commands and options",
                          run: async () => {
                              console.log(`\n${HELP}`);

                              return false;
                          },
                      },
                      { label: "Quit", detail: "", run: async () => true },
                  ]
                : [
                      {
                          label: "Start",
                          detail: "run here until Ctrl+C",
                          run: async () => {
                              await serve(file, "terminal");

                              return true;
                          },
                      },
                      {
                          label: "Settings",
                          detail: "asking before sessions, plain HTTP",
                          run: async () => {
                              await settingsMenu(file);

                              return false;
                          },
                      },
                      {
                          label: "Saved folders",
                          detail: "folders with permission",
                          run: async () => {
                              await foldersMenu(file);

                              return false;
                          },
                      },
                      {
                          label: "Approved sessions",
                          detail: "revoke one or all",
                          run: async () => {
                              await sessionsMenu(file);

                              return false;
                          },
                      },
                      ...(canService()
                          ? [
                                serviceActive()
                                    ? {
                                          label: serviceLabels.stop,
                                          detail: "keep the link",
                                          run: async () => {
                                              service(file, ["remove"]);

                                              return false;
                                          },
                                      }
                                    : {
                                          label: serviceLabels.start,
                                          detail:
                                              saved.settings?.totp === undefined
                                                  ? "needs an authenticator first (Settings)"
                                                  : serviceLabels.detail,
                                          run: async () => {
                                              if (saved.settings?.totp === undefined) {
                                                  console.log("");
                                                  console.log(
                                                      yellow(
                                                          `  ${NEEDS_TOTP.replace(/\n/g, "\n  ")}`,
                                                      ),
                                                  );

                                                  return false;
                                              }

                                              service(file, []);

                                              return false;
                                          },
                                      },
                            ]
                          : []),
                      {
                          label: "Link again",
                          detail: "replace the link with a new code",
                          run: async () => {
                              await linkInteractively(file);

                              return false;
                          },
                      },
                      {
                          label: "Unlink",
                          detail: "delete the link on this computer",
                          run: async () => {
                              const sure = await choose(
                                  `Unlink ${saved.name}?`,
                                  [
                                      { label: "Cancel", detail: "" },
                                      {
                                          label: "Unlink",
                                          detail: "delete the link and all runner settings, including the authenticator",
                                      },
                                  ],
                                  0,
                                  { clear: true },
                              );

                              if (sure === 1) {
                                  rmSync(file, { force: true });
                                  console.log(`  ${UNLINKED.replace(/\n/g, "\n  ")}`);
                              }

                              return false;
                          },
                      },
                      {
                          label: "Help",
                          detail: "commands and options",
                          run: async () => {
                              console.log(`\n${HELP}`);

                              return false;
                          },
                      },
                      { label: "Quit", detail: "", run: async () => true },
                  ];

        const picked = await choose("What next?", choices, 0, { clear: true });

        if (picked === undefined) {
            break;
        }

        try {
            if (await choices[picked]!.run()) {
                break;
            }
        } catch (error) {
            if (!(error instanceof Problem)) {
                throw error;
            }

            console.log(`  ${error.message}`);
        }
    }

    restoreTerminal();
}

// ─── Commands ───────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<void> {
    const args = [...argv];

    if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
        console.log(HELP);

        return;
    }

    const file =
        option(args, "--config", "~/.pi-pocket/runner.json") ??
        process.env.PI_POCKET_RUNNER_CONFIG ??
        join(homedir(), ".pi-pocket", "runner.json");
    const via = option(args, "--confirm-via", "stdio");

    if (via !== undefined && via !== "stdio") {
        fail(`--confirm-via takes stdio, not "${via}".`);
    }

    const [command, ...rest] = args;

    switch (command) {
        case undefined:
            // A person at a terminal gets the menu; the desktop app runs with stdio confirmation.
            return via === undefined && interactive ? menu(file) : serve(file, via ?? "none");
        case "start":
            return args.includes("--service")
                ? serve(file, "none", true)
                : serve(file, via ?? (interactive ? "terminal" : "none"));
        case "service":
            return service(file, rest);
        case "serve":
            return interactive ? menu(file) : serve(file, via ?? "none");
        case "link":
            return link(file, rest);
        case "settings":
            return settingsCommand(file, rest);
        case "status":
            try {
                console.log(await status(file));
            } catch (error) {
                fail((error as Error).message);
            }

            return;
        case "folders":
            return foldersCommand(file, rest);
        case "sessions":
            return sessionsCommand(file, rest);
        case "totp":
            return totpCommand(file, rest);
        case "unlink":
            // No code: unlinking only removes access. The settings, authenticator included, are in the link file.
            rmSync(file, { force: true });
            console.log(
                rest.includes("--json") ? JSON.stringify({ ok: true, unlinked: true }) : UNLINKED,
            );

            return;
        default:
            fail(`Unknown command "${command}".\n\n${HELP}`);
    }
}
