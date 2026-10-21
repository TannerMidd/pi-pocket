// Favorite folders are each person's own: read, changed, and sent only to them, with no star lost to another one.
import { type App, cleanUp, fakeTab, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app.close();
    cleanUp();
});

test("each person reads, changes, and hears only their own favorites", async () => {
    const me = owner(app);
    const guest = app.config.addUser("Guest", "guest").user;
    const mine = fakeTab(undefined, me);
    const theirs = fakeTab(undefined, guest);

    await app.attach(mine.client);
    await app.attach(theirs.client);

    try {
        const folder = join(root, "mine");

        await app.folderFavorites.set(me, { path: folder, starred: true });
        await app.folderFavorites.set(guest, { path: join(root, "theirs"), starred: true });
        assert.deepEqual(await app.folderFavorites.list(me), [folder]);
        assert.deepEqual(mine.last("folder-favorites"), [folder]);
        assert.deepEqual(theirs.last("folder-favorites"), [join(root, "theirs")]);
        assert.ok(!JSON.stringify(theirs.events).includes(folder), "no owner path reaches a guest");
    } finally {
        app.detach(mine.client);
        app.detach(theirs.client);
    }
});

test("stars at the same time keep one another", async () => {
    const me = owner(app);
    const before = await app.folderFavorites.list(me);
    const paths = Array.from({ length: 8 }, (_, i) => join(root, `at-once-${i}`));

    await Promise.all(paths.map((path) => app.folderFavorites.set(me, { path, starred: true })));
    assert.deepEqual(new Set(await app.folderFavorites.list(me)), new Set([...before, ...paths]));
});

test("only someone who may start sessions stars, and only a whole path", async () => {
    const viewer = app.config.addUser("Viewer", "viewer").user;
    const scoped = app.config.addUser("Scoped", "guest", ["1"]).user;
    const star = { path: root, starred: true };

    await assert.rejects(app.folderFavorites.set(viewer, star), { status: 403 });
    await assert.rejects(app.folderFavorites.set(scoped, star), { status: 403 });
    await assert.rejects(app.folderFavorites.set(owner(app), { path: "relative", starred: true }), {
        status: 400,
    });
});
