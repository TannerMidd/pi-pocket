// A session's environment on another computer (`src/server/runners.ts`, `src/runner/`): the server's `RunnerEnv`, a
// real WebSocket, the runner, and the real pi-env daemon, all on this machine. Pi Durable's own conformance suite checks
// that it acts as `NodeExecutionEnv` does; the rest checks linking, keys, and what survives a drop.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { Duplex } from "node:stream";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import {
    broadFolder,
    coveredFolder,
    folderContains,
    realFolder,
    sameFolder,
} from "../src/runner/folders.ts";
import WebSocket from "ws";
import {
    LINK_PATH,
    LINK_PROTOCOL,
    LINK_SUBPROTOCOL,
    parseControl,
} from "../src/runner/protocol.ts";
import {
    Runner,
    type RunnerOptions,
    type RunnerSettings,
    type SessionQuestion,
    RunnerStopped,
} from "../src/runner/runner.ts";
import { checkTools, toolsStatus } from "../src/runner/tools.ts";
import { ConfigStore } from "../src/server/config.ts";
import { readableEntries, Runners } from "../src/server/runners.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-runner-test-"));

type Setup = {
    server: Server;
    address: string;
    config: ConfigStore;
    runners: Runners;
    lines: string[];
};

async function serve(): Promise<Setup> {
    const config = new ConfigStore(mkdtempSync(join(root, "data-")));
    const lines: string[] = [];
    const runners = new Runners({ config, log: (line) => lines.push(line) });
    const server = createServer((request, response) => {
        response.writeHead(404).end();
    });

    server.on("upgrade", (request, socket, head) => {
        if (!runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = server.address() as AddressInfo;

    return { server, address: `http://127.0.0.1:${port}`, config, runners, lines };
}

/** Link a computer the way `pi-pocket runner link` does, and start its runner. */
function startRunner(
    setup: Setup,
    name: string,
    lines: string[] = [],
    more: Partial<RunnerOptions> = {},
): { runner: Runner; id: string } {
    const { code } = setup.runners.makeCode(name, "owner");
    const linked = setup.runners.redeem(code);
    const options: RunnerOptions = {
        link: { server: setup.address, ...linked },
        version: "test",
        cwd: root,
        log: (line) => lines.push(line),
        retryMs: [50, 100, 200],
        // The person at the computer allows each session (`sessionEnv`).
        ask: async () => ({ allow: true }),
        ...more,
    };
    const runner = new Runner(options);

    started.set(runner, options);
    runner.start();

    return { runner, id: linked.id };
}

/**
 * The environment of a session in `cwd` on computer `id`, approved there first as a new session is: each request names
 * the session, and its runner refuses one without a valid session permission.
 */
async function sessionEnv(setup: Setup, id: string, cwd: string, session = randomUUID()) {
    await setup.runners.link(id).confirm({ kind: "new", person: "Owner", folder: cwd, session });

    return setup.runners.env(id, cwd, { id: session, folder: cwd, person: "Owner" });
}

/** The options each test runner started with, to start it again (`startRunnerFor`). */
const started = new WeakMap<Runner, RunnerOptions>();

/** A new runner linked as `before` was (the same link file): as when the app starts again. */
function startRunnerFor(before: Runner): { runner: Runner } {
    const runner = new Runner(started.get(before)!);

    started.set(runner, started.get(before)!);
    runner.start();

    return { runner };
}

/** Two connected in-memory streams, as a socket and its peer. */
function socketPair(): [Duplex, Duplex] {
    let a: Duplex;
    let b: Duplex;
    const make = (peer: () => Duplex) =>
        new Duplex({
            write(chunk, _encoding, done) {
                peer().push(chunk);
                done();
            },
            final(done) {
                peer().push(null);
                done();
            },
            read() {},
            destroy(error, done) {
                if (!peer().destroyed) {
                    peer().destroy();
                }

                done(error);
            },
        });

    a = make(() => b);
    b = make(() => a);

    return [a, b];
}

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;

    while (!check()) {
        if (Date.now() > end) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function close(setup: Setup): Promise<void> {
    setup.runners.close();
    setup.server.closeAllConnections();
    await new Promise((resolve) => setup.server.close(resolve));
}

after(() => rmSync(root, { recursive: true, force: true }));

describe("runner conformance", () => {
    let setup: Setup;
    let runner: Runner;
    let id: string;

    before(async () => {
        setup = await serve();
        ({ runner, id } = startRunner(setup, "Conformance"));
        await until(() => runner.connected, "the runner to connect");
    });
    after(async () => {
        await runner.stop();
        await close(setup);
    });

    // Jest-style `expect` over node:assert, for the suite.
    const expect = (actual: unknown) => ({
        toBeTruthy: () => assert.ok(actual),
        toBe: (expected: unknown) => assert.equal(actual, expected),
        toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
        toMatchObject: (expected: unknown) => assert.partialDeepStrictEqual(actual, expected),
        toBeGreaterThan: (expected: number) => assert.ok((actual as number) > expected),
        rejects: {
            toThrow: async (message: string) => {
                await assert.rejects(actual as Promise<unknown>, (error: Error) => {
                    assert.ok(error.message.includes(message), error.message);

                    return true;
                });
            },
        },
    });

    registerEnvConformance(
        {
            describe: (name: string, body: () => void) => describe(name, body),
            it: (name: string, body: () => Promise<void>, timeout?: number) =>
                it(name, { timeout: timeout ?? 20_000 }, body),
            expect,
        } as unknown as Parameters<typeof registerEnvConformance>[0],
        "RunnerEnv",
        async (use) => {
            const cwd = mkdtempSync(join(root, "env-"));

            try {
                await use(await sessionEnv(setup, id, cwd));
            } finally {
                rmSync(cwd, { recursive: true, force: true });
            }
        },
        { listFiles: true },
    );
});

async function exec(env: ExecutionEnv, command: string): Promise<string> {
    let output = "";
    const result = await env.exec(command, { onOutput: (text) => (output += text) }, context);

    assert.ok(result.ok, result.ok ? "" : result.error.message);

    return output;
}

describe("runner tools", () => {
    it("reports missing programs without crashing, and checks GitHub sign-in separately", async () => {
        const folder = mkdtempSync(join(root, "tools-"));
        const previous = process.env.PATH;

        process.env.PATH = folder;

        try {
            assert.deepEqual(await checkTools(), { git: false, gh: false, github: false });
            writeFileSync(join(folder, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
            writeFileSync(join(folder, "gh"), '#!/bin/sh\n[ "$1" = "--version" ]\n', {
                mode: 0o700,
            });
            assert.deepEqual(await checkTools(), { git: true, gh: true, github: false });
            writeFileSync(join(folder, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
            assert.deepEqual(await checkTools(), { git: true, gh: true, github: true });
        } finally {
            process.env.PATH = previous;
        }
    });

    it("gives installation and sign-in commands for each system", () => {
        const absent = { git: false, gh: false, github: false };

        assert.match(toolsStatus(absent, "darwin"), /xcode-select --install.*brew install gh/);
        assert.match(
            toolsStatus(absent, "win32"),
            /winget install Git.Git.*winget install GitHub.cli/,
        );
        assert.match(
            toolsStatus(absent, "linux"),
            /sudo apt install git.*https:\/\/github.com\/cli\/cli#installation/,
        );
        assert.match(
            toolsStatus({ git: true, gh: true, github: false }, "linux"),
            /git ✓.*gh auth login/,
        );
        assert.equal(
            toolsStatus({ git: true, gh: true, github: true }, "linux"),
            "git ✓ · GitHub ✓",
        );
    });

    it("carries tools in Hello, exposes them in RunnerView, and refreshes them at reconnect", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Tools");

        try {
            await until(() => runner.connected, "the runner to connect");
            const tools = await checkTools();

            assert.deepEqual(setup.runners.list()[0]?.tools, tools);
            assert.deepEqual(setup.config.runnerById(id)?.tools, tools);
            setup.config.updateRunner(id, {
                tools: { git: !tools.git, gh: !tools.gh, github: !tools.github },
            });
            runner.drop();
            await until(
                () => runner.connected && setup.runners.list()[0]?.tools?.git === tools.git,
                "tools to refresh after reconnect",
            );
            assert.deepEqual(setup.runners.list()[0]?.tools, tools);
        } finally {
            await runner.stop();
            await close(setup);
        }
    });
});

describe("runner link", () => {
    it("a command keeps running across a drop, and its output arrives", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Laptop");

        try {
            await until(() => runner.connected, "the runner to connect");

            const cwd = mkdtempSync(join(root, "drop-"));
            const env = await sessionEnv(setup, id, cwd);
            const pending = exec(env, "echo before; sleep 1; echo during; sleep 1; echo after");

            await new Promise((resolve) => setTimeout(resolve, 300));
            runner.drop();
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(runner.connected, false);

            assert.equal(await pending, "before\nduring\nafter\n");
            assert.ok(setup.lines.some((line) => line.includes("is back; its work goes on")));

            // A handle opened before the drop still works after it.
            const written = await env.writeFile("kept.txt", "kept", context);

            assert.ok(written.ok);
            runner.drop();
            await until(() => runner.connected, "the runner to come back");
            assert.equal(await exec(env, "cat kept.txt"), "kept");
        } finally {
            await runner.stop();
            await close(setup);
        }
    });

    it("offline is offline: a command keeps running however long the link is down, and finishes when it is back", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Desktop");

        try {
            await until(() => runner.connected, "the runner to connect");

            const env = await sessionEnv(setup, id, root);
            const pending = exec(env, "echo start; sleep 2; echo end");

            await new Promise((resolve) => setTimeout(resolve, 300));
            // The link stays down well past the command's end: the server refuses the runner's reconnects for a while.
            const listener = setup.server.listeners("upgrade")[0] as (...args: unknown[]) => void;

            setup.server.removeAllListeners("upgrade");
            setup.server.on("upgrade", (_request, socket) => socket.destroy());
            runner.drop();
            await until(() => setup.runners.list()[0]!.away, "the computer to be offline");
            await new Promise((resolve) => setTimeout(resolve, 3_000));

            // Nothing failed meanwhile, and work asked for while it is offline waits too.
            const later = exec(env, "echo later");
            let settled = false;

            void pending.finally(() => (settled = true));
            await new Promise((resolve) => setTimeout(resolve, 200));
            assert.equal(settled, false);
            assert.ok(setup.lines.some((line) => line.includes("went offline; its work waits")));

            setup.server.removeAllListeners("upgrade");
            setup.server.on("upgrade", listener);

            assert.equal(await pending, "start\nend\n");
            assert.equal(await later, "later\n");
        } finally {
            await runner.stop();
            await close(setup);
        }
    });

    it("when the runner started over, what was in flight fails as lost, and new work runs", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Desktop");

        try {
            await until(() => runner.connected, "the runner to connect");

            const env = await sessionEnv(setup, id, root);
            const pending = env.exec("sleep 30", {}, context);

            await new Promise((resolve) => setTimeout(resolve, 300));
            // The app quit: its runner and the commands it ran are gone. A new runner connects as the same computer.
            await runner.stop();

            const { runner: again } = startRunnerFor(runner);

            try {
                const result = await pending;

                assert.equal(result.ok, false);
                // Stopped on purpose (the app quit), it says so; one that crashed says it restarted.
                assert.match(result.ok ? "" : result.error.message, /stopped|restarted/);
                assert.equal(await exec(env, "echo again"), "again\n");
            } finally {
                await again.stop();
            }
        } finally {
            await close(setup);
        }
    });

    it("a folder lists every entry it can read, without the ones whose lstat fails", async () => {
        const setup = await serve();
        const { runner, id } = startRunner(setup, "Monolith");

        try {
            await until(() => runner.connected, "the runner to connect");

            const folder = mkdtempSync(join(root, "home-"));

            mkdirSync(join(folder, "alpha"));
            mkdirSync(join(folder, "beta"));
            writeFileSync(join(folder, "notes.txt"), "notes");
            // A name the daemon cannot lstat: 255 bytes that are not UTF-8 become 765 bytes of U+FFFD, too long for
            // Linux (ENAMETOOLONG), as `nul` on Windows fails with EISDIR.
            writeFileSync(
                Buffer.concat([Buffer.from(`${folder}/`), Buffer.alloc(255, 0xff)]),
                "unreadable",
            );

            const listed = await setup.runners.folders(id, folder, false);

            assert.deepEqual(
                listed.dirs.map((dir) => dir.name),
                ["alpha", "beta"],
            );

            const env = await sessionEnv(setup, id, folder);
            const all = await env.listDir(folder, context);

            assert.ok(all.ok, all.ok ? "" : all.error.message);
            assert.deepEqual(all.value.map((entry) => entry.name).sort(), [
                "alpha",
                "beta",
                "notes.txt",
            ]);

            const reader = await env.openDirReader(folder, context);

            assert.ok(reader.ok, reader.ok ? "" : reader.error.message);

            const page = await reader.value.next(10, context);

            await reader.value.close(context);
            assert.ok(page.ok, page.ok ? "" : page.error.message);
            assert.equal(page.value.entries.length, 3);
            assert.equal(page.value.done, true);
        } finally {
            await runner.stop();
            await close(setup);
        }
    });

    it("an entry that fails with EISDIR (Windows' `nul`) is left out of its page", () => {
        const page = {
            json: {
                entries: [
                    { name: "Documents", info: { kind: "directory" } },
                    {
                        name: "nul",
                        error: {
                            code: "EISDIR",
                            message:
                                "EISDIR: illegal operation on a directory, lstat 'C:\\Users\\vital\\nul'",
                        },
                    },
                    { name: "Projects", info: { kind: "directory" } },
                ],
                done: true,
            },
            payload: new Uint8Array(),
            session: 1,
        };

        assert.deepEqual(readableEntries(page).json, {
            entries: [
                { name: "Documents", info: { kind: "directory" } },
                { name: "Projects", info: { kind: "directory" } },
            ],
            done: true,
        });

        const clean = { ...page, json: { entries: [page.json.entries[0]], done: true } };

        assert.equal(readableEntries(clean), clean);
    });

    it("a computer that is offline: work waits for it, and an abort ends the wait", async () => {
        const setup = await serve();

        try {
            const { runner: gone, id } = startRunner(setup, "Away");

            await until(() => gone.connected, "the runner to connect");
            // Approved while online: the permission is the computer's, and outlasts its runner.
            const env = await sessionEnv(setup, id, root);

            await gone.stop();
            await until(() => !setup.runners.list()[0]!.online, "the computer to be offline");

            const link = setup.runners.link(id);
            const controller = new AbortController();
            const waiting = link.whenOnline(controller.signal);

            setTimeout(() => controller.abort(new Error("stopped")), 200);
            await assert.rejects(waiting, /stopped/);
            // What a person waits on says it at once.
            await assert.rejects(link.infoNow(), /Away is offline/);

            // Its system is still known, from when it was online.
            assert.ok(setup.runners.system(id)?.tmpdir);

            const ran = exec(env, "echo back");
            const { runner: again } = startRunnerFor(gone);

            try {
                assert.equal(await ran, "back\n");
            } finally {
                await again.stop();
            }
        } finally {
            await close(setup);
        }
    });

    it("opens network connections on the computer, and resets them when the link drops", async () => {
        const setup = await serve();
        const echo = createNetServer((socket) => socket.pipe(socket));
        const gone = createNetServer();

        await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
        await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", resolve));
        // A port nothing listens on any more.
        const closedPort = (gone.address() as AddressInfo).port;

        await new Promise((resolve) => gone.close(resolve));
        const { runner, id } = startRunner(setup, "Net");

        try {
            await until(() => runner.connected, "the runner to connect");

            const link = setup.runners.link(id);
            const [near, far] = socketPair();
            const opened = runner.opened;
            const session = { id: randomUUID(), folder: root, person: "Owner" };

            await link.confirm({ kind: "new", person: "Owner", folder: root, session: session.id });
            await link.openNetwork("localhost", (echo.address() as AddressInfo).port, far, {
                first: [Buffer.from("first ")],
                session,
            });
            assert.equal(runner.opened, opened + 1);

            let echoed = "";

            near.on("data", (chunk: Buffer) => (echoed += chunk.toString()));
            // A megabyte each way: more than a credit window, so credit has to come back.
            const big = "x".repeat(1024 * 1024);

            near.write(big);
            await until(() => echoed.length === 6 + big.length, "the echo");
            assert.ok(echoed.startsWith("first x"));

            // Nothing listens: the computer's error comes back.
            await assert.rejects(
                link.openNetwork("127.0.0.1", closedPort, socketPair()[1], { session }),
                (error: Error) => /refused/i.test(error.message),
            );
            // A stream that names no approved session is refused before it connects.
            await assert.rejects(
                link.openNetwork(
                    "localhost",
                    (echo.address() as AddressInfo).port,
                    socketPair()[1],
                ),
                /not approved on Net/,
            );
            assert.equal(runner.opened, opened + 1);

            const closed = new Promise((resolve) => near.once("close", resolve));

            runner.drop();
            await closed;
            await until(() => runner.connected, "the runner to reconnect");
            await runner.stop();
            await until(() => !setup.runners.list()[0]!.online, "the computer to be offline");
            await assert.rejects(
                link.openNetwork("localhost", 80, socketPair()[1]),
                /Net is offline/,
            );
        } finally {
            await runner.stop();
            echo.close();
            await close(setup);
        }
    });

    it("tells the server its downloads folder, once it is set", async () => {
        const setup = await serve();
        const settings: RunnerSettings = {};
        const { runner, id } = startRunner(setup, "Folder", [], { settings: () => settings });

        try {
            await until(() => runner.connected, "the runner to connect");
            assert.equal(setup.runners.link(id).downloads, undefined);

            // A new setting reaches the server with the next hello.
            settings.downloads = join(root, "My Downloads");
            runner.drop();
            await until(
                () => setup.runners.link(id).downloads === join(root, "My Downloads"),
                "the folder in the hello",
            );
        } finally {
            await runner.stop();
            await close(setup);
        }
    });

    it("an older runner, without network streams, is told to update", async () => {
        const setup = await serve();

        try {
            const { code } = setup.runners.makeCode("Old", "owner");
            const linked = setup.runners.redeem(code);
            const old = new WebSocket(
                `${setup.address.replace("http", "ws")}${LINK_PATH}`,
                LINK_SUBPROTOCOL,
                {
                    headers: { authorization: `Bearer ${linked.key}` },
                },
            );

            await new Promise((resolve) => old.once("open", resolve));
            old.send(
                JSON.stringify({
                    type: "hello",
                    protocol: LINK_PROTOCOL,
                    session: null,
                    received: 0,
                    version: "0.27.0",
                }),
            );
            await until(() => setup.runners.list()[0]?.online === true, "the old runner to link");
            await assert.rejects(
                setup.runners.link(linked.id).openNetwork("localhost", 80, socketPair()[1]),
                /Old runs an older Pi Pocket runner.*update its runner/,
            );
            old.terminate();
        } finally {
            await close(setup);
        }
    });

    it("codes work once; wrong keys and removed computers are refused", async () => {
        const setup = await serve();

        try {
            const { code } = setup.runners.makeCode("Server box", "owner");

            assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);

            const linked = setup.runners.redeem(code.toLowerCase());

            assert.throws(() => setup.runners.makeCode("Server box ", "owner"), /already/);

            assert.throws(() => setup.runners.redeem(code), /wrong, already used, or expired/);
            assert.equal(setup.config.runnerByKey(linked.key)?.name, "Server box");
            assert.equal(setup.config.runnerByKey("nope"), undefined);
            assert.ok(!JSON.stringify(setup.config.runners).includes(linked.key));

            const wrong = new Runner({
                link: { server: setup.address, ...linked, key: "wrong" },
                version: "test",
                cwd: root,
                retryMs: [50],
            });

            wrong.start();
            await assert.rejects(wrong.finished, RunnerStopped);

            const runner = new Runner({
                link: { server: setup.address, ...linked },
                version: "test",
                cwd: root,
                retryMs: [50],
            });

            runner.start();
            await until(() => runner.connected, "the runner to connect");

            const listed = setup.runners.list()[0]!;

            assert.equal(listed.online, true);
            assert.equal(listed.version, "test");
            assert.ok(listed.os !== undefined && listed.home !== undefined);

            setup.runners.remove(linked.id);
            await assert.rejects(runner.finished, /removed this computer/);
            assert.equal(setup.runners.list().length, 0);
        } finally {
            await close(setup);
        }
    });
});

describe("allowed folders", () => {
    it("compares descendants, roots, and platform case without matching siblings", () => {
        assert.equal(folderContains("/work/project", "/work/project/nested", "linux"), true);
        assert.equal(folderContains("/work/project", "/work/project-two", "linux"), false);
        assert.equal(folderContains("/Work", "/work/project", "linux"), false);
        assert.equal(folderContains("/Work", "/work/project", "darwin"), true);
        assert.equal(folderContains("C:\\Work", "c:\\work\\project", "win32"), true);
        assert.equal(folderContains("C:\\Work", "c:\\work-two", "win32"), false);
        assert.equal(folderContains("/", "/work", "linux"), true);
        assert.equal(folderContains("C:\\", "C:\\work", "win32"), true);
        assert.equal(folderContains("/work\\", "/work", "linux"), false);
        assert.equal(broadFolder("/", "/home/person", "linux"), true);
        assert.equal(broadFolder("/home", "/home/person", "linux"), true);
        assert.equal(broadFolder("/home/person", "/home/person", "linux"), true);
        assert.equal(broadFolder("/home/person/project", "/home/person", "linux"), false);
        assert.equal(broadFolder("C:\\", "C:\\Users\\person", "win32"), true);
        assert.equal(broadFolder("/USERS", "/Users/person", "darwin"), true);
    });

    it("uses real paths, skips deleted entries, and can remove an entry that no longer exists", async () => {
        const folder = mkdtempSync(join(root, "real-"));
        const alias = `${folder}-alias`;
        const missing = join(folder, "missing");

        symlinkSync(folder, alias, process.platform === "win32" ? "junction" : "dir");
        assert.equal(await realFolder(alias), await realFolder(folder));
        assert.equal(await coveredFolder(folder, [alias]), true);
        assert.equal(await coveredFolder(missing, [missing]), false);
        assert.equal(await realFolder(missing), missing);
        assert.equal(await sameFolder(alias, folder), true);
        assert.equal(await sameFolder(missing, missing), true);
    });

    it("asks for folder permission in a new folder, session permission in a saved one, and none with stop asking", async () => {
        const setup = await serve();
        const parent = mkdtempSync(join(root, "allowed-"));
        const child = join(parent, "child");
        const sibling = `${parent}-sibling`;
        const settings: RunnerSettings = { folders: [parent] };
        const asked: SessionQuestion[] = [];
        let allow = false;
        const { runner, id } = startRunner(setup, "Folders", [], {
            settings: () => settings,
            saveSettings: (change) => {
                Object.assign(settings, change);
            },
            ask: async (question) => {
                asked.push(question);

                return allow ? { allow: true } : { allow: false, reason: "Not this folder." };
            },
        });

        try {
            await until(() => runner.connected, "the runner to connect");
            const link = setup.runners.link(id);

            // A saved folder (or one below it) asks for session permission, and saves nothing new.
            allow = true;
            await link.confirm({ kind: "new", person: "Owner", folder: child, session: "one" });
            assert.equal(asked.length, 1);
            assert.equal(asked[0]!.permission, "session");
            assert.equal(asked[0]!.session, "one");
            assert.deepEqual(settings.folders, [parent]);
            assert.equal(settings.sessions?.[0]?.approvedBy, "computer");

            // A folder without permission asks for it; Deny saves nothing.
            allow = false;
            await assert.rejects(
                link.confirm({ kind: "new", person: "Owner", folder: sibling, session: "two" }),
                /Not this folder/,
            );
            assert.equal(asked[1]!.permission, "folder");
            assert.equal(asked[1]!.broad, false);
            assert.deepEqual(settings.folders, [parent]);

            // Removing the folder applies to the next question, without reconnecting.
            settings.folders = [];
            await assert.rejects(
                link.confirm({ kind: "new", person: "Owner", folder: child, session: "three" }),
                /Not this folder/,
            );
            assert.equal(asked[2]!.permission, "folder");

            // Stop asking: a saved folder approves without a question; a folder without permission still asks.
            settings.confirm = false;
            settings.folders = [parent];
            await link.confirm({ kind: "new", person: "Owner", folder: child, session: "four" });
            assert.equal(asked.length, 3);
            assert.equal(
                settings.sessions?.find((each) => each.id === "four")?.approvedBy,
                "automatic",
            );
            await assert.rejects(
                link.confirm({ kind: "new", person: "Owner", folder: sibling, session: "five" }),
                /Not this folder/,
            );
            assert.equal(asked.length, 4);
            assert.equal(asked[3]!.permission, "folder");
        } finally {
            await runner.stop();
            await close(setup);
        }
    });

    it("saves Allow answers, including concurrent answers, but not broad folders or cancelled questions", async () => {
        const setup = await serve();
        const first = mkdtempSync(join(root, "first-"));
        const second = mkdtempSync(join(root, "second-"));
        const settings: RunnerSettings = {};
        const asked: SessionQuestion[] = [];
        let paused = false;
        let late: ((answer: { allow: boolean }) => void) | undefined;
        const { runner, id } = startRunner(setup, "Saving", [], {
            settings: () => settings,
            saveSettings: (change) => {
                Object.assign(settings, change);
            },
            ask: async (question) => {
                asked.push(question);

                return paused
                    ? new Promise((resolve) => {
                          late = resolve;
                      })
                    : { allow: true };
            },
        });

        try {
            await until(() => runner.connected, "the runner to connect");
            const link = setup.runners.link(id);

            await Promise.all(
                [first, second].map((folder) =>
                    link.confirm({ kind: "new", person: "Owner", folder }),
                ),
            );
            assert.deepEqual([...(settings.folders ?? [])].sort(), [first, second].sort());
            await link.confirm({ kind: "fork", person: "Owner", folder: first });
            assert.equal(asked.length, 3, "a saved folder asks for session permission");
            assert.equal(asked[2]!.permission, "session");
            assert.equal(settings.folders!.length, 2, "and does not duplicate the entry");

            for (const folder of [homedir(), parse(homedir()).root]) {
                await link.confirm({ kind: "new", person: "Owner", folder });
                assert.equal(asked.at(-1)!.broad, true);
            }

            assert.equal(settings.folders!.length, 2, "broad Allow saves nothing");

            // A broad folder found in the list is ignored: it asks for folder permission again.
            settings.folders = [...settings.folders!, homedir()];
            await link.confirm({
                kind: "new",
                person: "Owner",
                folder: join(homedir(), "x-missing"),
            });
            assert.equal(asked.at(-1)!.permission, "folder");
            settings.folders = settings.folders.filter((folder) => folder !== homedir());
            settings.folders = [];
            paused = true;
            const controller = new AbortController();
            const pending = link.confirm(
                { kind: "move", person: "Owner", folder: first },
                controller.signal,
            );
            const rejected = assert.rejects(pending, /Cancelled/);

            await until(() => late !== undefined, "the move question");
            assert.equal(asked.at(-1)!.kind, "move");
            controller.abort();
            await rejected;
            await until(() => asked.at(-1)!.signal.aborted, "the question to be withdrawn");
            late!({ allow: true });
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.deepEqual(settings.folders, []);
        } finally {
            await runner.stop();
            await close(setup);
        }
    });

    it("parses kind move and asks older runners with a compatible new-session message", async () => {
        const setup = await serve();
        const { code } = setup.runners.makeCode("Old", "owner");
        const linked = setup.runners.redeem(code);
        const old = new WebSocket(
            `${setup.address.replace("http", "ws")}${LINK_PATH}`,
            LINK_SUBPROTOCOL,
            {
                headers: { authorization: `Bearer ${linked.key}` },
            },
        );
        const question = {
            type: "confirm",
            id: "question",
            kind: "move",
            person: "Owner",
            folder: root,
        };

        assert.deepEqual(parseControl(JSON.stringify(question)), question);
        old.on("message", (data, binary) => {
            if (binary) {
                return;
            }

            const message = JSON.parse(data.toString());

            if (message.type === "confirm") {
                // The older parser accepts only new and fork. Extra fields are ignored.
                assert.equal(message.kind, "new");
                assert.equal(message.move, true);
                old.send(JSON.stringify({ type: "confirmed", id: message.id, allow: true }));
            }
        });

        try {
            await new Promise((resolve) => old.once("open", resolve));
            old.send(
                JSON.stringify({
                    type: "hello",
                    protocol: LINK_PROTOCOL,
                    session: null,
                    received: 0,
                    version: "0.27.0",
                }),
            );
            await until(() => setup.runners.list()[0]?.online === true, "the old runner to link");
            await setup.runners
                .link(linked.id)
                .confirm({ kind: "move", person: "Owner", folder: root });
        } finally {
            old.terminate();
            await close(setup);
        }
    });

    it("the terminal runner saves stdio Allow before ending a question, and sees CLI removals without restarting", async () => {
        const setup = await serve();
        const folder = mkdtempSync(join(root, "stdio-"));
        const file = join(folder, "link.json");
        const childFolder = join(folder, "child");
        const { code } = setup.runners.makeCode("Terminal", "owner");
        const linked = setup.runners.redeem(code);
        const launcher = fileURLToPath(new URL("../bin/pi-pocket.js", import.meta.url));

        mkdirSync(childFolder);
        writeFileSync(file, JSON.stringify({ server: setup.address, ...linked }));
        const proc = spawn(
            process.execPath,
            [launcher, "runner", "start", "--confirm-via", "stdio", "--config", file],
            {
                cwd: root,
                stdio: ["pipe", "pipe", "pipe"],
            },
        );
        const stopped = new Promise<void>((resolve) => proc.once("close", () => resolve()));
        const questions: {
            id: number;
            kind: SessionQuestion["kind"];
            broad: boolean;
            folder: string;
            person: string;
            permission: SessionQuestion["permission"];
        }[] = [];
        const savedAtEnd: string[][] = [];
        let errors = "";

        proc.stderr.on("data", (chunk: Buffer) => {
            errors += chunk.toString();
        });
        createInterface({ input: proc.stdout }).on("line", (line) => {
            if (line.startsWith("PI-POCKET-CONFIRM ")) {
                questions.push(JSON.parse(line.slice("PI-POCKET-CONFIRM ".length)));
            } else if (line.startsWith("PI-POCKET-CONFIRM-END ")) {
                savedAtEnd.push(JSON.parse(readFileSync(file, "utf8")).settings?.folders ?? []);
            }
        });
        const answer = (allow: boolean) =>
            proc.stdin.write(`${JSON.stringify({ id: questions.at(-1)!.id, allow })}\n`);

        try {
            await until(
                () => setup.runners.list()[0]?.online === true,
                `the CLI runner to connect (${errors})`,
            );
            const link = setup.runners.link(linked.id);
            const move = link.confirm({ kind: "move", person: "Owner", folder });

            await until(() => questions.length === 1, "the move question on stdout");
            assert.partialDeepStrictEqual(questions[0], {
                kind: "move",
                broad: false,
                folder: await realFolder(folder),
                person: "Owner",
            });
            answer(true);
            await move;
            await until(() => savedAtEnd.length === 1, "the question end after saving");
            assert.deepEqual(savedAtEnd[0], [await realFolder(folder)]);
            const session = link.confirm({ kind: "new", person: "Owner", folder: childFolder });

            await until(() => questions.length === 2, "the session question for a saved folder");
            assert.partialDeepStrictEqual(questions[1], {
                permission: "session",
                expired: false,
                totp: false,
                expiresInMs: 120_000,
            });
            answer(true);
            await session;
            await promisify(execFile)(process.execPath, [
                launcher,
                "runner",
                "folders",
                "remove",
                folder,
                "--config",
                file,
            ]);
            const denied = assert.rejects(
                link.confirm({ kind: "new", person: "Owner", folder: childFolder }),
                /denied/,
            );

            await until(() => questions.length === 3, "the new question after removal");
            assert.equal(questions[2]!.permission, "folder");
            answer(false);
            await denied;
            const broad = link.confirm({
                kind: "new",
                person: "Owner",
                folder: parse(homedir()).root,
            });

            await until(() => questions.length === 4, "the broad question");
            assert.equal(questions[3]!.broad, true);
            answer(true);
            await broad;
            assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).settings.folders, []);
        } finally {
            proc.kill("SIGTERM");
            await stopped;
            await close(setup);
        }
    });

    it("lists and removes folders through the CLI with an explicit config, without touching running sessions", async () => {
        const folder = mkdtempSync(join(root, "cli-"));
        const file = join(folder, "link.json");
        const allowed = join(folder, "allowed ");
        const run = (args: string[]) =>
            promisify(execFile)(process.execPath, [
                fileURLToPath(new URL("../bin/pi-pocket.js", import.meta.url)),
                "runner",
                ...args,
                "--config",
                file,
            ]);

        mkdirSync(allowed);
        writeFileSync(
            file,
            JSON.stringify({
                server: "https://example.com",
                id: "id",
                name: "Computer",
                key: "secret",
                settings: { confirm: true, folders: [allowed] },
            }),
        );
        assert.deepEqual(JSON.parse((await run(["folders", "--json"])).stdout), [allowed]);
        assert.equal((await run(["folders"])).stdout, `${allowed}\n`);
        await run(["folders", "remove", allowed]);
        assert.deepEqual(JSON.parse((await run(["folders", "--json"])).stdout), []);
        assert.equal((await run(["folders"])).stdout.trim(), "No saved folders yet.");
        assert.equal(JSON.parse(readFileSync(file, "utf8")).settings.confirm, true);
        await assert.rejects(
            run(["folders", "remove", allowed]),
            (error: Error & { code?: number }) =>
                error.code === 1 && error.message.includes("No allowed folder matches"),
        );
        await assert.rejects(
            run(["service"]),
            (error: Error & { code?: number }) => error.code === 1,
        );
    });
});

mkdirSync(root, { recursive: true });
