// The server process: how it starts and stops. Each test runs `src/server/main.ts` with its own data and Pi folders.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// The real path: a socket's folder may not be reached through a symlink, and macOS's tmpdir is under one (/var).
const root = mkdtempSync(join(realpathSync(tmpdir()), "pp-main-"));

after(() => rmSync(root, { recursive: true, force: true }));
const MAIN = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
/** Windows has no SIGUSR2 or SIGHUP to send: the launcher stops and starts the server there instead. */
const posix = process.platform === "win32" ? "POSIX signals only" : false;
const unix = process.platform === "win32" ? "Unix sockets only" : false;

/** A free port on this machine. */
async function freePort(): Promise<number> {
    const probe = createServer();

    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;

    await new Promise((resolve) => probe.close(resolve));

    return port;
}

function server(
    name: string,
    listen: number | string[],
    env: Record<string, string> = {},
): { proc: ChildProcess; data: string; output: () => string } {
    const data = join(root, name, "data");
    const proc = spawn(
        process.execPath,
        [
            MAIN,
            ...(typeof listen === "number" ? ["--port", String(listen)] : listen),
            ...["--data", data, "--cwd", root],
        ],
        {
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: join(root, name, "agent"),
                PI_POCKET_GUARD: "off",
                PI_POCKET_LAUNCHER: "",
                PI_POCKET_SUPERVISED: "",
                ...env,
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    let text = "";

    proc.stdout!.on("data", (chunk) => (text += chunk));
    proc.stderr!.on("data", (chunk) => (text += chunk));

    return { proc, data, output: () => text };
}

/** How the process ended; after `limitMs`, if given, it is killed, so a server that should have stopped fails the test. */
async function exit(
    proc: ChildProcess,
    limitMs?: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (proc.exitCode !== null || proc.signalCode !== null) {
        return { code: proc.exitCode, signal: proc.signalCode };
    }

    const timer =
        limitMs === undefined ? undefined : setTimeout(() => proc.kill("SIGKILL"), limitMs);
    const [code, signal] = (await once(proc, "exit")) as [number | null, NodeJS.Signals | null];

    clearTimeout(timer);

    return { code, signal };
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!check()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

test("a taken port stops the server before it opens the database", async () => {
    const blocker = createServer();
    const port = await freePort();

    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));

    try {
        const { proc, data, output } = server("taken", port);

        assert.deepEqual(await exit(proc), { code: 78, signal: null });
        assert.match(output(), /already in use/);
        assert.equal(
            existsSync(join(data, "pocket.sqlite")),
            false,
            "no database was opened, so no work resumed",
        );
        assert.equal(existsSync(join(data, "harness.lock")), false);
    } finally {
        blocker.close();
    }
});

test("a keep-alive time out of range stops the server before it opens the database", async () => {
    for (const value of ["0", "2.5", "3601"]) {
        const { proc, data, output } = server(`keepalive-${value}`, await freePort(), {
            PI_POCKET_KEEPALIVE_SECONDS: value,
        });

        assert.notEqual((await exit(proc)).code, 0, value);
        assert.match(output(), /PI_POCKET_KEEPALIVE_SECONDS must be/, value);
        assert.equal(existsSync(join(data, "pocket.sqlite")), false, value);
    }
});

/**
 * Whether a process handles SIGUSR2 (signal 12) by now, from its caught-signal mask in Linux's /proc; undefined where
 * that cannot be read. Node takes a while to start on a busy machine: until then, the signal's default would end it.
 */
function catchesRestart(pid: number): boolean | undefined {
    try {
        const mask = /^SigCgt:\s*([0-9a-f]+)$/m.exec(
            readFileSync(`/proc/${pid}/status`, "utf8"),
        )?.[1];

        return mask === undefined ? undefined : (BigInt(`0x${mask}`) & (1n << 11n)) !== 0n;
    } catch {
        return undefined;
    }
}

test(
    "a restart asked for while starting waits for the start, then restarts",
    { skip: posix },
    async () => {
        const port = await freePort();
        const { proc, data } = server("early", port);
        // As soon as the server listens for it, which is before it starts loading the app. Without /proc (macOS), once
        // it answers HTTP: it listens for the signal before it opens its port, and a slow start can take longer than
        // any fixed wait.
        const until = Date.now() + 5000;

        while (catchesRestart(proc.pid!) === false && Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        if (catchesRestart(proc.pid!) === undefined) {
            const answers = Date.now() + 30_000;

            while (Date.now() < answers) {
                const answered = await fetch(`http://127.0.0.1:${port}/`).then(
                    () => true,
                    () => false,
                );

                if (answered) {
                    break;
                }

                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }

        proc.kill("SIGUSR2");
        assert.deepEqual(await exit(proc), { code: 75, signal: null });
        assert.equal(
            existsSync(join(data, "harness.lock")),
            false,
            "it closed the database on the way out",
        );
    },
);

test(
    "the server answers 'starting' until it is open, then runs, and a closed terminal stops it cleanly",
    { skip: posix },
    async () => {
        const port = await freePort();
        const { proc, data, output } = server("hup", port, { PI_POCKET_KEEPALIVE_SECONDS: "125" });

        await until(() => output().includes("Pi Pocket is running."), "the server to start");
        const response = await fetch(`http://127.0.0.1:${port}/`);

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("keep-alive"), "timeout=125");
        proc.kill("SIGHUP");
        assert.deepEqual(await exit(proc), { code: 0, signal: null });
        assert.equal(existsSync(join(data, "harness.lock")), false);
    },
);

/** A socket's folder as an administrator makes it: this user's, and writable by no one else. */
function socketFolder(path: string, mode = 0o750): string {
    mkdirSync(path, { recursive: true });
    chmodSync(path, mode);

    return path;
}

function statusOverSocket(socketPath: string, path: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const sent = request({ socketPath, path }, (response) => {
            response.resume();
            resolve(response.statusCode!);
        });

        sent.on("error", reject);
        sent.end();
    });
}

test(
    "a socket folder that another user could change stops the server before it opens the database",
    { skip: unix, timeout: 60_000 },
    async () => {
        symlinkSync(socketFolder(join(root, "real")), join(root, "link"));
        socketFolder(join(root, "real", "in"));
        socketFolder(join(root, "open"), 0o777);

        for (const [name, socket] of [
            ["group may write", join(socketFolder(join(root, "group"), 0o770), "p.sock")],
            ["others may write above", join(socketFolder(join(root, "open", "in")), "p.sock")],
            ["through a symlink", join(root, "link", "in", "p.sock")],
        ] as const) {
            const { proc, data, output } = server(`unsafe-${name}`, ["--socket", socket]);

            assert.deepEqual(await exit(proc, 15_000), { code: 78, signal: null }, name);
            assert.match(output(), /socket folder/, name);
            assert.equal(existsSync(join(data, "pocket.sqlite")), false, name);
        }
    },
);

test(
    "the server never removes or follows a symlink, or a live socket, at the socket path",
    { skip: unix, timeout: 60_000 },
    async () => {
        const folder = socketFolder(join(root, "taken"));
        const target = join(root, "target.txt");
        const live = createServer();

        writeFileSync(target, "keep me");
        symlinkSync(target, join(folder, "link.sock"));
        await new Promise<void>((resolve) => live.listen(join(folder, "live.sock"), resolve));

        try {
            for (const [name, message] of [
                ["link.sock", /is not a socket/],
                ["live.sock", /already in use/],
            ] as const) {
                const { proc, output } = server(`taken-${name}`, ["--socket", join(folder, name)]);

                assert.deepEqual(await exit(proc, 15_000), { code: 78, signal: null }, name);
                assert.match(output(), message, name);
            }

            assert.ok(lstatSync(join(folder, "link.sock")).isSymbolicLink());
            assert.equal(readFileSync(target, "utf8"), "keep me");
            const probe = connect(join(folder, "live.sock"));

            await once(probe, "connect");
            probe.destroy();
        } finally {
            live.close();
        }
    },
);

test(
    "on a socket the server listens on no TCP port, replaces a stale socket, and removes its own on stop",
    { skip: unix, timeout: 60_000 },
    async () => {
        const port = await freePort();
        const empty = server("empty", ["--socket", ""], { PI_POCKET_PORT: String(port) });

        assert.deepEqual(await exit(empty.proc, 15_000), { code: 1, signal: null });
        assert.match(empty.output(), /--socket needs a path/);
        const socket = join(socketFolder(join(root, "stale")), "p.sock");
        // What a killed server leaves: a socket file that nothing answers on.
        const left = spawnSync(process.execPath, [
            "-e",
            `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => process.exit(0))`,
        ]);

        assert.ok(lstatSync(socket).isSocket(), String(left.stderr));
        const { proc, output } = server("stale", ["--socket", socket], {
            PI_POCKET_PORT: String(port),
        });

        try {
            await until(() => output().includes("Pi Pocket is running"), "the server to start");
            assert.equal(lstatSync(socket).mode & 0o777, 0o660, "the proxy's group can connect");
            assert.equal(await statusOverSocket(socket, "/api/me"), 401, "sign-in holds");
            const tcp = connect(port, "127.0.0.1");
            const answered = await new Promise<boolean>((resolve) => {
                tcp.once("connect", () => resolve(true));
                tcp.once("error", () => resolve(false));
            });

            tcp.destroy();
            assert.equal(answered, false, "nothing listens on the port");
            assert.doesNotMatch(output(), /http:\/\//);
        } finally {
            proc.kill("SIGTERM");
            assert.deepEqual(await exit(proc, 15_000), { code: 0, signal: null });
        }

        assert.equal(existsSync(socket), false);
    },
);
