import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { projectEntry } from "../src/server/projection.ts";
import type { RunningSession } from "../src/server/running.ts";

const Counter = defineDoc<{ count: number }>({
    kind: "test.command-counter",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ count: 0 }),
});
const modelRequests: string[] = [];
const model = scriptedModel((request) => {
    modelRequests.push(JSON.stringify(request));

    return fauxAssistantMessage([fauxText("A model reply.")]);
});
let app: App;
let server: Server;
let base = "";
let commandId = "";

before(async () => {
    app = await openApp(model);
    writeFileSync(
        join(app.dataDir, "extensions", "native-counter.ts"),
        `/** Counts explicit requests. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defineDoc } from "@earendil-works/pi-durable";
const Counter = defineDoc({
    kind: "test.command-counter", version: 1,
    scope: "conversation", history: "latest", fork: "current",
    initial: () => ({ count: 0 }),
});
export default (host) => {
    host.commands.register({
        name: "native-counter", description: "Read or update the counter", args: "[show]",
        scope: "conversation",
        handler: async (args, ctx) => {
            if (args === "fail") {
                throw new Error("The command rejected this request.");
            }
            if (args === "invalid") {
                return { type: "card", output: 42 };
            }
            if (args === "inject") {
                return {
                    type: "card", output: "Visible result",
                    model: [{ role: "user", content: "INJECTED_MODEL_MESSAGE" }],
                    head: 1, edits: [{ type: "drop", entry: 1 }],
                };
            }
            if (args === "long") {
                return { type: "card", output: "start\\n" + "x".repeat(10000) + "\\nend" };
            }
            if (args === "show") {
                const state = await ctx.snapshot(Counter, ctx.conversationId, ctx.context);
                return { type: "card", output: "COUNTER_STATUS_SENTINEL: " + (state?.count ?? 0) };
            }
            let count;
            await ctx.commit(async (tx) => {
                const state = await tx.doc(Counter, ctx.conversationId);
                count = ++state.count;
            });
            if (args === "hold") {
                await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
            }
            if (args === "wait") {
                while (!existsSync(join(host.dataDir, "command-release-" + ctx.conversationId))) {
                    await delay(5, undefined, { signal: ctx.signal });
                }
            }
            return { type: "toast", level: "info", message: "Counter is " + count + "." };
        },
    });
    host.commands.register({
        name: "owner-counter", description: "Update global configuration", scope: "global",
        handler: async (_args, ctx) => {
            await ctx.commit(async (tx) => {
                const state = await tx.doc(Counter, ctx.conversationId);
                state.count += 100;
            });
            if (_args === "hold") {
                await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
            }
            return { type: "toast", level: "info", message: "Owner setting updated." };
        },
    });
    return [];
};
`,
    );
    await app.setExtensionEnabled(owner(app), "native-counter.ts", true);
    commandId = app.loader.commands().find((command) => command.name === "native-counter")!.id;
    await startServer();
});

async function startServer(): Promise<void> {
    server = createServer(
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    assert.ok(address !== null && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
}

after(async () => {
    await stopServer();
    await app?.close();
    cleanUp();
});

function post(
    id: ConversationId,
    args: string,
    requestId = crypto.randomUUID(),
    options: { token?: string; commandId?: string } = {},
): Promise<Response> {
    return fetch(`${base}/api/c/${id}/extension-commands`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${options.token ?? app.config.ownerToken}`,
            "content-type": "application/json",
            "x-pocket": "1",
        },
        body: JSON.stringify({ commandId: options.commandId ?? commandId, args, requestId }),
    });
}

async function running(token = app.config.ownerToken): Promise<RunningSession[]> {
    const response = await fetch(`${base}/api/running`, {
        headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);

    return (await response.json()) as RunningSession[];
}

function stop(
    id: ConversationId,
    taskId: number,
    token = app.config.ownerToken,
): Promise<Response> {
    return fetch(`${base}/api/c/${id}/extension-commands/${taskId}/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pocket": "1" },
    });
}

async function finishPending(
    taskId: number | undefined,
    pending: Promise<Response>,
): Promise<void> {
    if (taskId !== undefined) {
        const task = await app.harness.getTask(taskId as TaskId, context);

        if (task !== undefined && task.state.status !== "terminal") {
            await app.harness.abortTask(task.id, context);
        }
    }

    await pending;
}

test("the HTTP command path changes durable state and returns a private toast without calling the model", async () => {
    const id = await newSession(app);
    const before = modelRequests.length;
    const response = await post(id, "");

    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();

    assert.equal(result.type, "toast");
    assert.equal(result.level, "info");
    assert.equal(result.message, "Counter is 1.");
    assert.equal((await app.harness.snapshot(Counter, id, context))?.count, 1);
    assert.equal(modelRequests.length, before);
});

test("concurrent retries of one HTTP request invoke the handler once and return the same receipt", async () => {
    const id = await newSession(app);
    const requestId = crypto.randomUUID();
    const responses = await Promise.all([post(id, "", requestId), post(id, "", requestId)]);

    for (const response of responses) {
        assert.equal(response.status, 200, await response.clone().text());
    }

    const [first, second] = await Promise.all(responses.map((response) => response.json()));

    assert.deepEqual(second, first);
    assert.equal((await app.harness.snapshot(Counter, id, context))?.count, 1);
});

test("a command card persists as display data without changing the requester or a later model request", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Previous requester", "guest").user;
    const submitted = await app.commands.submit(id, guest, {
        text: "Before the command.",
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submitted.submissionId, context))!.wait(context);
    const before = modelRequests.length;
    const response = await post(id, "show");

    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();

    assert.equal(result.type, "card");
    assert.equal(result.output, "COUNTER_STATUS_SENTINEL: 0");
    assert.equal(modelRequests.length, before);
    assert.equal(app.attribution.requesterOf(id), guest.id);

    const transcript = await (await app.conversation(id)).context(context);
    const card = transcript.entries.find((entry) => entry.kind === "pocket.command");

    assert.ok(card, "a committed command card exists");
    assert.equal(card.model, undefined);
    assert.equal(card.head, undefined);
    assert.equal(card.edits, undefined);
    assert.equal((card.data as { output: string }).output, "COUNTER_STATUS_SENTINEL: 0");

    await say(app, id, "After the command.");
    assert.equal(modelRequests.at(-1)?.includes("COUNTER_STATUS_SENTINEL"), false);
});

test("command execution enforces visibility, viewer, driver, and global-owner permissions", async () => {
    const id = await newSession(app);
    const other = await newSession(app);
    const guest = app.config.addUser("Command guest", "guest");
    const viewer = app.config.addUser("Command viewer", "viewer");
    const limited = app.config.addUser("Other session", "guest", [String(other)]);
    const global = app.loader.commands().find((command) => command.name === "owner-counter")!.id;

    assert.equal((await post(id, "", undefined, { token: viewer.token })).status, 403);
    assert.equal((await post(id, "", undefined, { token: limited.token })).status, 404);
    assert.equal(
        (await post(id, "", undefined, { token: guest.token, commandId: global })).status,
        403,
    );
    assert.equal(await app.harness.snapshot(Counter, id, context), undefined);

    await app.collab.turns(id, owner(app), { action: "on" });
    assert.equal((await post(id, "", undefined, { token: guest.token })).status, 409);
    assert.equal(await app.harness.snapshot(Counter, id, context), undefined);

    await app.collab.turns(id, owner(app), { action: "off" });
    assert.equal((await post(id, "", undefined, { token: guest.token })).status, 200);
    assert.equal((await post(id, "", undefined, { commandId: global })).status, 200);
    assert.equal((await app.harness.snapshot(Counter, id, context))?.count, 101);
});

test("a request id cannot be reused for different arguments or registrations", async () => {
    const id = await newSession(app);
    const key = crypto.randomUUID();
    const global = app.loader.commands().find((command) => command.name === "owner-counter")!.id;

    assert.equal((await post(id, "", key)).status, 200);
    assert.equal((await post(id, "show", key)).status, 409);
    assert.equal((await post(id, "", key, { commandId: global })).status, 409);
    assert.equal((await app.harness.snapshot(Counter, id, context))?.count, 1);
});

test("an old registration cannot silently run its replacement or a disabled command", async () => {
    const id = await newSession(app);
    const previous = commandId;

    await app.loader.reload("native-counter.ts");
    commandId = app.loader.commands().find((command) => command.name === "native-counter")!.id;
    assert.notEqual(commandId, previous);
    assert.equal((await post(id, "", undefined, { commandId: previous })).status, 404);
    await app.setExtensionEnabled(owner(app), "native-counter.ts", false);
    assert.equal((await post(id, "")).status, 404);
    assert.equal(await app.harness.snapshot(Counter, id, context), undefined);
    await app.setExtensionEnabled(owner(app), "native-counter.ts", true);
    commandId = app.loader.commands().find((command) => command.name === "native-counter")!.id;
});

test("handler errors and invalid feedback produce private failures, not malformed cards", async () => {
    const id = await newSession(app);
    const before = modelRequests.length;

    for (const args of ["fail", "invalid"]) {
        const response = await post(id, args);
        const result = await response.json();

        assert.equal(response.status, 200);
        assert.equal(result.status, "failed");
        assert.equal(result.type, "toast");
        assert.equal(result.level, "error");
    }

    const view = await (await app.conversation(id)).context(context);

    assert.equal(
        view.entries.some((entry) => entry.kind === "pocket.command"),
        false,
    );
    assert.equal(modelRequests.length, before);
});

test("feedback cannot inject model messages, head markers, or context edits", async () => {
    const id = await newSession(app);
    const response = await post(id, "inject");
    const result = await response.json();
    const view = await (await app.conversation(id)).context(context);
    const card = view.entries.find((entry) => entry.kind === "pocket.command")!;

    assert.equal(response.status, 200);
    assert.equal(result.type, "card");

    for (const field of ["model", "head", "edits"]) {
        assert.equal(field in result, false);
        assert.equal(card[field as keyof typeof card], undefined);
    }

    await say(app, id, "After the untrusted fields.");
    assert.equal(modelRequests.at(-1)?.includes("INJECTED_MODEL_MESSAGE"), false);
});

test("card projection clips long output while the full-entry path preserves it", async () => {
    const id = await newSession(app);
    const response = await post(id, "long");
    const result = await response.json();
    const view = await (await app.conversation(id)).context(context);
    const raw = view.entries.find((entry) => entry.kind === "pocket.command")!;
    const compact = projectEntry(raw);
    const full = projectEntry(raw, true);

    assert.equal(response.status, 200);
    assert.equal(compact?.kind, "command");
    assert.equal(full?.kind, "command");

    if (compact?.kind === "command" && full?.kind === "command") {
        assert.equal(compact.truncated, result.output.length);
        assert.ok(compact.output.length < result.output.length);
        assert.equal(full.output, result.output);
    }
});

test("completed requests survive restart and an interrupted handler is never run again", async () => {
    const id = await newSession(app);
    const data = app.dataDir;
    const completedKey = crypto.randomUUID();
    const completedResponse = await post(id, "", completedKey);
    const completed = await completedResponse.json();
    const request = { commandId, args: "hold", requestId: crypto.randomUUID() };
    const pending = app.extensionCommands.run(id, owner(app), request).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
    );

    await until(
        async () => (await app.harness.snapshot(Counter, id, context))?.count === 2,
        "the handler side effect",
    );
    await stopServer();
    await app.close();
    await pending;
    app = await openApp(model, data);
    await startServer();

    const resumed = await app.extensionCommands.run(id, owner(app), request);
    const replayed = await post(id, "", completedKey);

    assert.equal(resumed.status, "interrupted");
    assert.equal(resumed.type, "toast");
    assert.equal((await app.harness.snapshot(Counter, id, context))?.count, 2);
    assert.equal(replayed.status, 200);
    assert.deepEqual(await replayed.json(), completed);
    commandId = app.loader.commands().find((command) => command.name === "native-counter")!.id;
});

test("stopping a conversation command is available to steerers, not viewers or other sessions", async () => {
    const id = await newSession(app);
    const other = await newSession(app);
    const guest = app.config.addUser("Command stopper", "guest");
    const viewer = app.config.addUser("Stop viewer", "viewer");
    const limited = app.config.addUser("Stop elsewhere", "guest", [String(other)]);
    const key = crypto.randomUUID();
    const before = modelRequests.length;
    const pending = post(id, "hold", key);
    let taskId: number | undefined;

    try {
        await until(
            async () => (await app.harness.snapshot(Counter, id, context))?.count === 1,
            "the held command",
        );
        const task = (await running())
            .flatMap((session) => session.tasks)
            .find((task) => task.conversationId === id && task.kind === "pocket.command");

        assert.ok(task);
        taskId = task.id;
        assert.equal(task.label, "running /native-counter");
        await app.collab.turns(id, owner(app), { action: "on" });
        assert.equal((await stop(id, taskId, viewer.token)).status, 403);
        assert.equal((await stop(id, taskId, limited.token)).status, 404);
        assert.equal((await stop(other, taskId)).status, 404);
        assert.equal((await stop(id, taskId, guest.token)).status, 200);
        const response = await pending;
        const result = await response.json();

        assert.equal(response.status, 200);
        assert.equal(result.status, "stopped");
        assert.equal(result.type, "toast");
        assert.equal((await app.harness.snapshot(Counter, id, context))?.count, 1);
        assert.equal(modelRequests.length, before);
        assert.deepEqual(await (await post(id, "hold", key)).json(), result);
    } finally {
        await finishPending(taskId, pending);
    }
});

test("stopping a global command is owner-only and its running details stay private", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Global stopper", "guest");
    const viewer = app.config.addUser("Global observer", "viewer");
    const global = app.loader.commands().find((command) => command.name === "owner-counter")!.id;

    await app.collab.turns(id, guest.user, { action: "on" });
    const pending = post(id, "hold", undefined, { commandId: global });
    let taskId: number | undefined;

    try {
        await until(
            async () => (await app.harness.snapshot(Counter, id, context))?.count === 100,
            "the held global command",
        );
        const task = (await running())
            .flatMap((session) => session.tasks)
            .find((task) => task.conversationId === id && task.kind === "pocket.command");

        assert.ok(task);
        taskId = task.id;
        assert.equal(task.label, "running /owner-counter");

        for (const token of [guest.token, viewer.token]) {
            assert.equal(
                (await running(token))
                    .flatMap((session) => session.tasks)
                    .some((task) => task.id === taskId),
                false,
            );
            assert.equal((await stop(id, taskId, token)).status, 403);
        }

        assert.equal((await stop(id, taskId)).status, 200);
        assert.equal((await (await pending).json()).status, "stopped");
        assert.equal((await app.harness.snapshot(Counter, id, context))?.count, 100);
    } finally {
        await finishPending(taskId, pending);
    }
});

test("execution rechecks current access after the request's user snapshot was taken", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Former steerer", "guest");
    const authenticated = { ...guest.user };

    app.config.updateUser(guest.user.id, { role: "viewer" });
    const result = await app.extensionCommands.run(id, authenticated, {
        commandId,
        args: "",
        requestId: crypto.randomUUID(),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.type, "toast");
    assert.ok(
        result.taskId > 0,
        "a task admitted with the earlier user snapshot rechecked it before calling the handler",
    );
    assert.equal(await app.harness.snapshot(Counter, id, context), undefined);
});

test("reloading a module lets its running invocation finish on the old handler", async () => {
    const id = await newSession(app);
    const file = join(app.dataDir, "extensions", "native-counter.ts");
    const source = readFileSync(file, "utf8");
    const release = join(app.dataDir, "command-release-" + id);
    const pending = post(id, "wait");

    try {
        await until(
            async () => (await app.harness.snapshot(Counter, id, context))?.count === 1,
            "the old handler starting",
        );
        writeFileSync(file, source.replace('"Counter is "', '"Replacement counter is "'));
        await app.loader.reload("native-counter.ts");
        commandId = app.loader.commands().find((command) => command.name === "native-counter")!.id;
        writeFileSync(release, "continue");
        assert.equal((await (await pending).json()).message, "Counter is 1.");
        assert.equal((await (await post(id, "")).json()).message, "Replacement counter is 2.");
        assert.equal((await app.harness.snapshot(Counter, id, context))?.count, 2);
    } finally {
        writeFileSync(release, "continue");
        await pending;
        writeFileSync(file, source);
        await app.loader.reload("native-counter.ts");
        commandId = app.loader.commands().find((command) => command.name === "native-counter")!.id;
    }
});

test("malformed requests and oversized arguments cannot start a command", async () => {
    const id = await newSession(app);

    for (const body of [
        null,
        {},
        { commandId, args: "", requestId: "../invalid" },
        { commandId, args: [], requestId: "bad-args" },
        { commandId, args: "x".repeat(4001), requestId: "too-long" },
    ]) {
        const response = await fetch(`${base}/api/c/${id}/extension-commands`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "content-type": "application/json",
                "x-pocket": "1",
            },
            body: JSON.stringify(body),
        });

        assert.equal(response.status, body?.requestId === "too-long" ? 413 : 400);
    }

    assert.equal(await app.harness.snapshot(Counter, id, context), undefined);
    assert.equal((await post(id, "x".repeat(4000))).status, 200);
    assert.equal((await app.harness.snapshot(Counter, id, context))?.count, 1);
});
