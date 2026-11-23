// An opt-in browser benchmark. See README.md for Playwright setup and the timing endpoints.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as tcpServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const executablePath = process.env.PI_POCKET_BROWSER ?? chromium.executablePath();
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pp-rr-")));
const host = "127.0.0.1";
const warmups = 2;
const samples = 24;
const small = "Remote reads avoid serial requests.\n";
const now = () => performance.timeOrigin + performance.now();

// Set these before importing Pi or spawning the runner. Everything it writes belongs to this run.
Object.assign(process.env, {
    HOME: sandbox,
    USERPROFILE: sandbox,
    TMPDIR: sandbox,
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_STATE_HOME: join(sandbox, "state"),
    PI_POCKET_RUNNER_CONFIG: join(sandbox, "runner.json"),
    PI_OFFLINE: "1",
});
delete process.env.PI_POCKET_RUNNER_DAEMON;

async function listen(server) {
    server.listen(0, host);
    await once(server, "listening");

    return server.address().port;
}

// Split the added RTT over both legs of the runner's real TCP link. The browser goes straight to the server.
function delayProxy(port, rtt) {
    const sockets = new Set();
    const proxy = tcpServer((client) => {
        const remote = connect(port, host);

        for (const [source, peer] of [
            [client, remote],
            [remote, client],
        ]) {
            sockets.add(source);
            source.setNoDelay(true);
            source.on("data", (bytes) => {
                const forward = () => {
                    if (!peer.destroyed) {
                        peer.write(bytes);
                    }
                };

                const halfRtt = rtt() / 2;

                if (halfRtt === 0) {
                    forward();
                } else {
                    setTimeout(forward, halfRtt);
                }
            });
            source.on("error", () => source.destroy());
            source.on("close", () => {
                sockets.delete(source);
                peer.destroy();
            });
        }
    });

    return {
        proxy,
        close: () => {
            proxy.close();

            for (const socket of sockets) {
                socket.destroy();
            }
        },
    };
}

/** The shortest of nine local clock probes bounds the error in a browser-to-server timestamp. */
async function clockOffset(page) {
    const probes = [];

    for (let i = 0; i < 9; i++) {
        const start = now();
        const time = await page.evaluate(() => performance.timeOrigin + performance.now());
        const end = now();

        probes.push({ rtt: end - start, offset: (start + end) / 2 - time });
    }

    return probes.sort((a, b) => a.rtt - b.rtt)[0].offset;
}

/** In the browser, time the first visible summary of the current tool result, not a network response. */
async function showResult(page, tool, file) {
    const send = '.composer button[aria-label="Send"]:enabled';

    await page.locator(".composer textarea").fill(`${tool} ${file}`);
    await page.locator(send).waitFor();

    return page.evaluate(
        ({ send, file }) =>
            new Promise((resolve, reject) => {
                const observer = new MutationObserver(() => {
                    const step = [...document.querySelectorAll('[data-part="tool-call"]')].find(
                        (step) => step.querySelector(".step-subject")?.textContent === file,
                    );
                    const summary = step?.querySelector(".step-meta");

                    if (
                        step?.dataset.state === "ok" &&
                        summary?.checkVisibility() &&
                        summary.textContent.trim()
                    ) {
                        finish(undefined, performance.timeOrigin + performance.now());
                    } else if (["failed", "denied", "stopped"].includes(step?.dataset.state)) {
                        finish(new Error(`Tool failed for ${file}: ${summary?.textContent}`));
                    }
                });
                const timer = setTimeout(
                    () => finish(new Error(`No result shown for ${file}`)),
                    10_000,
                );

                function finish(error, value) {
                    observer.disconnect();
                    clearTimeout(timer);

                    if (error) {
                        reject(error);
                    } else {
                        resolve(value);
                    }
                }

                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    characterData: true,
                });
                document.querySelector(send).click();
            }),
        { send, file },
    );
}

function summary(values) {
    const sorted = values.toSorted((a, b) => a - b);
    const middle = (sorted.length - 1) / 2;

    return {
        medianMs: (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    };
}

let app, http, proxy, runner, runnerExit, browser, cleanUp;
let runnerLog = "";

try {
    const helpers = await import("../helpers.ts");
    const { lastText, openApp, owner, scriptedModel, until } = helpers;
    const { createHandler } = await import("../../src/server/http.ts");
    const { READ_SNAPSHOT } = await import("../../src/runner/read-snapshot.ts");
    const { fauxAssistantMessage, fauxText, fauxToolCall } =
        await import("@earendil-works/pi-ai/providers/faux");
    const started = new Map();

    cleanUp = helpers.cleanUp;
    app = await openApp(
        scriptedModel((input) => {
            const { role, text } = lastText(input);
            const match = role === "user" && /(?:^|\n)(read|edit) ([a-z0-9-]+\.txt)$/.exec(text);

            if (!match) {
                return fauxAssistantMessage([fauxText("Done.")]);
            }

            const [, tool, path] = match;
            const args =
                tool === "read"
                    ? { path }
                    : { path, edits: [{ oldText: "Edit A", newText: "Edit B" }] };

            started.set(path, now());

            return fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" });
        }),
    );
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    http = createServer(createHandler({ app, listen: { host, port: 0 }, restart: () => {} }));
    http.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    const port = await listen(http);
    const base = `http://${host}:${port}`;
    let rtt = 0;

    proxy = delayProxy(port, () => rtt);
    const proxyUrl = `http://${host}:${await listen(proxy.proxy)}`;
    const cli = fileURLToPath(new URL("../../bin/pi-pocket.js", import.meta.url));
    const { code } = app.runners.makeCode("Benchmark runner", owner(app).id);

    await promisify(execFile)(
        process.execPath,
        [cli, "runner", "link", proxyUrl, code, "--allow-http"],
        { timeout: 15_000 },
    );
    runner = spawn(process.execPath, [cli, "runner", "start", "--confirm-via", "stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    // Approve only the new lab session in its temporary folder. This happens before timing any tool calls.
    const confirm = "PI-POCKET-CONFIRM ";

    createInterface({ input: runner.stdout }).on("line", (line) => {
        if (line.startsWith(confirm)) {
            const { id, kind, folder } = JSON.parse(line.slice(confirm.length));
            const allow = kind === "new" && folder === join(sandbox, `files-${rtt}`);

            runner.stdin.write(JSON.stringify({ id, allow }) + "\n");
        }
    });
    runnerExit = once(runner, "exit");
    runnerExit.catch(() => {});

    for (const stream of [runner.stdout, runner.stderr]) {
        stream.on("data", (bytes) => {
            runnerLog = (runnerLog + bytes.toString()).slice(-4_000);
        });
    }

    await until(
        () => app.runners.list()[0]?.online === true,
        "the benchmark runner to connect",
        15_000,
    );
    const runnerId = app.runners.list()[0].id;
    const link = app.runners.link(runnerId);
    let fast = link.supportsReadSnapshot;

    assert.equal(fast, true, "Runner did not announce snapshots");
    // An old runner advertises no support. Switching this only in the fixture uses the unchanged path in the same lab.
    Object.defineProperty(link, "supportsReadSnapshot", { get: () => fast });
    const request = link.request.bind(link);
    let scope;
    let ops = [];

    link.request = (...args) => {
        if (args[3]?.id === scope && scope !== undefined && args[0] !== "exec") {
            ops.push(args[0]);
        }

        return request(...args);
    };

    browser = await chromium.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    const offset = await clockOffset(page);
    const timings = [];

    await page.goto(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);

    for (const addedRttMs of [0, 20, 50, 100]) {
        rtt = addedRttMs;
        const cwd = join(sandbox, `files-${rtt}`);

        await mkdir(cwd);
        const { id } = await app.commands.createSession(owner(app), { cwd, runner: runnerId });

        scope = app.runnerScope(id).id;
        await page.goto(`${base}/s/${id}`);
        const pairs = { read: [], edit: [] };

        for (let i = 0; i < warmups + samples; i++) {
            for (const tool of ["read", "edit"]) {
                const pair = {};

                // Alternate AB/BA and never overlap samples, even at the highest RTT.
                for (const mode of i % 2 === 0 ? ["before", "after"] : ["after", "before"]) {
                    const file = `${tool}-${i}-${mode}.txt`;
                    const path = join(cwd, file);

                    await writeFile(path, tool === "read" ? small : "Edit A\n");
                    fast = mode === "after";
                    ops = [];
                    const visibleAt = await showResult(page, tool, file);
                    const duration = visibleAt + offset - started.get(file);

                    assert.ok(
                        Number.isFinite(duration) && duration >= 0,
                        `Missing timing for ${file}`,
                    );
                    assert.equal(
                        ops.includes(READ_SNAPSHOT),
                        fast && tool === "read",
                        ops.join(", "),
                    );

                    if (tool === "edit") {
                        assert.equal(await readFile(path, "utf8"), "Edit B\n");
                    }

                    pair[mode] = { ms: duration, requests: ops.slice() };
                }

                if (i >= warmups) {
                    pairs[tool].push(pair);
                }
            }
        }

        for (const [tool, pairsForTool] of Object.entries(pairs)) {
            timings.push({
                tool,
                addedRttMs,
                before: summary(pairsForTool.map((pair) => pair.before.ms)),
                after: summary(pairsForTool.map((pair) => pair.after.ms)),
                pairedMedianSavedMs: summary(
                    pairsForTool.map((pair) => pair.before.ms - pair.after.ms),
                ).medianMs,
                pairs: pairsForTool,
            });
        }

        console.error(`Completed +${rtt} ms RTT`);
    }

    console.log(
        JSON.stringify({ warmups, samples, chromium: browser.version(), timings }, null, 2),
    );
} catch (error) {
    console.error(runnerLog);

    throw error;
} finally {
    await browser?.close();

    if (runner?.kill()) {
        await Promise.race([runnerExit, delay(5_000, undefined, { ref: false })]);

        if (runner.exitCode === null && runner.signalCode === null) {
            runner.kill("SIGKILL");
            await runnerExit;
        }
    }

    proxy?.close();
    http?.close();
    http?.closeAllConnections();
    await app?.close();
    cleanUp?.();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
