import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Auth, SIGN_IN_LINK_MS } from "../src/server/auth.ts";
import { ConfigStore } from "../src/server/config.ts";
import { readRunning, removeRunning, RUNNING_FILE, writeRunning } from "../src/launcher/desktop.ts";
import { parseArgs } from "../src/launcher/options.ts";

const root = mkdtempSync(join(realpathSync(tmpdir()), "pp-desktop-"));

after(() => rmSync(root, { recursive: true, force: true }));
const LAUNCHER = fileURLToPath(new URL("../src/launcher/main.ts", import.meta.url));
const OPTIONS = fileURLToPath(new URL("../src/launcher/options.ts", import.meta.url));

test("--desktop means this device only and no questions, unless --access says otherwise", () => {
    const saved = { ...process.env };

    process.env.PI_POCKET_ACCESS = "lan";
    process.env.PI_POCKET_HOST = "0.0.0.0";
    process.env.PI_POCKET_SOCKET = join(root, "env.sock");

    try {
        const plain = parseArgs(["--desktop"]);

        assert.equal(plain.desktop, true);
        assert.equal(plain.access, "local", "the environment's access mode does not reach the app");
        assert.equal(plain.host, undefined, "nor its address");
        assert.equal(plain.socket, undefined, "nor its socket");
        assert.equal(parseArgs(["--desktop", "--host", "127.0.0.2"]).host, "127.0.0.2");
        assert.equal(plain.yes, true);
        assert.equal(parseArgs(["--desktop", "--access", "tailscale"]).access, "tailscale");
        delete process.env.PI_POCKET_SOCKET;
        assert.equal(parseArgs([]).desktop, false);
    } finally {
        for (const name of ["PI_POCKET_ACCESS", "PI_POCKET_HOST", "PI_POCKET_SOCKET"]) {
            if (saved[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = saved[name];
            }
        }
    }

    // Windows may refuse the socket path first.
    if (process.platform === "win32") {
        return;
    }

    const socket = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `const { parseArgs } = await import(${JSON.stringify(new URL(`file://${OPTIONS}`).href)}); parseArgs(["--desktop", "--socket", ${JSON.stringify(join(root, "s.sock"))}]);`,
        ],
        { encoding: "utf8", timeout: 30_000 },
    );

    assert.equal(socket.status, 1);
    assert.match(socket.stderr, /--desktop cannot be combined with --socket/);
});

test("launcher-running.json is private, and only the launcher that wrote it removes it", () => {
    const data = mkdtempSync(join(root, "running-"));

    writeRunning(data, { version: 1, pid: 4242, url: "http://127.0.0.1:1", desktop: true });
    assert.deepEqual(readRunning(data), {
        version: 1,
        pid: 4242,
        url: "http://127.0.0.1:1",
        desktop: true,
    });

    if (process.platform !== "win32") {
        assert.equal(statSync(join(data, RUNNING_FILE)).mode & 0o777, 0o600);
    }

    removeRunning(data, 4343);
    assert.equal(readRunning(data)?.pid, 4242, "another launcher's file stays");
    removeRunning(data, 4242);
    assert.equal(existsSync(join(data, RUNNING_FILE)), false);
    assert.equal(readRunning(data), undefined);
});

test("a one-time sign-in link gives the owner's token once, and only for a minute", (t) => {
    const config = new ConfigStore(mkdtempSync(join(root, "links-")));
    const auth = new Auth(config);
    const first = auth.createSignInLink();

    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(auth.redeemSignInLink(first), config.ownerToken);
    assert.equal(auth.redeemSignInLink(first), undefined, "a link works once");
    assert.equal(auth.redeemSignInLink("not-a-link"), undefined);

    const late = auth.createSignInLink();

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + SIGN_IN_LINK_MS + 1 });
    assert.equal(auth.redeemSignInLink(late), undefined, "a link ends after a minute");
    assert.equal(auth.redeemSignInLink(late), undefined);
    t.mock.timers.reset();

    // Only a few wait at once: each new one past them ends the oldest.
    const links = Array.from({ length: 9 }, () => auth.createSignInLink());

    assert.equal(auth.redeemSignInLink(links[0]!), undefined);
    assert.equal(auth.redeemSignInLink(links[8]!), config.ownerToken);
    assert.equal(auth.redeemSignInLink(links[1]!), config.ownerToken);
});

async function freePort(): Promise<number> {
    const probe = createServer();

    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;

    await new Promise((resolve) => probe.close(resolve));

    return port;
}

async function until<T>(check: () => T | undefined, what: string, timeoutMs = 60_000): Promise<T> {
    const started = Date.now();

    for (;;) {
        const value = check();

        if (value !== undefined) {
            return value;
        }

        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

test("the desktop app's launcher: a ready file, a window that signs in once, no token in its output, and a stop when its input closes", async () => {
    const data = join(root, "desktop", "data");
    const port = await freePort();
    const proc = spawn(
        process.execPath,
        [LAUNCHER, "--desktop", "--port", String(port), "--data", data, "--cwd", root],
        {
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: join(root, "desktop", "agent"),
                PI_POCKET_GUARD: "off",
                PI_POCKET_ACCESS: "",
            },
            stdio: ["pipe", "pipe", "pipe"],
        },
    );
    let output = "";

    proc.stdout.on("data", (chunk) => (output += chunk));
    proc.stderr.on("data", (chunk) => (output += chunk));
    const exited = once(proc, "exit");

    try {
        const running = await until(
            () => (readRunning(data)?.pid === proc.pid ? readRunning(data) : undefined),
            "launcher-running.json",
        );

        assert.deepEqual(running, {
            version: 1,
            pid: proc.pid,
            url: `http://127.0.0.1:${port}`,
            desktop: true,
        });

        const token = (
            JSON.parse(readFileSync(join(data, "config.json"), "utf8")) as {
                ownerToken: string;
            }
        ).ownerToken;
        const ask = (headers: Record<string, string>) =>
            fetch(`${running.url}/api/sign-in-link`, { method: "POST", headers });

        assert.equal((await ask({ "x-pocket": "1" })).status, 401);
        const asked = await ask({ authorization: `Bearer ${token}`, "x-pocket": "1" });

        assert.equal(asked.status, 200);
        const { path } = (await asked.json()) as { path: string };

        assert.match(path, /^\/login\?once=[A-Za-z0-9_-]+$/);
        assert.ok(!path.includes(token));
        const signedIn = await fetch(`${running.url}${path}`, { redirect: "manual" });

        assert.equal(signedIn.status, 303);
        assert.equal(signedIn.headers.get("location"), "/");
        const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;

        assert.equal(cookie, `pocket_auth=${encodeURIComponent(token)}`);
        assert.equal((await fetch(`${running.url}/api/me`, { headers: { cookie } })).status, 200);
        assert.equal(
            (await fetch(`${running.url}${path}`, { redirect: "manual" })).status,
            401,
            "the link is spent",
        );

        // A guest's browser that opens the owner's own link switches without a page that would show the token.
        const guest = await fetch(`${running.url}/api/invite`, {
            method: "POST",
            body: "{}",
            headers: { authorization: `Bearer ${token}`, "x-pocket": "1" },
        });

        assert.equal(guest.status, 200);
        const next = (await (
            await ask({ authorization: `Bearer ${token}`, "x-pocket": "1" })
        ).json()) as {
            path: string;
        };
        const switched = await fetch(`${running.url}${next.path}`, {
            redirect: "manual",
            headers: { cookie: "pocket_auth=someone-else" },
        });

        assert.equal(switched.status, 303);
        assert.ok(!(await switched.text()).includes(token));
        assert.ok(!output.includes(token), "the launcher's output has no token");
        assert.ok(!output.includes("/login"), "the launcher's output has no sign-in link");
        assert.equal(
            existsSync(join(data, "launcher.json")),
            false,
            "the desktop app's access mode is not saved as the last choice",
        );
    } catch (error) {
        console.log(output);

        throw error;
    } finally {
        proc.stdin.end();
    }

    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    const [code] = (await exited) as [number | null];

    clearTimeout(timer);
    assert.equal(code, 0, "the launcher stops when its input closes");
    assert.equal(existsSync(join(data, RUNNING_FILE)), false, "and removes launcher-running.json");
});
