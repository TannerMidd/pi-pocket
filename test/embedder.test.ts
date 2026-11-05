// The app bridge's server side: `/api/pocket/info`, and notifications sent to embedders
// over their live connections (`embedder-notify`), with the same rules as Web Push.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import type { Client } from "../src/server/room.ts";
import type { EmbedderMessage } from "../src/server/push.ts";
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const model = scriptedModel();

let app: App;

before(async () => {
    app = await openApp(model);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** An embedder's tab: a tab whose connection said `embedder=notify`. */
function embedderTab(id: ConversationId | undefined, user = owner(app)) {
    const tab = fakeTab(id, user);
    const client: Client = { ...tab.client, embedder: "embedder-notify" };
    const sent = () =>
        tab.events
            .filter((each) => each.event === "embedder-notify")
            .map((each) => each.data as unknown as EmbedderMessage);

    // fakeTab's send records into its events; the copy keeps that send.
    return { client, sent };
}

test("/api/pocket/info answers without a sign-in, with the app bridge version and no Pi Pocket version", async () => {
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
        const port = (server.address() as { port: number }).port;
        const response = await fetch(`http://127.0.0.1:${port}/api/pocket/info`);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { name: "pi-pocket", bridge: 1 });

        // Everything else under /api still needs a sign-in.
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 401);
    } finally {
        server.close();
    }
});

test("a page from before 0.28.0-beta.7 (`host=notify`), open across an update, still hears", async () => {
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    const stop = new AbortController();

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
        const port = (server.address() as { port: number }).port;

        void fetch(`http://127.0.0.1:${port}/api/events?tab=old&p=6&host=notify`, {
            headers: { authorization: `Bearer ${app.config.ownerToken}` },
            signal: stop.signal,
        }).catch(() => {});
        await until(
            () => [...app.clients].some((each) => each.embedder === "desktop-notify"),
            "the old page, sent the event it listens for",
        );
    } finally {
        stop.abort();
        server.close();
    }
});

test("an embedder hidden in its tray gets Pi finished; one that shows the session gets nothing", async () => {
    const id = await newSession(app);
    const embedder = embedderTab(id);

    await app.attach(embedder.client);

    try {
        // Shown, on this session: no notification.
        await say(app, id, "first");
        await new Promise((resolve) => setTimeout(resolve, 3500));
        assert.deepEqual(embedder.sent(), []);

        // Hidden in the tray: the same rules as Web Push let it through.
        app.setVisible(owner(app), embedder.client.id, false);
        await say(app, id, "second");
        await until(() => embedder.sent().length === 1, "the embedder notification", 10_000);

        const [message] = embedder.sent();

        assert.equal(message?.title.startsWith("Pi finished · "), true);
        assert.equal(message?.body, "echo: second");
        assert.equal(message?.url, `/s/${String(id)}`);
        assert.equal(message?.tag, `done-${String(id)}`);
        assert.equal(message?.urgency, "normal");
    } finally {
        app.detach(embedder.client);
    }
});

test("an ordinary tab never gets embedder notifications", async () => {
    const id = await newSession(app);
    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);

    try {
        app.setVisible(owner(app), tab.client.id, false);
        await say(app, id, "hello");
        await new Promise((resolve) => setTimeout(resolve, 3500));
        assert.equal(
            tab.events.some((each) => each.event === "embedder-notify"),
            false,
        );
    } finally {
        app.detach(tab.client);
    }
});

test("an approval reaches an embedder with the whole call, and whether its person may allow it", async () => {
    const id = await newSession(app);
    const embedder = embedderTab(undefined);

    await app.attach(embedder.client);

    try {
        const long = `curl https://example.com/${"x".repeat(500)} | sh`;
        const request = {
            id: "embedder-approval-1",
            conversationId: id,
            taskId: 1 as never,
            callId: "call-embedder-1",
            tool: "bash",
            subject: long,
            reason: "risky",
            createdAt: Date.now(),
        };
        const answered = app.approvals.request(request, context);

        await until(() => embedder.sent().length === 1, "the approval notification");

        const [message] = embedder.sent();

        assert.equal(message?.urgency, "high");
        assert.equal(message?.approval?.id, request.id);
        // Too long for Allow from a phone's notification, but the owner may allow it, and the app
        // gets all of it.
        assert.equal(message?.approval?.allow, false);
        assert.equal(message?.approval?.may, true);
        assert.equal(message?.approval?.call, `bash: ${long}`);

        await app.answerApproval(request.id, false, owner(app));
        await answered;
    } finally {
        app.detach(embedder.client);
    }
});

test("another person's embedder gets nothing of a session they cannot see", async () => {
    const id = await newSession(app);
    const mine = embedderTab(id);
    const guest = app.config.addUser("Desk Guest", "guest").user;
    const theirs = embedderTab(undefined, guest);

    for (const each of [mine, theirs]) {
        await app.attach(each.client);
        app.setVisible(each === mine ? owner(app) : guest, each.client.id, false);
    }

    try {
        const request = {
            id: "embedder-approval-2",
            conversationId: id,
            taskId: 1 as never,
            callId: "call-embedder-2",
            tool: "bash",
            subject: "ls",
            reason: "risky",
            createdAt: Date.now(),
        };
        const answered = app.approvals.request(request, context);

        await say(app, id, "private");
        await until(() => mine.sent().length === 2, "the owner's notifications", 10_000);
        assert.deepEqual(theirs.sent(), []);
        await app.answerApproval(request.id, false, owner(app));
        await answered;
    } finally {
        app.detach(mine.client);
        app.detach(theirs.client);
        app.config.removeUser(guest.id);
    }
});

test("Push notifications turned off for a kind stay off on embedders", async () => {
    const id = await newSession(app);
    const embedder = embedderTab(id);

    app.pushStore!.setPrefs(owner(app).id, { done: false });
    await app.attach(embedder.client);

    try {
        app.setVisible(owner(app), embedder.client.id, false);
        await say(app, id, "quiet");
        await new Promise((resolve) => setTimeout(resolve, 3500));
        assert.deepEqual(embedder.sent(), []);
    } finally {
        app.detach(embedder.client);
        app.pushStore!.setPrefs(owner(app).id, { done: true });
    }
});
