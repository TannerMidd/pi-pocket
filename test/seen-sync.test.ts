// When a person looked at a session is theirs: sent to their other tabs and devices, never to anyone else's, and
// only ever later.
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { MAX_SEEN_ITEMS } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base = "";

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server.close();
    await app.close();
    cleanUp();
});

const seen = (tab: ReturnType<typeof fakeTab>) =>
    tab.events.filter((each) => each.event === "seen").map((each) => each.data);

test("a look reaches the same person's other tabs, and nobody else's", async () => {
    const me = owner(app);
    const guest = app.config.addUser("Guest", "guest").user;
    const id = await newSession(app);
    const here = fakeTab(undefined, me);
    const there = fakeTab(undefined, me);
    const other = fakeTab(undefined, guest);

    for (const tab of [here, there, other]) {
        await app.attach(tab.client);
        tab.events.length = 0; // what an earlier test saw, sent on attach, is not what this one looks for
    }

    try {
        const at = Date.now() - 5000;

        app.setSeen(me, [{ id: Number(id), at }]);
        assert.deepEqual(seen(here), [{ [Number(id)]: at }]);
        assert.deepEqual(seen(there), [{ [Number(id)]: at }]);
        assert.deepEqual(seen(other), [], "a guest hears nothing of the owner's looks");
    } finally {
        for (const tab of [here, there, other]) {
            app.detach(tab.client);
        }
    }
});

test("only a later look counts, and a time ahead of the server's is cut to now", async () => {
    const me = owner(app);
    const id = Number(await newSession(app));
    const tab = fakeTab(undefined, me);

    await app.attach(tab.client);
    tab.events.length = 0;

    try {
        const first = Date.now() - 60_000;

        app.setSeen(me, [{ id, at: first }]);
        app.setSeen(me, [{ id, at: first }]);
        app.setSeen(me, [{ id, at: first - 1 }]);
        assert.equal(seen(tab).length, 1, "an equal or earlier look says nothing");

        const before = Date.now();

        app.setSeen(me, [{ id, at: before + 3_600_000 }]);

        const sent = Object.values(seen(tab).at(-1)!)[0] as number;

        assert.ok(sent >= before && sent <= Date.now(), "the future is cut to the server's now");
    } finally {
        app.detach(tab.client);
    }
});

test("a session that is gone, or that the person cannot see, is left out and the rest count", async () => {
    const mine = Number(await newSession(app));
    const theirs = Number(await newSession(app));
    const scoped = app.config.addUser("Scoped", "guest", [String(theirs)]).user;
    const tab = fakeTab(undefined, scoped);

    await app.attach(tab.client);
    tab.events.length = 0;

    try {
        const at = Date.now() - 1000;

        app.setSeen(scoped, [
            { id: mine, at },
            { id: 987_654, at },
            { id: theirs, at },
        ]);
        assert.deepEqual(seen(tab), [{ [theirs]: at }], "only the session shared with them");
    } finally {
        app.detach(tab.client);
    }
});

test("a tab that comes later is told what the person saw, and only theirs", async () => {
    const me = owner(app);
    const guest = app.config.addUser("Late guest", "guest").user;
    const id = Number(await newSession(app));
    const at = Date.now() - 2000;

    app.setSeen(me, [{ id, at }]);

    const mine = fakeTab(undefined, me);
    const theirs = fakeTab(undefined, guest);

    await app.attach(mine.client);
    await app.attach(theirs.client);

    try {
        assert.equal((seen(mine).at(-1) as Record<number, number>)[id], at);
        assert.deepEqual(seen(theirs), [], "a guest is not told what the owner saw");
    } finally {
        app.detach(mine.client);
        app.detach(theirs.client);
    }
});

// ─── Over HTTP ──────────────────────────────────────────────────────────────

const post = (body: unknown) =>
    fetch(`${base}/api/seen`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

test("a request that is not a list of looks is refused, and a look that is not whole is left out", async () => {
    const id = Number(await newSession(app));
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);
    tab.events.length = 0;

    try {
        assert.equal((await post({})).status, 400);
        assert.equal((await post({ items: "no" })).status, 400);
        assert.equal(
            (await post({ items: Array.from({ length: MAX_SEEN_ITEMS + 1 }, () => ({})) })).status,
            400,
            "more than the limit is refused whole",
        );

        const at = Date.now() - 1000;
        const response = await post({
            items: [{ id: -1, at }, { id, at: 1.5 }, { id: "x", at }, null, { id, at }],
        });

        assert.equal(response.status, 200);
        assert.deepEqual(seen(tab), [{ [id]: at }], "the whole look still counts");
    } finally {
        app.detach(tab.client);
    }
});
