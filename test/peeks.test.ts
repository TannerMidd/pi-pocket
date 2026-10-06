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
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { MAX_PEEKS } from "../src/server/app.ts";
import { SubagentsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import type { PeekSummary } from "../src/server/room.ts";

/**
 * Asked to read the notes, Pi reads notes.txt. "work slowly" runs three short sleeps, one after another. "start a
 * helper" starts a subagent that sleeps a while. Anything else is echoed.
 */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxText(`calling ${name}`), fauxToolCall(name, args)], {
            stopReason: "toolUse",
        });
    const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
    const asked = messages.findLast((message) => message.role === "user");
    const askedText = JSON.stringify(asked?.content ?? "");

    if (role === "user" && text.includes("read the notes")) {
        return call("read", { path: "notes.txt" });
    }

    if (role === "user" && text.endsWith("start a helper")) {
        return call("subagent", { action: "spawn", name: "helper", message: "look around" });
    }

    if (role === "user" && text === "look around") {
        return call("bash", { command: "sleep 3" });
    }

    if (askedText.includes("work slowly")) {
        const done = messages
            .slice(messages.indexOf(asked!))
            .filter((m) => m.role === "toolResult");

        return done.length < 3
            ? call("bash", { command: `sleep 0.8 && echo step ${done.length + 1}` })
            : fauxAssistantMessage([fauxText("all three steps done")]);
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("read them")]);
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
let server: Server;
let base = "";

before(async () => {
    const model = scriptedModel(route);

    model.setResponses(Array.from({ length: 1000 }, () => route));
    app = await openApp(model);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const peeks = (tab: ReturnType<typeof fakeTab>, id?: ConversationId) =>
    tab.events
        .filter((each) => each.event === "peek")
        .map((each) => each.data as unknown as PeekSummary)
        .filter((peek) => id === undefined || peek.conversationId === id);

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The words of a tile's line, for the kinds that have them. */
const words = (line: PeekSummary["lines"][number] | undefined) =>
    line !== undefined && "text" in line ? line.text : undefined;

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

        assert.equal(first.conversationId, other);
        assert.equal(first.busy, false);
        assert.deepEqual(first.lines, [
            { kind: "user", text: "hello there" },
            { kind: "text", text: "echo: hello there" },
        ]);
        assert.deepEqual(first.approvals, []);
        // Peeking is not being there: the session's people and tab count leave the tab out.
        const room = await app.room(other);

        assert.equal(room.clients.size, 1);
        assert.deepEqual(
            room.presence().people.map((person) => person.tabs),
            [1],
        );
        assert.equal(
            there.events.filter((each) => each.event === "peek").length,
            0,
            "a tab that is there gets the view, not peeks",
        );

        // New work shows on the tile.
        writeFileSync(join(work, "notes.txt"), "remember the milk");
        await say(app, other, "read the notes");
        await until(
            () => words(peeks(tab).at(-1)?.lines.at(-1)) === "read them",
            "the tile to show the answer",
        );
        assert.deepEqual(peeks(tab).at(-1)!.lines.slice(-4), [
            { kind: "user", text: "read the notes" },
            { kind: "text", text: "calling read" },
            { kind: "tool", name: "read", args: { path: "notes.txt" }, status: "done" },
            { kind: "text", text: "read them" },
        ]);

        // Scrolled away: nothing more is sent, and the session's view no longer counts the tab.
        app.setPeeks(owner(app), tab.client.id, []);
        await until(() => room.peekers.size === 0, "the tile to be dropped");
        const sent = peeks(tab).length;

        await say(app, other, "and again");
        await settle(1300);
        assert.equal(peeks(tab).length, sent);
        assert.equal(room.clients.size, 1, "the tab that is there stays");
    } finally {
        app.detach(there.client);
        app.detach(tab.client);
    }
});

test("a running session's tile changes at most once a second, never twice the same, and says it is busy", async () => {
    const id = await newSession(app);
    const tab = fakeTab(undefined, owner(app));
    const times: number[] = [];
    const send = tab.client.send;

    tab.client.send = (event, data) => {
        if (event === "peek") {
            times.push(Date.now());
        }

        send(event, data);
    };

    try {
        await app.attach(tab.client);
        app.setPeeks(owner(app), tab.client.id, [id]);
        await until(() => peeks(tab, id).length > 0, "the first peek");
        await say(app, id, "work slowly");
        await until(
            () => words(peeks(tab, id).at(-1)?.lines.at(-1)) === "all three steps done",
            "the tile to show the end",
        );
        const list = peeks(tab, id);

        assert.ok(
            list.some((peek) => peek.busy),
            "a tile said Pi was working",
        );
        assert.equal(list.at(-1)!.busy, false);
        assert.ok(
            list.some((peek) =>
                peek.lines.some((line) => line.kind === "tool" && line.status === "running"),
            ),
            "a tile showed a call running",
        );

        // The first is sent at once; later ones wait for the second to pass.
        for (let index = 2; index < times.length; index++) {
            assert.ok(
                times[index]! - times[index - 1]! >= 900,
                `peeks ${index - 1} and ${index} came ${times[index]! - times[index - 1]!} ms apart`,
            );
        }

        const json = list.map((peek) => JSON.stringify(peek));

        for (let index = 1; index < json.length; index++) {
            assert.notEqual(json[index], json[index - 1], `peek ${index} repeats the one before`);
        }
    } finally {
        app.detach(tab.client);
    }
});

test("a tile scrolled away while its view opens is never sent, and a tab gone mid-open leaves nothing behind", async () => {
    const first = await newSession(app);
    const second = await newSession(app);
    const tab = fakeTab(undefined, owner(app));

    try {
        await app.attach(tab.client);
        // In and out again at once: the view opens, but the tile is not there any more.
        app.setPeeks(owner(app), tab.client.id, [first]);
        app.setPeeks(owner(app), tab.client.id, []);
        await settle(300);
        assert.equal(peeks(tab, first).length, 0);
        assert.equal((await app.openRoom(first))?.peekers.size ?? 0, 0);

        // The tab goes while the view opens.
        app.setPeeks(owner(app), tab.client.id, [second]);
        app.detach(tab.client);
        await settle(300);
        assert.equal(peeks(tab, second).length, 0);
        assert.equal((await app.openRoom(second))?.peekers.size ?? 0, 0);
        assert.equal(tab.client.peeks, undefined);

        // Peeking from a tab the server does not know changes nothing.
        app.setPeeks(owner(app), "no-such-tab", [first]);
        await settle(100);
        assert.equal((await app.openRoom(first))?.peekers.size ?? 0, 0);
    } finally {
        app.detach(tab.client);
    }
});

test(`a tab gets at most ${MAX_PEEKS} live tiles, each once`, async () => {
    const ids: ConversationId[] = [];

    for (let index = 0; index < MAX_PEEKS + 3; index++) {
        ids.push(await newSession(app));
    }

    const tab = fakeTab(undefined, owner(app));

    try {
        await app.attach(tab.client);
        app.setPeeks(owner(app), tab.client.id, [...ids, ids[0]!, ids[1]!]);
        assert.equal(tab.client.peeks?.size, MAX_PEEKS);
        await until(
            () => new Set(peeks(tab).map((peek) => peek.conversationId)).size === MAX_PEEKS,
            "every tile",
        );
        await settle(200);
        assert.equal(peeks(tab).length, MAX_PEEKS, "one peek each");
        assert.deepEqual(
            new Set(peeks(tab).map((peek) => peek.conversationId)),
            new Set(ids.slice(0, MAX_PEEKS)),
        );
    } finally {
        app.detach(tab.client);
    }
});

test("an old and a new connection of one tab both follow its list, and the old one leaving keeps the new one's tiles", async () => {
    const id = await newSession(app);
    const old = fakeTab(undefined, owner(app));
    const fresh = fakeTab(undefined, owner(app));

    fresh.client = { ...fresh.client, id: old.client.id, sentEntries: new Set() };
    fresh.client.send = (event, data) =>
        fresh.events.push({ event, data: data as Record<string, unknown> });

    try {
        await app.attach(old.client);
        await app.attach(fresh.client);
        app.setPeeks(owner(app), old.client.id, [id]);
        await until(
            () => peeks(old, id).length > 0 && peeks(fresh, id).length > 0,
            "both connections to get the tile",
        );
        const room = await app.room(id);

        assert.equal(room.peekers.size, 2);
        app.detach(old.client);
        await until(() => room.peekers.size === 1, "the old connection to let go");
        assert.ok(room.peekers.has(fresh.client));
        await say(app, id, "still there?");
        await until(
            () => words(peeks(fresh, id).at(-1)?.lines.at(-1)) === "echo: still there?",
            "the new connection to keep getting the tile",
        );
    } finally {
        app.detach(old.client);
        app.detach(fresh.client);
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
        await settle(200);
        assert.ok(peeks(tab).every((peek) => peek.conversationId === mine));
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
                subject: `git push ${"x".repeat(900)}`,
                reason: "pushes to a remote",
                createdAt: Date.now(),
            },
            context,
        );

        await until(() => peeks(tab).at(-1)?.approvals.length === 1, "the approval on the tile");
        const shown = peeks(tab).at(-1)!.approvals[0]!;

        assert.equal(shown.id, "call-1");
        assert.equal(shown.conversationId, id);
        assert.equal(shown.tool, "bash");
        assert.equal(shown.subject.length, 500, "a long command is cut short");
        assert.ok(!("taskId" in shown), "only what the tile shows");
        assert.equal(await app.answerApproval("call-1", true, owner(app)), true);
        assert.deepEqual(await asked, { allow: true, by: owner(app).name });
        await until(() => peeks(tab).at(-1)?.approvals.length === 0, "the approval to go");
    } finally {
        app.detach(tab.client);
    }
});

test("a subagent's waiting call shows on its session's tile", async () => {
    const id = await newSession(app);
    const tab = fakeTab(undefined, owner(app));

    try {
        await say(app, id, "please start a helper");
        const helper = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!
            .conversationId;

        await app.attach(tab.client);
        app.setPeeks(owner(app), tab.client.id, [id]);
        await until(() => peeks(tab, id).length > 0, "the tile");
        const asked = app.approvals.request(
            {
                id: "helper-call",
                conversationId: helper,
                taskId: 2 as unknown as TaskId,
                tool: "bash",
                subject: "rm -rf build",
                reason: "deletes files",
                createdAt: Date.now(),
            },
            context,
        );

        await until(
            () => peeks(tab, id).at(-1)?.approvals[0]?.conversationId === helper,
            "the helper's call on its session's tile",
        );
        app.approvals.answer("helper-call", { allow: false, by: "test" });
        await asked;
        await until(() => peeks(tab, id).at(-1)?.approvals.length === 0, "the call to go");
    } finally {
        app.detach(tab.client);
    }
});

test("the session list says when a session's last run ended", async () => {
    const id = await newSession(app);
    const started = Date.now();

    assert.equal(
        app.sessions().find((each) => each.id === Number(id))?.endedAt,
        undefined,
        "not before it ran",
    );
    await say(app, id, "hi");
    await until(
        () => (app.sessions().find((each) => each.id === Number(id))?.endedAt ?? 0) >= started,
        "the end of the run",
    );
});

// ─── Over HTTP ──────────────────────────────────────────────────────────────

const headers = (token = app.config.ownerToken) => ({
    authorization: `Bearer ${token}`,
    "x-pocket": "1",
    "content-type": "application/json",
});

const postPeeks = (body: unknown, init: { headers?: Record<string, string> } = {}) =>
    fetch(`${base}/api/peeks`, {
        method: "POST",
        headers: init.headers ?? headers(),
        body: JSON.stringify(body),
    });

/** An event stream as a browser opens it, collecting its events until closed. */
function openStream(query: string) {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const stop = new AbortController();
    const done = (async () => {
        const response = await fetch(`${base}/api/events?${query}`, {
            headers: headers(),
            signal: stop.signal,
        });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
            const { value, done: ended } = await reader.read();

            if (ended) {
                return;
            }

            buffer += decoder.decode(value, { stream: true });
            let end = buffer.indexOf("\n\n");

            while (end >= 0) {
                const block = buffer.slice(0, end);

                buffer = buffer.slice(end + 2);
                end = buffer.indexOf("\n\n");
                const event = /^event: (.*)$/m.exec(block)?.[1];
                const data = /^data: (.*)$/m.exec(block)?.[1];

                if (event !== undefined && data !== undefined) {
                    events.push({ event, data: JSON.parse(data) });
                }
            }
        }
    })().catch(() => {});

    return {
        events,
        close: async () => {
            stop.abort();
            await done;
        },
    };
}

test("the peeks route checks who asks and what, and the event stream carries the tiles", async () => {
    const open = await newSession(app);
    const other = await newSession(app);

    await say(app, other, "over the wire");

    assert.equal((await postPeeks({ tab: "t", ids: [] }, { headers: {} })).status, 401);
    assert.equal(
        (
            await postPeeks(
                { tab: "t", ids: [] },
                { headers: { authorization: headers().authorization } },
            )
        ).status,
        403,
        "a post needs the X-Pocket header",
    );
    assert.equal((await postPeeks({ tab: "t", ids: "1,2" })).status, 400);
    assert.equal((await postPeeks({ tab: "t", ids: ["two"] })).status, 400);
    assert.equal((await postPeeks({ tab: "t", ids: [-1] })).status, 400);
    assert.equal((await postPeeks({ tab: "t" })).status, 400);

    const stream = openStream(`tab=wire-tab&c=${open}`);

    try {
        await until(() => stream.events.some((each) => each.event === "hello"), "hello");
        assert.equal(
            (
                stream.events.find((each) => each.event === "hello")!.data.server as {
                    peeks?: boolean;
                }
            ).peeks,
            true,
            "the server says it sends peeks",
        );
        const response = await postPeeks({ tab: "wire-tab", ids: [Number(other)] });

        assert.equal(response.status, 200);
        await until(
            () =>
                stream.events.some(
                    (each) => each.event === "peek" && each.data.conversationId === Number(other),
                ),
            "the peek over the stream",
        );
        const room = await app.room(other);

        assert.equal(room.peekers.size, 1);
        await stream.close();
        await until(() => room.peekers.size === 0, "the tile to end with the stream");
    } finally {
        await stream.close();
    }
});

test("long polling carries the tiles too", async () => {
    const other = await newSession(app);

    await say(app, other, "by polling");
    type Poll = { session: string; events: { seq: number; event: string; data: PeekSummary }[] };
    const poll = async (query: string): Promise<Poll> =>
        (await (await fetch(`${base}/api/poll?${query}`, { headers: headers() })).json()) as Poll;
    const first = await poll("tab=poll-tab");

    try {
        assert.equal((await postPeeks({ tab: "poll-tab", ids: [Number(other)] })).status, 200);
        const last = first.events.at(-1)?.seq ?? 0;
        let found: PeekSummary | undefined;

        await until(async () => {
            const next = await poll(`tab=poll-tab&session=${first.session}&ack=${last}`);

            found = next.events.find((each) => each.event === "peek")?.data;

            return found !== undefined;
        }, "a peek by polling");
        assert.equal(found!.conversationId, other);
        assert.deepEqual(found!.lines.at(-1), { kind: "text", text: "echo: by polling" });
    } finally {
        await fetch(`${base}/api/poll?session=${first.session}&close=1`, { headers: headers() });
    }
});
