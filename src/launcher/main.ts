/**
 * The Pi Pocket launcher. Pick how your devices reach this server (this device only, the local network, a Cloudflare
 * quick tunnel, Tailscale, or Tailscale Serve), then it runs the server and the tunnel. The server restarts when the app
 * asks (exit code 75) or after a crash; the tunnel stays up across those restarts, so its address does not change.
 *
 *   pi-pocket [--access local|lan|cloudflare|tailscale|tailscale-serve] [-y] [--port 8787] [--cwd DIR] [--data DIR]
 *   [--rotate-token]
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
    ACCESS_LABELS,
    type AccessMode,
    listenHost,
    chooseAccess,
    CloudflareTunnel,
    cloudflaredSource,
    downloadCloudflared,
    findCloudflared,
    findTailscale,
    isAccessMode,
    lanAddresses,
    serveBailOut,
    staleServePorts,
    TAILSCALE_MISSING_MESSAGE,
    tailscaleAddress,
} from "./access.ts";
import { fail, parseArgs } from "./options.ts";
import { removeStaleServe, TailscaleServe } from "./serve.ts";
// The two server modules the launcher runs itself: both import only Node's own, so an update cannot break the launcher.
import { takeLock } from "../server/lock.ts";
import {
    readPending,
    restoreMissingNpmPackage,
    rollBackUpdate,
    stopMeansRollBack,
} from "../server/update-state.ts";
import {
    accent,
    bold,
    type Choice,
    choose,
    columns,
    confirm,
    cut,
    cyan,
    dim,
    green,
    interactive,
    onKeys,
    qrLines,
    red,
    restoreTerminal,
    yellow,
} from "./term.ts";

const SERVER = fileURLToPath(new URL("../server/main.ts", import.meta.url));
/** Pi Pocket's checkout, which an update from the app changes (`src/server/updates.ts`). */
const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/**
 * From an npm install (a node_modules folder), Node strips no types: the server then starts with the hook that does
 * (`bin/strip-types.js`). A checkout starts without it.
 */
const SERVER_FLAGS = APP_ROOT.split(sep).includes("node_modules")
    ? ["--import", new URL("../../bin/strip-types.js", import.meta.url).href]
    : [];
const RESTART_CODE = 75;
/** How long a server started with an update under way may take to be ready before it counts as not starting. */
const UPDATE_START_LIMIT_MS = 5 * 60_000;

// ─── Options ────────────────────────────────────────────────────────────

const options = parseArgs(process.argv.slice(2));

mkdirSync(options.data, { recursive: true, mode: 0o700 });
const settingsFile = join(options.data, "launcher.json");
/**
 * The receipt for a Tailscale Serve mount this launcher made: the port it points at. It is written before the mount
 * command runs and kept until the mount is gone, so a run killed outright leaves the next start what to take down. A
 * mount the launcher found and adopted gets none, and neither does the owner's own `tailscale serve` at this port.
 */
const serveMountFile = join(options.data, "serve-mount.json");

/** The port of the mount that the receipt names, if there is one. */
function savedServeMountPort(): number | undefined {
    try {
        const { port } = JSON.parse(readFileSync(serveMountFile, "utf8")) as { port?: number };

        return Number.isSafeInteger(port) && port! > 0 && port! < 65_536 ? port : undefined;
    } catch {
        return undefined;
    }
}

/** Write the receipt, all at once, for a mount this run is about to make. */
function recordServeMount(): void {
    const temp = `${serveMountFile}.tmp`;

    writeFileSync(temp, `${JSON.stringify({ port: options.port })}\n`, { mode: 0o600 });
    renameSync(temp, serveMountFile);
}

/** Drop the receipt: its mount is gone, or no longer points here. */
function forgetServeMount(): void {
    rmSync(serveMountFile, { force: true });
}

function loadSettings(): { access?: AccessMode } {
    try {
        const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as { access?: string };
        // `serve` is what the mode was called before it took systemd's own name for it, in builds of this branch.
        const saved = parsed.access === "serve" ? "tailscale-serve" : parsed.access;

        return isAccessMode(saved) ? { access: saved } : {};
    } catch {
        return {};
    }
}

function saveSettings(access: AccessMode): void {
    writeFileSync(settingsFile, `${JSON.stringify({ access }, null, "\t")}\n`, { mode: 0o600 });
}

const home = homedir();
const tilde = (path: string) =>
    path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

/**
 * One launcher per data folder, because two would share tailscaled's mount for `/`: the second adopts the first's
 * mount, and its quit takes that mount down, leaving the running launcher's tailnet address pointing at nothing.
 */
let releaseLauncherLock: () => void;

try {
    releaseLauncherLock = takeLock(join(options.data, "launcher.lock"));
} catch (error) {
    fail(
        `Another Pi Pocket launcher is using ${tilde(options.data)}. ${error instanceof Error ? error.message : String(error)}`,
    );
}

// ─── Output ─────────────────────────────────────────────────────────────

/** Server and tunnel lines wait here while a menu or question is on screen. */
let held: string[] | undefined;

function log(line: string): void {
    if (held !== undefined) {
        held.push(line);
    } else {
        process.stdout.write(`${line}\n`);
    }
}

function hold(): void {
    held ??= [];
}

function release(): void {
    const lines = held ?? [];

    held = undefined;

    for (const line of lines) {
        log(line);
    }
}

function pipeLines(stream: NodeJS.ReadableStream | null, each: (line: string) => void): void {
    if (stream !== null) {
        createInterface({ input: stream }).on("line", each);
    }
}

// ─── Choosing access ────────────────────────────────────────────────────

function accessChoices(): { mode: AccessMode; choice: Choice }[] {
    const port = options.port;
    const lan = lanAddresses()[0];
    const tailnet = tailscaleAddress();
    const cloudflared = findCloudflared(options.data);
    const source = cloudflaredSource();

    return [
        {
            mode: "local",
            choice: { label: ACCESS_LABELS.local, detail: `http://127.0.0.1:${port}` },
        },
        {
            mode: "lan",
            choice:
                lan === undefined
                    ? {
                          label: ACCESS_LABELS.lan,
                          detail: "no network connection found",
                          disabled: true,
                      }
                    : {
                          label: ACCESS_LABELS.lan,
                          detail: `http://${lan}:${port} · same Wi-Fi, not encrypted`,
                      },
        },
        {
            mode: "cloudflare",
            choice: {
                label: ACCESS_LABELS.cloudflare,
                detail: cloudflared
                    ? "public https link from anywhere · no account needed"
                    : "url" in source
                      ? "public https link · downloads cloudflared first"
                      : `needs cloudflared: ${source.install}`,
                disabled: cloudflared === undefined && !("url" in source),
            },
        },
        {
            mode: "tailscale",
            choice:
                tailnet === undefined
                    ? {
                          label: ACCESS_LABELS.tailscale,
                          detail: "not connected on this machine",
                          disabled: true,
                      }
                    : {
                          label: ACCESS_LABELS.tailscale,
                          detail: `http://${tailnet}:${port} · your tailnet only`,
                      },
        },
        {
            mode: "tailscale-serve",
            choice:
                findTailscale() === undefined
                    ? {
                          label: ACCESS_LABELS["tailscale-serve"],
                          detail: "needs tailscale on PATH",
                          disabled: true,
                      }
                    : {
                          label: ACCESS_LABELS["tailscale-serve"],
                          detail:
                              state.mode === "tailscale-serve" && state.accessUrl !== undefined
                                  ? `${state.accessUrl} · your tailnet, encrypted`
                                  : "https on your tailnet · tailscale serve",
                      },
        },
    ];
}

/** Get `mode` ready to use: false, having said what is wrong, when it cannot be; the cloudflared to run for a tunnel. */
async function prepareAccess(mode: AccessMode): Promise<boolean | string> {
    if (mode === "tailscale" && tailscaleAddress() === undefined) {
        log(yellow("  Tailscale is not connected on this machine. Connect it with: tailscale up"));

        return false;
    }

    if (mode === "cloudflare") {
        return (await ensureCloudflared()) ?? false;
    }

    if (mode === "tailscale-serve") {
        return prepareServe();
    }

    return true;
}

async function pickAccess(current: AccessMode | undefined): Promise<AccessMode | undefined> {
    const options = accessChoices();
    const initial = Math.max(
        0,
        options.findIndex((each) => each.mode === current),
    );
    const picked = await choose(
        "How should your devices reach Pi Pocket?",
        options.map((each) => each.choice),
        initial,
    );

    return picked === undefined ? undefined : options[picked]!.mode;
}

/** cloudflared's path, downloading it first when the user agrees. */
async function ensureCloudflared(): Promise<string | undefined> {
    const found = findCloudflared(options.data);

    if (found !== undefined) {
        return found;
    }

    const source = cloudflaredSource();

    if (!("url" in source)) {
        log(yellow(`  cloudflared is not installed. Install it with: ${source.install}`));

        return undefined;
    }

    if (!interactive) {
        log(
            yellow(
                "  cloudflared is not installed. Install it, or run pi-pocket once in a terminal to download it.",
            ),
        );

        return undefined;
    }

    log("");
    const yes = await confirm(
        `Download cloudflared (Cloudflare's official release, about 40 MB) to ${tilde(join(options.data, "bin"))}?`,
        true,
    );

    if (!yes) {
        return undefined;
    }

    let last = 0;

    try {
        const file = await downloadCloudflared(options.data, source.url, (done, total) => {
            if (Date.now() - last < 120 && done !== total) {
                return;
            }

            last = Date.now();
            const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

            process.stdout.write(
                `\r  ${dim(`Downloading… ${mb(done)}${total ? ` / ${mb(total)}` : ""} MB`)}\x1b[K`,
            );
        });

        process.stdout.write(`\r  ${green("✓")} cloudflared is ready.\x1b[K\n`);

        return file;
    } catch (error) {
        process.stdout.write("\n");
        log(
            red(
                `  Could not download cloudflared: ${error instanceof Error ? error.message : String(error)}`,
            ),
        );

        return undefined;
    }
}

// ─── State ──────────────────────────────────────────────────────────────

type Mode = AccessMode | "custom";

const state = {
    mode: "local" as Mode,
    host: "127.0.0.1",
    loginPath: undefined as string | undefined,
    serverReady: false,
    everReady: false,
    /** Show the panel once the server (and the tunnel, if any) is up. */
    panelPending: true,
    /** The address others open, when something publishes this server: the Cloudflare link or the tailnet's https name. */
    accessUrl: undefined as string | undefined,
    tunnelTrouble: false,
    tunnelFailures: 0,
    /** A restart asked for while the server was starting: done once it is up. */
    restartWhenReady: false,
    /** Server starts in a row that failed after it had run, for the pause before the next try. */
    serverFailures: 0,
};

let child: ChildProcess | undefined;
let tunnel: CloudflareTunnel | undefined;
let serve: TailscaleServe | undefined;
let quitting = false;

const wildcard = (host: string) => host === "0.0.0.0" || host === "::";
const loopback = (host: string) =>
    host === "localhost" || host === "::1" || host.startsWith("127.");

/** Whether something outside this machine publishes the server, and `state.accessUrl` is its address. */
const served = () => state.mode === "cloudflare" || state.mode === "tailscale-serve";

/** The address other devices should open. */
function appUrl(): string {
    const port = options.port;

    // Ahead of the wildcard and loopback branches: serve keeps the server itself on 127.0.0.1, which is not the address
    // to hand out; the tailnet's https name is, and it has no port.
    if (served() && state.accessUrl !== undefined) {
        return state.accessUrl;
    }

    if (wildcard(state.host)) {
        return `http://${lanAddresses()[0] ?? "127.0.0.1"}:${port}`;
    }

    return `http://${state.host.includes(":") ? `[${state.host}]` : state.host}:${port}`;
}

/** The address a browser on this machine should open. */
function localUrl(): string {
    // A specific address, loopback or not, only answers on itself: keep it. `localhost` too, since Node may listen
    // for it on ::1 alone.
    const host = wildcard(state.host) ? "127.0.0.1" : state.host;

    return `http://${host.includes(":") ? `[${host}]` : host}:${options.port}`;
}

function modeLabel(): string {
    if (state.mode === "custom") {
        return `Listening on ${state.host}`;
    }

    return ACCESS_LABELS[state.mode];
}

function modeNote(): string {
    switch (state.mode) {
        case "local":
            return "other devices cannot connect";
        case "lan":
            // It listens on every address (a VPN's, a public one), not only the local network's: say where.
            return `all addresses (${state.host}), not encrypted`;
        case "cloudflare":
            return state.accessUrl === undefined
                ? "tunnel not up yet"
                : "public https link, new each launch";
        case "tailscale":
            return "devices on your tailnet";
        case "tailscale-serve":
            return state.accessUrl === undefined ? "serve not up yet" : "https on your tailnet";
        default:
            return "";
    }
}

/** Other devices can open the app at `appUrl()`. */
function reachable(): boolean {
    if (served()) {
        return state.accessUrl !== undefined;
    }

    return !loopback(state.host);
}

function sendAccess(): void {
    if (child?.connected !== true) {
        return;
    }

    const access = {
        mode: state.mode,
        label: modeLabel(),
        ...(served() && state.accessUrl !== undefined ? { url: state.accessUrl } : {}),
    };

    child.send({ type: "access", access });
}

// ─── The panel ──────────────────────────────────────────────────────────

const KEYS_HINT = "q quit · r restart server · a access · o open here · s sign-in QR";

async function showPanel(withQr: boolean): Promise<void> {
    const width = columns();
    const row = (label: string, value: string) => `  ${dim(label.padEnd(9))}${value}`;
    const lines = ["", `  ${accent("π")} ${bold("Pi Pocket")}  ${green("● running")}`, ""];

    lines.push(row("Access", `${modeLabel()}${modeNote() ? dim(` · ${modeNote()}`) : ""}`));
    lines.push(row("Open", cyan(appUrl())));

    if (state.mode === "lan") {
        for (const address of lanAddresses().slice(1)) {
            lines.push(row("", cyan(`http://${address}:${options.port}`)));
        }
    }

    lines.push(row("Folder", tilde(options.cwd)));
    lines.push(row("Data", tilde(options.data)));
    lines.push("");
    // The base comes from a tunnel's own output or from serve, so a trailing slash is dropped rather than trusted: the
    // sign-in path starts with one, and two in a row (`https://host//login`) is a link nobody can open.
    const base = (reachable() ? appUrl() : localUrl()).replace(/\/+$/, "");
    const login = state.loginPath === undefined ? undefined : `${base}${state.loginPath}`;

    if (login !== undefined) {
        if (withQr && reachable()) {
            lines.push(
                `  ${bold("Scan to sign in on your phone.")} ${dim("It is your owner link: keep it private.")}`,
                "",
            );

            for (const line of await qrLines(login)) {
                lines.push(`  ${line}`);
            }

            lines.push("");
        } else if (!reachable()) {
            lines.push(
                dim(
                    interactive
                        ? `  Only this machine can connect. Press ${bold("a")} to let your phone in.`
                        : "  Only this machine can connect. Use --access lan, cloudflare, tailscale, or tailscale-serve to let other devices in.",
                ),
                "",
            );
        }

        lines.push(row("Sign in", login));
        lines.push("");
    }

    if (interactive) {
        lines.push(dim(`  ${cut(KEYS_HINT, width - 3)}`), "");
    }

    log(lines.join("\n"));
}

function maybeShowPanel(): void {
    if (!state.panelPending || !state.serverReady) {
        return;
    }

    if (served() && state.accessUrl === undefined && !state.tunnelTrouble) {
        return;
    }

    state.panelPending = false;
    void showPanel(true);
}

// ─── The server ─────────────────────────────────────────────────────────

function startServer(first: boolean): void {
    try {
        restoreMissingNpmPackage(APP_ROOT);
    } catch (error) {
        // A child that cannot load still reaches the normal rollback and retry path below.
        log(red(`Could not restore the live npm package: ${(error as Error).message}`));
    }

    const args = [
        SERVER,
        "--host",
        state.host,
        "--port",
        String(options.port),
        "--cwd",
        options.cwd,
        "--data",
        options.data,
    ];

    if (first && options.rotateToken) {
        args.push("--rotate-token");
    }

    // Node 22 calls node:sqlite experimental and says so at every start, right above the panel.
    const flags = ["--disable-warning=ExperimentalWarning", ...SERVER_FLAGS];
    const proc = spawn(process.execPath, [...flags, ...args], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        // PI_POCKET_ROLLBACK: this launcher goes back to the version before an update that does not start.
        env: {
            ...process.env,
            PI_POCKET_SUPERVISED: "1",
            PI_POCKET_LAUNCHER: "1",
            PI_POCKET_ROLLBACK: "1",
            PI_POCKET_NPM_ROLLBACK: "1",
        },
    });
    /** This start said it was ready: a stop after that is not a new version that cannot start. */
    let ready = false;
    // A new version that hangs before it is ready never exits: stop it, so the exit goes back to the version before.
    const watchdog = readPending(APP_ROOT)
        ? setTimeout(() => {
              if (!ready && child === proc) {
                  log(
                      yellow(
                          `  The server did not get ready in ${UPDATE_START_LIMIT_MS / 60_000} minutes after an update: stopping it.`,
                      ),
                  );
                  proc.kill("SIGKILL");
              }
          }, UPDATE_START_LIMIT_MS)
        : undefined;

    child = proc;
    pipeLines(proc.stdout, (line) => log(line));
    pipeLines(proc.stderr, (line) => log(line));
    proc.on("message", (message: { type?: string; loginPath?: string }) => {
        if (message?.type !== "ready" || child !== proc) {
            return;
        }

        ready = true;
        clearTimeout(watchdog);

        state.loginPath = message.loginPath;
        state.serverReady = true;
        state.serverFailures = 0;
        const restarted = state.everReady;

        state.everReady = true;
        sendAccess();

        if (state.panelPending) {
            maybeShowPanel();
        } else if (restarted) {
            log(green("  ✓ Server restarted. Running work continues."));
        }

        if (state.restartWhenReady) {
            state.restartWhenReady = false;
            restartServer();
        }
    });

    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(watchdog);

        if (child !== proc) {
            return;
        }

        child = undefined;
        state.serverReady = false;

        if (quitting) {
            return;
        }

        // A server that stops before it is ready, with an update from the app under way: the new version does not
        // start. Go back to the version before, and start that one, also on a first start.
        if (stopMeansRollBack(ready, code)) {
            let undone: string | undefined;

            try {
                undone = rollBackUpdate(APP_ROOT);
            } catch (error) {
                // The update stays noted: the next try, after the usual pause, tries going back again.
                log(
                    red(
                        `  Going back to the version before the update failed: ${(error as Error).message}`,
                    ),
                );
            }

            if (undone !== undefined) {
                log(yellow(`  ${undone}`));
                startServer(false);

                return;
            }
        }

        if (code === RESTART_CODE) {
            log(dim("  ↻ Restarting the server…"));
            startServer(false);

            return;
        }

        if (!state.everReady) {
            log(red("  Pi Pocket could not start (see above)."));
            void quit(code ?? 1);

            return;
        }

        if (code === 0 && signal === null) {
            void quit(0);

            return;
        }

        // It ran before: a crash, a start that fails after an edit to the server's code, or a port or address that is
        // not back yet. Keep trying, more slowly each time, and keep the tunnel and its address for the phones using it.
        state.serverFailures++;
        const delay = Math.min(60_000, 2000 * 2 ** Math.min(5, state.serverFailures - 1));

        log(
            yellow(
                `  The server stopped (${signal ?? `code ${code}`}); trying again in ${delay / 1000} seconds. Press q to quit.`,
            ),
        );
        setTimeout(() => !quitting && child === undefined && startServer(false), delay);
    };

    proc.on("exit", exited);
    // A process that could not be started at all reports an error and never exits.
    proc.on("error", (error) => {
        log(red(`  Could not run the server: ${error.message}`));

        if (proc.pid === undefined) {
            exited(1, null);
        }
    });
}

function restartServer(): void {
    if (child === undefined) {
        return;
    }

    // Still starting: stopping it now would end the start; restart once it is up.
    if (!state.serverReady) {
        state.restartWhenReady = true;
        log(dim("  ↻ The server will restart as soon as it is up."));

        return;
    }

    if (process.platform === "win32") {
        log(dim("  ↻ Restarting the server…"));
        // No SIGUSR2 on Windows: stop it, and start it again from the exit handler.
        child.once("exit", () => !quitting && startServer(false));
        const proc = child;

        child = undefined;
        proc.kill();

        return;
    }

    child.kill("SIGUSR2");
}

// ─── The tunnel ─────────────────────────────────────────────────────────

function startTunnel(binary: string): void {
    log(dim("  Starting a Cloudflare quick tunnel…"));
    const current: CloudflareTunnel = new CloudflareTunnel(
        binary,
        options.port,
        join(options.data, "cloudflared.log"),
        {
            ready(url) {
                if (tunnel !== current) {
                    return;
                }

                const changed = state.accessUrl !== undefined && state.accessUrl !== url;

                state.accessUrl = url;
                state.tunnelTrouble = false;
                state.tunnelFailures = 0;
                sendAccess();

                if (state.panelPending) {
                    maybeShowPanel();
                } else {
                    log(green(`  ✓ Tunnel is up${changed ? " at a new address" : ""}: ${url}`));
                    state.panelPending = true;
                    maybeShowPanel();
                }
            },
            problem(line) {
                if (tunnel === current) {
                    log(yellow(`  cloudflared: ${line}`));
                }
            },
            exit(code) {
                if (tunnel !== current || quitting) {
                    return;
                }

                state.accessUrl = undefined;
                state.tunnelTrouble = true;
                state.tunnelFailures++;
                sendAccess();
                const delay = Math.min(60, 2 ** state.tunnelFailures) * 1000;

                log(
                    yellow(
                        `  The tunnel stopped (code ${code}); trying again in ${delay / 1000} seconds. Log: ${tilde(join(options.data, "cloudflared.log"))}`,
                    ),
                );
                maybeShowPanel();
                setTimeout(() => {
                    if (tunnel === current && !quitting) {
                        startTunnel(binary);
                    }
                }, delay);
            },
        },
    );

    tunnel = current;
    current.start();
}

async function stopTunnel(): Promise<void> {
    const current = tunnel;

    tunnel = undefined;
    state.accessUrl = undefined;
    state.tunnelTrouble = false;
    state.tunnelFailures = 0;
    await current?.stop();
}

// ─── Tailscale Serve ────────────────────────────────────────────────────

/**
 * Publish the server on the tailnet: true, with the mount up and its address in `state`, or false having said why not.
 * `start()` is both the check (version, a running daemon, certificates) and the mount. Tailscaled fronts this server on
 * 443 with the tailnet's https name and proxies to loopback, so, unlike `tailscale`, nothing here binds the tailnet
 * address, and the mount outlives a server restart because tailscaled owns it. Pi Pocket speaks SSE and long polling and
 * no WebSockets, so serve's HTTP/2 WebSocket gap does not apply. Nothing watches the mount after this: a `tailscale
 * serve off` behind Pi Pocket's back shows up on the next start, not here.
 */
function prepareServe(): boolean {
    const binary = findTailscale();

    if (binary === undefined) {
        log(yellow(`  ${TAILSCALE_MISSING_MESSAGE}`));

        return false;
    }

    const current = new TailscaleServe(binary, options.port, {
        problem(line) {
            log(yellow(`  tailscale: ${line}`));
        },
        mountAttempt: recordServeMount,
        mountRemoved: forgetServeMount,
    });

    // Recorded before it is up, so a quit during the CLI round-trips below still takes down a mount those made.
    serve = current;
    // Saved for the same reason from the other side: the receipt (written just before the mount command) says what to
    // take down, and the saved choice says whether a failure to do so is worth telling.
    saveSettings("tailscale-serve");

    const result = current.start();

    if (!result.ok) {
        log(yellow(`  ${result.message}`));
        // A failed switch must not cost the live tunnel its address: `stopServe()` would forget `state.accessUrl`, which
        // here still belongs to the Cloudflare tunnel this switch was about to leave.
        serve = undefined;
        current.stop();

        return false;
    }

    // An existing mount of ours is adopted rather than mounted again, and it is the owner's as much as ours: it stays
    // when this launcher quits, which is what the line says, rather than being taken down at the end of the session.
    if (result.adopted) {
        log(
            dim(
                "  Using the Tailscale Serve mount already in place; it stays when this launcher quits.",
            ),
        );
    }

    state.accessUrl = result.url;

    return true;
}

function stopServe(): void {
    const current = serve;

    serve = undefined;
    state.accessUrl = undefined;
    current?.stop();
}

/** Switch to `mode`: start or stop the tunnel, and restart the server when it has to listen somewhere else. */
async function applyAccess(mode: AccessMode, binary: string | undefined): Promise<void> {
    // prepareServe() has already mounted `tailscale-serve` and set its address, and tailscaled owns that mount: it stays
    // for the new mode, and only a move to another mode unmounts it. The stops below forget the address, so it is put
    // back after.
    const mounted = mode === "tailscale-serve" && serve !== undefined ? state.accessUrl : undefined;

    await stopTunnel();

    if (mode !== "tailscale-serve") {
        stopServe();
    }

    state.mode = mode;
    saveSettings(mode);
    state.accessUrl = mounted;
    // `--host` overrides a mode's own address here too: switching modes in the menu must keep listening where it was
    // told, except that serve always wants loopback.
    const host = listenHost(mode, options.host);

    state.panelPending = true;

    if (host !== state.host) {
        state.host = host;
        restartServer();
    } else {
        // Nothing moves, so the server is told the new mode and address now: serve's tailnet name included, since its
        // mount never moved.
        sendAccess();
    }

    if (mode === "cloudflare" && binary !== undefined) {
        startTunnel(binary);
    }

    maybeShowPanel();
}

// ─── Keys and shutdown ──────────────────────────────────────────────────

function openInBrowser(url: string): void {
    const command =
        process.platform === "darwin"
            ? ["open", url]
            : process.platform === "win32"
              ? ["cmd", "/c", "start", "", url]
              : process.platform === "android"
                ? ["termux-open-url", url]
                : ["xdg-open", url];

    try {
        const proc = spawn(command[0]!, command.slice(1), { stdio: "ignore", detached: true });

        proc.on("error", () => log(yellow(`  Could not open a browser. Open this: ${url}`)));
        proc.unref();
    } catch {
        log(yellow(`  Could not open a browser. Open this: ${url}`));
    }
}

async function changeAccess(): Promise<void> {
    hold();
    log("");

    try {
        const current = state.mode === "custom" ? undefined : state.mode;
        const next = await pickAccess(current);

        if (next === undefined || next === state.mode) {
            return;
        }

        const binary = next === "cloudflare" ? await ensureCloudflared() : undefined;

        if (next === "cloudflare" && binary === undefined) {
            return;
        }

        // prepareServe() saves the serve choice before it tries: a switch that fails puts back what was saved.
        const saved = loadSettings().access;

        if (next === "tailscale-serve" && !prepareServe()) {
            if (saved === undefined) {
                rmSync(settingsFile, { force: true });
            } else {
                saveSettings(saved);
            }

            return;
        }

        await applyAccess(next, binary);
    } finally {
        release();
    }
}

let busyWithKey = false;

function onRunKey(key: string): void {
    if (busyWithKey) {
        return;
    }

    if (key === "q" || key === "ctrl-c") {
        void quit(0);
    } else if (key === "r") {
        restartServer();
    } else if (key === "o" && state.loginPath !== undefined) {
        openInBrowser(`${localUrl()}${state.loginPath}`);
    } else if (key === "s") {
        void showPanel(true);
    } else if (key === "a") {
        busyWithKey = true;
        void changeAccess().finally(() => {
            busyWithKey = false;
        });
    } else if (key === "h" || key === "?" || key === "enter") {
        log(dim(`  ${KEYS_HINT}`));
    }
}

async function quit(code: number): Promise<void> {
    if (quitting) {
        return;
    }

    quitting = true;
    release();
    log(dim("  Stopping Pi Pocket…"));
    await stopTunnel();
    // Before the server goes: the tailnet should never point at a port with nothing behind it.
    stopServe();
    const proc = child;

    if (proc !== undefined && proc.exitCode === null) {
        proc.kill("SIGTERM");
        const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);

        await once(proc, "exit").catch(() => {});
        clearTimeout(timer);
    }

    restoreTerminal();
    process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void quit(0));
}

if (process.platform !== "win32") {
    process.on("SIGUSR2", () => restartServer());
}

process.on("exit", () => {
    restoreTerminal();
    releaseLauncherLock();
});

// ─── Start ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // Until the server runs, Ctrl+C (raw mode turns off the terminal's own) still quits, even mid-download.
    onKeys((key) => key === "ctrl-c" && void quit(130));
    const settings = loadSettings();

    // Serve's contract is the server on 127.0.0.1 with tailscaled proxying to it, so `--host` together with serve would
    // bind the LAN while the panel claims the tailnet. The two are a contradiction, not one overriding the other.
    if (options.access === "tailscale-serve" && options.host !== undefined) {
        fail(
            "--access tailscale-serve keeps the server on 127.0.0.1 and lets Tailscale reach it; drop --host, or pick another access mode.",
        );
    }

    // Stop here rather than fall back to another mode: the user would believe they are on their tailnet while they are
    // not. The saved choice is left as it is, so the next start works once Tailscale is installed. This is a filesystem
    // check only, with no `tailscale` command run: a daemon that is down, an old version, or certificates that are off
    // are problems to report when serve is prepared, not reasons to refuse to launch. `--host` alone never uses serve,
    // so a saved choice is not a reason to refuse to start there either.
    if (
        serveBailOut({
            access: options.access,
            saved: settings.access,
            host: options.host,
            ask: interactive && !options.yes,
        }) &&
        findTailscale() === undefined
    ) {
        fail(TAILSCALE_MISSING_MESSAGE);
    }

    let mode: Mode | undefined = options.access;

    if (mode === undefined && options.host !== undefined) {
        mode = loopback(options.host) ? "local" : wildcard(options.host) ? "lan" : "custom";
    }

    if (interactive && mode === undefined && !options.yes) {
        log("");
        log(`  ${accent("π")} ${bold("Pi Pocket")}  ${dim(tilde(options.cwd))}`);
        log("");
    }

    // Anything this start got ready comes back off when a later step throws: an exit must not leave a serve mount behind
    // for the next run to adopt or reclaim.
    try {
        let binary: string | undefined;

        if (mode !== "custom") {
            const chosen = await chooseAccess({
                given: mode,
                saved: settings.access,
                ask: interactive && !options.yes,
                menu: pickAccess,
                prepare: prepareAccess,
            });

            if (chosen === "closed") {
                restoreTerminal();
                process.exit(0);
            }

            if (chosen === "unready") {
                fail(
                    interactive && options.yes && options.access === undefined
                        ? "Fix the problem above, or start without -y to pick another access mode."
                        : "Fix the problem above, or pick another access mode with --access.",
                );
            }

            mode = chosen.mode;
            binary = chosen.binary;
        }

        state.mode = mode;
        state.host = listenHost(mode, options.host);

        if (mode !== "custom") {
            saveSettings(mode);
        }

        // A mount tailscaled makes outlives the launcher that made it, and a run killed outright leaves one behind
        // answering 502. Clear it before this run needs the port, whichever mode it starts in. Only a mount with a
        // receipt is ours: a port alone proves nothing, since 0.27's docs had owners point `tailscale serve` at
        // `--access local` themselves. Never for `tailscale-serve` itself, whose mount prepareServe() made or adopted.
        const stalePorts = staleServePorts(mode, savedServeMountPort());

        if (stalePorts.length > 0) {
            const tailscale = findTailscale();

            if (tailscale !== undefined) {
                // Tailscale installed but never used is ordinary, so a failing probe is worth saying only when the last
                // run was the serve mode. A failure keeps the receipt, so the next start tries again.
                const removed = removeStaleServe(tailscale, stalePorts, {
                    problem(line) {
                        if (settings.access === "tailscale-serve") {
                            log(yellow(`  tailscale: ${line}`));
                        }
                    },
                    mountRemoved: forgetServeMount,
                });

                if (removed) {
                    log(dim("  Removed the Tailscale Serve mount an earlier run left behind."));
                }
            }
        }

        log(dim(`  Starting Pi Pocket (${modeLabel()})…`));
        startServer(true);

        if (mode === "cloudflare" && binary !== undefined) {
            startTunnel(binary);
        }

        onKeys(onRunKey);
    } catch (error) {
        stopServe();

        throw error;
    }
}

await main();
