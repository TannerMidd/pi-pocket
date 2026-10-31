// How other devices reach Pi Pocket: this device only, the local network, a Cloudflare quick tunnel,
// Tailscale, or Tailscale Serve.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
    accessSync,
    appendFileSync,
    chmodSync,
    constants,
    createWriteStream,
    mkdirSync,
    renameSync,
    rmSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

export type AccessMode = "local" | "lan" | "cloudflare" | "tailscale" | "tailscale-serve";
export const ACCESS_MODES: readonly AccessMode[] = [
    "local",
    "lan",
    "cloudflare",
    "tailscale",
    "tailscale-serve",
];

export const ACCESS_LABELS: Record<AccessMode, string> = {
    local: "This device only",
    lan: "Local network",
    cloudflare: "Cloudflare Tunnel",
    tailscale: "Tailscale",
    "tailscale-serve": "Tailscale Serve",
};

export function isAccessMode(value: string | undefined): value is AccessMode {
    return value !== undefined && (ACCESS_MODES as readonly string[]).includes(value);
}

/** Tailscale hands out addresses in 100.64.0.0/10. */
function isTailscaleAddress(address: string): boolean {
    const [first, second] = address.split(".").map(Number);

    return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

function ipv4Addresses(): { name: string; address: string }[] {
    return Object.entries(networkInterfaces()).flatMap(([name, list]) =>
        (list ?? [])
            .filter((net) => net.family === "IPv4" && !net.internal)
            .map((net) => ({ name, address: net.address })),
    );
}

/** This machine's addresses on the local network (not Tailscale's). */
export function lanAddresses(): string[] {
    return ipv4Addresses()
        .filter((each) => !isTailscaleAddress(each.address))
        .map((each) => each.address);
}

/** This machine's Tailscale address, when Tailscale is connected. */
export function tailscaleAddress(): string | undefined {
    const candidates = ipv4Addresses().filter((each) => isTailscaleAddress(each.address));

    return (candidates.find((each) => /tailscale|utun|tun/i.test(each.name)) ?? candidates[0])
        ?.address;
}

/**
 * The address the server listens on. A tunnel reaches it on this machine, so only the local network mode opens it to
 * other machines directly, and Tailscale opens it to the tailnet only. Tailscale Serve is a tunnel as well: tailscaled
 * proxies the tailnet to loopback, so nothing binds the tailnet address for it as Tailscale mode does.
 */
export function bindHost(mode: AccessMode): string {
    if (mode === "lan") {
        return "0.0.0.0";
    }

    if (mode === "tailscale") {
        return tailscaleAddress() ?? "127.0.0.1";
    }

    return "127.0.0.1";
}

/** Where the server listens: `--host` when it is given, with any mode, as in 0.27; else the mode's own address. */
export function listenHost(mode: AccessMode | "custom", host: string | undefined): string {
    return host ?? (mode === "custom" ? "127.0.0.1" : bindHost(mode));
}

// ─── Choosing a mode ────────────────────────────────────────────────────

export interface AccessChoice {
    /** The mode from `--access` or `--host`, if any. */
    given: AccessMode | undefined;
    /** The last choice, from the data folder. */
    saved: AccessMode | undefined;
    /** Whether someone is there to choose from the menu: a terminal, and no `-y`. */
    ask: boolean;
    /** Show the menu; undefined when it is closed. */
    menu(current: AccessMode | undefined): Promise<AccessMode | undefined>;
    /** Get `mode` ready to use, and say what is wrong when it cannot be: false then, else true or the cloudflared to run. */
    prepare(mode: AccessMode): Promise<boolean | string>;
}

type AccessResult = { mode: AccessMode; binary?: string } | "closed" | "unready";

/**
 * The mode to start in. One that is not ready (Tailscale not connected, no cloudflared) goes back to the menu when it
 * came from there. One from `--access`, `-y`, or the last choice without a terminal ends the start: asking nobody again
 * would only try the same mode again, forever.
 */
export async function chooseAccess(choice: AccessChoice): Promise<AccessResult> {
    let mode = choice.given;

    for (;;) {
        const fromMenu = mode === undefined && choice.ask;

        if (mode === undefined) {
            mode = fromMenu ? await choice.menu(choice.saved) : (choice.saved ?? "local");

            if (mode === undefined) {
                return "closed";
            }
        }

        const ready = await choice.prepare(mode);

        if (ready !== false) {
            return typeof ready === "string" ? { mode, binary: ready } : { mode };
        }

        if (!fromMenu) {
            return "unready";
        }

        mode = undefined;
    }
}

// ─── cloudflared ────────────────────────────────────────────────────────

function findExecutable(name: string, extraDirectories: string[]): string | undefined {
    const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];

    for (const directory of [...(process.env.PATH ?? "").split(delimiter), ...extraDirectories]) {
        if (directory === "") {
            continue;
        }

        for (const each of names) {
            const file = join(directory, each);

            try {
                accessSync(file, constants.X_OK);

                return file;
            } catch {
                // keep looking
            }
        }
    }

    return undefined;
}

/** cloudflared from PATH, or the copy the launcher downloaded into the data folder. */
export function findCloudflared(dataDir: string): string | undefined {
    return findExecutable("cloudflared", [join(dataDir, "bin")]);
}

// ─── Tailscale Serve ────────────────────────────────────────────────────

/**
 * tailscale from PATH. Pi Pocket neither ships nor downloads Tailscale, so it has to be installed already, and only
 * PATH is searched: the data folder never holds a copy.
 */
export function findTailscale(): string | undefined {
    return findExecutable("tailscale", []);
}

export const TAILSCALE_MISSING_MESSAGE =
    'Tailscale Serve needs the tailscale command, and it is not on PATH.\nInstall it: macOS "brew install tailscale" (the App Store app keeps its command in the bundle, not on PATH) · Linux "curl -fsSL https://tailscale.com/install.sh | sh" · Windows "winget install Tailscale.Tailscale".\nOr pick another access mode: --access local|lan|cloudflare|tailscale.';

/**
 * Whether the start has to stop because `tailscale-serve` needs the missing tailscale and nobody is there to choose
 * another mode: `--access tailscale-serve` or PI_POCKET_ACCESS asked for it, or it is the saved choice and no terminal
 * can ask. It never falls back to `local` on its own, because the user would believe they are on their tailnet while
 * they are not, and it leaves the saved choice alone so the next start works once Tailscale is installed.
 */
export function serveWithoutTailscale(request: {
    given: AccessMode | undefined;
    saved: AccessMode | undefined;
    ask: boolean;
}): boolean {
    if (request.given === "tailscale-serve") {
        return true;
    }

    return request.given === undefined && request.saved === "tailscale-serve" && !request.ask;
}

/**
 * Whether the start stops for the missing `tailscale-serve` tailscale, `--host` aside: `--host` means the launcher
 * listens where it is told and never uses serve, so a saved serve choice must not refuse to start there. An explicit
 * `--access tailscale-serve` together with `--host` never arrives here; `main` refuses that pair before choosing.
 */
export function serveBailOut(request: {
    access: AccessMode | undefined;
    saved: AccessMode | undefined;
    host: string | undefined;
    ask: boolean;
}): boolean {
    return (
        request.host === undefined &&
        serveWithoutTailscale({ given: request.access, saved: request.saved, ask: request.ask })
    );
}

/**
 * The loopback ports that a mount left by an earlier run of this launcher could point at: the port its receipt names.
 * None without a receipt, and none for `tailscale-serve` itself, whose mount prepareServe() mounted or adopted for this
 * run's port.
 */
export function staleServePorts(mode: AccessMode | "custom", owned: number | undefined): number[] {
    return mode === "tailscale-serve" || owned === undefined ? [] : [owned];
}

/** Where to get cloudflared on this platform: a release binary the launcher can download, or how to install it. */
export function cloudflaredSource(): { url: string } | { install: string } {
    const arch = (
        { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" } as Record<string, string>
    )[process.arch];

    if (process.platform === "linux" && arch !== undefined) {
        return {
            url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`,
        };
    }

    if (process.platform === "android") {
        return { install: "pkg install cloudflared" };
    }

    if (process.platform === "darwin") {
        return { install: "brew install cloudflared" };
    }

    if (process.platform === "win32") {
        return { install: "winget install --id Cloudflare.cloudflared" };
    }

    return {
        install:
            "see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    };
}

/** Download Cloudflare's release binary into `<data>/bin/cloudflared` and check that it runs. */
export async function downloadCloudflared(
    dataDir: string,
    url: string,
    progress: (done: number, total: number) => void,
): Promise<string> {
    const directory = join(dataDir, "bin");

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, "cloudflared");
    const temp = `${target}.download`;
    // Give up when no data arrives for a minute: a stalled connection must not hang the launcher. Slow is fine.
    const controller = new AbortController();
    let idle: NodeJS.Timeout | undefined;

    const wait = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(new Error("the download stalled")), 60_000);
    };

    wait();
    const out = createWriteStream(temp, { mode: 0o755 });
    let done = 0;

    try {
        const response = await fetch(url, { signal: controller.signal });

        if (!response.ok || response.body === null) {
            throw new Error(`download failed: HTTP ${response.status}`);
        }

        const total = Number(response.headers.get("content-length") ?? 0);

        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            wait();
            done += chunk.length;

            if (!out.write(chunk)) {
                await once(out, "drain");
            }

            progress(done, total);
        }

        await new Promise<void>((resolve, reject) =>
            out.end((error?: Error | null) => (error ? reject(error) : resolve())),
        );
    } catch (error) {
        out.destroy();
        rmSync(temp, { force: true });

        throw error;
    } finally {
        clearTimeout(idle);
    }

    chmodSync(temp, 0o755);
    const check = spawnSync(temp, ["--version"], { encoding: "utf8", timeout: 20_000 });

    if (check.status !== 0) {
        rmSync(temp, { force: true });

        throw new Error("the downloaded cloudflared does not run on this machine");
    }

    renameSync(temp, target);

    return target;
}

export interface TunnelEvents {
    /** The tunnel is registered and serving at this address. */
    ready(url: string): void;
    /** A problem cloudflared reported. */
    problem(line: string): void;
    /** cloudflared exited. */
    exit(code: number | null): void;
}

/**
 * A Cloudflare quick tunnel: a random https://….trycloudflare.com address, no account needed. The address is new for
 * every cloudflared process, so the launcher keeps one running across server restarts. Its log goes to `logFile`.
 */
export class CloudflareTunnel {
    readonly #binary: string;
    readonly #port: number;
    readonly #logFile: string;
    readonly #events: TunnelEvents;
    #child: ChildProcess | undefined;
    url: string | undefined;

    constructor(binary: string, port: number, logFile: string, events: TunnelEvents) {
        this.#binary = binary;
        this.#port = port;
        this.#logFile = logFile;
        this.#events = events;
    }

    start(): void {
        // cloudflared logs the addresses of failed requests, which can include a sign-in token: only this user may read it.
        appendFileSync(this.#logFile, `\n--- ${new Date().toISOString()} starting cloudflared\n`, {
            mode: 0o600,
        });
        chmodSync(this.#logFile, 0o600);
        const child = spawn(
            this.#binary,
            ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.#port}`],
            {
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        this.#child = child;
        let candidate: string | undefined;

        const onLine = (line: string) => {
            appendFileSync(this.#logFile, `${line}\n`);
            candidate ??= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0];

            if (
                this.url === undefined &&
                candidate !== undefined &&
                /Registered tunnel connection/i.test(line)
            ) {
                this.url = candidate;
                this.#events.ready(candidate);
            } else if (
                (/\sERR\s/.test(line) || /failed to (request|create) quick tunnel/i.test(line)) &&
                // A browser closing a request (a reload, a long poll it gave up on) is routine, not a tunnel problem.
                !/context canceled|canceled by remote|ended abruptly/i.test(line)
            ) {
                this.#events.problem(line.replace(/^\S+\s+ERR\s+/, ""));
            }
        };

        for (const stream of [child.stdout, child.stderr]) {
            createInterface({ input: stream! }).on("line", onLine);
        }

        child.on("error", (error) => this.#events.problem(error.message));
        // "close", not "exit": a cloudflared that could not be started (removed, not executable) never exits.
        child.on("close", (code) => {
            if (this.#child === child) {
                this.#child = undefined;
            }

            this.#events.exit(code);
        });
    }

    async stop(): Promise<void> {
        const child = this.#child;

        this.#child = undefined;

        if (child === undefined || child.exitCode !== null) {
            return;
        }

        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 4000);

        await once(child, "exit").catch(() => {});
        clearTimeout(timer);
    }
}
