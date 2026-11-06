// Publishing Pi Pocket on the tailnet: the version gate, what `tailscale status --json` must say before anything is
// served, who already holds 443, and the mount itself. The mount runs against a fake tailscale that a test writes into
// a temp dir: no real tailscale is run and nothing here touches the network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
    certificateProblem,
    parseTailscaleVersion,
    portState,
    preflightProblem,
    removeStaleServe,
    sameLocalTarget,
    serveSupported,
    TailscaleServe,
} from "../src/launcher/serve.ts";
import type { ServeEvents } from "../src/launcher/serve.ts";

const NAME = "host.tail1.ts.net";
const LOCAL_PORT = 8787;
const PROXY = `http://127.0.0.1:${LOCAL_PORT}`;
const OFF = "serve --https=443 --set-path=/ off";
const MOUNT = `serve --bg --https=443 --set-path=/ ${PROXY}`;
const SKIP_WINDOWS = "an executable file needs the execute bit, which this platform does not have";
const STATUS = {
    BackendState: "Running",
    Self: { DNSName: `${NAME}.` },
    CertDomains: [NAME],
};

test("the version gate reads `tailscale version` and needs 1.52", () => {
    assert.deepEqual(parseTailscaleVersion("1.58.2\n  tailscale commit: 4f2d1a2b\n"), [1, 58, 2]);
    assert.equal(parseTailscaleVersion("bash: tailscale: command not found"), undefined);
    assert.equal(serveSupported([1, 52, 0]), true);
    assert.equal(serveSupported([2, 0, 0]), true);
    assert.equal(serveSupported([1, 51, 9]), false);
    assert.equal(serveSupported(undefined), false);
});

test("nothing is served from a node that cannot serve", () => {
    const status = (change: object) => ({ ...STATUS, ...change });
    const down = preflightProblem({});

    assert.match(down ?? "", /not running or not signed in/);

    for (const gone of [null, undefined, status({ Self: null })]) {
        assert.equal(preflightProblem(gone), down);
    }

    for (const BackendState of ["NeedsLogin", "Stopped", "NoState"]) {
        assert.equal(preflightProblem(status({ BackendState })), down, BackendState);
    }

    assert.match(preflightProblem(status({ BackendState: "NeedsMachineAuth" })) ?? "", /approval/);
    // An empty DNSName is no name to mount under: the mount would fail after the fact.
    assert.match(
        preflightProblem(status({ Self: { DNSName: "" } })) ?? "",
        /not given this machine a name/,
    );
    // Certificates are a check of their own: a mount already in place needs no new one.
    assert.equal(preflightProblem(status({ CertDomains: [] })), undefined);
    assert.match(certificateProblem(status({ CertDomains: [] })) ?? "", /certificates are off/);
    assert.equal(certificateProblem(STATUS), undefined);
});

const at = (config: unknown, port = 443, name = `${NAME}.`) =>
    portState(config, name, port, LOCAL_PORT);
const web = (proxy: string, key = `${NAME}:443`, path = "/") => ({
    Web: { [key]: { Handlers: { [path]: { Proxy: proxy } } } },
});

test("the address is https on the node's own name, and only a / mount of ours has one", () => {
    const ours = { kind: "ours", url: `https://${NAME}` };

    // No trailing slash (the panel appends a path), no port on 443, the config's own spelling of the name.
    assert.deepEqual(at(web(PROXY)), ours);
    assert.deepEqual(at(web(PROXY), 443, "Host.Tail1.ts.net."), {
        kind: "ours",
        url: "https://Host.Tail1.ts.net",
    });
    assert.deepEqual(at(web(PROXY, `${NAME}:8443`), 8443), {
        kind: "ours",
        url: `https://${NAME}:8443`,
    });
    assert.deepEqual(at(web(PROXY, `${NAME}:8443`)), { kind: "free" });
    assert.deepEqual(at(web(PROXY), 443, ""), { kind: "free" });

    for (const proxy of ["http://localhost:8787", "localhost:8787", "127.0.0.1:8787"]) {
        assert.deepEqual(at(web(proxy)), ours, proxy);
    }
});

test("a mount, a TCP forward, or plain http on 443 is someone else's, with the command that frees it", () => {
    const off = "tailscale serve --https=443 --set-path=/ off";

    for (const proxy of ["http://127.0.0.1:9999", "http://10.0.0.5:8787"]) {
        assert.deepEqual(at(web(proxy)), { kind: "taken", detail: proxy, command: off });
    }

    // Serve mode listens on 127.0.0.1 alone: a mount at [::1] would reach nothing (#254).
    for (const proxy of [
        "http://[::1]:8787",
        "https://127.0.0.1:8787",
        "http://127.0.0.1:8787/x",
    ]) {
        assert.equal(sameLocalTarget(proxy, LOCAL_PORT), false, proxy);
    }

    assert.equal(sameLocalTarget("http://127.0.0.1", LOCAL_PORT), false);
    assert.equal(sameLocalTarget(undefined, LOCAL_PORT), false);
    // Announcing a plain-http serve as https would hand out an address that answers with a TLS error.
    assert.deepEqual(at({ ...web(PROXY), TCP: { "443": { HTTP: true } } }), {
        kind: "taken",
        detail: PROXY,
        command: "tailscale serve --http=443 --set-path=/ off",
    });
    // The web form of `off` fails while a forward holds the port.
    assert.deepEqual(at({ TCP: { "443": { TCPForward: "localhost:22" } } }), {
        kind: "taken",
        detail: "a TCP forward to localhost:22",
        command: "tailscale serve --tcp=443 off",
    });
});

test("another path, tailscaled's own HTTPS, or another port leaves 443 free for /", () => {
    const https = { TCP: { "443": { HTTPS: true } } };

    assert.deepEqual(
        at({ ...web("http://127.0.0.1:9999", `${NAME}:443`, "/elsewhere"), ...https }),
        {
            kind: "free",
        },
    );
    assert.deepEqual(at(https), { kind: "free" });
    assert.deepEqual(at({ ...web(PROXY, `${NAME}:8443`), TCP: { "8443": { HTTPS: true } } }), {
        kind: "free",
    });
});

test("a Funnel on this name and port is reported before anything else holds it", () => {
    const funnel = { kind: "funnel", detail: `${NAME}:443` };

    // It would put the port on the internet, so it outranks our own mount.
    assert.deepEqual(
        at({ ...web(PROXY), AllowFunnel: { [`${NAME}:443`]: true } }, 443, NAME),
        funnel,
    );
    assert.deepEqual(at({ AllowFunnel: { "HOST.Tail1.ts.net:443": true } }), funnel);

    for (const AllowFunnel of [{ "443": true }, { "other.tail1.ts.net:443": true }]) {
        assert.deepEqual(at({ AllowFunnel }), { kind: "free" });
    }

    assert.equal(at({ ...web(PROXY), AllowFunnel: { [`${NAME}:443`]: false } }).kind, "ours");
});

// ─── The mount, against a fake tailscale ────────────────────────────────

const mounted = (proxy: string = PROXY) => web(proxy);

/** A fake tailscale: it logs its argv to `calls`, answers from files beside it, and a mount copies `mounted.json` to `serve.json`. */
function fakeScript(dir: string): string {
    return `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls"
fail() { if [ -f "${dir}/fail-$1" ]; then cat "${dir}/fail-$1" >&2; exit 1; fi; }
case "$1" in
version) fail version; cat "${dir}/version" ;;
status)
    if [ -f "${dir}/hang-status" ]; then sleep 5; fi
    fail status; cat "${dir}/status.json" ;;
serve)
    case " $* " in
    *" status "*) cat "${dir}/serve.json" ;;
    *" off "*)
        fail off
        printf '{"Web":{}}\\n' > "${dir}/serve.json" ;;
    *)
        fail mount
        if [ -f "${dir}/mount-says" ]; then cat "${dir}/mount-says"; fi
        cat "${dir}/mounted.json" > "${dir}/serve.json" ;;
    esac ;;
esac
`;
}

interface FakeOptions {
    status?: unknown;
    serve?: unknown;
    mounted?: unknown;
    /** What `tailscale version` prints. */
    version?: string;
    /** Raw `serve status --json` text, for an answer JSON.parse refuses. */
    serveText?: string;
    /** What the mount command prints on stdout when it does not mount. */
    mountSays?: string;
    /** Fails one command the way the CLI does: this on stderr, exit code 1. */
    fail?: { command: "version" | "status" | "mount" | "off"; error: string };
    /** Makes `tailscale status` hang, for a probe that has to be abandoned. */
    hang?: boolean;
}

interface Fake {
    binary: string;
    calls(): string[];
    /** The `off` commands that ran. */
    offs(): string[];
    /** Replaces what `serve status --json` answers, as someone re-pointing `/` would. */
    serve(config: unknown): void;
    restore(): void;
}

/** A tailscale on PATH that answers from files, so a test can see exactly which commands ran. */
function fakeTailscale(options: FakeOptions = {}): Fake {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-serve-"));
    const binary = join(dir, "tailscale");
    const previous = process.env.PATH;
    const files: Record<string, string> = {
        version: options.version ?? "1.60.0\n",
        "status.json": JSON.stringify(options.status ?? STATUS),
        "serve.json": options.serveText ?? JSON.stringify(options.serve ?? {}),
        "mounted.json": JSON.stringify(options.mounted ?? mounted()),
    };

    if (options.mountSays !== undefined) {
        files["mount-says"] = options.mountSays;
    }

    if (options.fail !== undefined) {
        files[`fail-${options.fail.command}`] = `${options.fail.error}\n`;
    }

    if (options.hang === true) {
        files["hang-status"] = "";
    }

    writeFileSync(binary, fakeScript(dir), { mode: 0o755 });

    for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(dir, name), text);
    }

    process.env.PATH = `${dir}${delimiter}${previous ?? ""}`;

    const calls = () => {
        try {
            return readFileSync(join(dir, "calls"), "utf8")
                .split("\n")
                .filter((line) => line !== "");
        } catch {
            return [];
        }
    };

    return {
        binary,
        calls,
        offs: () => calls().filter((line) => line.endsWith(" off")),
        serve(config) {
            writeFileSync(
                join(dir, "serve.json"),
                typeof config === "string" ? config : JSON.stringify(config),
            );
        },
        restore() {
            if (previous === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = previous;
            }

            rmSync(dir, { recursive: true, force: true });
        },
    };
}

interface Run {
    fake: Fake;
    data: string;
    problems: string[];
    events: ServeEvents;
    /** The ownership lifecycle the launcher would write to its receipt. */
    lifecycle: string[];
    serve(owned?: boolean): TailscaleServe;
}

/** A test with a fake tailscale on PATH (skipped where no file can be executable), cleaned up afterwards. */
function withFake(name: string, options: FakeOptions, body: (run: Run) => void | Promise<void>) {
    test(name, { skip: process.platform === "win32" && SKIP_WINDOWS }, async () => {
        const fake = fakeTailscale(options);
        const data = mkdtempSync(join(tmpdir(), "pi-pocket-launcher-data-"));
        const problems: string[] = [];
        const lifecycle: string[] = [];
        const events: ServeEvents = {
            problem: (line) => problems.push(line),
            mountAttempt: () => lifecycle.push("recorded"),
            mountRemoved: () => lifecycle.push("removed"),
        };

        try {
            await body({
                fake,
                data,
                problems,
                events,
                lifecycle,
                serve: (owned = false) =>
                    new TailscaleServe(fake.binary, LOCAL_PORT, events, owned),
            });
        } finally {
            fake.restore();
            rmSync(data, { recursive: true, force: true });
        }
    });
}

withFake(
    "a fresh mount is published on the node's own name, and stop takes down only it",
    {},
    (run) => {
        const serve = run.serve();
        const order: string[] = [];

        // The receipt is written before the CLI mounts, and dropped only once the CLI has been asked to take it
        // down: a run killed in between must leave it for the next start.
        run.events.mountAttempt = () =>
            order.push(`recorded after ${run.fake.calls().length} calls`);
        run.events.mountRemoved = () => order.push(`removed after ${run.fake.calls().at(-1)}`);
        serve.stop();
        assert.deepEqual(run.fake.calls(), [], "stop with nothing mounted runs nothing");
        assert.deepEqual(serve.start(), { ok: true, url: `https://${NAME}`, adopted: false });
        assert.deepEqual(run.fake.calls(), [
            "version",
            "status --json",
            "serve status --json",
            MOUNT,
            "serve status --json",
        ]);
        serve.stop();
        assert.equal(run.fake.calls().at(-1), OFF);
        assert.deepEqual(order, ["recorded after 3 calls", `removed after ${OFF}`]);
        assert.deepEqual(run.problems, []);
    },
);

withFake(
    "an adopted mount is not mounted again, needs no CertDomains, and quitting leaves it",
    { serve: mounted("http://localhost:8787"), status: { ...STATUS, CertDomains: [] } },
    (run) => {
        const serve = run.serve();

        assert.deepEqual(serve.start(), { ok: true, url: `https://${NAME}`, adopted: true });
        assert.equal(
            run.fake.calls().some((line) => line.startsWith("serve --bg")),
            false,
        );
        serve.stop();
        assert.deepEqual(run.fake.offs(), []);
        assert.deepEqual(run.lifecycle, []);
    },
);

withFake(
    "leaving serve mode takes down an adopted mount that publishes this server",
    { serve: mounted() },
    (run) => {
        const serve = run.serve();

        // Quitting leaves an adopted mount (it may be the owner's); moving to another mode cannot, or the tailnet keeps
        // serving the app while the panel says "this device only".
        assert.equal(serve.start().ok, true);
        serve.stop(true);
        assert.deepEqual(run.fake.offs(), [OFF]);
    },
);

withFake(
    "a mount the receipt names is this run's, so quitting takes it down",
    { serve: mounted() },
    (run) => {
        const serve = run.serve(true);

        assert.equal(serve.start().ok, true);
        serve.stop();
        assert.deepEqual(run.fake.offs(), [OFF]);
    },
);

for (const leaving of [false, true]) {
    withFake(
        `stop(${leaving}) leaves a mount at / that someone pointed at another service`,
        {},
        (run) => {
            const serve = run.serve(true);

            assert.equal(serve.start().ok, true);
            run.fake.serve(mounted("http://127.0.0.1:9999"));
            serve.stop(leaving);
            assert.deepEqual(run.fake.offs(), []);
        },
    );
}

withFake("stop leaves a mount it cannot read, which may be someone else's by now", {}, (run) => {
    const serve = run.serve(true);

    assert.equal(serve.start().ok, true);
    run.fake.serve("No serve config\n");
    run.lifecycle.length = 0;
    assert.equal(serve.stop(), false);
    // Leaving the mode does not take it down either, and the receipt stays for the next start.
    assert.equal(serve.stop(true), false);
    assert.deepEqual(run.fake.offs(), []);
    assert.equal(run.problems.length, 2);
    assert.equal(run.lifecycle.includes("removed"), false, "the receipt stays");
});

withFake(
    "a Funnel on 443 stops the start before anything is mounted",
    { serve: { AllowFunnel: { [`${NAME}:443`]: true } } },
    (run) => {
        const result = run.serve().start();

        assert.equal(result.ok, false);
        assert.match(result.ok ? "" : result.message, /Funnel is on for host\.tail1\.ts\.net:443/);
        assert.equal(
            run.fake.calls().some((line) => line.startsWith("serve --bg")),
            false,
        );
    },
);

withFake(
    "a mount that leaves no entry is not reported as served, says what tailscale said, and is still taken down",
    {
        mounted: {},
        mountSays: "To enable HTTPS, visit https://login.tailscale.com/f/certificates\n",
    },
    (run) => {
        const serve = run.serve();
        const result = serve.start();
        const message = result.ok ? "" : result.message;

        assert.equal(result.ok, false);
        assert.match(
            message,
            /Tailscale said: To enable HTTPS, visit https:\/\/login\.tailscale\.com\/f\/certificates/,
        );
        assert.match(message, /no mount at "\/" for host\.tail1\.ts\.net:443/);
        // main removes the mount after a failed start, and the attempted mount is what makes that an `off` at all.
        serve.stop();
        assert.equal(run.fake.calls().at(-1), OFF);
    },
);

withFake(
    "an off that finds no handler is no problem, and the receipt goes",
    {
        fail: {
            command: "off",
            error: "error: failed to remove web serve: handler does not exist\n\ntry `tailscale serve --help` for usage info",
        },
    },
    (run) => {
        const serve = run.serve();

        serve.start();
        serve.stop();
        assert.deepEqual(run.problems, []);
        assert.deepEqual(run.lifecycle, ["recorded", "removed"]);
    },
);

withFake(
    "an off that fails for another reason is reported and keeps the receipt",
    { fail: { command: "off", error: "serve config denied" } },
    (run) => {
        const serve = run.serve();

        serve.start();
        assert.equal(serve.stop(), false, "the mount is still up");
        assert.equal(run.problems.length, 1);
        assert.match(run.problems[0] ?? "", /set --operator/);
        assert.equal(run.lifecycle.includes("removed"), false, "the receipt stays");
    },
);

const refusals: [string, FakeOptions, RegExp][] = [
    [
        "a daemon that is not running",
        {
            fail: {
                command: "status",
                error: "failed to connect to local tailscale daemon; Falling back to flags-only handling",
            },
        },
        /not running on this machine/,
    ],
    ["a tailscale older than the gate", { version: "1.50.1\n" }, /Tailscale 1\.50\.1 is too old/],
    [
        "a serve status that is not JSON",
        { serveText: "No serve config\n" },
        /could not read the "tailscale serve status" output/,
    ],
    [
        "a failed mount",
        { fail: { command: "mount", error: "error: invalid proxy target" } },
        /^invalid proxy target$/,
    ],
    [
        "the CLI's help footer",
        {
            fail: {
                command: "mount",
                error: "error: cannot serve web; already serving TCP\n\ntry `tailscale serve --help` for usage info",
            },
        },
        /^cannot serve web; already serving TCP$/,
    ],
];

for (const [name, options, expected] of refusals) {
    withFake(`${name} refuses the start with its own reason`, options, (run) => {
        const result = run.serve().start();

        assert.equal(result.ok, false);
        assert.match(result.ok ? "" : result.message, expected);
    });
}

withFake(
    "a stale mount of an earlier run is removed, whatever port it was on",
    { serve: mounted("http://127.0.0.1:9000") },
    (run) => {
        assert.equal(removeStaleServe(run.fake.binary, [9000, LOCAL_PORT], run.events), true);
        assert.deepEqual(run.fake.calls(), ["status --json", "serve status --json", OFF]);
        assert.deepEqual(run.problems, []);
    },
);

withFake(
    "a mount that points somewhere else is not ours to remove",
    { serve: mounted("http://127.0.0.1:9999") },
    (run) => {
        assert.equal(removeStaleServe(run.fake.binary, [LOCAL_PORT], run.events), false);
        assert.deepEqual(run.fake.offs(), []);
    },
);

withFake("with nothing mounted, a stale cleanup runs no off and drops the receipt", {}, (run) => {
    assert.equal(removeStaleServe(run.fake.binary, [LOCAL_PORT], run.events), false);
    assert.deepEqual(run.fake.offs(), []);
    assert.deepEqual(run.lifecycle, ["removed"]);
});

withFake(
    "a failed cleanup keeps ownership for a later retry",
    { serve: mounted(), fail: { command: "off", error: "serve config denied" } },
    (run) => {
        assert.equal(removeStaleServe(run.fake.binary, [LOCAL_PORT], run.events), false);
        assert.deepEqual(run.lifecycle, []);
    },
);

withFake("a probe that hangs is abandoned and says so", { hang: true }, (run) => {
    assert.equal(removeStaleServe(run.fake.binary, [LOCAL_PORT], run.events), false);
    assert.equal(run.problems.length, 1);
    assert.match(run.problems[0] ?? "", /did not answer within 3 seconds/);
});

// ─── The launcher itself ─────────────────────────────────────────────────

/**
 * The launcher itself, copied beside a stub server that only says it is ready, started in `local` mode on `port` with
 * the fake tailscale on its PATH. It runs until the stub starts, which is after the stale mount cleanup, then quits.
 */
async function launchLocal(data: string, port: number, access = "local"): Promise<boolean> {
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const root = mkdtempSync(join(tmpdir(), "pi-pocket-launcher-"));
    const started = join(root, "started");
    let launcher: ReturnType<typeof spawn> | undefined;
    let exited: Promise<unknown> | undefined;

    try {
        mkdirSync(join(root, "src", "launcher"), { recursive: true });
        mkdirSync(join(root, "src", "server"));

        for (const file of readdirSync(join(repo, "src", "launcher"))) {
            copyFileSync(join(repo, "src", "launcher", file), join(root, "src", "launcher", file));
        }

        for (const file of ["lock.ts", "update-state.ts"]) {
            copyFileSync(join(repo, "src", "server", file), join(root, "src", "server", file));
        }

        symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
        writeFileSync(
            join(root, "src", "server", "main.ts"),
            `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "");
// What the launcher tells its server about access, for the test to read back, and the Serve receipt as it was then.
process.on("message", (message) => {
    appendFileSync(${JSON.stringify(join(data, "access.jsonl"))}, JSON.stringify(message) + "\\n");

    if (message?.type === "access") {
        try {
            writeFileSync(
                ${JSON.stringify(join(data, "receipt-at-ready.json"))},
                readFileSync(${JSON.stringify(join(data, "serve-mount.json"))}, "utf8"),
            );
        } catch {}
    }
});
process.send?.({ type: "ready" });
process.on("disconnect", () => process.exit(0));
setInterval(() => {}, 60_000);
`,
        );

        launcher = spawn(
            process.execPath,
            [
                join(root, "src", "launcher", "main.ts"),
                ...["--access", access, "--port", String(port), "--data", data, "--cwd", root],
            ],
            { stdio: "ignore", env: { ...process.env, NO_COLOR: "1" } },
        );
        let launchError: unknown;

        exited = once(launcher, "exit").catch((error: unknown) => {
            launchError = error;
        });

        for (let waited = 0; !existsSync(started) && launcher.exitCode === null; waited += 50) {
            if (launchError !== undefined) {
                throw launchError;
            }

            assert.ok(waited < 15_000, "the launcher did not start its server");
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        return existsSync(started);
    } finally {
        const timer = setTimeout(() => launcher?.kill("SIGKILL"), 15_000);

        try {
            if (
                launcher !== undefined &&
                launcher.exitCode === null &&
                launcher.signalCode === null
            ) {
                launcher.kill("SIGTERM");
            }

            await exited;
        } finally {
            clearTimeout(timer);
            rmSync(root, { recursive: true, force: true });
        }
    }
}

/** What the launcher sent its server about access, once it has sent one. */
async function accessMessages(
    data: string,
): Promise<{ mode?: string; label?: string; url?: string }[]> {
    const file = join(data, "access.jsonl");

    for (let waited = 0; waited < 10_000; waited += 50) {
        try {
            const messages = readFileSync(file, "utf8")
                .split("\n")
                .filter((line) => line !== "")
                .map((line) => JSON.parse(line) as { type?: string; access?: unknown });

            const access = messages
                .filter((message) => message.type === "access")
                .map(
                    (message) => message.access as { mode?: string; label?: string; url?: string },
                );

            if (access.length > 0) {
                return access;
            }
        } catch {
            // Not written yet.
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return [];
}

const receipt = (data: string) => join(data, "serve-mount.json");
const own = (data: string, port: number) =>
    writeFileSync(receipt(data), `${JSON.stringify({ port })}\n`);

withFake(
    "a local start leaves the owner's own mount at its port alone, and takes down one it made",
    { serve: mounted() },
    async (run) => {
        // 0.27's docs had owners run `tailscale serve` in front of `--access local` themselves.
        await launchLocal(run.data, LOCAL_PORT);
        assert.deepEqual(run.fake.offs(), []);

        // A run that made its mount and was killed left a receipt: the next start takes that mount down.
        own(run.data, LOCAL_PORT);
        await launchLocal(run.data, LOCAL_PORT);
        assert.deepEqual(run.fake.offs(), [OFF]);
        assert.equal(existsSync(receipt(run.data)), false);
    },
);

withFake(
    "a local start refuses a port that a mount of an earlier run may still publish",
    { serve: mounted(), fail: { command: "off", error: "serve config denied" } },
    async (run) => {
        own(run.data, LOCAL_PORT);
        assert.equal(await launchLocal(run.data, LOCAL_PORT), false, "the server does not start");
        assert.ok(existsSync(receipt(run.data)), "the receipt stays for a retry");
    },
);

withFake(
    "a serve-mode start clears a receipted mount, writes its own, and takes it down on quit",
    { serve: mounted("http://127.0.0.1:9000") },
    async (run) => {
        // A run killed on --port 9000 left its mount and a receipt: serve mode on 8787 clears that first, or it reads its
        // own mount as someone else's and refuses to start.
        own(run.data, 9000);
        await launchLocal(run.data, LOCAL_PORT, "tailscale-serve");
        assert.ok(run.fake.calls().includes(OFF));
        assert.ok(run.fake.calls().includes(MOUNT));
        assert.equal(
            readFileSync(join(run.data, "receipt-at-ready.json"), "utf8").trim(),
            '{"port":8787}',
        );
        assert.deepEqual(await accessMessages(run.data), [
            { mode: "tailscale-serve", label: "Tailscale Serve", url: `https://${NAME}` },
        ]);
        // SIGTERM goes through the same quit as "q": the mount this run made is taken down and the receipt dropped.
        assert.equal(run.fake.offs().length, 2);
        assert.equal(existsSync(receipt(run.data)), false);
    },
);
