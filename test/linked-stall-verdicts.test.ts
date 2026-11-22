// The stall watch of linked sessions classifies a first stall (`extensions/agent-teams.ts`): a `looping` or `stuck`
// verdict reports at once with the line, `progressing` says nothing while the time rules stay the backstop, and a
// classifier that fails reports as today. One verdict per quiet spell. No network: the classifier is scripted.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createProvider, type ClassifierResult } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { PocketApp } from "../src/server/app.ts";
import { STALL_LOOK } from "../src/server/stall-facts.ts";
import {
    cleanUp,
    context,
    lastText,
    type App,
    newSession,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";

const dataDir = join(root, "linked-verdicts");
let offset = 0;
let verdict: "progressing" | "looping" | "stuck" = "looping";
let failClassify = false;
let classifyCalls = 0;
let app: App;

before(async () => {
    STALL_LOOK.ms = 100;
    const model = scriptedModel((request) => {
        const { text, role } = lastText(request as never);

        if (role === "user" && text.includes("START_A_TEAM")) {
            return fauxAssistantMessage(
                [fauxToolCall("team", { action: "start", message: "HANG_HERE please." })],
                { stopReason: "toolUse" },
            );
        }

        // The linked session: one call that never ends, then, once it is stopped, an answer.
        if (JSON.stringify(request).includes("HANG_HERE") && !text.includes("[linked sessions]")) {
            if (role !== "toolResult") {
                return fauxAssistantMessage(
                    [fauxToolCall("bash", { command: "exec tail -f /dev/null" })],
                    { stopReason: "toolUse" },
                );
            }
        }

        return fauxAssistantMessage([fauxText("Done.")]);
    });

    // A classifier provider, signed in by its own fake key: the verdict call reaches it through `host.classify`.
    const classify = createProvider({
        id: "faux-jev",
        auth: { apiKey: { name: "Faux Jev", resolve: async () => ({ auth: {} }) } },
        models: [
            {
                type: "classifier",
                id: "jev-test",
                name: "Faux Jev",
                api: "typesafe-system-one",
                provider: "faux-jev",
                baseUrl: "https://faux.example/v1",
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 64000,
            },
        ],
        classifiers: {
            "typesafe-system-one": {
                classify: async (_model, _context): Promise<ClassifierResult> => {
                    classifyCalls += 1;

                    if (failClassify) {
                        return {
                            api: "typesafe-system-one",
                            provider: "faux-jev",
                            model: "jev-test",
                            answers: {},
                            stopReason: "error",
                            errorMessage: "the classifier is off",
                            timestamp: Date.now(),
                        };
                    }

                    return {
                        api: "typesafe-system-one",
                        provider: "faux-jev",
                        model: "jev-test",
                        answers: {
                            verdict: {
                                type: "choice",
                                choice: verdict,
                                probabilities: {},
                                confidence: 1,
                            },
                        },
                        stopReason: "stop",
                        timestamp: Date.now(),
                    };
                },
            },
        },
    });

    app = await PocketApp.open({
        dataDir,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home: join(root, "home"),
        now: () => Date.now() + offset,
        configureModels: (models) => {
            models.registerNativeProvider(model.provider);
            models.registerNativeProvider(classify);
        },
    });
    app.background.limits.commandQuietMs = 0;
    await app.setExtensionEnabled(owner(app), "agent-teams.ts", true);
    // A stall after one minute; the verdict model, the scripted one.
    await app.setExtensionSettings(owner(app), "agent-teams", {
        stalledMinutes: 1,
        classifyModel: "faux-jev/jev-test",
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** The call a session waits on now, if any. */
const running = async (id: ConversationId) =>
    (await app.harness.snapshot(LiveDoc, id, context))?.tools?.find(
        (tool) => tool.status === "running",
    )?.callId;

/** What a lead was told: its messages from people and from Pi Pocket. */
async function told(id: ConversationId): Promise<string> {
    const messages = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;

    return JSON.stringify(messages.filter((message) => message.role === "user"));
}

/** A new lead and the linked session it started, with its stuck call running. */
async function team(): Promise<[ConversationId, ConversationId]> {
    const id = await newSession(app);

    await say(app, id, "START_A_TEAM");
    const started = app.sessions().find((session) => session.linkedFrom?.id === Number(id))!;

    await until(async () => (await running(started.id as never)) !== undefined, "the stuck call");
    await new Promise((resolve) => setTimeout(resolve, 300));

    return [id, started.id as unknown as ConversationId];
}

test("a looping verdict reports at once, with the verdict on the stall line", async () => {
    verdict = "looping";
    failClassify = false;
    const [id, target] = await team();
    const before = classifyCalls;

    offset += 61_000;
    await until(
        async () => (await told(id)).includes("stalled: no progress for 1 min"),
        "the stall with its verdict",
    );
    const heard = await told(id);

    assert.match(
        heard,
        /Linked session \S+ stalled: no progress for 1 min, waiting on its bash call/,
    );
    assert.match(heard, /A classifier model reads its recent activity as looping\./);
    assert.equal(
        (heard.match(/\[linked sessions\]/g) ?? []).length,
        1,
        "one message, once for this spell",
    );
    assert.equal(classifyCalls - before, 1, "one classification for the stall");

    // Several looks later, the spell is still classified: no second call and no second line.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(classifyCalls - before, 1, "no second classification");
    assert.equal(((await told(id)).match(/\[linked sessions\]/g) ?? []).length, 1);

    assert.notEqual(await running(target), undefined, "the call still runs: nothing was stopped");
    await app.commands.abort(target, owner(app));
});

test("a progressing verdict says nothing yet; the time rules stay the backstop", async () => {
    verdict = "progressing";
    failClassify = false;
    const [id, target] = await team();
    const before = classifyCalls;

    offset += 61_000;
    // Past the soft limit with a progressing verdict: no message, and one classification only.
    await until(async () => classifyCalls - before === 1, "the one classification");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await told(id)).includes("stalled"), false, "nothing was said yet");
    assert.equal(classifyCalls - before, 1, "no second classification");

    // The hard limit still stops the stuck call, and the lead still hears, as today.
    offset += 60 * 60_000;
    await until(async () => (await running(target)) === undefined, "the call stopped");
    await until(async () => (await told(id)).includes("stop 1 of 2"), "the stop, as today");
    assert.match(await told(id), /Pi Pocket stopped its bash call/);
});

test("a classifier that fails reports the stall as today, without a verdict", async () => {
    verdict = "looping";
    failClassify = true;
    const [id, target] = await team();

    offset += 61_000;
    await until(
        async () => (await told(id)).includes("stalled: no progress for 1 min"),
        "the stall, as today",
    );
    const heard = await told(id);

    assert.doesNotMatch(heard, /classifier model reads/);
    assert.equal((heard.match(/\[linked sessions\]/g) ?? []).length, 1, "one message");
    await app.commands.abort(target, owner(app));
});
