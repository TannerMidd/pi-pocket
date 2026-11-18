// Restart when safe (`restart.ts`): the planner with fake model streams and blockers, then the app with the scripted
// model: a running bash blocks, a replay-safe call does not, new requests wait for the restart, Cancel lets them go, and
// Pi's own restart_server call waits for its result to be stored.
import {
    type App,
    cleanUp,
    context,
    home,
    lastText,
    loadTools,
    newSession,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
    type Api,
    createAssistantMessageEventStream,
    type FauxResponseStep,
    type Model,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { noWait } from "../src/server/limit-gate.ts";
import { type RestartBlocker, type RestartDeps, Restarts } from "../src/server/restart.ts";

const { PocketApp } = await import("../src/server/app.ts");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const model = { id: "m", provider: "p", api: "anthropic-messages" } as unknown as Model<Api>;

after(() => cleanUp());

// ─── The planner ────────────────────────────────────────────────────────────

function planner(blockers: () => RestartBlocker[], extra: Partial<RestartDeps> = {}) {
    const seen = { restarts: 0, changes: [] as unknown[], log: [] as string[] };
    const restarts = new Restarts({
        restart: () => seen.restarts++,
        blockers: async () => blockers(),
        conversationOf: () => 7,
        changed: (pending) => seen.changes.push(pending),
        heldChanged: () => {},
        log: (line) => seen.log.push(line),
        intervalMs: 10,
        spacingMs: 0,
        delayMs: 0,
        ...extra,
    });

    return { restarts, seen };
}

/** A runtime whose requests answer at once, counted. */
function runtime() {
    const sent: string[] = [];
    const models = {
        streamSimple: (
            _m: Model<Api>,
            _c: unknown,
            options?: { sessionId?: string; signal?: AbortSignal },
        ) => {
            const stream = createAssistantMessageEventStream();
            const message = {
                ...{ role: "assistant", api: "anthropic-messages", provider: "p", model: "m" },
                ...{ usage: { input: 0, output: 0, cacheRead: 0 }, timestamp: Date.now() },
                ...{ content: [{ type: "text", text: "ok" }], stopReason: "stop" },
            } as never;

            sent.push(options?.sessionId ?? "");
            queueMicrotask(() => {
                stream.push({ type: "done", reason: "stop", message });
                stream.end(message);
            });

            return stream;
        },
    };

    return { models, sent };
}

const bash: RestartBlocker = { conversationId: 1, callId: "c1", tool: "bash" };

test("immediate restarts at once, whatever runs", async () => {
    const { restarts, seen } = planner(() => [bash]);
    const answer = await restarts.ask({ mode: "immediate", by: "owner" });

    assert.equal(answer.restarting, true);
    await sleep(5);
    assert.equal(seen.restarts, 1);
});

test("when-safe with nothing running restarts at once", async () => {
    const { restarts, seen } = planner(() => []);
    const answer = await restarts.ask({ mode: "when-safe", by: "owner" });

    assert.equal(answer.restarting, true);
    assert.equal(answer.pending, undefined);
    await sleep(5);
    assert.equal(seen.restarts, 1);
});

test("when-safe waits for what runs, says what it waits for, and restarts once it ends", async () => {
    let running = [bash];
    const { restarts, seen } = planner(() => running);
    const answer = await restarts.ask({ mode: "when-safe", by: "owner" });

    assert.equal(answer.restarting, false);
    assert.deepEqual(answer.pending?.blockers, [bash]);
    await sleep(40);
    assert.equal(seen.restarts, 0, "the bash call still runs");
    assert.equal(restarts.pending()?.blockers[0]?.tool, "bash");

    running = [];
    await until(() => seen.restarts === 1, "the restart once bash ended");
    restarts.close();
});

test("Restart now goes over one that waits; a second when-safe keeps the first", async () => {
    const { restarts, seen } = planner(() => [bash]);

    await restarts.ask({ mode: "when-safe", by: "owner" });
    const first = restarts.pending()!.since;

    await sleep(5);
    await restarts.ask({ mode: "when-safe", by: "someone" });
    assert.equal(restarts.pending()!.since, first);
    assert.equal(restarts.pending()!.by, "owner");

    await restarts.ask({ mode: "now", by: "owner" });
    await sleep(5);
    assert.equal(seen.restarts, 1);
});

test("the deadline restarts anyway", async () => {
    let clock = 1_000_000;
    const { restarts, seen } = planner(() => [bash], { now: () => clock });

    await restarts.ask({ mode: "when-safe", by: "owner", deadlineMinutes: 5 });
    assert.equal(restarts.pending()!.deadline, 1_000_000 + 5 * 60_000);
    await sleep(30);
    assert.equal(seen.restarts, 0);

    clock += 5 * 60_000;
    await until(() => seen.restarts === 1, "the restart at the deadline");
    assert.match(seen.log.at(-1)!, /deadline passed, with bash still running/);
});

test("a restart that waits holds new model requests; Cancel lets them go", async () => {
    const { restarts, seen } = planner(() => [bash]);
    const { models, sent } = runtime();

    restarts.install(models);

    // No restart waits: a request goes out.
    await models.streamSimple(model, {} as never, { sessionId: "a" }).result();
    assert.deepEqual(sent, ["a"]);

    await restarts.ask({ mode: "when-safe", by: "owner" });

    const held = models.streamSimple(model, {} as never, { sessionId: "b" });

    await until(() => restarts.holds(7), "the request held");
    assert.deepEqual(sent, ["a"], "a held request has not gone out");
    assert.equal(restarts.pending()!.held, 1);

    // One that never waits for a limit does not wait for a restart either: a title, a summary.
    await models.streamSimple(model, {} as never, noWait({ sessionId: "c" })).result();
    assert.deepEqual(sent, ["a", "c"]);

    assert.equal(restarts.cancel(), true);
    assert.equal((await held.result()).stopReason, "stop");
    assert.deepEqual(sent, ["a", "c", "b"]);
    assert.equal(restarts.holds(7), false);
    assert.equal(restarts.pending(), undefined);
    assert.equal(seen.changes.at(-1), undefined, "the tabs hear that it ended");
    assert.equal(seen.restarts, 0);
    assert.equal(restarts.cancel(), false, "nothing waits any more");
});

test("a held request that is stopped ends as aborted, and never goes out", async () => {
    const { restarts } = planner(() => [bash]);
    const { models, sent } = runtime();

    restarts.install(models);
    await restarts.ask({ mode: "when-safe", by: "owner" });

    const stop = new AbortController();
    const held = models.streamSimple(model, {} as never, { sessionId: "x", signal: stop.signal });

    await until(() => restarts.holds(7), "the request held");
    stop.abort();
    assert.equal((await held.result()).stopReason, "aborted");
    assert.equal(restarts.holds(7), false);
    assert.equal(restarts.pending()!.held, 0);
    restarts.cancel();
    await sleep(5);
    assert.deepEqual(sent, []);
});

// ─── In the app ─────────────────────────────────────────────────────────────

const gate = join(work, "restart-gate");

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "user" && text.includes("run the slow command")) {
        return call("bash", {
            command: `while [ ! -f ${gate} ]; do sleep 0.05; done; echo ended`,
        });
    }

    if (role === "user" && text.includes("ask me")) {
        return call("ask", {
            questions: [
                {
                    question: "Which one?",
                    header: "Pick",
                    options: [{ label: "A" }, { label: "B" }],
                },
            ],
        });
    }

    if (role === "user" && text.includes("restart yourself")) {
        return call("restart_server", { reason: "a test" });
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`after the call: ${text}`)]);
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let restarted = 0;

async function openSupervised(dir: string): Promise<App> {
    const faux = scriptedModel(route);

    return PocketApp.open({
        dataDir: join(root, dir),
        defaultCwd: work,
        supervised: true,
        restart: () => restarted++,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(faux.provider),
        home,
    });
}

async function send(app: App, id: ConversationId, text: string) {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
    });

    return (await app.harness.submission(submissionId, context))!;
}

const answered = async (app: App, id: ConversationId, pattern: RegExp) => {
    const view = await (await app.harness.conversation(id, context))!.context(context);

    return view.messages.some(
        (message) => message.role === "assistant" && pattern.test(JSON.stringify(message.content)),
    );
};

/** Whether a call of `tool` runs in the conversation now. */
async function runs(app: App, id: ConversationId, tool: string): Promise<boolean> {
    const live = await app.harness.snapshot(LiveDoc, id, context);

    return (live?.tools ?? []).some((slot) => slot.name === tool && slot.status === "running");
}

function openGate() {
    writeFileSync(gate, "");
}

function closeGate() {
    rmSync(gate, { force: true });
}

test("in the app: immediate (the default) restarts over a running bash", async () => {
    closeGate();
    restarted = 0;
    const app = await openSupervised("restart-immediate");

    try {
        const id = await newSession(app);

        await send(app, id, "run the slow command");
        await until(() => runs(app, id, "bash"), "bash running");

        const answer = await app.askRestart(owner(app), undefined);

        assert.equal(answer.restarting, true);
        await until(() => restarted === 1, "the restart");
    } finally {
        openGate();
        await app.close();
    }
});

test("in the app: a running bash blocks, a new message waits, and Cancel lets it go", async () => {
    closeGate();
    restarted = 0;
    const app = await openSupervised("restart-cancel");

    try {
        const slow = await newSession(app);
        const other = await newSession(app);
        const slowRun = await send(app, slow, "run the slow command");

        await until(() => runs(app, slow, "bash"), "bash running");

        const answer = await app.askRestart(owner(app), "when-safe");

        assert.equal(answer.restarting, false);
        assert.equal(answer.pending?.blockers[0]?.tool, "bash");
        assert.equal(answer.pending?.blockers[0]?.conversationId, Number(slow));

        // A message to another session: its model request waits for the restart, and has not gone out.
        const otherRun = await send(app, other, "hello there");

        await until(() => app.restarts.holds(Number(other)), "the other session's request held");
        assert.equal(await answered(app, other, /echo: hello there/), false);
        assert.equal(app.restarts.pending()?.held, 1);

        assert.equal(app.cancelRestart(owner(app)), true);
        await otherRun.wait(context);
        assert.equal(await answered(app, other, /echo: hello there/), true);

        openGate();
        await slowRun.wait(context);
        assert.equal(await answered(app, slow, /after the call/), true);
        assert.equal(restarted, 0, "a cancelled restart never happens");
    } finally {
        openGate();
        await app.close();
    }
});

test("in the app: once the bash ends, the restart goes, with the run's next request held", async () => {
    closeGate();
    restarted = 0;
    const app = await openSupervised("restart-ends");

    try {
        const id = await newSession(app);

        await send(app, id, "run the slow command");
        await until(() => runs(app, id, "bash"), "bash running");
        assert.equal((await app.askRestart(owner(app), "when-safe")).restarting, false);
        await sleep(100);
        assert.equal(restarted, 0);

        openGate();
        await until(() => restarted === 1, "the restart once bash ended");
        // The answer to the bash result waits for the restart: after it, Pi Durable sends it again.
        assert.equal(app.restarts.holds(Number(id)), true);
        assert.equal(await answered(app, id, /after the call/), false);
    } finally {
        openGate();
        await app.close();
    }
});

test("in the app: a replay-safe call (ask, waiting for its answer) does not block", async () => {
    restarted = 0;
    const app = await openSupervised("restart-safe-call");

    try {
        const id = await newSession(app);

        await send(app, id, "ask me");
        await until(() => runs(app, id, "ask"), "ask waiting");

        const answer = await app.askRestart(owner(app), "when-safe");

        assert.equal(answer.restarting, true);
        await until(() => restarted === 1, "the restart");
    } finally {
        await app.close();
    }
});

test("in the app: Pi's restart_server waits until its own result is stored, also when the owner restarts at once", async () => {
    restarted = 0;
    const app = await openSupervised("restart-agent");

    try {
        await app.setExtensionEnabled(owner(app), "restart.ts", true);
        assert.equal(app.config.restart, "immediate");

        const id = await newSession(app);

        await loadTools(app, id, "restart_server");
        await send(app, id, "restart yourself");
        await until(() => restarted === 1, "the restart Pi asked for");

        const view = await (await app.harness.conversation(id, context))!.context(context);
        const result = view.messages.find((message) => message.role === "toolResult");

        assert.match(JSON.stringify(result?.content), /restarts in a moment/);
        // Pi's next request waits for the restart.
        assert.equal(app.restarts.holds(Number(id)), true);
    } finally {
        await app.close();
    }
});

test("in the app: settings, and who may ask", async () => {
    const app = await openSupervised("restart-settings");

    try {
        await app.setRestartSettings(owner(app), "when-safe", 15);
        assert.equal(app.config.restart, "when-safe");
        assert.equal(app.config.restartDeadlineMinutes, 15);
        await assert.rejects(
            app.setRestartSettings(owner(app), "later", undefined),
            /restart must/,
        );
        await assert.rejects(app.setRestartSettings(owner(app), undefined, 7), /DeadlineMinutes/);
        await app.setRestartSettings(owner(app), "immediate", 0);
        assert.equal(app.config.restart, "immediate");
        assert.equal(app.config.restartDeadlineMinutes, 0);

        const guest = { ...owner(app), id: "guest", role: "guest" as const };

        await assert.rejects(app.askRestart(guest as never, "now"), /Only the owner/);
        assert.equal(existsSync(join(root, "restart-settings", "config.json")), true);
    } finally {
        await app.close();
    }
});

test("over HTTP: status, a bad mode, cancel with nothing waiting, and the settings", async () => {
    const app = await openSupervised("restart-http");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const headers = {
        authorization: `Bearer ${app.config.ownerToken}`,
        "content-type": "application/json",
        "x-pocket": "1",
    };
    const post = (path: string, body: unknown) =>
        fetch(`${base}/${path}`, { method: "POST", headers, body: JSON.stringify(body) });

    try {
        const status = await (await fetch(`${base}/restart`, { headers })).json();

        assert.deepEqual(status, {
            supervised: true,
            restart: "immediate",
            restartDeadlineMinutes: 0,
            pending: null,
        });
        assert.equal((await post("restart", { mode: "soon" })).status, 400);
        assert.deepEqual(await (await post("restart/cancel", {})).json(), {
            ok: true,
            cancelled: false,
        });
        assert.equal((await post("settings", { restart: "when-safe" })).status, 200);
        assert.equal(app.config.restart, "when-safe");
        assert.equal((await post("settings", { restartDeadlineMinutes: 30 })).status, 200);
        assert.equal(app.config.restartDeadlineMinutes, 30);
    } finally {
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});
