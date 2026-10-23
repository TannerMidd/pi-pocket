// Import the helper first: every app, model, and data folder in this regression is isolated from the live server.
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Room } from "../src/server/room.ts";

let app: App;

before(async () => {
    app = await openApp(
        scriptedModel(() => {
            throw new Error("Attachment must not call a model");
        }),
    );
});

after(async () => {
    await app.close();
    cleanUp();
});

/** Hold a fully opened room immediately before attach can join it or send its contents. */
async function waitingAttachment(staleActor = false) {
    const id = await newSession(app);
    const user = app.config.addUser("Waiting attachment", "guest").user;
    const tab = fakeTab(id, staleActor ? structuredClone(user) : user);
    const originalRoom = app.room;
    const originalRelease = app.releaseRoom;
    let room: Room | undefined;
    let releases = 0;
    let release!: () => void;
    let failure: Error | undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    app.room = async function (cid) {
        const opened = await originalRoom.call(app, cid);

        if (cid === id) {
            room = opened;
            await gate;

            if (failure !== undefined) {
                throw failure;
            }
        }

        return opened;
    };

    app.releaseRoom = function (opened) {
        if (opened.id === id) {
            releases++;
        }

        originalRelease.call(app, opened);
    };

    const pending = app.attach(tab.client);

    await until(() => room !== undefined, "attachment's room wait");
    const marker = tab.events.length;

    return {
        id,
        user,
        tab,
        room: room!,
        afterWait: () => tab.events.slice(marker),
        releases: () => releases,
        finish: async (error?: Error) => {
            failure = error;
            release();
            await pending;
        },
        clean: async () => {
            release();
            await pending;
            app.room = originalRoom;
            app.releaseRoom = originalRelease;
            app.detach(tab.client);

            if (room !== undefined) {
                originalRelease.call(app, room);
            }

            app.config.removeUser(user.id);
        },
    };
}

const roomEvents = new Set(["view", "chat", "notes", "browser", "presence"]);

function assertNoRoomEvents(events: { event: string }[]) {
    assert.deepEqual(
        events.filter((entry) => roomEvents.has(entry.event)),
        [],
    );
}

test("access revoked during the room wait never attaches or sends conversation data", async () => {
    const waiting = await waitingAttachment();

    try {
        app.setAccess(owner(app), waiting.user.id, { sessions: [] });
        await waiting.finish();
        assert.equal(app.canSee(waiting.user, waiting.id), false);
        assert.equal(waiting.tab.client.conversationId, undefined);
        assert.equal(app.clients.has(waiting.tab.client), true, "keep app-wide events");
        assert.equal(waiting.room.clients.has(waiting.tab.client), false);
        assert.equal(waiting.releases(), 1);
        assertNoRoomEvents(waiting.afterWait());
        assert.match(String(waiting.tab.last("missing")?.message), /no longer shared/);

        await app.collab.postChat(waiting.id, owner(app), {
            text: "private after revocation",
            requestId: "attach-revocation-chat",
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        assertNoRoomEvents(waiting.afterWait());
    } finally {
        await waiting.clean();
    }
});

test("attachment checks the current actor instead of a stale client actor", async () => {
    const waiting = await waitingAttachment(true);

    try {
        // Change config without the normal eviction, and leave the client's actor snapshot unchanged.
        app.config.updateUser(waiting.user.id, { sessions: [] });
        assert.equal(waiting.tab.client.user.sessions, undefined);
        await waiting.finish();
        assert.equal(waiting.tab.client.conversationId, undefined);
        assert.equal(waiting.room.clients.has(waiting.tab.client), false);
        assert.equal(waiting.releases(), 1);
        assertNoRoomEvents(waiting.afterWait());
    } finally {
        await waiting.clean();
    }
});

test("a removed actor cannot join a room even if its connection remains registered", async () => {
    const waiting = await waitingAttachment();
    let closed = 0;

    waiting.tab.client.close = () => closed++;

    try {
        app.config.removeUser(waiting.user.id);
        await waiting.finish();
        assert.equal(app.clients.has(waiting.tab.client), false);
        assert.equal(waiting.room.clients.has(waiting.tab.client), false);
        assert.equal(closed, 1);
        assert.equal(waiting.releases(), 1);
        assertNoRoomEvents(waiting.afterWait());
    } finally {
        await waiting.clean();
    }
});

test("changing the selected conversation while opening never attaches the old room", async () => {
    const waiting = await waitingAttachment();

    try {
        const other = await newSession(app);

        waiting.tab.client.conversationId = other;
        await waiting.finish();
        assert.equal(waiting.tab.client.conversationId, other);
        assert.equal(waiting.room.clients.has(waiting.tab.client), false);
        assert.equal(waiting.releases(), 1);
        assertNoRoomEvents(waiting.afterWait());
        assert.ok(!waiting.afterWait().some((entry) => entry.event === "missing"));
    } finally {
        await waiting.clean();
    }
});

test("disconnect during room opening releases the room without sending its data", async () => {
    const waiting = await waitingAttachment();

    try {
        app.detach(waiting.tab.client);
        await waiting.finish();
        assert.equal(waiting.room.clients.has(waiting.tab.client), false);
        assert.equal(waiting.releases(), 1);
        assert.deepEqual(waiting.afterWait(), []);
    } finally {
        await waiting.clean();
    }
});

test("a still-authorized viewer joins normally after a role change during room opening", async () => {
    const waiting = await waitingAttachment();

    try {
        app.setAccess(owner(app), waiting.user.id, { role: "viewer" });
        await waiting.finish();
        assert.equal(app.config.userById(waiting.user.id)!.role, "viewer");
        assert.equal(waiting.room.clients.has(waiting.tab.client), true);
        assert.equal(waiting.tab.client.conversationId, waiting.id);
        assert.ok(waiting.afterWait().some((entry) => entry.event === "view"));
        assert.ok(waiting.afterWait().some((entry) => entry.event === "chat"));
        assert.equal(waiting.tab.last("missing"), undefined);
    } finally {
        await waiting.clean();
    }
});

test("a room error after revocation does not disclose the error to that conversation", async () => {
    const waiting = await waitingAttachment();

    try {
        app.setAccess(owner(app), waiting.user.id, { sessions: [] });
        await waiting.finish(new Error("private room loading detail"));
        assert.equal(waiting.room.clients.has(waiting.tab.client), false);
        assert.ok(!JSON.stringify(waiting.afterWait()).includes("private room loading detail"));
        assertNoRoomEvents(waiting.afterWait());
    } finally {
        await waiting.clean();
    }
});
