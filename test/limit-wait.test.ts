// A run that hits a provider limit waits inside its request. The "limit" is an error the scripted model throws.
import {
    type App,
    cleanUp,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { LimitTuning } from "../src/server/limit-gate.ts";

const TUNING: Partial<LimitTuning> = { minWaitMs: 50, backoffMs: [60_000] };
const OVERLOADED = "529 overloaded_error";
const apps: App[] = [];

/** The model throws `state.text` while `state.limited`; `calls` counts the requests that reached it. */
function limited(text = OVERLOADED) {
    const state = { limited: true, text, calls: 0 };
    const model = scriptedModel(() => {
        state.calls++;

        if (state.limited) {
            throw new Error(state.text);
        }

        return fauxAssistantMessage([fauxText("answered")]);
    });

    return { state, model };
}

async function open(
    model: ReturnType<typeof scriptedModel>,
    dir = join(root, `limit-${apps.length}`),
    limits = TUNING,
) {
    const app = await openApp(model, dir, undefined, limits);

    apps.push(app);

    return app;
}

after(async () => {
    for (const app of apps) {
        await app.close();
    }

    cleanUp();
});

const send = (app: App, id: ConversationId, text: string, mode?: "interrupt") =>
    app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID(), mode });
const waits = (app: App, id: ConversationId) => app.limits.waitFor(Number(id));

type Reply = { kind: string; stopReason?: string };
const replies = async (app: App, id: ConversationId) =>
    ((await app.transcripts.allEntries(id, false)) as Reply[]).filter(
        (e) => e.kind === "assistant",
    );
const lastStop = async (app: App, id: ConversationId) =>
    (await replies(app, id)).at(-1)?.stopReason;

test("a run that hits a limit waits inside its request and answers by itself, with no failure on record", async () => {
    const { state, model } = limited();
    const app = await open(model);
    const id = await newSession(app);

    await send(app, id, "hello");
    await until(() => waits(app, id) !== undefined, "the run to wait");
    assert.ok(app.isBusy(id));
    assert.deepEqual((await app.room(id)).peek()?.lines.at(-1), {
        kind: "event",
        text: "Waiting to retry: faux is overloaded",
    });

    // Only someone who may steer sends the request now.
    await assert.rejects(app.commands.retryLimit(id, app.config.addUser("Vee", "viewer").user), {
        status: 403,
    });
    state.limited = false;
    assert.equal(await app.commands.retryLimit(id, owner(app)), true);
    await until(async () => (await lastStop(app, id)) === "stop", "the answer");

    assert.ok(!(await replies(app, id)).some((reply) => reply.stopReason === "error"));
});

test("Stop and Interrupt end a wait at once, and no request goes out for the stopped run", async () => {
    const { state, model } = limited();
    const app = await open(model);
    const stopped = await newSession(app);
    const interrupted = await newSession(app);

    for (const id of [stopped, interrupted]) {
        await send(app, id, "first");
        await until(() => waits(app, id) !== undefined, "the run to wait");
    }

    const calls = state.calls;
    const started = Date.now();

    await app.commands.abort(stopped, owner(app));
    await send(app, interrupted, "second", "interrupt");
    await until(() => !app.isBusy(stopped), "the stopped run to end");
    await until(
        async () => (await modelTexts(app, interrupted)).some((text) => text.includes("second")),
        "the interrupt",
    );
    assert.ok(Date.now() - started < 2000);
    assert.equal(waits(app, stopped), undefined);
    assert.equal(state.calls, calls, "the stopped requests sent nothing more");
});

test("a restart in the middle of a wait: the run waits again with no request, and answers by its own time, even with the file damaged", async () => {
    for (const damaged of [false, true]) {
        const dir = join(root, `limit-restart-${damaged}`);
        const { state, model } = limited();
        const slow: Partial<LimitTuning> = { ...TUNING, backoffMs: [1500], resetJitterMs: [0, 0] };
        let app = await open(model, dir, slow);
        const id = await newSession(app);

        await send(app, id, "hello");
        await until(() => waits(app, id) !== undefined, "the run to wait");
        await app.close();

        if (damaged) {
            writeFileSync(join(dir, "provider-limits.json"), "{ damaged");
        }

        const calls = state.calls;

        app = await open(model, dir, slow);
        await until(
            () => waits(app, id) !== undefined || state.calls > calls,
            "the run to resume",
            15_000,
        );
        // With the file kept, the replayed request waits and sends nothing; without it, it meets the limit again.
        assert.equal(state.calls, damaged ? calls + 1 : calls);
        state.limited = false;
        await until(
            async () => (await lastStop(app, id)) === "stop",
            "the answer by its own time",
            20_000,
        );
    }
});

test("an account limit keeps its gate through a sign-in renewal and a restart, and a new sign-in clears it", async () => {
    const dir = join(root, "limit-account");
    const { state, model } = limited(
        "You have hit your ChatGPT usage limit (plus plan). Try again in ~1 min.",
    );
    let app = await open(model, dir);
    const id = await newSession(app);

    await app.providers.logout("faux").catch(() => {});
    assert.ok(app.providers.signInEpoch("faux") > 0);
    await send(app, id, "hello");
    await until(() => waits(app, id) !== undefined, "the run to wait");

    const [gate] = app.limits.gates();

    assert.equal(gate?.scope, "account");
    await app.providers.check("faux");
    assert.equal(waits(app, id)?.until, gate?.until, "a renewal keeps the gate");
    await app.close();

    app = await open(model, dir);
    await until(() => waits(app, id) !== undefined, "the wait after the restart", 15_000);
    assert.equal(waits(app, id)?.until, gate?.until);
    assert.equal(state.calls, 1, "no request before the reset");

    state.limited = false;
    await app.providers.logout("faux").catch(() => {});
    await until(async () => (await lastStop(app, id)) === "stop", "the answer", 15_000);
    assert.equal(app.limits.gates().length, 0);
});

test("only the owner sets the longest wait, and turning it off lets a waiting run go on at once", async () => {
    const { state, model } = limited();
    const app = await open(model);
    const id = await newSession(app);

    await assert.rejects(app.setLimitWaitHours(app.config.addUser("Gil", "guest").user, 1), {
        status: 403,
    });
    await send(app, id, "hello");
    await until(() => waits(app, id) !== undefined, "the run to wait");
    await app.setLimitWaitHours(owner(app), 0);
    await until(async () => (await lastStop(app, id)) === "error", "the failure");
    assert.equal(state.calls, 2);
});

test("an idle session's manual compaction waits for a limit too, with a view and Retry now", async () => {
    const { state, model } = limited();
    const app = await open(model);
    const id = await newSession(app);

    app.settings.getCompactionSettings = () =>
        ({ enabled: true, reserveTokens: 16384, keepRecentTokens: 50 }) as never;
    state.limited = false;
    await say(app, id, "first message ".repeat(100));
    await say(app, id, "second message ".repeat(100));
    state.limited = true;
    await app.commands.compact(id, owner(app), undefined);
    await until(() => waits(app, id) !== undefined, "the compaction to wait");
    state.limited = false;
    assert.equal(await app.commands.retryLimit(id, owner(app)), true);
    await until(() => waits(app, id) === undefined, "the compaction to go on");
});
