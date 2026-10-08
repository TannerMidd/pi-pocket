import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test(
    "installed Pocket loads, reloads and preserves owner extensions across restarts",
    {
        timeout: 120_000,
    },
    async (t) => {
        const packageDir = process.env.PI_POCKET_TEST_PACKAGE;
        const source = readFileSync(process.env.PI_POCKET_TEST_EXTENSION, "utf8");
        const root = mkdtempSync(join(tmpdir(), "pi-pocket-installed-"));
        const data = join(root, "data");
        const extensions = join(data, "extensions");
        const file = join(extensions, "extension.ts");
        const jsonFile = (name) => JSON.parse(readFileSync(join(data, name), "utf8"));

        mkdirSync(extensions, { recursive: true });
        writeFileSync(file, source);
        assert.equal(
            existsSync(join(packageDir, "share/pi-pocket/node_modules/typescript")),
            false,
        );

        // Use a free loopback port, rather than colliding with a real Pocket instance.
        const listener = createServer();

        listener.listen(0, "127.0.0.1");
        await once(listener, "listening");
        const port = listener.address().port;

        await new Promise((resolve) => listener.close(resolve));
        const base = `http://127.0.0.1:${port}`;

        let child;
        let exited;
        let output = "";

        function start() {
            child = spawn(
                join(packageDir, "bin/pi-pocket"),
                [
                    "--access",
                    "local",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    String(port),
                    "--data",
                    data,
                    "--cwd",
                    root,
                ],
                {
                    cwd: root,
                    detached: true,
                    stdio: ["ignore", "pipe", "pipe"],
                    // The wrapper must supply its own tools; no checkout, user config or build PATH.
                    env: {
                        HOME: root,
                        PATH: "",
                        TMPDIR: tmpdir(),
                        PI_CODING_AGENT_DIR: join(root, "agent"),
                        PI_POCKET_GUARD: "off",
                    },
                },
            );
            exited = once(child, "exit");
            child.stdout.on("data", (chunk) => {
                output += chunk;
            });
            child.stderr.on("data", (chunk) => {
                output += chunk;
            });
        }

        async function stop() {
            if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
                return;
            }

            child.kill("SIGTERM");
            const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 15_000);

            try {
                await exited;
                assert.equal(child.exitCode, 0, "the installed launcher shuts down cleanly");
            } finally {
                clearTimeout(timer);
            }
        }

        t.after(async () => {
            try {
                await stop();
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        async function until(check, what) {
            const deadline = Date.now() + 30_000;

            while (!(await check())) {
                assert.equal(
                    child.exitCode,
                    null,
                    `Pocket exited while waiting for ${what}\n${output}`,
                );
                assert.equal(
                    child.signalCode,
                    null,
                    `Pocket was killed while waiting for ${what}\n${output}`,
                );
                assert.ok(Date.now() < deadline, `Timed out waiting for ${what}\n${output}`);
                await delay(100);
            }
        }

        async function ready() {
            await until(async () => {
                try {
                    const response = await fetch(base, {
                        signal: AbortSignal.timeout(2_000),
                    });

                    await response.text();

                    return response.status === 200;
                } catch {
                    return false;
                }
            }, "the installed server to serve HTTP");
        }

        async function api(path, body) {
            const response = await fetch(`${base}/api/${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: {
                    Authorization: `Bearer ${jsonFile("config.json").ownerToken}`,
                    "X-Pocket": "1",
                    "Content-Type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(3_000),
            });
            const result = await response.json();

            assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}\n${output}`);

            return result;
        }

        const module = async () =>
            (await api("extensions")).modules.find((each) => each.file === "extension.ts");

        async function loaded(version) {
            await until(async () => {
                const current = await module();

                assert.equal(
                    current?.error,
                    undefined,
                    "the drop-in imports installed runtime dependencies",
                );

                return current?.extensions.some((each) => each.name === `runtime-${version}`);
            }, `extension ${version} to be installed`);
            const current = await module();

            assert.equal(current.enabled, true);
            assert.deepEqual(current.extensions, [
                { name: `runtime-${version}`, tools: [`probe_${version}`] },
            ]);
            assert.equal(jsonFile("runtime-probe.json").version, version);
        }

        start();
        await ready();
        const token = jsonFile("config.json").ownerToken;
        const session = await api("sessions", {
            title: "Installed runtime session",
        });

        for (const asset of [
            "/",
            "/app.js",
            "/vendor/preact.mjs",
            "/vendor/preact-hooks.mjs",
            "/vendor/htm.mjs",
            "/vendor/marked.mjs",
            "/vendor/purify.mjs",
        ]) {
            const response = await fetch(`${base}${asset}`, {
                signal: AbortSignal.timeout(3_000),
            });

            assert.equal(response.status, 200, asset);
            assert.match(
                response.headers.get("content-type"),
                asset === "/" ? /text\/html/ : /text\/javascript/,
            );
            assert.ok((await response.text()).length > 0, `${asset} is not empty`);
        }

        assert.equal(
            realpathSync(join(extensions, "node_modules")),
            realpathSync(join(packageDir, "share/pi-pocket/node_modules")),
        );
        assert.equal((await module()).enabled, false);
        assert.deepEqual((await module()).extensions, []);
        assert.equal(
            existsSync(join(data, "runtime-probe.json")),
            false,
            "disabled modules are not executed",
        );

        await api("extensions/extension.ts", { enabled: true });
        await loaded("v1");
        const serverPid = jsonFile("runtime-probe.json").pid;

        writeFileSync(file, source.replaceAll("v1", "v2"));
        await loaded("v2");
        assert.equal(
            jsonFile("runtime-probe.json").pid,
            serverPid,
            "hot reload does not restart the server",
        );

        // Restart through Pocket's actual supervisor, not by reopening an in-process app.
        await api("restart", {});
        await until(
            () => jsonFile("runtime-probe.json").pid !== serverPid,
            "the supervisor to restart the server",
        );
        await ready();
        await loaded("v2");

        // A full installed-launcher restart also preserves owner-created files and enabled choices.
        await stop();
        start();
        await ready();
        await loaded("v2");
        assert.equal(readFileSync(file, "utf8"), source.replaceAll("v1", "v2"));
        assert.equal(jsonFile("config.json").ownerToken, token);
        assert.ok(
            (await api("sessions")).some(
                (each) => each.id === session.id && each.title === "Installed runtime session",
            ),
            "the database session survives both kinds of restart",
        );

        await api("extensions/extension.ts", { enabled: false });
        assert.deepEqual((await module()).extensions, []);
        await stop();
        start();
        await ready();
        assert.equal((await module()).enabled, false, "a disabled choice also survives restart");
        assert.deepEqual((await module()).extensions, []);
    },
);
