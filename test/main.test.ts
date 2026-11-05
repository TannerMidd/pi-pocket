// The server process: how it starts and stops. Each test runs `src/server/main.ts` with its own data and Pi folders.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "pp-main-"));

after(() => rmSync(root, { recursive: true, force: true }));
const MAIN = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
/** Windows has no SIGUSR2 or SIGHUP to send: the launcher stops and starts the server there instead. */
const posix = process.platform === "win32" ? "POSIX signals only" : false;

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
    port: number,
    env: Record<string, string> = {},
): { proc: ChildProcess; data: string; output: () => string } {
    const data = join(root, name, "data");
    const proc = spawn(
        process.execPath,
        [MAIN, "--port", String(port), "--data", data, "--cwd", root],
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

async function exit(
    proc: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const [code, signal] = (await once(proc, "exit")) as [number | null, NodeJS.Signals | null];

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
        const { proc, data } = server("early", await freePort());
        // As soon as the server listens for it, which is before it starts loading the app; elsewhere, a moment in.
        const until = Date.now() + 5000;

        while (catchesRestart(proc.pid!) === false && Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        if (catchesRestart(proc.pid!) === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 300));
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
