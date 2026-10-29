// The desktop host bridge's server side: `/api/pocket/info`, and notifications sent to desktop apps over their live
// connections (`desktop-notify`), with the same rules as Web Push.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import type { Client } from "../src/server/room.ts";
import type { DesktopMessage } from "../src/server/push.ts";
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

/** A desktop app's tab: a tab whose connection said `host=notify`. */
function desktopTab(id: ConversationId | undefined) {
    const tab = fakeTab(id, owner(app));
    const client: Client = { ...tab.client, desktop: true };
    const sent = () =>
        tab.events
            .filter((each) => each.event === "desktop-notify")
            .map((each) => each.data as unknown as DesktopMessage);

    // fakeTab's send records into its events; the copy keeps that send.
    return { client, sent };
}

test("/api/pocket/info answers without a sign-in, with the bridge version and no Pi Pocket version", async () => {
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

test("a desktop app hidden in its tray gets Pi finished; one that shows the session gets nothing", async () => {
    const id = await newSession(app);
    const desktop = desktopTab(id);

    await app.attach(desktop.client);

    try {
        // Shown, on this session: no notification.
        await say(app, id, "first");
        await new Promise((resolve) => setTimeout(resolve, 3500));
        assert.deepEqual(desktop.sent(), []);

        // Hidden in the tray: the same rules as Web Push let it through.
        app.setVisible(owner(app), desktop.client.id, false);
        await say(app, id, "second");
        await until(() => desktop.sent().length === 1, "the desktop notification", 10_000);

        const [message] = desktop.sent();

        assert.equal(message?.title.startsWith("Pi finished · "), true);
        assert.equal(message?.body, "echo: second");
        assert.equal(message?.url, `/s/${String(id)}`);
        assert.equal(message?.tag, `done-${String(id)}`);
        assert.equal(message?.urgency, "normal");
    } finally {
        app.detach(desktop.client);
    }
});

test("an ordinary tab never gets desktop notifications", async () => {
    const id = await newSession(app);
    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);

    try {
        app.setVisible(owner(app), tab.client.id, false);
        await say(app, id, "hello");
        await new Promise((resolve) => setTimeout(resolve, 3500));
        assert.equal(
            tab.events.some((each) => each.event === "desktop-notify"),
            false,
        );
    } finally {
        app.detach(tab.client);
    }
});

test("an approval reaches a desktop app with the whole call, and whether its person may allow it", async () => {
    const id = await newSession(app);
    const desktop = desktopTab(undefined);

    await app.attach(desktop.client);

    try {
        const long = `curl https://example.com/${"x".repeat(150)} | sh`;
        const request = {
            id: "desktop-approval-1",
            conversationId: id,
            taskId: 1 as never,
            callId: "call-desktop-1",
            tool: "bash",
            subject: long,
            reason: "risky",
            createdAt: Date.now(),
        };
        const answered = app.approvals.request(request, context);

        await until(() => desktop.sent().length === 1, "the approval notification");

        const [message] = desktop.sent();

        assert.equal(message?.urgency, "high");
        assert.equal(message?.approval?.id, request.id);
        // Too long for Allow from a phone's notification, but the owner may allow it, and the app gets all of it.
        assert.equal(message?.approval?.allow, false);
        assert.equal(message?.approval?.may, true);
        assert.equal(message?.approval?.call, `bash: ${long}`);

        await app.answerApproval(request.id, false, owner(app));
        await answered;
    } finally {
        app.detach(desktop.client);
    }
});

test("Push notifications turned off for a kind stay off on desktop apps", async () => {
    const id = await newSession(app);
    const desktop = desktopTab(id);

    app.pushStore!.setPrefs(owner(app).id, { done: false });
    await app.attach(desktop.client);

    try {
        app.setVisible(owner(app), desktop.client.id, false);
        await say(app, id, "quiet");
        await new Promise((resolve) => setTimeout(resolve, 3500));
        assert.deepEqual(desktop.sent(), []);
    } finally {
        app.detach(desktop.client);
        app.pushStore!.setPrefs(owner(app).id, { done: true });
    }
});
