// A run that gives up (`run.ended`, `linkedSessions.list`): extensions hear how it ended, and the failure line the
// session list shows. A later run clears it, a stop is not a failure, and the line lasts across a restart.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { RunFailureDoc } from "../src/server/docs.ts";
import type { AppEvents } from "../src/server/host.ts";
import type { LimitTuning } from "../src/server/limit-gate.ts";

let dirs = 0;

/** "fail now" errors; "wait here" answers slowly, so a stop can land first; the rest is echoed. */
const route: FauxResponseStep = async (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.includes("fail now")) {
        return fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: "Invalid request: unsupported parameter temperature",
        });
    }

    if (role === "user" && text.includes("wait here")) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));

        return fauxAssistantMessage([fauxText("late")]);
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const open: App[] = [];

after(async () => {
    await Promise.all(open.splice(0).map((app) => app.close()));
    cleanUp();
});

async function started(limits?: Partial<LimitTuning>): Promise<App> {
    const app = await openApp(
        scriptedModel(route),
        join(root, `run-failure-${dirs++}`),
        undefined,
        limits,
    );

    open.push(app);

    return app;
}

/** A session with someone Pi works for: a linked session acts as them. */
async function source(app: App): Promise<ConversationId> {
    const id = await newSession(app);

    await say(app, id, "hello");

    return id;
}

type Ended = AppEvents["run.ended"];

function listen(app: App): Ended[] {
    const ended: Ended[] = [];

    app.events.on("run.ended", (data) => ended.push(data));

    return ended;
}

const row = (app: App, id: ConversationId) =>
    app.sessions(owner(app)).find((each) => each.id === Number(id))!;

async function stored(app: App, id: ConversationId): Promise<string | undefined> {
    return (await app.harness.snapshot(RunFailureDoc, id, context))?.text;
}

test("a run that gives up says so, and the failure lasts across a restart", async () => {
    const dir = join(root, "run-failure-restart");
    const app = await openApp(scriptedModel(route), dir);

    open.push(app);
    const id = await source(app);
    const ended = listen(app);
    const { session } = await app.linkedSessions.start(
        id,
        { title: "Helper", message: "fail now" },
        "fail-key",
    );

    await until(() => row(app, session).failed === true, "the failure");
    await until(() => ended.some((each) => each.conversationId === Number(session)), "the event");

    const event = ended.find((each) => each.conversationId === Number(session))!;

    assert.equal(event.outcome, "failed");
    assert.equal(event.failure, "Invalid request: unsupported parameter temperature");
    assert.equal(event.session, Number(session));
    assert.equal(row(app, session).failure, event.failure);

    const [linked] = await app.linkedSessions.list(id);

    assert.equal(linked?.failed, event.failure);
    await until(async () => (await stored(app, session)) === event.failure, "the stored line");
    await app.close();
    open.pop();

    const again = await openApp(scriptedModel(route), dir);

    open.push(again);

    assert.equal(row(again, session).failed, true);
    assert.equal(row(again, session).failure, event.failure);
    assert.equal((await again.linkedSessions.list(id))[0]?.failed, event.failure);
    assert.equal(row(again, id).failed, undefined, "the source finished");
});

test("a run that then answers clears the failure, and a stop is not one", async () => {
    const app = await started();
    const id = await source(app);
    const ended = listen(app);

    await app.commands.submit(id, owner(app), { text: "fail now", requestId: "fail-clear" });
    await until(() => row(app, id).failed === true, "the failure");
    await until(async () => (await stored(app, id)) !== undefined, "the stored line");
    await say(app, id, "try again");
    await until(() => row(app, id).failed === undefined && !app.isBusy(id), "the failure cleared");
    await until(async () => (await stored(app, id)) === undefined, "the stored line cleared");

    const cleared = ended.filter((each) => each.conversationId === Number(id));

    assert.equal(cleared[0]?.outcome, "failed");
    assert.equal(cleared.at(-1)?.outcome, "done");
    assert.equal(cleared.at(-1)?.failure, undefined);
    assert.equal(
        (await app.linkedSessions.list(id)).find((each) => each.failed),
        undefined,
    );

    const { session } = await app.linkedSessions.start(
        id,
        { title: "Slow", message: "wait here" },
        "stop-key",
    );

    await until(() => app.isBusy(session), "the run");
    await app.commands.abort(session, owner(app));
    await until(() => !app.isBusy(session), "the stop");
    await until(
        () => ended.some((each) => each.conversationId === Number(session)),
        "the stop's event",
    );

    const stopped = ended.find((each) => each.conversationId === Number(session))!;

    assert.equal(stopped.outcome, "aborted");
    assert.equal(stopped.failure, undefined);
    assert.equal(row(app, session).failed, undefined);
    assert.equal(await stored(app, session), undefined);

    const [linked] = await app.linkedSessions.list(id);

    assert.equal(linked?.address === undefined, false);
    assert.equal(linked?.failed, undefined);
});

test("a limit the provider then clears is not a failure", async () => {
    let calls = 0;
    const model = scriptedModel(() => {
        calls++;

        if (calls === 1) {
            throw new Error("529 overloaded_error");
        }

        return fauxAssistantMessage([fauxText("answered")]);
    });
    const app = await openApp(model, join(root, "run-failure-retry"), undefined, {
        minWaitMs: 20,
        backoffMs: [30],
    });

    open.push(app);

    const id = await newSession(app);
    const ended = listen(app);

    await say(app, id, "hello");
    await until(() => ended.some((each) => each.conversationId === Number(id)), "the event");
    assert.ok(calls > 1, "the provider was asked again");
    assert.equal(ended.find((each) => each.conversationId === Number(id))?.outcome, "done");
    assert.equal(row(app, id).failed, undefined);
    assert.equal(await stored(app, id), undefined);
});
