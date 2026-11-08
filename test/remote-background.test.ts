// A real runner and pi-env daemon: tasks and their logs belong to the session's computer, not this server.
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runner, type RunnerOptions } from "../src/runner/runner.ts";
import { StartCutOff } from "../src/server/background.ts";
import { RemoteBackground } from "../src/server/background-remote.ts";
import { BackgroundDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { runningNow } from "../src/server/running.ts";
import type { RunnerEnv } from "../src/server/runners.ts";

const there = join(root, "computer");
let app: App;
let server: Server;
let runner: Runner;
let options: RunnerOptions;
let computer: string;
const sessions: ConversationId[] = [];
const folders = new Set<string>();
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.startsWith("bg ")) {
        return fauxAssistantMessage([fauxToolCall("background", JSON.parse(text.slice(3)))], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `tool said: ${text}` : "ok")]);
});

before(async () => {
    mkdirSync(there);
    app = await openApp(model);
    app.background.timing.grace = 300;
    app.background.timing.starting = 300;
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const linked = app.runners.redeem(
        app.runners.makeCode("Background laptop", owner(app).id).code,
    );

    computer = linked.id;
    legacyRunner();
    options = {
        link: { server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...linked },
        version: "test",
        cwd: there,
        log: () => {},
        retryMs: [50, 100, 200],
        ask: () => Promise.resolve({ allow: true }),
    };
    runner = new Runner(options);
    runner.start();
    await until(() => app.runners.list()[0]?.online === true, "runner online");
});

after(async () => {
    for (const id of sessions) {
        for (const item of await app.background.list(id).catch(() => [])) {
            await app.background.stop(id, item.id).catch(() => undefined);
        }
    }

    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    // Only folders this test's sessions owned, never another runner's files.
    for (const folder of folders) {
        rmSync(folder, { recursive: true, force: true });
    }

    cleanUp();
});

async function session() {
    const id = (await app.commands.createSession(owner(app), { cwd: there, runner: computer })).id;

    sessions.push(id);
    await loadTools(app, id, "background");
    const scope = app.runnerScope(id);

    folders.add(
        await new RemoteBackground(app.runners.env(computer, there, scope), scope.id).dir(),
    );

    return id;
}

const items = async (id: ConversationId) =>
    Object.values((await app.harness.snapshot(BackgroundDoc, id, context))?.items ?? {});
const one = async (id: ConversationId) => (await items(id))[0]!;

async function userTexts(id: ConversationId): Promise<string> {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        200,
        undefined,
        context,
    );

    return page.items
        .filter((entry) => entry.kind === "pi.user")
        .map((entry) => JSON.stringify(entry.model))
        .join("\n");
}

/** Exercise the unchanged bash implementation with a hello from before runner-owned tasks. */
function legacyRunner(): void {
    const link = app.runners.link(computer);
    const attach = link.attach.bind(link);

    link.attach = (socket, hello) => {
        delete hello.tasks;
        attach(socket, hello);
    };
}

test("the server no longer refuses Windows background tasks", async () => {
    const env = {
        connection: { info: () => Promise.resolve({ os: "windows" }) },
        computer: () => ({ name: "Windows workstation" }),
    } as unknown as RunnerEnv;

    await new RemoteBackground(env, "permission").supported();
});

test("the no-setsid fallback detaches with nohup and perl, and command env is kept", async () => {
    const id = await session();
    const bin = join(there, "fallback-bin");

    mkdirSync(bin);

    for (const name of ["bash", "split", "nohup", "perl", "sleep"]) {
        symlinkSync(`/usr/bin/${name}`, join(bin, name));
    }

    const remove = app.commandEnvs.add(() => ({ PATH: bin, BACKGROUND_TEST: "from provider" }));

    try {
        const item = await app.background.start(id, {
            command: "printf '%s\\n' \"$BACKGROUND_TEST\"; sleep 30",
            notify: false,
        });

        await until(
            async () => (await app.background.output(id, item.id))!.text.includes("from provider"),
            "fallback output",
        );
        assert.equal(await app.background.alive(id, item), true);
        await app.background.stop(id, item.id);
        assert.equal(await app.background.alive(id, item), false);
    } finally {
        remove();
    }
});

// Every command is bounded or sleeps; no synthetic load, even the log-limit test.
test("the tool starts there, Running now lists it, and log reads use the computer", async () => {
    const id = await session();

    await say(
        app,
        id,
        `bg ${JSON.stringify({ action: "start", command: "pwd; printf 'remote ready\\n'; sleep 30", notify: false })}`,
    );
    const item = await one(id);

    assert.equal(item.status, "running");
    assert.ok(item.pid > 0);
    assert.equal(await app.background.alive(id, item), true);
    const running = await runningNow(app, owner(app));

    assert.ok(
        running.some(
            (entry) =>
                entry.id === Number(id) &&
                entry.tasks.some((task) => task.kind === "pocket.background"),
        ),
    );
    const read = await app.background.read(id, item.id);

    assert.match(read!.text, /remote ready/);
    assert.ok(read!.text.includes(there));
    assert.equal(existsSync(join(app.dataDir, "background", String(id))), false);
    const output = await app.background.output(id, item.id);

    assert.match(output!.text, /remote ready/);
    assert.equal((await app.background.read(id, item.id))!.text, "");
    await app.background.stop(id, item.id);
});

test("a completed task sends its output and nonzero exit code to Pi", async () => {
    const id = await session();
    const item = await app.background.start(id, {
        command: "printf 'done on computer\\n'; exit 7",
    });

    await until(async () => (await one(id)).toldAt !== undefined, "completion message", 15_000);
    assert.equal((await one(id)).status, "exited");
    assert.equal((await one(id)).code, 7);
    assert.match(await userTexts(id), /exited with code 7/);
    assert.match(await userTexts(id), /done on computer/);
    assert.equal((await app.background.list(id))[0]?.id, item.id);
});

test("Running now's Stop forces a long task that ignores the polite signal", async () => {
    const id = await session();
    const item = await app.background.start(id, {
        command: "trap '' TERM; printf ready; sleep 300",
        notify: false,
    });
    const stopped = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/c/${id}/background/${item.taskId}/stop`,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: "{}",
        },
    );

    assert.equal(stopped.status, 200);
    assert.equal((await one(id)).status, "stopped");
    await until(async () => !(await app.background.alive(id, item)), "process group stopped");
});

test("the task survives a runner and daemon restart, and offline never means ended", async () => {
    const id = await session();
    const item = await app.background.start(id, {
        command: "printf 'before reconnect\\n'; sleep 5; printf 'after reconnect\\n'; exit 3",
    });

    await runner.stop();
    await until(() => app.runners.list()[0]?.online === false, "runner offline");
    await new Promise((resolve) => setTimeout(resolve, 6500));
    assert.equal((await one(id)).status, "running");
    assert.equal((await one(id)).toldAt, undefined);
    runner = new Runner(options);
    runner.start();
    await until(() => app.runners.list()[0]?.online === true, "runner reconnect");
    await until(async () => (await one(id)).toldAt !== undefined, "end after reconnect", 15_000);
    assert.equal((await one(id)).code, 3);
    assert.match(
        (await app.background.output(id, item.id))!.text,
        /before reconnect\nafter reconnect/,
    );
});

test("a server reopen resumes the watch without stopping or starting the task again", async () => {
    // Finish the previous task's Pi turn before closing its loaded model environment.
    await app.harness.waitForIdle(context);
    const id = await session();
    const item = await app.background.start(id, {
        command:
            "printf 'before server reopen\\n'; sleep 4; printf 'after server reopen\\n'; exit 4",
    });

    await app.close();
    app = await openApp(model);
    legacyRunner();
    app.background.timing.grace = 300;
    app.background.timing.starting = 300;
    server.removeAllListeners("request");
    server.on(
        "request",
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await until(() => app.runners.list()[0]?.online === true, "runner after server reopen");
    await until(
        async () => (await one(id)).toldAt !== undefined,
        "end after server reopen",
        15_000,
    );
    assert.equal((await one(id)).id, item.id);
    assert.equal((await one(id)).pid, item.pid);
    assert.equal((await one(id)).code, 4);
    assert.match(
        (await app.background.output(id, item.id))!.text,
        /before server reopen\nafter server reopen/,
    );
    assert.equal((await items(id)).length, 1);
});

test("a start cut off before recording is adopted by marker without another launch", async () => {
    const id = await session();

    app.background.beforeRecord = () => Promise.reject(new StartCutOff());

    try {
        await assert.rejects(
            app.background.start(id, {
                command: "printf 'just once\\n'; sleep 30",
                key: "same",
                notify: false,
            }),
            StartCutOff,
        );
    } finally {
        app.background.beforeRecord = undefined;
    }

    await until(async () => (await one(id)).status === "running", "marker adoption", 10_000);
    const replay = await app.background.start(id, { command: "printf duplicate", key: "same" });

    assert.equal(replay.id, (await one(id)).id);
    assert.equal((await items(id)).length, 1);
    assert.match((await app.background.output(id, replay.id))!.text, /^just once/);
    await app.background.stop(id, replay.id);
});

test("task files are limited to their session's permission folder", async () => {
    const id = await session();
    const other = await session();
    const item = await app.background.start(id, { command: "printf private", notify: false });
    const ownScope = app.runnerScope(id);
    const own = new RemoteBackground(app.runners.env(computer, there, ownScope), ownScope.id);

    await until(
        async () => (await own.files()).some((file) => file.name.startsWith(`${item.id}.log.`)),
        "private log",
    );
    const log = (await own.files()).find((file) => file.name.startsWith(`${item.id}.log.`))!;

    assert.ok(log);
    const denied = await app.envFor(other).readTextFile(log.path, context);

    assert.equal(denied.ok, false);

    if (!denied.ok) {
        assert.match(denied.error.message, /outside the session's approved folder/);
    }

    const parent = await app
        .envFor(id)
        .createDir(join(await own.dir(), "..", "not-owned"), { recursive: true }, context);

    assert.equal(parent.ok, false);
});

test("log segments are trimmed on the computer and reads have the same bounds", async () => {
    const id = await session();
    const saved = { ...app.background.sizes };

    Object.assign(app.background.sizes, { segment: 8192, maxLog: 16384 });

    try {
        // A single bounded write, far below the runaway limits.
        const item = await app.background.start(id, {
            command: "printf '%050000d' 1",
            notify: false,
        });

        await until(async () => (await one(id)).status === "exited", "bounded writer end", 10_000);
        const scope = app.runnerScope(id);
        const io = new RemoteBackground(app.runners.env(computer, there, scope), scope.id);
        const logs = (await io.files()).filter((file) => file.name.includes(".log."));

        assert.ok(logs.length <= 2);
        const read = await app.background.read(id, item.id);

        assert.ok(read!.skipped > 0);
        assert.ok(read!.text.length <= 20_000);
        const output = await app.background.output(id, item.id, { chars: 1000 });

        assert.ok(output!.text.length <= 1000);
        assert.ok(output!.skipped > 0);
    } finally {
        Object.assign(app.background.sizes, saved);
    }
});
