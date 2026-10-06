// How other devices reach Pi Pocket: this device only, the local network, a Cloudflare quick tunnel, or Tailscale.
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

export type AccessMode = "local" | "lan" | "cloudflare" | "tailscale";
export const ACCESS_MODES: readonly AccessMode[] = ["local", "lan", "cloudflare", "tailscale"];

export const ACCESS_LABELS: Record<AccessMode, string> = {
    local: "This device only",
    lan: "Local network",
    cloudflare: "Cloudflare Tunnel",
    tailscale: "Tailscale",
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
 * other machines directly, and Tailscale opens it to the tailnet only.
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
