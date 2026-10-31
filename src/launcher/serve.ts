// Publishing Pi Pocket on the tailnet: tailscaled terminates HTTPS on 443 and proxies to the server on loopback, so the
// server keeps speaking plain http and every request arrives with X-Forwarded-Proto: https and the original Host.
import { spawnSync } from "node:child_process";

/** The first Tailscale with this `serve` CLI; before 1.52.0 the positional form was the one there, and errors now. */
export const TAILSCALE_MIN_VERSION: readonly [number, number, number] = [1, 52, 0];
/** Tailscale serves a node on 443, the port every device expects https on. */
export const SERVE_PORT = 443;

const MINIMUM = `${TAILSCALE_MIN_VERSION[0]}.${TAILSCALE_MIN_VERSION[1]}`;
/** The Tailscale CLI has no timeout of its own and waits forever on a hung daemon, so every command gets this long. */
const TIMEOUT_MS = 10_000;
/** Reading the status of the daemon is local and quick, so a probe that hangs is abandoned sooner than a mount is. */
const PROBE_TIMEOUT_MS = 3_000;
/**
 * The mount waits on the control plane, and enabling HTTPS certificates is a step an admin may be doing right then, so
 * it gets longer than a probe. It is still bounded: the launcher blocks on the CLI until it answers.
 */
const MOUNT_TIMEOUT_MS = 30_000;

const NOT_RUNNING = "Tailscale is not running or not signed in. Run: tailscale up";
const NOT_AUTHORIZED = "This machine is waiting for approval in the tailnet's admin console.";
const STARTING = "Tailscale is still starting up. Try again in a moment.";
const NOT_NAMED =
    'Tailscale has not given this machine a name in the tailnet yet. Check "tailscale status", then try again.';
// An empty CertDomains is also what a netmap that has not arrived yet looks like, so this asks rather than asserts.
const NO_CERTIFICATES =
    "Pi Pocket could not confirm an HTTPS name for this machine yet. If HTTPS certificates are off in this tailnet, open DNS in the admin console, enable MagicDNS and HTTPS certificates, then try again.";
const UNREADABLE =
    'Pi Pocket could not read the "tailscale serve status" output. Update Tailscale, then try again.';

/** What one run of the CLI said; `message` is set instead of the output when it failed. */
type Run = { ok: true; out: string; err: string } | { ok: false; message: string };
/** The serve config, as `tailscale serve status --json` printed it. */
type ConfigRun = { ok: true; config: unknown } | { ok: false; message: string };

export type PortState =
    | { kind: "free" }
    | { kind: "ours"; url: string }
    | { kind: "taken"; detail: string; command: string }
    | { kind: "funnel"; detail: string };

export interface ServeEvents {
    problem(line: string): void;
    /** Persist ownership before a new mount can outlive this process. */
    mountAttempt?(): void;
    /** Forget ownership only after the mount is absent or its removal succeeds. */
    mountRemoved?(): void;
}

export type ServeResult =
    { ok: true; url: string; adopted: boolean } | { ok: false; message: string };

/** The first `1.2.3` line of `tailscale version`, or of anything else that starts with one. */
export function parseTailscaleVersion(text: string): number[] | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)/m.exec(text);

    if (match === null) {
        return undefined;
    }

    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function serveSupported(version: number[] | undefined): boolean {
    if (version === undefined) {
        return false;
    }

    for (let i = 0; i < TAILSCALE_MIN_VERSION.length; i += 1) {
        const found = version[i] ?? 0;
        const needed = TAILSCALE_MIN_VERSION[i] ?? 0;

        if (found !== needed) {
            return found > needed;
        }
    }

    return true;
}

/** Why this node cannot serve anything yet, in terms someone can act on; undefined when it can. */
export function preflightProblem(status: unknown): string | undefined {
    const settings = recordOf(status);

    if (settings === undefined) {
        return NOT_RUNNING;
    }

    const backend = settings.BackendState;

    // A node the tailnet has not admitted yet is signed in, so it waits on the admin console rather than on `tailscale up`.
    if (backend === "NeedsMachineAuth") {
        return NOT_AUTHORIZED;
    }

    // A daemon on its way up is a moment, not a fault, and `tailscale up` is not the advice for it.
    if (backend === "Starting") {
        return STARTING;
    }

    // NeedsLogin, Stopped and NoState, like a missing backend state, all mean there is nothing to serve into.
    if (backend !== "Running") {
        return NOT_RUNNING;
    }

    // Self is null while the node is logged out, and a node that is not in the tailnet cannot be served into it.
    if (recordOf(settings.Self) === undefined) {
        return NOT_RUNNING;
    }

    // A node with no name of its own has no address to serve at, and mounting under an empty key fails after the fact.
    if (tailnetHost(dnsNameOf(settings) ?? "") === undefined) {
        return NOT_NAMED;
    }

    return undefined;
}

/**
 * Why this node has no HTTPS certificate for its name yet, in terms someone can act on; undefined when it has one.
 * `CertDomains` comes from the control plane and is empty unless HTTPS certificates are enabled in the admin console.
 * An empty list is also what a netmap that has not arrived yet looks like, so this asks rather than asserts. It is a
 * check of its own rather than part of preflightProblem() because a mount already in place needs no new certificate.
 */
export function certificateProblem(status: unknown): string | undefined {
    const certificates = recordOf(status)?.CertDomains;

    if (!Array.isArray(certificates) || certificates.length === 0) {
        return NO_CERTIFICATES;
    }

    return undefined;
}

/**
 * Who holds `port` on this node, and whether that is this Pi Pocket's own mount at `/`. `localPort` is the server's own
 * port on loopback, which is what a mount of ours proxies to. A `taken` state carries the command that frees the port:
 * what frees a web mount does not free a TCP forward, and tailscaled refuses the web form while one is there.
 */
export function portState(
    config: unknown,
    dnsName: string,
    port: number,
    localPort: number,
): PortState {
    const host = tailnetHost(dnsName);
    const settings = recordOf(config);
    const allowFunnel = recordOf(settings?.AllowFunnel);
    const funnelKey = host === undefined ? undefined : entryKey(allowFunnel, host, port);

    // Funnel comes before the mounts: it publishes the port to the whole internet, which matters more than who else, or
    // we ourselves, holds a path on it. `AllowFunnel` is keyed "<dnsname>:<port>" in every version 1.52 and later.
    if (funnelKey !== undefined && allowFunnel?.[funnelKey] === true) {
        return { kind: "funnel", detail: webKey(host ?? dnsName, port) };
    }

    const mount = host === undefined ? undefined : mountAt(config, dnsName, port);
    const tcp = recordOf(recordOf(settings?.TCP)?.[String(port)]);

    if (host !== undefined && mount !== undefined) {
        // Our own mount can be spelled several ways, so the target is compared rather than the exact string: it is ours
        // while it points at this server's own loopback port, whoever wrote it down. A plain-http serve at our port is
        // not: calling it https would hand out an address that answers with a TLS error.
        if (sameLocalTarget(mount.Proxy, localPort) && tcp?.HTTP !== true) {
            return { kind: "ours", url: serveUrl(host, port) };
        }

        return {
            kind: "taken",
            detail: typeof mount.Proxy === "string" ? mount.Proxy : 'another mount at "/"',
            command:
                tcp?.HTTP === true
                    ? `tailscale serve --http=${port} --set-path=/ off`
                    : `tailscale serve --https=${port} --set-path=/ off`,
        };
    }

    // HTTPS on the port is how tailscaled terminates TLS for the mounts above, ours included, so on its own it holds
    // nothing. A TCP forward does: it hands the whole port to something that is not http.
    const forward = tcp?.TCPForward;

    if (typeof forward === "string" && forward !== "") {
        return {
            kind: "taken",
            detail: `a TCP forward to ${forward}`,
            command: `tailscale serve --tcp=${port} off`,
        };
    }

    return { kind: "free" };
}

/**
 * Whether `proxy` is a proxy target on this machine's own loopback at exactly `port`. Serve records a target as written,
 * so `localhost:8787`, `127.0.0.1:8787` and `http://[::1]:8787` all name the same local server as `http://127.0.0.1:8787`.
 */
export function sameLocalTarget(proxy: unknown, port: number): boolean {
    if (typeof proxy !== "string") {
        return false;
    }

    const text = proxy.trim();

    if (text === "") {
        return false;
    }

    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
    let target: URL;

    try {
        target = new URL(withScheme);
    } catch {
        return false;
    }

    if (!LOOPBACK_HOSTS.has(target.hostname.toLowerCase())) {
        return false;
    }

    const targetPort =
        target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port);

    // The root of the port over plain http, which is what a mount of this server is: `/app` is a different address, and
    // https at a server that speaks http is a mount that only half works. Neither is ours to adopt or to report.
    return target.protocol === "http:" && target.pathname === "/" && targetPort === port;
}

/**
 * Pi Pocket's address on the tailnet, served by tailscaled itself: one CLI command mounts it, and no process of ours
 * keeps running afterwards. A mount that is already ours is adopted rather than mounted again, so restarting Pi Pocket
 * leaves the address someone is using where it is.
 */
export class TailscaleServe {
    readonly #binary: string;
    readonly #port: number;
    readonly #events: ServeEvents;
    /**
     * Whether this run tried to put a mount at `/`, so a later stop removes only what this run is responsible for. An
     * attempt counts even when the CLI did not answer: only the scoped `off` can tell.
     */
    #published = false;
    /** The node's DNS name as `start` found it, where the mount at `/` is looked for. */
    #dnsName = "";

    /**
     * `binary` is the tailscale CLI to run, and `port` the local server it should proxy to: the tailnet port is always
     * SERVE_PORT.
     */
    constructor(binary: string, port: number, events: ServeEvents) {
        this.#binary = binary;
        this.#port = port;
        this.#events = events;
    }

    start(): ServeResult {
        const versionRun = this.#run(["version"]);

        if (!versionRun.ok) {
            return { ok: false, message: versionRun.message };
        }

        const version = parseTailscaleVersion(`${versionRun.out}\n${versionRun.err}`);

        if (version === undefined) {
            return {
                ok: false,
                message: `Pi Pocket could not tell which Tailscale is installed. Version ${MINIMUM} or newer is needed; update Tailscale.`,
            };
        }

        if (!serveSupported(version)) {
            return {
                ok: false,
                message: `Tailscale ${version.join(".")} is too old for serve. Version ${MINIMUM} or newer is needed; update Tailscale.`,
            };
        }

        const statusRun = this.#run(["status", "--json"]);

        if (!statusRun.ok) {
            return { ok: false, message: statusRun.message };
        }

        const status = parseJson(statusRun.out);
        const problem = preflightProblem(status);

        if (problem !== undefined) {
            return { ok: false, message: problem };
        }

        const dnsName = dnsNameOf(status) ?? "";

        this.#dnsName = dnsName;
        // The node's own name is what every message about it should use; a node with none cannot be served by name.
        const servedName = tailnetHost(dnsName) ?? "this node";
        const proxy = loopback(this.#port);
        const before = this.#serveConfig();

        if (!before.ok) {
            return { ok: false, message: before.message };
        }

        const state = portState(before.config, dnsName, SERVE_PORT, this.#port);
        const adopted = state.kind === "ours";

        // A mount of ours needs no certificate check: it is up, so its certificate already is. Reading the mount before
        // the check is what lets an existing address survive a netmap that has not reported CertDomains yet.
        if (!adopted) {
            const certificates = certificateProblem(status);

            if (certificates !== undefined) {
                return { ok: false, message: certificates };
            }
        }

        if (state.kind === "funnel") {
            // Mounting `/` under Funnel would put Pi Pocket on the internet, not just on the tailnet the menu promises.
            return {
                ok: false,
                message: `Tailscale Funnel is on for ${state.detail ?? servedName}, which would publish Pi Pocket to the internet. Turn it off with "tailscale funnel --https=${SERVE_PORT} off", which takes every handler on ${SERVE_PORT} with it, then try again.`,
            };
        }

        if (state.kind === "taken") {
            return {
                ok: false,
                message: `Port ${SERVE_PORT} is already served by ${state.detail}. Pi Pocket will not replace it. Free it with "${state.command}", or pick another access mode.`,
            };
        }

        /** What the mount command said, for the case where it exits without mounting anything. */
        let said = "";

        // `#published` follows what this run is responsible for. A mount command that timed out may still have been
        // applied by tailscaled, and nothing else can tell us whether it was, so an attempt counts before it runs. An
        // adopted mount is not this run's to remove: quitting leaves it where it is.
        if (!adopted) {
            this.#events.mountAttempt?.();
            this.#published = true;

            // --set-path=/ keeps the mount to this one path, so removing it later cannot take another mount with it.
            const mounted = this.#run(
                ["serve", "--bg", `--https=${SERVE_PORT}`, "--set-path=/", proxy],
                MOUNT_TIMEOUT_MS,
                "If you were enabling HTTPS certificates for this tailnet, finish that in the admin console, then try again.",
            );

            if (!mounted.ok) {
                return { ok: false, message: mounted.message };
            }

            // Tailscale can exit 0 without mounting anything: with HTTPS certificates off it prints the address that
            // turns them on and stops. That address is the only useful thing to say next, so keep it.
            said = lastSaid(`${mounted.out}\n${mounted.err}`);
        }

        const after = this.#serveConfig();
        const served = after.ok
            ? portState(after.config, dnsName, SERVE_PORT, this.#port)
            : undefined;
        const url = served?.kind === "ours" ? served.url : undefined;

        if (url === undefined) {
            // Only tailscaled's own report is worth opening: Self.DNSName would name an address nothing serves when the
            // mount did not take, or when someone removed it in between. main removes the mount after a failed start.
            return {
                ok: false,
                message: after.ok
                    ? `Tailscale Serve reports no mount at "/" for ${servedName}:${SERVE_PORT}.${said === "" ? "" : ` Tailscale said: ${said}`} Check "tailscale serve status".`
                    : after.message,
            };
        }

        return { ok: true, url, adopted };
    }

    stop(): void {
        if (!this.#published) {
            return;
        }

        this.#published = false;

        // Someone may have put another service at `/` since: that one is theirs, and stays.
        const now = this.#serveConfig();
        const mount = now.ok ? mountAt(now.config, this.#dnsName, SERVE_PORT) : undefined;

        if (mount !== undefined && !sameLocalTarget(mount.Proxy, this.#port)) {
            this.#events.mountRemoved?.();

            return;
        }

        const removed = this.#run(["serve", `--https=${SERVE_PORT}`, "--set-path=/", "off"]);

        // An `off` with no handler under it, or with no serve config at all, has nothing to remove: that is what a mount
        // that never took leaves behind, and it is not a problem to report. Any other failure leaves the mount publishing
        // this server, so say what that means: the start after this one takes it down, or reuses it in serve mode.
        if (!removed.ok && !missingMount(removed.message)) {
            this.#events.problem(
                `${removed.message} The tailnet may still point here; the next start takes the mount down or reuses it.`,
            );
        } else {
            this.#events.mountRemoved?.();
        }
    }

    #serveConfig(): ConfigRun {
        return readServeConfig(this.#binary);
    }

    #run(args: string[], timeout = TIMEOUT_MS, timedOutHint?: string): Run {
        return runTailscale(this.#binary, args, timeout, timedOutHint);
    }
}

/**
 * Remove a mount a crashed launcher left at `/` for one of `ports`, so the next start finds it free or adopts it
 * instead of refusing its own remains. Any port the launcher used before counts, because a mount left by a killed run
 * still points at the port that run listened on, not at this one. This never throws: a problem is said through
 * `events?.problem`, and the answer is whether a mount of ours was there to remove.
 */
export function removeStaleServe(
    binary: string,
    ports: readonly number[],
    events?: ServeEvents,
): boolean {
    try {
        const statusRun = runTailscale(binary, ["status", "--json"], PROBE_TIMEOUT_MS);

        if (!statusRun.ok) {
            events?.problem(statusRun.message);

            return false;
        }

        const dnsName = dnsNameOf(parseJson(statusRun.out));

        if (dnsName === undefined) {
            return false;
        }

        const before = readServeConfig(binary, PROBE_TIMEOUT_MS);

        if (!before.ok) {
            events?.problem(before.message);

            return false;
        }

        const mount = mountAt(before.config, dnsName, SERVE_PORT);

        // Only a `/` of ours is ours to remove: the scoped `off` cannot take another mount or another path with it.
        if (mount === undefined || !ports.some((port) => sameLocalTarget(mount.Proxy, port))) {
            events?.mountRemoved?.();

            return false;
        }

        const removed = runTailscale(binary, [
            "serve",
            `--https=${SERVE_PORT}`,
            "--set-path=/",
            "off",
        ]);

        if (!removed.ok) {
            events?.problem(removed.message);

            return false;
        }

        events?.mountRemoved?.();

        return true;
    } catch (error) {
        // A stale mount is tidying up before the real start, so nothing in here is worth failing the start over.
        events?.problem(error instanceof Error ? error.message : String(error));

        return false;
    }
}

function loopback(port: number): string {
    return `http://127.0.0.1:${port}`;
}

/**
 * One CLI command, bounded by `timeout` so a hung daemon cannot hang Pi Pocket with it. `timedOutHint` replaces the
 * generic "it may be hung" advice for a command that legitimately waits on something outside this machine.
 */
function runTailscale(
    binary: string,
    args: string[],
    timeout = TIMEOUT_MS,
    timedOutHint?: string,
): Run {
    const result = spawnSync(binary, args, {
        timeout,
        // `status --json` lists every peer: a large tailnet passes the 1 MiB default.
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    const error = result.error;

    if (error !== undefined) {
        const timedOut = "code" in error && error.code === "ETIMEDOUT";

        return {
            ok: false,
            message: timedOut
                ? `"tailscale ${args.join(" ")}" did not answer within ${timeout / 1000} seconds. ${timedOutHint ?? "Tailscale may be hung: restart it, then try again."}`
                : `Could not run ${binary}: ${error.message}`,
        };
    }

    const out = result.stdout;
    const err = result.stderr;

    if (result.status !== 0) {
        return { ok: false, message: complaint(err, out, args) };
    }

    return { ok: true, out, err };
}

function readServeConfig(binary: string, timeout = TIMEOUT_MS): ConfigRun {
    const run = runTailscale(binary, ["serve", "status", "--json"], timeout);

    if (!run.ok) {
        return run;
    }

    // `{}`, a missing Web, and `null` all mean nothing is served; unparsable output is not the same thing.
    const config = parseJson(run.out);

    if (config === undefined) {
        return { ok: false, message: UNREADABLE };
    }

    return { ok: true, config };
}

/** Whether a failed `off` is tailscaled saying there was nothing mounted under that path. */
/** Whether a failed `off` is tailscaled saying there was nothing mounted under that path. */
function missingMount(message: string): boolean {
    // "handler does not exist" is what the web `off` prints for a path with no handler. The `--tcp` form says "serve
    // config does not exist" instead, and this never runs that one.
    return message.toLowerCase().includes("handler does not exist");
}

/** The last thing a command said, for the message about why it exited without doing what it was asked. */
function lastSaid(text: string): string {
    const said = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .slice(-3)
        .join(" ");

    return said.length > 300 ? `${said.slice(0, 297)}…` : said;
}

/** Why the CLI refused, in terms someone can act on, or its own last word. */
function complaint(err: string, out: string, args: string[]): string {
    if (err.includes("serve config denied")) {
        return 'Run "sudo tailscale set --operator=$USER" once, so Pi Pocket may configure serve.';
    }

    // Tailscale has reworded this more than once, and says it either way when nothing is listening on the socket.
    const said = `${err}\n${out}`.toLowerCase();

    if (
        said.includes("failed to connect to local tailscale daemon") ||
        said.includes("failed to connect to local tailscale service")
    ) {
        return "Tailscale is not running on this machine. Start it (or run: tailscale up), then try again.";
    }

    return (
        lastLine(err) ?? lastLine(out) ?? `"tailscale ${args.join(" ")}" failed without saying why.`
    );
}

function lastLine(text: string): string | undefined {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");

    return lines.at(-1);
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    return value as Record<string, unknown>;
}

/** The hosts that name this machine itself; `URL` keeps the brackets on an IPv6 literal. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The node's name without Tailscale's trailing dot. */
function tailnetHost(dnsName: string): string | undefined {
    const host = dnsName.trim().replace(/\.+$/, "");

    return host === "" ? undefined : host;
}

/** ServeConfig keys its mounts by "<dnsname>:<port>". */
function webKey(host: string, port: number): string {
    return `${host}:${port}`;
}

/**
 * The key `record` holds for `host` and `port`, in the case it spells the name itself: Tailscale prints the DNS name the
 * way the control plane gave it, which need not match the case of the one read from `tailscale status`.
 */
function entryKey(
    record: Record<string, unknown> | undefined,
    host: string,
    port: number,
): string | undefined {
    if (record === undefined) {
        return undefined;
    }

    const wanted = webKey(host, port).toLowerCase();

    return Object.keys(record).find((key) => key.toLowerCase() === wanted);
}

/** The `/` mount this node holds on `port`, when `tailscale serve status --json` reports one. */
function mountAt(
    config: unknown,
    dnsName: string,
    port: number,
): Record<string, unknown> | undefined {
    const host = tailnetHost(dnsName);

    if (host === undefined) {
        return undefined;
    }

    const web = recordOf(recordOf(config)?.Web);
    const key = entryKey(web, host, port);
    const entry = key === undefined ? undefined : recordOf(web?.[key]);

    return recordOf(recordOf(entry?.Handlers)?.["/"]);
}

/**
 * The https address of a mount on `port`, with no trailing slash: it is a base a path gets appended to (the panel's
 * sign-in link), and tailscaled answers `/` itself when a browser opens it.
 */
function serveUrl(host: string, port: number): string {
    return port === SERVE_PORT ? `https://${host}` : `https://${host}:${port}`;
}

function dnsNameOf(status: unknown): string | undefined {
    const name = recordOf(recordOf(status)?.Self)?.DNSName;

    return typeof name === "string" ? name : undefined;
}
