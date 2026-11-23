// Forks, sending a message again (edited, or to another model), new contexts, and instructions for Pi.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    type ConversationId,
    type EntryRecord,
    InboxDoc,
    type SubmissionId,
} from "@earendil-works/pi-durable";
import { ChatDoc, SessionsDoc } from "../src/server/docs.ts";

/** What each model request saw: the model, the system prompt's sections, and the newest message. */
const requests: { model: string; sections: Record<string, string>; text: string }[] = [];

const route: FauxResponseStep = (request, _options, _state, model) => {
    const { role, text } = lastText(request as never);
    // Pi Durable sends the system prompt as positional system messages with sections by name: each one changes the
    // sections it names, and null removes one.
    const sections: Record<string, string> = {};

    for (const message of (
        request as { messages: { role: string; sections?: Record<string, string | null> }[] }
    ).messages) {
        if (message.role !== "system") {
            continue;
        }

        for (const [name, value] of Object.entries(message.sections ?? {})) {
            if (value === null) {
                delete sections[name];
            } else {
                sections[name] = value;
            }
        }
    }

    requests.push({ model: model.id, sections, text });

    if (role === "user" && text.endsWith("list the files")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], {
            stopReason: "toolUse",
        });
    }

    if (text.includes("work slowly")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 15" })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;

before(async () => {
    const model = scriptedModel(route);

    Object.assign(model.getModel("faux-2")!, { reasoning: true });
    app = await openApp(model);
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function entries(id: ConversationId): Promise<EntryRecord[]> {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        256,
        undefined,
        context,
    );

    return [...page.items].reverse();
}

const texts = async (id: ConversationId) => (await modelTexts(app, id)).join("\n");
const ofKind = async (id: ConversationId, kind: string) =>
    (await entries(id)).filter((entry) => entry.kind === kind);

/** A guest with steering rights, signed in as `name`. */
const guest = (name: string, sessions?: string[]) =>
    app.config.addUser(name, "guest", sessions).user;

test("a fork keeps the history through the chosen message, then goes its own way", async () => {
    const id = await newSession(app);

    await say(app, id, "first question");
    await say(app, id, "second question");
    const [firstAnswer, secondAnswer] = await ofKind(id, "pi.assistant");
    const { id: fork } = await app.commands.fork(id, owner(app), {
        entryId: Number(firstAnswer!.id),
    });

    assert.match(await texts(fork), /first question/);
    assert.doesNotMatch(await texts(fork), /second question/);

    await say(app, fork, "a different second question");
    assert.match(await texts(fork), /a different second question/);
    assert.doesNotMatch(
        await texts(id),
        /a different second question/,
        "the original does not change",
    );

    // Inherited messages are the fork's own to load; the original's later ones are not.
    assert.equal(
        (await app.transcripts.fullEntry(fork, Number(firstAnswer!.id)))?.kind,
        "assistant",
    );
    assert.equal(await app.transcripts.fullEntry(fork, Number(secondAnswer!.id)), undefined);

    // A fork of the fork inherits through both.
    const forkAnswer = (await ofKind(fork, "pi.assistant")).at(-1)!;
    const { id: grandchild } = await app.commands.fork(fork, owner(app), {
        entryId: Number(forkAnswer.id),
    });

    assert.equal(
        (await app.transcripts.fullEntry(grandchild, Number(firstAnswer!.id)))?.kind,
        "assistant",
    );
    assert.equal(
        (await app.transcripts.fullEntry(grandchild, Number(forkAnswer.id)))?.kind,
        "assistant",
    );
    assert.equal(await app.transcripts.fullEntry(grandchild, Number(secondAnswer!.id)), undefined);
});

test("a fork with no message chosen takes the whole session, through Pi's latest reply", async () => {
    const id = await newSession(app);
    const { id: empty } = await app.commands.fork(id, owner(app), {});

    assert.doesNotMatch(
        await texts(empty),
        /question/,
        "before any reply there is nothing to take",
    );

    await say(app, id, "first question");
    await say(app, id, "second question");
    const { id: fork } = await app.commands.fork(id, owner(app), {});

    assert.match(await texts(fork), /first question/);
    assert.match(await texts(fork), /second question/);
    assert.match(app.sessionMeta(fork)?.title ?? "", /· fork$/);
});

test("Undo forks before the latest message, keeps the title and settings, and archives the original", async () => {
    const id = await newSession(app);
    const user = owner(app);
    const title = "Keep this title";
    const cwd = join(root, "undo-new-folder");

    guest("Another person"); // The stored message now has a [from: …] prefix.
    await app.commands.updateSession(id, user, { title });
    await say(app, id, "keep this prompt");
    await say(app, id, "return this prompt\nwith both lines");
    await app.commands.note(id, user, "a later note");
    mkdirSync(cwd);
    await app.commands.configure(id, user, {
        cwd,
        model: { provider: "faux", modelId: "faux-2" },
        thinkingLevel: "high",
    });
    const before = await entries(id);
    const [first, last] = before.filter((entry) => entry.kind === "pi.user");
    const previous = before[before.indexOf(last!) - 1]!;
    const requestCount = requests.length;
    const back = await app.commands.undo(id, user, { entryId: Number(last!.id) });

    assert.equal(back.text, "return this prompt\nwith both lines");
    assert.equal(app.sessionMeta(id)?.archived, true);
    assert.equal(app.sessionMeta(back.id)?.archived, undefined);
    assert.equal(app.sessionMeta(back.id)?.title, title);
    assert.deepEqual(app.sessionMeta(back.id)?.forkedFrom, {
        id: Number(id),
        entryId: Number(previous.id),
    });
    assert.equal(app.cwdOf(back.id), cwd);
    const agent = await app.agentState(back.id);

    assert.deepEqual(agent?.model, { provider: "faux", modelId: "faux-2" });
    assert.equal(agent?.thinkingLevel, "high");
    assert.deepEqual(
        (await entries(back.id)).map((entry) => entry.id),
        before.slice(0, before.indexOf(last!)).map((entry) => entry.id),
    );
    assert.deepEqual(await entries(id), before, "the archive keeps the original transcript");
    assert.equal(requests.length, requestCount, "Undo does not ask the model for anything");
    assert.match(
        (await app.harness.snapshot(ChatDoc, back.id, context))!.messages.at(-1)!.text,
        /undid a message/,
    );

    const again = await app.commands.undo(back.id, user, { entryId: Number(first!.id) });

    assert.equal(again.text, "keep this prompt");
    assert.deepEqual(await ofKind(again.id, "pi.user"), []);
    assert.equal(app.sessionMeta(again.id)?.title, title);
    assert.equal(app.sessionMeta(back.id)?.archived, true);
    await app.commands.updateSession(id, user, { archived: false });
    assert.equal(app.sessionMeta(id)?.archived, false);
});

test("Undo refuses older messages, replies, and people who cannot fork or drive", async () => {
    const id = await newSession(app);
    const user = owner(app);

    await say(app, id, "the older message");
    await say(app, id, "the newest message");
    const [older, latest] = await ofKind(id, "pi.user");
    const [reply] = await ofKind(id, "pi.assistant");
    const request = { entryId: Number(latest!.id) };
    const sessions = app.sessions().length;

    for (const entry of [older!, reply!]) {
        await assert.rejects(app.commands.undo(id, user, { entryId: Number(entry.id) }), {
            status: 400,
        });
    }

    await assert.rejects(app.commands.undo(id, guest("Scoped undo", [String(id)]), request), {
        status: 403,
    });
    await app.collab.turns(id, user, { action: "on" });
    await assert.rejects(app.commands.undo(id, guest("Not driving"), request), {
        status: 409,
    });
    assert.equal(app.sessionMeta(id)?.archived, undefined);
    assert.equal(app.sessions().length, sessions, "refusals do not leave any forks");
});

test("Undo waits for Pi to stop and does not drop queued or steered messages", async () => {
    const id = await newSession(app);
    const user = owner(app);
    const { submissionId } = await app.commands.submit(id, user, {
        text: "work slowly",
        requestId: "slow undo",
    });

    try {
        await until(() => app.isBusy(id), "Pi to start");
        const [last] = await ofKind(id, "pi.user");
        const request = { entryId: Number(last!.id) };

        await assert.rejects(app.commands.undo(id, user, request), { status: 409 });
        const queued = await app.commands.submit(id, user, {
            text: "the queued message",
            mode: "followUp",
            requestId: "undo cannot drop this",
        });

        await assert.rejects(app.commands.undo(id, user, request), { status: 409 });
        assert.ok(
            (await app.harness.snapshot(InboxDoc, id, context))!.items.some(
                (item) => item.id === queued.submissionId,
            ),
        );
        assert.equal(app.sessionMeta(id)?.archived, undefined);
    } finally {
        await app.commands.abort(id, user);
        await (await app.harness.submission(submissionId, context))!.wait(context);
    }
});

test("Undo refuses a pending input even without an active run", async () => {
    const id = await newSession(app);
    const user = owner(app);

    await say(app, id, "the last message before the queue");
    const [last] = await ofKind(id, "pi.user");

    for (const mode of ["followUp", "steer"] as const) {
        // Represent an input waiting for a run boundary without racing the worker that starts the next run.
        await app.harness.commit(async (tx) => {
            (await tx.doc(InboxDoc, id)).items.push({
                id: 1 as unknown as SubmissionId,
                mode,
                content: "still waiting",
            });
        }, context);

        try {
            await assert.rejects(app.commands.undo(id, user, { entryId: Number(last!.id) }), {
                status: 409,
            });
            assert.equal(app.sessionMeta(id)?.archived, undefined);
        } finally {
            await app.harness.commit(async (tx) => {
                (await tx.doc(InboxDoc, id)).items.splice(0);
            }, context);
        }
    }
});

test("Undo restores available uploads and reports a missing file", async () => {
    const id = await newSession(app);
    const uploads = app.workspace.uploadDirectory(id);
    const path = join(uploads, "id-notes (copy).txt");
    const missing = join(uploads, "id-missing.txt");

    writeFileSync(path, "some notes");
    await say(app, id, "read these notes", [
        { path, name: "notes (copy).txt", mime: "text/plain", size: 10 },
        { path: missing, name: "missing.txt", mime: "text/plain", size: 1 },
    ]);
    const [message] = await ofKind(id, "pi.user");
    const back = await app.commands.undo(id, owner(app), { entryId: Number(message!.id) });
    const restored = join(app.workspace.uploadDirectory(back.id), "id-notes (copy).txt");

    assert.equal(back.text, "read these notes");
    assert.equal(back.attachmentsOmitted, true);
    assert.deepEqual(back.attachments, [
        { path: restored, name: "notes (copy).txt", mime: "text/plain", size: 10 },
    ]);
    assert.equal(readFileSync(restored, "utf8"), "some notes");
    assert.equal(readFileSync(path, "utf8"), "some notes");
});

test("Undo of a message sent again restores the uploads of the session it came from", async () => {
    const id = await newSession(app);
    const path = join(app.workspace.uploadDirectory(id), "id-plan.txt");

    writeFileSync(path, "the plan");
    await say(app, id, "read the plan", [{ path, name: "plan.txt", mime: "text/plain", size: 8 }]);
    const [message] = await ofKind(id, "pi.user");
    const { id: retry } = await app.commands.resend(id, owner(app), {
        entryId: Number(message!.id),
    });

    await until(
        async () => (await ofKind(retry, "pi.assistant")).length === 1,
        "the retry to be answered",
    );
    const [resent] = await ofKind(retry, "pi.user");
    const back = await app.commands.undo(retry, owner(app), { entryId: Number(resent!.id) });
    const restored = join(app.workspace.uploadDirectory(back.id), "id-plan.txt");

    assert.equal(back.text, "read the plan");
    assert.equal(back.attachmentsOmitted, false);
    assert.deepEqual(back.attachments, [
        { path: restored, name: "plan.txt", mime: "text/plain", size: 8 },
    ]);
    assert.equal(readFileSync(restored, "utf8"), "the plan");
});

test("a message can be edited and sent again in a fork that ends just before it", async () => {
    const id = await newSession(app);

    await say(app, id, "hello one");
    await say(app, id, "hello two");
    const [, second] = await ofKind(id, "pi.user");
    const { id: fork } = await app.commands.resend(id, owner(app), {
        entryId: Number(second!.id),
        text: "hello TWO, edited",
    });

    await until(
        async () => (await ofKind(fork, "pi.assistant")).length === 2,
        "the edit to be answered",
    );
    const sent = (await ofKind(fork, "pi.user")).map((entry) => JSON.stringify(entry.model));

    assert.equal(sent.length, 2, "the inherited first message and the edit");
    assert.match(sent[0]!, /hello one/);
    assert.match(sent[1]!, /hello TWO, edited/);
});

test("a message sent again reaches its fork even when the server stops before sending it", async () => {
    const id = await newSession(app);

    await say(app, id, "hello once");
    const [message] = await ofKind(id, "pi.user");
    // The server stops right after making the fork: the request never sends the message itself.
    const conversation = app.conversation;

    app.conversation = async (cid) =>
        cid === id
            ? conversation.call(app, cid)
            : new Proxy(await conversation.call(app, cid), {
                  get: (found, key) => {
                      if (key === "submit") {
                          return () => new Promise(() => {});
                      }

                      const value: unknown = Reflect.get(found, key, found);

                      return typeof value === "function" ? value.bind(found) : value;
                  },
              });
    let fork: ConversationId | undefined;

    try {
        void app.commands.resend(id, owner(app), {
            entryId: Number(message!.id),
            text: "hello again",
        });
        await until(async () => {
            const items = (await app.harness.snapshot(SessionsDoc, context))?.items ?? {};

            fork = Object.keys(items).find(
                (key) => items[key]!.forkedFrom?.id === Number(id),
            ) as unknown as ConversationId | undefined;

            return fork !== undefined;
        }, "the fork");
    } finally {
        app.conversation = conversation;
    }

    await until(
        async () => (await ofKind(fork!, "pi.assistant")).length === 1,
        "the fork's own task to send it",
    );
    assert.deepEqual(
        (await ofKind(fork!, "pi.user")).map((entry) =>
            JSON.stringify(entry.model).includes("hello again"),
        ),
        [true],
    );
});

test("an edited message keeps the files attached to the original", async () => {
    const id = await newSession(app);
    const path = join(app.workspace.uploadDirectory(id), "notes.txt");

    writeFileSync(path, "some notes");
    await say(app, id, "read my notes", [
        { path, name: "notes.txt", mime: "text/plain", size: 10 },
    ]);
    const [message] = await ofKind(id, "pi.user");
    const { id: fork } = await app.commands.resend(id, owner(app), {
        entryId: Number(message!.id),
        text: "summarize my notes",
    });

    await until(
        async () => (await ofKind(fork, "pi.assistant")).length === 1,
        "the edit to be answered",
    );
    const [edited] = await ofKind(fork, "pi.user");
    const text = JSON.stringify(edited!.model);

    assert.match(text, /summarize my notes/);
    assert.doesNotMatch(text, /read my notes/);
    assert.ok(text.includes(path), "the attachment list comes along");
});

test("an edit of a message of files alone from before 0.14.0 keeps its files", async () => {
    const id = await newSession(app);

    // What 0.13 stored: the heading without the blank line before it.
    await say(
        app,
        id,
        "Attached files (saved on the server):\n- /tmp/x/a.txt (a.txt, text/plain, 3 bytes)",
    );
    const [message] = await ofKind(id, "pi.user");
    const { id: fork } = await app.commands.resend(id, owner(app), {
        entryId: Number(message!.id),
        text: "summarize it",
    });

    await until(
        async () => (await ofKind(fork, "pi.assistant")).length === 1,
        "the edit to be answered",
    );
    const [edited] = await ofKind(fork, "pi.user");

    assert.ok(JSON.stringify(edited!.model).includes("/tmp/x/a.txt"), "the files come along");
});

test("sending a message again to another model forks before it and switches the fork's model", async () => {
    const id = await newSession(app);

    await say(app, id, "which model are you");
    const [message] = await ofKind(id, "pi.user");
    const before = requests.length;
    const { id: fork } = await app.commands.resend(id, owner(app), {
        entryId: Number(message!.id),
        model: { provider: "faux", modelId: "faux-2" },
    });
    const agent = await app.agentState(fork);

    assert.deepEqual(agent?.model, { provider: "faux", modelId: "faux-2" });
    await until(
        () =>
            requests
                .slice(before)
                .some(
                    (each) => each.model === "faux-2" && each.text.endsWith("which model are you"),
                ),
        "the other model to answer",
    );
    assert.equal(
        (await app.agentState(id))?.model?.modelId,
        "faux-1",
        "the original keeps its model",
    );
});

test("a message sent again with the same model takes the model the session runs on now", async () => {
    const id = await newSession(app);

    await say(app, id, "first, on the old model");
    await say(app, id, "which model are you");
    const [, message] = await ofKind(id, "pi.user");

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
    });
    const before = requests.length;
    const { id: fork } = await app.commands.resend(id, owner(app), {
        entryId: Number(message!.id),
    });

    assert.equal((await app.agentState(fork))?.model?.modelId, "faux-2");
    await until(
        () =>
            requests
                .slice(before)
                .some(
                    (each) => each.model === "faux-2" && each.text.endsWith("which model are you"),
                ),
        "the current model to answer the message again",
    );
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
});

test("forks need a steering person with access to every session, and an existing message", async () => {
    const id = await newSession(app);

    await say(app, id, "something to fork");
    const [answer] = await ofKind(id, "pi.assistant");
    const viewer = app.config.addUser("Vera", "viewer").user;

    await assert.rejects(app.commands.fork(id, viewer, { entryId: Number(answer!.id) }), {
        status: 403,
    });
    await assert.rejects(
        app.commands.fork(id, guest("Scoped", [String(id)]), { entryId: Number(answer!.id) }),
        { status: 403 },
    );
    await say(app, id, "list the files");
    const calling = (await ofKind(id, "pi.assistant")).find((entry) =>
        JSON.stringify(entry.model).includes('"toolUse"'),
    )!;

    await assert.rejects(
        app.commands.fork(id, owner(app), { entryId: Number(calling.id) }),
        { status: 400 },
        "its tool calls would have no results",
    );
});

test("a new context hides earlier messages from Pi but keeps them for people, with an optional handoff note", async () => {
    const id = await newSession(app);

    await say(app, id, "remember the word apricot");
    await app.commands.reset(id, owner(app), "We were talking about fruit.");
    await say(app, id, "what now");
    const said = await texts(id);

    assert.doesNotMatch(said, /apricot/);
    assert.match(said, /We were talking about fruit\./);
    assert.equal((await ofKind(id, "pi.user")).length, 2, "the transcript keeps everything");
});

test("an open session's view starts again at a new context, as Pi's context does", async () => {
    const id = await newSession(app);
    const tab = fakeTab(id, owner(app));
    const order = () => (tab.field("order") as number[] | undefined) ?? [];

    await app.attach(tab.client);

    try {
        await say(app, id, "remember the word apricot");
        await until(() => order().length === 2, "the first exchange in the view");
        const earlier = order();

        await app.commands.reset(id, owner(app), "We were talking about fruit.");
        await say(app, id, "what now");
        const conversation = (await app.harness.conversation(id, context))!;
        const active = (await conversation.context(context)).entries.map((entry) => entry.id);
        const room = await app.room(id);

        try {
            // Pi Durable's view holds the whole history: the room reads the active context again at the reset.
            await until(
                () =>
                    JSON.stringify(room.value!.entries.map((entry) => entry.id)) ===
                    JSON.stringify(active),
                "the room to hold the new context",
            );
            assert.equal(room.value!.entries[0]!.kind, "pi.reset");
            await until(
                () => order().length > 0 && !order().some((each) => earlier.includes(each)),
                "the tab's order to start at the new context",
            );
        } finally {
            app.releaseRoom(room);
        }
    } finally {
        app.detach(tab.client);
    }
});

test("instructions for Pi go into every request of a session and can be cleared", async () => {
    const id = await newSession(app);

    await app.commands.setInstructions(id, owner(app), "Always answer in French.");
    assert.equal((await app.agentState(id))?.instructions, "Always answer in French.");
    // With several people on the server, messages start with who sent them: match the end.
    const sentWith = (text: string) => requests.findLast((each) => each.text.endsWith(text));

    await say(app, id, "asked under the rules");
    assert.match(
        sentWith("asked under the rules")!.sections.instructions ?? "",
        /Always answer in French\./,
    );
    await app.commands.setInstructions(id, owner(app), "  ");
    assert.equal((await app.agentState(id))?.instructions, undefined);
    await say(app, id, "asked after clearing them");
    assert.equal(sentWith("asked after clearing them")!.sections.instructions, undefined);
});

test("a session exports as Markdown with its whole history, inherited messages included", async () => {
    const id = await newSession(app);

    await say(app, id, "the first word");
    await app.commands.reset(id, owner(app), undefined);
    await say(app, id, "after the reset");
    const [, answer] = await ofKind(id, "pi.assistant");
    const { id: fork } = await app.commands.fork(id, owner(app), { entryId: Number(answer!.id) });
    const { markdown } = await app.transcripts.exportMarkdown(fork, owner(app));

    assert.match(
        markdown,
        new RegExp(
            `\\*\\*${owner(app).name}\\*\\*\\n\\nthe first word[\\s\\S]*_New context\\._[\\s\\S]*after the reset`,
        ),
    );
    const viewer = app.config.addUser("Scoped viewer", "viewer", [String(id)]).user;

    await assert.rejects(app.transcripts.exportMarkdown(fork, viewer), { status: 404 });
});

test("the folder picker makes a new folder, nested ones too, for people who may browse folders", async () => {
    const { existsSync, statSync } = await import("node:fs");
    const { root } = await import("./helpers.ts");
    const made = join(root, "picked", "new app");

    assert.equal(app.workspace.makeFolder(owner(app), made), made);
    assert.ok(statSync(made).isDirectory());
    assert.throws(
        () => app.workspace.makeFolder(app.config.addUser("Vic", "viewer").user, join(root, "v")),
        { status: 403 },
    );
    assert.throws(() => app.workspace.makeFolder(guest("Scoped Sam", ["1"]), join(root, "s")), {
        status: 403,
    });
    assert.ok(!existsSync(join(root, "v")) && !existsSync(join(root, "s")));
});
