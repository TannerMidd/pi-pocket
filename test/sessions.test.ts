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
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { ChatDoc, NotesDoc, PinsDoc, PlanDoc, SessionsDoc } from "../src/server/docs.ts";

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

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
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

    await app.commands.updateSession(id, owner(app), { title: "Origin" });
    await say(app, id, "first question");
    await say(app, id, "second question");
    const [firstAnswer, secondAnswer] = await ofKind(id, "pi.assistant");

    await app.collab.postChat(id, owner(app), { text: "chat before the fork", requestId: "c1" });
    await app.collab.pin(id, owner(app), { entryId: Number(firstAnswer!.id) });
    await app.collab.pin(id, owner(app), { entryId: Number(secondAnswer!.id) });

    const { id: fork } = await app.commands.fork(id, owner(app), {
        entryId: Number(firstAnswer!.id),
    });
    const meta = app.sessions().find((each) => each.id === Number(fork))!;

    assert.equal(meta.title, "Origin · fork");
    assert.deepEqual(meta.forkedFrom, { id: Number(id), entryId: Number(firstAnswer!.id) });
    assert.match(await texts(fork), /first question/);
    assert.doesNotMatch(await texts(fork), /second question/);

    await say(app, fork, "a different second question");
    assert.match(await texts(fork), /a different second question/);
    assert.doesNotMatch(
        await texts(id),
        /a different second question/,
        "the original does not change",
    );

    // Inherited messages are the fork's own to load, pin, and quote; the original's later ones are not.
    assert.equal((await app.fullEntry(fork, Number(firstAnswer!.id)))?.kind, "assistant");
    assert.equal(await app.fullEntry(fork, Number(secondAnswer!.id)), undefined);
    const pins = (await app.harness.snapshot(PinsDoc, fork, context))!.items;

    assert.deepEqual(
        pins.map((pin) => pin.entryId),
        [Number(firstAnswer!.id)],
        "only pins of inherited messages come along",
    );

    // The fork starts its own chat; both sessions say what happened.
    const forkChat = (await app.harness.snapshot(ChatDoc, fork, context))!.messages.map(
        (message) => message.text,
    );

    assert.deepEqual(forkChat, ["forked this from “Origin”"]);
    const originChat = (await app.harness.snapshot(ChatDoc, id, context))!.messages.map(
        (message) => message.text,
    );

    assert.ok(originChat.includes("chat before the fork"));
    assert.ok(originChat.includes("forked “Origin · fork” from this session"));

    // A fork of the fork inherits through both.
    const forkAnswer = (await ofKind(fork, "pi.assistant")).at(-1)!;
    const { id: grandchild } = await app.commands.fork(fork, owner(app), {
        entryId: Number(forkAnswer.id),
    });

    assert.equal((await app.fullEntry(grandchild, Number(firstAnswer!.id)))?.kind, "assistant");
    assert.equal((await app.fullEntry(grandchild, Number(forkAnswer.id)))?.kind, "assistant");
    assert.equal(await app.fullEntry(grandchild, Number(secondAnswer!.id)), undefined);
});

test("a fork's people are the ones who took part up to where it forked", async () => {
    const id = await newSession(app);

    await say(app, id, "one");
    const lena = guest("Lena");
    const { submissionId } = await app.commands.submit(id, lena, {
        text: "two",
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await until(
        async () => (await app.alerts.participants(id)).has(lena.id),
        "Lena's message to be recorded",
    );
    const [first] = await ofKind(id, "pi.assistant");
    const { id: fork } = await app.commands.fork(id, owner(app), { entryId: Number(first!.id) });

    assert.deepEqual(
        [...(await app.alerts.participants(fork))],
        [owner(app).id],
        "Lena wrote after the fork point",
    );
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
    assert.ok(
        app
            .sessions()
            .find((each) => each.id === Number(fork))
            ?.title?.endsWith("· edit"),
    );

    // Unchanged, it is the same message sent again: a retry.
    const { id: retry } = await app.commands.resend(id, owner(app), {
        entryId: Number(second!.id),
        text: " hello two ",
    });

    await until(
        async () => (await ofKind(retry, "pi.assistant")).length === 2,
        "the retry to be answered",
    );
    assert.ok(
        app
            .sessions()
            .find((each) => each.id === Number(retry))
            ?.title?.endsWith("· retry"),
    );
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
    const path = join(app.uploadDirectory(id), "notes.txt");

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

    // Emptied, the message still sends its files.
    const { id: filesOnly } = await app.commands.resend(id, owner(app), {
        entryId: Number(message!.id),
        text: "",
    });

    await until(
        async () => (await ofKind(filesOnly, "pi.assistant")).length === 1,
        "the files to be answered",
    );
    const [sent] = await ofKind(filesOnly, "pi.user");

    assert.ok(JSON.stringify(sent!.model).includes(path));
    assert.doesNotMatch(JSON.stringify(sent!.model), /read my notes/);
});

test("sending a message again to another model forks before it and switches the fork's model", async () => {
    const id = await newSession(app);

    await say(app, id, "which model are you");
    const [message] = await ofKind(id, "pi.user");

    await app.commands.setPlan(id, owner(app), true);
    await app.collab.saveNotes(id, owner(app), "keep it short", 0);
    const before = requests.length;
    const { id: fork } = await app.commands.resend(id, owner(app), {
        entryId: Number(message!.id),
        model: { provider: "faux", modelId: "faux-2" },
    });
    const agent = await app.agentState(fork);

    assert.deepEqual(agent?.model, { provider: "faux", modelId: "faux-2" });
    // The first message had nothing before it: the fork is a new session that runs like the original.
    assert.equal(agent?.cwd, (await app.agentState(id))?.cwd);
    assert.equal(
        (await app.harness.snapshot(PlanDoc, fork, context))?.on,
        true,
        "in plan mode, as the original is",
    );
    assert.equal((await app.harness.snapshot(NotesDoc, fork, context))?.text, "keep it short");
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
    await assert.rejects(app.commands.fork(id, owner(app), { entryId: 999_999 }), { status: 404 });
    await assert.rejects(app.commands.fork(id, owner(app), { entryId: "x" }), { status: 400 });
    const [question] = await ofKind(id, "pi.user");

    await assert.rejects(app.commands.fork(id, owner(app), { entryId: Number(question!.id) }), {
        status: 400,
        message: /finished replies/,
    });
    await say(app, id, "list the files");
    const calling = (await ofKind(id, "pi.assistant")).find((entry) =>
        JSON.stringify(entry.model).includes('"toolUse"'),
    )!;

    await assert.rejects(
        app.commands.fork(id, owner(app), { entryId: Number(calling.id) }),
        { status: 400 },
        "its tool calls would have no results",
    );
    await assert.rejects(
        app.commands.resend(id, owner(app), { entryId: Number(answer!.id) }),
        { status: 404 },
        "only messages to Pi are sent again",
    );
    const forked = await app.commands.fork(id, guest("Gus"), { entryId: Number(answer!.id) });

    assert.ok(forked.id);
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
    const chat = (await app.harness.snapshot(ChatDoc, id, context))!.messages.map(
        (message) => message.text,
    );

    assert.ok(chat.includes("started a new context with a handoff note"));
    await assert.rejects(app.commands.reset(id, owner(app), "x".repeat(20_001)), { status: 413 });
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
    const chat = (await app.harness.snapshot(ChatDoc, id, context))!.messages.map(
        (message) => message.text,
    );

    assert.deepEqual(chat.slice(-2), [
        "changed the instructions for Pi",
        "cleared the instructions for Pi",
    ]);

    const other = await app.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
    );

    await assert.rejects(
        app.commands.setInstructions(other.id, owner(app), "no"),
        { status: 400 },
        "only sessions",
    );
    await assert.rejects(app.commands.setInstructions(id, owner(app), "x".repeat(8001)), {
        status: 413,
    });
});

test("a session exports as Markdown with its whole history, inherited messages included", async () => {
    const id = await newSession(app);

    await app.commands.updateSession(id, owner(app), { title: "Export me!" });
    await say(app, id, "the first word");
    await app.commands.reset(id, owner(app), undefined);
    await say(app, id, "after the reset");
    const [, answer] = await ofKind(id, "pi.assistant");
    const { id: fork } = await app.commands.fork(id, owner(app), { entryId: Number(answer!.id) });
    const { filename, markdown } = await app.exportMarkdown(fork, owner(app));

    assert.equal(filename, "export-me-fork.md");
    assert.match(markdown, /^# Export me! · fork\n/);
    assert.match(
        markdown,
        new RegExp(
            `\\*\\*${owner(app).name}\\*\\*\\n\\nthe first word[\\s\\S]*_New context\\._[\\s\\S]*after the reset`,
        ),
    );
    const viewer = app.config.addUser("Scoped viewer", "viewer", [String(id)]).user;

    await assert.rejects(app.exportMarkdown(fork, viewer), { status: 404 });
});

test("a new title and spend limit reach the people looking at the session at once", async () => {
    const id = await newSession(app);
    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);

    try {
        const conversation = () =>
            tab.events.findLast((each) => each.event === "view")?.data.conversation as
                { title?: string; spend?: { budget?: number } } | undefined;

        await app.commands.updateSession(id, owner(app), { title: "Renamed" });
        await until(() => conversation()?.title === "Renamed", "the new title in the view");
        await app.spend.setSessionBudget(owner(app), id, 3);
        await until(() => conversation()?.spend?.budget === 3, "the limit in the view");
    } finally {
        app.detach(tab.client);
    }
});
