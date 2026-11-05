// The documentation's example extensions work as drop-ins.
import {
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
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { AuthorsDoc } from "../src/server/docs.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const DOCS = fileURLToPath(new URL("../docs/", import.meta.url));
const EXAMPLES = join(DOCS, "examples");
/** Sits in the middle of a note the live view clips. The model must still read it. */
const NOTE_MARKER = "model-reads-the-middle";
const NOTE_BODY = `${"a".repeat(4500)}${NOTE_MARKER}${"b".repeat(4500)}`;

/** The system prompt of the newest request, and its sections by name. */
let prompt = "";
let sections: Record<string, string> = {};

/** Holds a turn open while it is set: what is sent then waits in the queue. */
let hold: Promise<void> | undefined;

const route: FauxResponseStep = async (context) => {
    const { role, text } = lastText(context as never);

    // The system prompt reaches the model as system messages, each with the sections that changed since the last.
    sections = Object.assign(
        {},
        ...(context.messages as { role: string; sections?: Record<string, string> }[])
            .filter((message) => message.role === "system")
            .map((message) => message.sections ?? {}),
    ) as Record<string, string>;

    prompt = Object.values(sections).join("\n");
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.includes("what time")) {
        return call("clock", { zone: "UTC" });
    }

    if (text.includes("force push")) {
        return call("bash", { command: "git push --force origin main" });
    }

    if (text.includes("count the words")) {
        return call("my_word_count", { text: "one two  three" });
    }

    if (text.includes("read the local page")) {
        return call("read_page", { url: "http://localhost:9999/admin" });
    }

    if (text.includes("plain push")) {
        return call("bash", { command: "echo git push origin main" });
    }

    if (text.includes("hold the turn")) {
        await hold;
    }

    if (text.includes("leave a quiet note")) {
        return call("quiet_note", { text: NOTE_BODY, summary: "saved a long note" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: Awaited<ReturnType<typeof openApp>>;

before(async () => {
    // The examples, copied in as the owner would: into the data folder's extensions/, before the server starts.
    const data = join(root, "docs-data");
    const dropIns = join(data, "extensions");

    mkdirSync(dropIns, { recursive: true });

    // The modules, and the browser module beside one of them.
    for (const file of readdirSync(EXAMPLES).filter((each) => /\.(ts|js)$/.test(each))) {
        copyFileSync(join(EXAMPLES, file), join(dropIns, file));
    }

    app = await openApp(scriptedModel(route), data);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** What Pi's last answer in a session says. */
const answer = async (id: Parameters<typeof say>[1]) => (await modelTexts(app, id)).at(-1) ?? "";

test("the example extensions load as drop-ins, off until the owner turns them on, and work", async () => {
    const listed = (await app.extensions(owner(app))).modules.filter(
        (module) => module.source === "drop-in",
    );

    assert.deepEqual(
        listed.map((module) => [module.file, module.enabled]),
        [
            ["clock.ts", false],
            ["my-words.ts", false],
            ["no-force-push.ts", false],
            ["quiet-note.ts", false],
            ["read-page.ts", false],
            ["server-status.ts", false],
        ],
    );

    for (const file of [
        "clock.ts",
        "my-words.ts",
        "no-force-push.ts",
        "quiet-note.ts",
        "read-page.ts",
        "server-status.ts",
    ]) {
        await app.setExtensionEnabled(owner(app), file, true);
    }

    const id = await newSession(app);

    await say(app, id, "what time is it in UTC?");
    assert.match(await answer(id), /tool said: .*\d{4}.*\(UTC\)/);
    assert.match(prompt, /Do not force-push with git/);

    // The tutorial's module (docs/extensions/first-extension.md).
    await say(app, id, "count the words");
    assert.match(await answer(id), /tool said: 3 words/);

    await say(app, id, "force push it");
    assert.match(await answer(id), /Force-pushing is turned off here/);

    // host.fetchPublic refuses a name that resolves to this machine, before it connects.
    await say(app, id, "read the local page");
    assert.match(await answer(id), /tool said: The page could not be read: .*not a public address/);

    await say(app, id, "now a plain push");
    assert.match(await answer(id), /tool said: git push origin main/);

    // Server status adds to the app, not to Pi: a route, and a browser module for the owner's tabs.
    const status = app.webs.match("server-status", "GET", ["status"], owner(app));

    assert.ok(status !== undefined && "route" in status, "its route is there");
    const reading = (await status.route.handle({} as never)) as { cpus: number; load: number[] };

    assert.ok(reading.cpus > 0 && reading.load.length === 3);
    const client = app.webs.clients(owner(app)).find((each) => each.module === "server-status");

    assert.ok(client !== undefined, "its browser module is there");

    // The live row clips a long note. The model still reads every character, including past that clip.
    await say(app, id, "leave a quiet note");
    const whole = `NOTE ${NOTE_BODY}`;

    await until(
        async () => (await modelTexts(app, id)).some((text) => text.includes(whole)),
        "the model reads the whole note",
    );
    const shown = (await app.transcripts.history(id, Number.MAX_SAFE_INTEGER)).find(
        (entry) => entry.kind === "user" && entry.presentation?.entryKind === "x.quiet-note.note",
    );

    assert.equal(shown?.kind, "user");

    if (shown?.kind !== "user") {
        return;
    }

    assert.equal(shown.presentation?.label, "Note");
    assert.equal(shown.presentation?.summary, "saved a long note");
    assert.ok(shown.text.length < whole.length);
    assert.equal(shown.presentation?.clipped, whole.length);
    assert.equal(shown.text.includes(NOTE_MARKER), false);

    // `pocket.messages` reads the people's messages: a note stored as the module's kind is not one.
    const room = await app.room(id);

    try {
        const page = room.userMessages(undefined, 200);

        assert.ok(page !== null);
        assert.ok(
            page.messages.some(
                (each) => each.kind === "user" && each.text === "leave a quiet note",
            ),
        );
        assert.equal(
            page.messages.some((each) => each.id === shown.id),
            false,
            "the note stays out",
        );
    } finally {
        app.releaseRoom(room);
    }

    // It cannot be sent again: it is not a message a person sent to Pi.
    await assert.rejects(
        app.commands.resend(id, owner(app), { entryId: shown.id }),
        /No such message to Pi/,
    );

    // A tab that is open as the module goes off, and comes back on, gets the row each time it shows differently.
    const tab = fakeTab(id, owner(app), 5);
    const newest = (entryId: number) =>
        tab.events
            .filter((each) => each.event === "view")
            .flatMap((each) => each.data.entries as { id: number; kind: string; partial?: true }[])
            .findLast((each) => each.id === entryId && each.partial !== true);

    await app.attach(tab.client);

    try {
        await until(
            async () => newest(shown.id)?.kind === "user",
            "the tab has the presented note",
        );
        await app.setExtensionEnabled(owner(app), "quiet-note.ts", false);
        await until(
            async () => newest(shown.id)?.kind === "other",
            "the tab hears it is not presented",
        );
        await app.setExtensionEnabled(owner(app), "quiet-note.ts", true);
        await until(
            async () => newest(shown.id)?.kind === "user",
            "the tab hears it is presented again",
        );

        // A message nobody wrote that starts with the prefix is presented. Once its author is known, it is theirs, and
        // the open tab gets it as their message.
        const conversation = (await app.harness.conversation(id, context))!;
        const submission = await conversation.submit(
            { type: "input", content: "NOTE from nobody yet", requestId: crypto.randomUUID() },
            context,
        );

        await submission.wait(context);
        const sentEntry = (await app.transcripts.history(id, Number.MAX_SAFE_INTEGER)).find(
            (each) => each.kind === "user" && each.text === "NOTE from nobody yet",
        );

        assert.ok(sentEntry !== undefined, "the message is in the session");
        const sentId = sentEntry.id;
        const presentedFor = (entryId: number) =>
            (newest(entryId) as { presentation?: { prefixed?: true } } | undefined)?.presentation;

        await until(async () => presentedFor(sentId)?.prefixed === true, "the tab presents it");
        await app.harness.commit(async (tx) => {
            (await tx.doc(AuthorsDoc, id)).entries[String(sentId)] = owner(app).id;
        }, context);
        await until(
            async () => newest(sentId) !== undefined && presentedFor(sentId) === undefined,
            "the tab hears it is the owner's message",
        );

        // An input waiting in the queue, and a module that only presents (no browser module, no commands, no
        // committed row of its kind): the open tab's queue still follows it going on and off.
        let release = () => {};

        hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        const turn = await app.commands.submit(id, owner(app), {
            text: "hold the turn",
            requestId: crypto.randomUUID(),
        });

        await until(async () => app.isBusy(id), "the turn is running");
        await conversation.submit(
            {
                type: "input",
                content: "a ping that waits in the queue",
                whenBusy: "followUp",
                requestId: crypto.randomUUID(),
                entry: { kind: "x.queue-only.ping", data: { summary: "queued ping" } },
            },
            context,
        );
        const queued = () =>
            (tab.field("inbox") as { label?: string; text?: string }[] | undefined)?.find(
                (each) => each.label === "Ping" || each.text === "a ping that waits in the queue",
            );

        try {
            await until(async () => queued()?.text !== undefined, "the queue shows the body");
            const staged = app.webs.stage("queue-only.ts", root, "Queue only");

            staged.web.presentEntry({ kind: "x.queue-only.ping", label: "Ping" });
            app.webs.commit(staged.part);
            await until(async () => queued()?.label === "Ping", "the queue shows the label");
            app.webs.remove("queue-only.ts");
            await until(
                async () => queued()?.text !== undefined,
                "the queue shows the body once the module is off",
            );
        } finally {
            release();
            hold = undefined;
            await (await app.harness.submission(turn.submissionId, context))!.wait(context);
        }
    } finally {
        app.detach(tab.client);
    }
});
