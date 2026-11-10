// The browser of a session on another computer (`src/server/browser/proxy.ts`, `src/runner/tunnels.ts`): a real
// Chromium on this server, a real runner and pi-env daemon, a real WebSocket link. Every page the session opens loads
// through the runner, which opens the connections on its computer; here that computer is this machine, so the runner's
// count of opened connections proves the path, and the test sites count what reaches them.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { WebSocketServer } from "ws";
import { Runner } from "../src/runner/runner.ts";
import type { RunnerOptions, RunnerSettings } from "../src/runner/runner.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** The other computer's folders: its project, and its temporary folder (`TMPDIR` of its daemon). */
const there = join(root, "there");
const computerTmp = join(root, "computer-tmp");
/** This server's temporary folder (`TMPDIR` of the test process once the runner started). */
const serverTmp = join(root, "server-tmp");
const BIG = 96 * 1024 * 1024;
const REPORT = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) % 251));

let app: App;
let server: Server;
let site: Server;
let sitePort = 0;
/** Requests that reached the test site, by path. */
const reached: string[] = [];
let runner: Runner;
let runnerOptions: RunnerOptions;
let runnerId: string;
const settings: RunnerSettings = {};
/** Each browser tool result, in order. */
const results: string[] = [];

const PAGE = `<!doctype html><title>Through the computer</title><h1>Hello from the computer</h1>
<a id="dl" href="/report.bin">Report</a>
<p id="ws">waiting</p>
<script>
const socket = new WebSocket("ws://" + location.host + "/ws");
socket.onopen = () => socket.send("ping");
socket.onmessage = (event) => { document.getElementById("ws").textContent = event.data; };
socket.onerror = () => { document.getElementById("ws").textContent = "ws failed"; };
</script>`;

/** The model: each "browser {...}" message is one browser tool call with those arguments. */
const route: FauxResponseStep = (input) => {
    const { role, text } = lastText(input as never);

    if (role === "toolResult") {
        results.push(text);

        return fauxAssistantMessage([fauxText("done")]);
    }

    if (text.startsWith("browser ")) {
        return fauxAssistantMessage([fauxToolCall("browser", JSON.parse(text.slice(8)))], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

/** Call the browser tool in a session; its result. */
async function browse(id: number, args: Record<string, unknown>): Promise<string> {
    const count = results.length;

    await say(app, id as never, `browser ${JSON.stringify(args)}`);
    await until(() => results.length > count, "the browser tool's result");

    return results.at(-1)!;
}

/** Start a download with a browser call, and wait for its end unless that call's result has it already. */
async function download(id: number, args: Record<string, unknown>): Promise<string> {
    const began = await browse(id, args);

    if (/Downloaded |The download of /.test(began)) {
        return began;
    }

    return `${began}\n${await browse(id, { action: "wait", download: true, timeoutMs: 60_000 })}`;
}

/** Every file below a folder. */
function files(folder: string): string[] {
    if (!existsSync(folder)) {
        return [];
    }

    return readdirSync(folder, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name));
}

const incoming = () => files(join(root, "data", "browser", "incoming"));

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(there, { recursive: true });
    mkdirSync(computerTmp, { recursive: true });
    mkdirSync(serverTmp, { recursive: true });

    site = createServer((request, response) => {
        reached.push(request.url ?? "");

        if (request.url === "/report.bin") {
            response.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-disposition": 'attachment; filename="report.bin"',
                "content-length": REPORT.length,
            });
            response.end(REPORT);

            return;
        }

        if (request.url === "/big.bin") {
            const piece = Buffer.alloc(1024 * 1024, 7);
            let sent = 0;

            response.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-disposition": 'attachment; filename="big.bin"',
                "content-length": BIG,
            });

            const more = () => {
                while (sent < BIG) {
                    sent += piece.length;

                    if (!response.write(piece)) {
                        response.once("drain", more);

                        return;
                    }
                }

                response.end();
            };

            more();

            return;
        }

        response.writeHead(200, { "content-type": "text/html" });
        response.end(PAGE);
    });
    site.on("upgrade", (request) => reached.push(request.url ?? ""));
    new WebSocketServer({ server: site }).on("connection", (socket) =>
        socket.on("message", () => socket.send("ws-ok")),
    );
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    sitePort = (site.address() as AddressInfo).port;

    app = await openApp(scriptedModel(route));
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer((request, response) => response.writeHead(404).end());
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

    const { code } = app.runners.makeCode("Laptop", owner(app).id);
    const linked = app.runners.redeem(code);

    runnerId = linked.id;
    // The daemon takes its temporary folder from its environment, as on a person's computer.
    const tmp = process.env.TMPDIR;

    process.env.TMPDIR = computerTmp;
    runnerOptions = {
        link: { server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...linked },
        version: "test",
        cwd: there,
        log: () => {},
        retryMs: [50, 100, 200],
        settings: () => settings,
        ask: () => Promise.resolve({ allow: true }),
    };
    runner = new Runner(runnerOptions);
    runner.start();
    await until(() => app.runners.list()[0]?.online === true, "the runner to connect");
    await app.runners.link(runnerId).info();

    // From now, this server's temporary folder is its own, apart from the computer's.
    process.env.TMPDIR = serverTmp;

    restoreTmp = () => {
        if (tmp === undefined) {
            delete process.env.TMPDIR;
        } else {
            process.env.TMPDIR = tmp;
        }
    };
});

let restoreTmp = () => {};

after(async () => {
    restoreTmp();
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    server?.close();
    site?.closeAllConnections();
    site?.close();
    cleanUp();
});

describe("the browser of a session on another computer", () => {
    let id: number;
    const page = () => `localhost:${sitePort}`;

    before(async () => {
        if (chromium === undefined) {
            return;
        }

        const created = await app.commands.createSession(owner(app), {
            cwd: there,
            runner: runnerId,
        });

        id = created.id;
        await app.commands.configure(id as never, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });
        await loadTools(app, id as never, "browser");
    });

    it(
        "loads a page and its WebSocket through the computer, its localhost included",
        real,
        async () => {
            const opened = runner.opened;
            const result = await browse(id, { action: "navigate", url: page() });

            assert.match(result, /Through the computer/);
            assert.ok(!/Could not open/.test(result), result);
            assert.match(await browse(id, { action: "wait", text: "ws-ok" }), /ws-ok|Found/i);
            // The page and its WebSocket: each a connection the runner opened on its computer.
            assert.ok(runner.opened - opened >= 2, `the runner opened ${runner.opened - opened}`);
            assert.ok(reached.includes("/ws"));
        },
    );

    it("downloads to the computer's temporary folder, and keeps no copy here", real, async () => {
        const done = await download(id, { action: "click", selector: "#dl" });
        const folder = join(computerTmp, "pi-pocket-downloads", app.runnerScope(id as never).id);
        const file = join(folder, "report.bin");

        assert.ok(done.includes(`Downloaded ${file} (68 KB).`), done);
        assert.deepEqual(readFileSync(file), REPORT);
        assert.deepEqual(incoming(), [], "no server copy stays");
        assert.deepEqual(files(serverTmp), [], "nothing in this server's folder");

        // The same name again gets a number.
        const again = await download(id, { action: "navigate", url: `${page()}/report.bin` });

        assert.ok(again.includes(`Downloaded ${join(folder, "report (2).bin")} (68 KB).`), again);

        // Waiting after the call that reported it names that download, not "none".
        const late = await browse(id, { action: "wait", download: true, timeoutMs: 300 });

        assert.ok(
            late.includes(
                `The last one, already reported by the call that started it: ${join(folder, "report (2).bin")} (68 KB).`,
            ),
            late,
        );
    });

    it("downloads to the folder the computer's runner settings name", real, async () => {
        const chosen = join(root, "chosen downloads");

        // The setting reaches the server with the runner's next hello.
        settings.downloads = chosen;

        try {
            runner.drop();
            await until(
                () => app.runners.link(runnerId).downloads === chosen,
                "the runner's folder",
            );
            const done = await download(id, { action: "navigate", url: `${page()}/report.bin` });
            const file = join(chosen, app.runnerScope(id as never).id, "report.bin");

            assert.ok(done.includes(`Downloaded ${file} (68 KB).`), done);
            assert.deepEqual(readFileSync(file), REPORT);
        } finally {
            delete settings.downloads;
            runner.drop();
            await until(
                () => app.runners.link(runnerId).downloads === undefined && runner.connected,
                "the default folder again",
            );
        }
    });

    it("keeps the computer's commands fast while a large download runs", real, async (t) => {
        // The session's own environment: its runner refuses a command that names no approved session.
        const env = app.runners.env(
            runnerId,
            there,
            app.runnerScope(id as unknown as Parameters<typeof app.runnerScope>[0]),
        );
        const navigated = await browse(id, { action: "navigate", url: `${page()}/big.bin` });

        assert.match(navigated, /is a download|Downloading big\.bin/);

        const timings: number[] = [];

        while (app.browsers.downloads.pending(id) && timings.length < 20) {
            const started = Date.now();
            const ran = await env.exec("echo hi", { timeout: 10 }, context);

            assert.ok(ran.ok);
            timings.push(Date.now() - started);
        }

        const done = await browse(id, { action: "wait", download: true, timeoutMs: 60_000 });

        assert.match(done, /Downloaded \S*big\.bin \(96 MB\)\./);
        t.diagnostic(`commands during the download: ${timings.join(", ")} ms`);
        assert.ok(timings.length >= 2, `commands ran ${timings.length} times during the download`);
        assert.ok(Math.max(...timings) < 2000, `slowest command: ${Math.max(...timings)} ms`);
        assert.deepEqual(incoming(), []);
    });

    it("refuses this server's files", real, async () => {
        const result = await browse(id, { action: "navigate", url: "/etc/hosts" });

        assert.match(result, /is a file: in a session on Laptop/);
    });

    it("lets nobody else on this server use the proxy", real, async () => {
        const port = app.browsers.proxyPort;

        assert.ok(port !== undefined);

        // A wrong user and password ("wrong:wrong"), encoded here so that secret scanners do not take it for a real one.
        const wrong = Buffer.from("wrong:wrong").toString("base64");

        for (const auth of ["", `Proxy-Authorization: Basic ${wrong}\r\n`]) {
            const answer = await new Promise<string>((done) => {
                const socket = connect(port, "127.0.0.1", () =>
                    socket.write(`CONNECT localhost:${sitePort} HTTP/1.1\r\n${auth}\r\n`),
                );
                let text = "";

                socket.on("data", (chunk) => (text += chunk.toString()));
                socket.on("close", () => done(text));
            });

            assert.match(answer, /^HTTP\/1\.1 407 /);
        }
    });

    it("fails when the computer does not share its network", real, async () => {
        settings.network = false;

        try {
            const count = reached.length;
            const result = await browse(id, { action: "navigate", url: `${page()}/closed` });

            assert.match(result, /Laptop does not share its network/);
            assert.equal(reached.length, count, "nothing reached the site");
        } finally {
            delete settings.network;
        }
    });

    it("leaves a server session's browser as it was: no proxy, no computer", real, async () => {
        const local = await newSession(app);

        await loadTools(app, local, "browser");
        const opened = runner.opened;
        const result = await browse(Number(local), {
            action: "navigate",
            url: `127.0.0.1:${sitePort}/`,
        });

        assert.match(result, /Through the computer/);
        assert.equal(runner.opened, opened, "the runner opened nothing");

        // Its downloads go to this server's private folder, not to the computer.
        const done = await download(Number(local), {
            action: "navigate",
            url: `127.0.0.1:${sitePort}/report.bin`,
        });
        const folder = join(serverTmp, `pi-pocket-downloads-${process.getuid!()}`);
        const file = join(folder, String(local), "report.bin");

        assert.ok(done.includes(`Downloaded ${file} (68 KB).`), done);
        assert.deepEqual(readFileSync(file), REPORT);
        assert.equal(statSync(folder).mode & 0o777, 0o700);
        assert.equal(runner.opened, opened, "the runner opened nothing");
        assert.deepEqual(incoming(), []);
    });

    it(
        "a download whose computer goes offline before the copy waits, and is copied there when it is back",
        real,
        async () => {
            const downloads = app.browsers.downloads;
            const progress = downloads.progress.bind(downloads);
            const folder = join(
                computerTmp,
                "pi-pocket-downloads",
                app.runnerScope(id as never).id,
            );

            // The moment Chromium finishes the file, the computer goes away, and comes back a little later.
            downloads.progress = (params) => {
                if (params.state === "completed") {
                    void runner.stop().then(() => {
                        progress(params);
                        setTimeout(() => {
                            const tmp = process.env.TMPDIR;

                            process.env.TMPDIR = computerTmp;
                            runner = new Runner(runnerOptions);
                            runner.start();
                            process.env.TMPDIR = tmp;
                        }, 1_000);
                    });

                    return;
                }

                progress(params);
            };

            try {
                const result = await download(id, {
                    action: "navigate",
                    url: `${page()}/report.bin`,
                });

                assert.match(result, /Downloaded .*report.*\.bin/);
                assert.ok(files(folder).some((file) => file.includes("report")));
                assert.deepEqual(incoming(), [], "no server copy stays");
            } finally {
                downloads.progress = progress;
            }
        },
    );

    it(
        "a page asked for while the computer is offline waits for it, and nothing goes out from here meanwhile",
        real,
        async () => {
            await runner.stop();
            await until(() => app.runners.list()[0]?.online === false, "the runner to go offline");
            const count = reached.length;
            const pending = browse(id, { action: "navigate", url: `${page()}/offline` });

            await new Promise((resolve) => setTimeout(resolve, 1_000));
            assert.equal(reached.length, count, "nothing reached the site while it was offline");

            const tmp = process.env.TMPDIR;

            process.env.TMPDIR = computerTmp;
            runner = new Runner(runnerOptions);
            runner.start();
            process.env.TMPDIR = tmp;
            await pending;
            assert.ok(
                reached.length > count,
                "the page loaded through the computer once it was back",
            );
        },
    );
});
