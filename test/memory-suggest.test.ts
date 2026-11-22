// Memory suggestions (extensions/memory.ts): when the owner turns on Suggest lessons, a classifier call reads each
// person's message, and one that states a rule, a preference, or a correction gets a turn note that suggests the
// memory tool's add — and only that: no lesson is ever written by the note, the owner still approves every save. A
// low-confidence yes, a no, a failed call, and the setting off all stay silent. No network: the classifier is scripted.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createProvider, type ClassifierResult } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, type EntryRecord } from "@earendil-works/pi-durable";
import { PocketApp } from "../src/server/app.ts";
import { TURN_NOTE_ENTRY } from "../src/server/entry-format.ts";
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    owner,
    root,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";

const dataDir = join(root, "memory-suggest");
/** The scripted classifier's answer: its choice, its confidence, or a failure. */
let choice: "yes" | "no" = "yes";
let confidence = 1;
let failClassify = false;
let classifyCalls = 0;
/** The requests the chat model saw, so a test can see the message still went. */
const requests: string[] = [];
let app: App;

before(async () => {
    const model = scriptedModel((request) => {
        requests.push(JSON.stringify(request.messages));

        return fauxAssistantMessage([fauxText(`echo: ${lastText(request as never).text}`)]);
    });

    // A classifier provider, signed in by its own fake key: the suggestion call reaches it through `host.classify`.
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
                            remember: {
                                type: "choice",
                                choice,
                                probabilities: {},
                                confidence,
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
        configureModels: (models) => {
            models.registerNativeProvider(model.provider);
            models.registerNativeProvider(classify);
        },
    });

    // The memory module is on by default: turn its suggestions on, with the scripted classifier.
    await app.setExtensionSettings(owner(app), "memory", {
        suggestLessons: true,
        classifyModel: "faux-jev/jev-test",
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function entries(id: ConversationId): Promise<EntryRecord[]> {
    const page = await (
        await app.conversation(id)
    ).entries({ order: "ascending" }, 200, undefined, context);

    return [...page.items];
}

/** The conversation's turn notes, oldest first. */
async function notes(id: ConversationId): Promise<{ source: string; text: string }[]> {
    const found = (await entries(id)).filter((entry) => entry.kind === TURN_NOTE_ENTRY);

    return found.map((entry) => entry.data as { source: string; text: string });
}

const RULE_MESSAGE = "From now on, always run the full test suite before you call the work done.";

test("a sure yes on a rule message gives one note that names the memory tool, and writes no lesson", async () => {
    choice = "yes";
    confidence = 1;
    failClassify = false;
    const id = await newSession(app);
    const before = await app.memory.view(id, owner(app));
    const calls = classifyCalls;

    await say(app, id, RULE_MESSAGE);

    const found = (await notes(id)).filter((note) => note.source === "memory-suggest");

    assert.equal(found.length, 1, "exactly one turn-note entry from memory-suggest");
    assert.match(found[0]!.text, /memory tool/);
    assert.match(found[0]!.text, /the owner approves/);
    assert.equal(classifyCalls - calls, 1, "one classify call for the message");

    // The note only suggests: nothing reached the memory store, pending or otherwise.
    const after = await app.memory.view(id, owner(app));

    assert.deepEqual(after.lessons, before.lessons, "no lesson was written");
});

test("a low-confidence yes and a no answer give no note", async () => {
    const id = await newSession(app);

    choice = "yes";
    confidence = 0.7;
    await say(app, id, "Always run the full test suite before you call the work done.");
    assert.deepEqual(
        (await notes(id)).filter((note) => note.source === "memory-suggest"),
        [],
        "no note on a low-confidence yes",
    );
    assert.equal((await app.memory.view(id, owner(app))).lessons.length, 0);

    choice = "no";
    confidence = 1;
    await say(app, id, "Please fix the failing build now.");
    assert.deepEqual(
        (await notes(id)).filter((note) => note.source === "memory-suggest"),
        [],
        "no note on a no answer",
    );
    assert.equal((await app.memory.view(id, owner(app))).lessons.length, 0);
});

test("a failing classifier is silent: no note, the message still goes to the model, nothing written", async () => {
    choice = "yes";
    confidence = 1;
    failClassify = true;
    const id = await newSession(app);
    const before = (await app.memory.view(id, owner(app))).lessons.length;
    const sent = requests.length;

    await say(app, id, RULE_MESSAGE);

    assert.deepEqual(
        (await notes(id)).filter((note) => note.source === "memory-suggest"),
        [],
        "no turn-note entry from memory-suggest",
    );
    assert.ok(requests.length > sent, "the message still went to the model");
    assert.match(requests.at(-1)!, /always run the full test suite/);
    assert.equal((await app.memory.view(id, owner(app))).lessons.length, before);
});

test("with suggestLessons off, no classify call happens", async () => {
    choice = "yes";
    confidence = 1;
    failClassify = false;
    await app.setExtensionSettings(owner(app), "memory", {
        suggestLessons: false,
        classifyModel: "faux-jev/jev-test",
    });

    const id = await newSession(app);
    const calls = classifyCalls;

    await say(app, id, RULE_MESSAGE);
    await say(app, id, "And always show me the diff before you commit.");

    assert.equal(classifyCalls - calls, 0, "no classify call with suggestions off");
    assert.deepEqual(await notes(id), [], "no note either");
    assert.equal((await app.memory.view(id, owner(app))).lessons.length, 0);
});
