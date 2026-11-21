import {
    type App,
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { linkInProcess } from "../src/runner/secure-link.ts";
import fs, { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { READ_SNAPSHOT } from "../src/runner/read-snapshot.ts";
import { Runner, type RunnerSettings } from "../src/runner/runner.ts";
import { createHandler } from "../src/server/http.ts";

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNoYGj4DwAEBAIAXHop6wAAAABJRU5ErkJggg==",
    "base64",
);
let app: App;
let server: Server;
let runner: Runner;
let folder: string;
let outside: string;
let runnerId: string;
let id: ConversationId;
const settings: RunnerSettings = {};
let approvalsAllowed = true;
let questions = 0;

before(async () => {
    const here = await realpath(root);

    folder = join(here, "runner-read");
    outside = join(here, "outside.txt");
    await mkdir(folder);
    await Promise.all([
        writeFile(join(folder, "small.txt"), "Remote line one\nRemote line two\nfin\n"),
        writeFile(join(folder, "bom.txt"), "\ufeffFørste\r\nAndre\nTredje\n"),
        writeFile(join(folder, "lines.txt"), "x\n".repeat(2_500)),
        writeFile(join(folder, "large.txt"), "x".repeat(60 * 1024)),
        writeFile(join(folder, "binary.bin"), Buffer.from([0, 0xff, 0x80, 0x0a, 0xc3])),
        writeFile(join(folder, "pixel.png"), PNG),
        writeFile(join(folder, "cafe\u0301.txt"), "Normalized name."),
        writeFile(outside, "Not in this session's folder."),
        symlink("small.txt", join(folder, "link.txt")),
        symlink(outside, join(folder, "outside-link.txt")),
    ]);
    app = await openApp(
        scriptedModel((input) => {
            const { role, text } = lastText(input as never);
            const args = role === "user" && /(?:^|\n)read: (\{.*\})$/.exec(text)?.[1];

            return args
                ? fauxAssistantMessage([fauxToolCall("read", JSON.parse(args))], {
                      stopReason: "toolUse",
                  })
                : fauxAssistantMessage([fauxText("Done.")]);
        }),
    );
    app.config.lastModel = { provider: "faux", modelId: "faux-vision", thinkingLevel: "off" };
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { code } = app.runners.makeCode("Read computer", owner(app).id);
    const linked = linkInProcess((request) => app.runners.redeem(request), code);

    runnerId = linked.id;
    runner = new Runner({
        link: { server: base, ...linked },
        version: "test",
        cwd: folder,
        log: () => {},
        settings: () => settings,
        saveSettings: (change) => {
            Object.assign(settings, change);
        },
        ask: async () => {
            questions++;

            return { allow: approvalsAllowed };
        },
    });
    runner.start();
    await app.runners.link(runnerId).whenOnline(AbortSignal.timeout(10_000));
    ({ id } = await app.commands.createSession(owner(app), { cwd: folder, runner: runnerId }));
});

after(async () => {
    await runner?.stop();
    await app?.close();

    if (server !== undefined) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    cleanUp();
});

async function read(path: string, range?: { offset?: number; limit?: number }) {
    await say(app, id, `read: ${JSON.stringify({ path, ...range })}`);
    const view = await (await app.conversation(id)).context(context);
    const result = view.messages.findLast((message) => message.role === "toolResult");

    assert.ok(result);
    assert.equal(result.toolName, "read");

    return { content: result.content, isError: result.isError };
}

/** Capture scoped file requests, not workspace checks or other sessions' activity. */
function record(t: TestContext) {
    const link = app.runners.link(runnerId);
    const scope = app.runnerScope(id)!;
    const request = link.request.bind(link);
    const ops: string[] = [];

    t.mock.method(link, "request", (...args: Parameters<typeof request>) => {
        const [op, , , named] = args;

        if (named?.id === scope.id && op !== "exec" && op !== "opendir") {
            ops.push(op);
        }

        return request(...args);
    });

    return ops;
}

test("a small read uses one or two round trips on the runner link", async (t) => {
    const ops = record(t);
    const result = await read("small.txt");

    assert.match(JSON.stringify(result.content), /Remote line one\\nRemote line two/);
    assert.ok(
        ops.length >= 1 && ops.length <= 2,
        `Read made ${ops.length} requests: ${ops.join(", ")}`,
    );
});

test("the runner snapshot and the existing path give Pi the same results", async (t) => {
    const link = app.runners.link(runnerId);
    const cases = [
        { path: "small.txt", snapshot: true },
        { path: "bom.txt", snapshot: true },
        { path: "bom.txt", range: { offset: 2, limit: 1 }, snapshot: true },
        { path: "bom.txt", range: { offset: 2.5, limit: -1 }, snapshot: true },
        { path: "bom.txt", range: { offset: 20 }, snapshot: true, error: /beyond end of file/ },
        { path: "lines.txt", snapshot: true },
        { path: "large.txt", snapshot: false },
        { path: "binary.bin", snapshot: true },
        { path: "pixel.png", snapshot: true },
        { path: "link.txt", snapshot: false },
        { path: "caf\u00e9.txt", snapshot: false },
        { path: "missing.txt", snapshot: false, error: /not found|no such file|ENOENT/i },
        { path: outside, snapshot: false, error: /outside the session's approved folder/ },
        {
            path: "outside-link.txt",
            snapshot: false,
            error: /outside the session's approved folder/,
        },
    ];

    for (const { path, range, snapshot, error } of cases) {
        await t.test(`${path} ${JSON.stringify(range ?? {})}`, async (t) => {
            const ops = record(t);
            const actual = await read(path, range);

            assert.equal(
                Boolean(actual.isError),
                error !== undefined,
                JSON.stringify(actual.content).slice(0, 500),
            );

            if (error !== undefined) {
                assert.match(JSON.stringify(actual.content), error);
            }

            if (path === "pixel.png") {
                assert.ok(actual.content.some((block) => block.type === "image"));
            }

            if (snapshot) {
                assert.deepEqual(ops, [READ_SNAPSHOT]);
            } else {
                assert.ok(ops.includes("open"), ops.join(", "));
            }

            // No capability is how an older runner connects: use precisely the old pi-env path.
            ops.length = 0;
            t.mock.getter(link, "supportsReadSnapshot", () => false);
            assert.deepEqual(await read(path, range), actual);
            assert.equal(ops.includes(READ_SNAPSHOT), false);
        });
    }
});

test("the snapshot operation itself requires a session and checks its folder", async () => {
    const link = app.runners.link(runnerId);
    const scope = app.runnerScope(id)!;

    await assert.rejects(link.request(READ_SNAPSHOT, { path: outside }, {}, scope), {
        code: "EACCES",
        message: /outside the session's approved folder/,
    });
    await assert.rejects(link.request(READ_SNAPSHOT, { path: join(folder, "small.txt") }), {
        code: "EACCES",
        message: /session permission on .* is required/,
    });
});

/** Run `afterRead` between the local file read and its consistency check, without a timer race. */
async function duringSnapshot(
    t: TestContext,
    path: string,
    afterRead: () => Promise<void>,
    run: () => Promise<void>,
) {
    const open = fs.open.bind(fs);
    const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);

        if (args[0] === path && typeof args[1] === "number") {
            const read = handle.read.bind(handle);

            t.mock.method(
                handle,
                "read",
                async (bytes: Uint8Array, offset: number, length: number, position: number) => {
                    const result = await read(bytes, offset, length, position);

                    if (position === 0) {
                        await afterRead();
                    }

                    return result;
                },
            );
        }

        return handle;
    });

    syncBuiltinESMExports();

    try {
        await run();
    } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
    }
}

test("a file changed during capture falls back to Pi's ordinary read", async (t) => {
    const name = "changing.txt";
    const path = join(folder, name);
    const ops = record(t);

    await writeFile(path, "Original contents.\n");
    await duringSnapshot(
        t,
        path,
        () => writeFile(path, "Replaced contents.\n"),
        async () => {
            const actual = await read(name);

            assert.match(JSON.stringify(actual.content), /Replaced contents/);
            assert.equal(ops[0], READ_SNAPSHOT);
            assert.ok(ops.includes("open"));
            t.mock.getter(app.runners.link(runnerId), "supportsReadSnapshot", () => false);
            assert.deepEqual(await read(name), actual);
        },
    );
});

test("an in-flight snapshot can be cancelled before any file bytes are returned", async (t) => {
    const path = join(folder, "small.txt");
    const scope = app.runnerScope(id)!;
    const link = app.runners.link(runnerId);
    const controller = new AbortController();
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await duringSnapshot(
        t,
        path,
        async () => {
            blocked.resolve();
            await release.promise;
        },
        async () => {
            const reply = link.request(
                READ_SNAPSHOT,
                { path },
                { signal: controller.signal },
                scope,
            );
            const denied = assert.rejects(reply, /request was cancelled/);

            try {
                await Promise.race([blocked.promise, reply]);
                controller.abort();
                await denied;
            } finally {
                release.resolve();
            }

            // This next same-session snapshot is queued behind the cancelled one and its close.
            assert.ok((await link.request(READ_SNAPSHOT, { path }, {}, scope)).payload.length > 0);
        },
    );
});

test("a revoked approval returns no snapshot and the normal read asks just once", async (t) => {
    const link = app.runners.link(runnerId);
    const scope = app.runnerScope(id)!;
    const path = join(folder, "small.txt");

    settings.sessions = settings.sessions?.filter((session) => session.id !== scope.id);
    approvalsAllowed = false;

    const before = questions;
    const reply = await link.request(READ_SNAPSHOT, { path }, {}, scope);

    assert.deepEqual(reply.json, {});
    assert.equal(reply.payload.length, 0);
    assert.equal(questions, before);

    const actual = await read("small.txt");

    assert.equal(actual.isError, true);
    assert.match(JSON.stringify(actual.content), /not approved on Read computer/);
    assert.equal(questions, before + 1);
    t.mock.getter(link, "supportsReadSnapshot", () => false);
    assert.deepEqual(await read("small.txt"), actual);
    assert.equal(questions, before + 2);
});
