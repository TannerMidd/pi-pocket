// Peek tiles: a tab's short live view of other sessions, sent only while they are on its screen.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";

/** Asked to read the notes, Pi reads notes.txt; anything else is echoed. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.includes("read the notes")) {
        return fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], {
            stopReason: "toolUse",
        });
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("read them")]);
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

type Peek = {
    conversationId: number;
    busy: boolean;
    lines: Record<string, unknown>[];
    approvals: { id: string; subject: string }[];
};

const peeks = (tab: ReturnType<typeof fakeTab>) =>
    tab.events.filter((each) => each.event === "peek").map((each) => each.data as Peek);

test("a tab gets peek tiles for the sessions on its screen, and stays out of their people", async () => {
    const open = await newSession(app);
    const other = await newSession(app);

    await say(app, other, "hello there");
    const there = fakeTab(other, owner(app));
    const tab = fakeTab(open, owner(app));

    try {
        await app.attach(there.client);
        await app.attach(tab.client);
        app.setPeeks(owner(app), tab.client.id, [other]);
        await until(() => peeks(tab).length > 0, "the first peek");
        const first = peeks(tab)[0]!;

        assert.equal(first.conversationId, Number(other));
        assert.equal(first.busy, false);
        assert.deepEqual(first.lines, [
            { kind: "user", text: "hello there" },
            { kind: "text", text: "echo: hello there" },
        ]);
        // Peeking is not being there: the session's people and tab count leave the tab out.
        const room = await app.room(other);

        assert.equal(room.clients.size, 1);
        assert.deepEqual(
            room.presence().people.map((person) => person.tabs),
            [1],
        );

        // New work shows on the tile.
        writeFileSync(join(work, "notes.txt"), "remember the milk");
        await say(app, other, "read the notes");
        await until(
            () => peeks(tab).at(-1)?.lines.at(-1)?.text === "read them",
            "the tile to show the answer",
        );
        assert.deepEqual(peeks(tab).at(-1)!.lines.slice(-3), [
            { kind: "user", text: "read the notes" },
            { kind: "tool", name: "read", args: { path: "notes.txt" }, status: "done" },
            { kind: "text", text: "read them" },
        ]);

        // Scrolled away: nothing more is sent, and the session's view no longer counts the tab.
        app.setPeeks(owner(app), tab.client.id, []);
        await until(() => room.peekers.size === 0, "the tile to be dropped");
        const sent = peeks(tab).length;

        await say(app, other, "and again");
        await new Promise((resolve) => setTimeout(resolve, 1300));
        assert.equal(peeks(tab).length, sent);
    } finally {
        app.detach(there.client);
        app.detach(tab.client);
    }
});

test("peeks leave out sessions the person may not see, and end with the tab or the access", async () => {
    const mine = await newSession(app);
    const theirs = await newSession(app);
    const sam = app.config.addUser("Sam", "guest", [String(mine)]).user;
    const tab = fakeTab(undefined, sam);

    try {
        await app.attach(tab.client);
        app.setPeeks(sam, tab.client.id, [theirs, mine, 99_999 as unknown as ConversationId]);
        assert.deepEqual([...(tab.client.peeks ?? [])], [mine]);
        await until(() => peeks(tab).length > 0, "Sam's peek");
        assert.ok(peeks(tab).every((peek) => peek.conversationId === Number(mine)));
        const room = await app.room(mine);

        // Narrowed to another session, the tile stops.
        app.setAccess(owner(app), sam.id, { sessions: [String(theirs)] });
        assert.equal(tab.client.peeks?.has(mine), false);
        await until(() => room.peekers.size === 0, "the tile to end with the access");

        // A tab that goes takes its tiles with it.
        app.setPeeks(sam, tab.client.id, [theirs]);
        const theirRoom = await app.room(theirs);

        await until(() => theirRoom.peekers.size === 1, "the new tile");
        app.detach(tab.client);
        assert.equal(tab.client.peeks, undefined);
        await until(() => theirRoom.peekers.size === 0, "the tile to end with the tab");
    } finally {
        app.detach(tab.client);
        app.config.removeUser(sam.id);
    }
});

test("a call waiting for approval shows on its session's tile, and goes when answered", async () => {
    const id = await newSession(app);
    const tab = fakeTab(undefined, owner(app));

    try {
        await app.attach(tab.client);
        app.setPeeks(owner(app), tab.client.id, [id]);
        await until(() => peeks(tab).length > 0, "the tile");
        const asked = app.approvals.request(
            {
                id: "call-1",
                conversationId: id,
                taskId: 1 as unknown as TaskId,
                tool: "bash",
                subject: "git push",
                reason: "pushes to a remote",
                createdAt: Date.now(),
            },
            context,
        );

        await until(() => peeks(tab).at(-1)?.approvals.length === 1, "the approval on the tile");
        assert.equal(peeks(tab).at(-1)!.approvals[0]!.subject, "git push");
        app.approvals.answer("call-1", { allow: false, by: "test" });
        await asked;
        await until(() => peeks(tab).at(-1)?.approvals.length === 0, "the approval to go");
    } finally {
        app.detach(tab.client);
    }
});

test("the session list says when a session's last run ended", async () => {
    const id = await newSession(app);
    const started = Date.now();

    await say(app, id, "hi");
    await until(
        () => (app.sessions().find((each) => each.id === Number(id))?.endedAt ?? 0) >= started,
        "the end of the run",
    );
});
