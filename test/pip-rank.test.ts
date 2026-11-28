// PiP's sessions tool, with ranking on: one classifier call (through `host.classify`) ranks a query's top matches,
// so what the words are about comes first in what PiP reads; a failed or late call keeps today's newest-first order,
// and with the setting off nothing is asked. No network: the classifier is scripted.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    createProvider,
    type ClassifierAnswer,
    type ClassifierResult,
} from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { PocketApp } from "../src/server/app.ts";
import { type ClassifyRequest } from "../src/server/classify.ts";
import { rankSessions } from "../src/server/extensions/pip.ts";
import { type PipSession } from "../src/server/pip.ts";
import {
    cleanUp,
    type App,
    lastText,
    newSession,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** One session as the sessions tool sees it. */
const session = (id: number, title: string): PipSession => ({
    id,
    title,
    state: "idle",
    folder: "/work",
    archived: false,
    updatedAt: id,
});

/** A classify that scores whichever session's title says "login" as what the words are about. */
function ranker(byTitle: (title: string) => boolean) {
    const asked: ClassifyRequest[] = [];

    const classify = async (request: ClassifyRequest) => {
        asked.push(request);

        const state = request.state as { query: string; sessions: { title: string }[] };
        const answers: Record<string, ClassifierAnswer> = {};

        for (const id of Object.keys(request.questions)) {
            const at = Number(id.slice(1));

            answers[id] = {
                type: "score",
                score: byTitle(state.sessions[at]?.title ?? "") ? 2 : 0,
                confidence: 1,
            };
        }

        return answers;
    };

    return { classify, asked };
}

test("one call ranks a query's matches; the scores of one sort keep today's order between them", async () => {
    const { classify, asked } = ranker((title) => title.includes("login"));
    const sessions = [
        session(1, "fix the docs page"),
        session(2, "fix the login screen"),
        session(3, "fix the upload crash"),
    ];

    assert.deepEqual(
        (await rankSessions(classify as never, "faux/jev", "fix", sessions)).map((each) => each.id),
        [2, 1, 3],
        "what the words are about comes first; the rest keep today's order",
    );

    // What the classifier was asked: the query and the shortlist, one score question each, in one call.
    assert.equal(asked.length, 1);
    assert.equal((asked[0]!.state as { query?: string }).query, "fix");
    assert.equal(asked[0]!.model, "faux/jev");
    assert.deepEqual(Object.keys(asked[0]!.questions), ["s0", "s1", "s2"]);
    assert.equal(asked[0]!.questions.s0!.type, "score");

    // One session alone, or none of the answers, changes nothing.
    assert.deepEqual(await rankSessions(classify as never, "faux/jev", "fix", [sessions[0]!]), [
        sessions[0]!,
    ]);
    assert.deepEqual(
        (await rankSessions(async () => ({}), "faux/jev", "fix", sessions)).map((each) => each.id),
        [1, 2, 3],
        "no answers: today's order",
    );

    // A call that fails is swallowed by its deadline: today's order, with nothing thrown at the tool.
    assert.deepEqual(
        (
            await rankSessions(
                async () => {
                    throw new Error("no sign-in");
                },
                "faux/jev",
                "fix",
                sessions,
            )
        ).map((each) => each.id),
        [1, 2, 3],
        "a failed call: today's order",
    );
});

// End to end: the app's model runtime answers the ranking call, and the order reaches what PiP reads.
const dataDir = join(root, "pip-rank");
let failClassify = false;
let classifyCalls = 0;
let app: App;

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const isPip = all.includes("You are PiP");
    const { role, text } = lastText(request as never);

    if (!isPip) {
        return fauxAssistantMessage([fauxText(role === "toolResult" ? "woke" : `echo: ${text}`)]);
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`done: ${text}`)]);
    }

    if (text.startsWith("find ")) {
        return tool("sessions", { query: text.slice(5) });
    }

    return fauxAssistantMessage([fauxText(`pip: ${text}`)]);
};

before(async () => {
    const chat = scriptedModel(route);
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
                classify: async (_model, context): Promise<ClassifierResult> => {
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

                    const state = context.state as {
                        sessions: { title?: string }[];
                    };
                    const answers: Record<string, ClassifierAnswer> = {};

                    for (const id of Object.keys(context.questions)) {
                        const at = Number(id.slice(1));

                        answers[id] = {
                            type: "score",
                            score: (state.sessions[at]?.title ?? "").includes("login") ? 2 : 0,
                            confidence: 1,
                        };
                    }

                    return {
                        api: "typesafe-system-one",
                        provider: "faux-jev",
                        model: "jev-test",
                        answers,
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
        configureModels: (models) => {
            models.registerNativeProvider(chat.provider);
            models.registerNativeProvider(classify);
        },
    });

    await app.setExtensionSettings(owner(app), "pip", {
        rankSessions: true,
        classifyModel: "faux-jev/jev-test",
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** PiP's answers, oldest first. */
async function said(id: ConversationId): Promise<string[]> {
    const entries = await app.transcripts.allEntries(id, true);

    return entries.flatMap((entry) =>
        entry.kind === "assistant"
            ? entry.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))
            : [],
    );
}

/** PiP's newest answer to a "find" search: the sessions tool's lines. */
async function found(id: ConversationId): Promise<string> {
    const lines = (await said(id)).filter((text) => text.startsWith("done: #"));

    assert.ok(lines.at(-1) !== undefined, "a search was answered");

    return lines.at(-1)!;
}

test("a query's matches reach PiP ranked; a failed call, or the setting off, keeps today's order", async () => {
    const pip = await app.pip.ensure(owner(app));

    await app.commands.configure(pip, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    // Three sessions, made oldest first: today's list is newest first.
    const login = await newSession(app);
    const docs = await newSession(app);
    const crash = await newSession(app);

    await say(app, login, "fix the login screen");
    await say(app, docs, "fix the docs page");
    await say(app, crash, "fix the upload crash");
    await until(
        async () => app.sessions().some((each) => (each.title ?? "").includes("login")),
        "the login session's title",
    );

    failClassify = false;
    await say(app, pip, "find fix");

    assert.match(
        await found(pip),
        new RegExp(`^done: #${String(Number(login))} `),
        "the login session comes first: what the words are about",
    );
    assert.equal(classifyCalls, 1, "one ranking call");

    // A failed call keeps today's order: newest first.
    failClassify = true;
    await say(app, pip, "find fix");

    assert.match(await found(pip), new RegExp(`^done: #${String(Number(crash))} `));
    assert.equal(classifyCalls, 2);

    // With the setting off, nothing is asked and today's order stands.
    await app.setExtensionSettings(owner(app), "pip", {
        rankSessions: false,
        classifyModel: "faux-jev/jev-test",
    });
    failClassify = false;
    const before = classifyCalls;

    await say(app, pip, "find fix");

    assert.match(await found(pip), new RegExp(`^done: #${String(Number(crash))} `));
    assert.equal(classifyCalls, before, "no ranking call with the setting off");
});
