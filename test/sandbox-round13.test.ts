// Threads of the Greptile review at 4aaa1682: an open that a release revoked is closed; sessions of one folder archived together
// all change; a stopped subagent clears the refusal; a handle of a moved session goes to its new folder.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SubagentsDoc } from "../src/server/docs.ts";
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    type App,
} from "./helpers.ts";
import { FakeProvider, gate, sandboxOptions } from "./sandbox-fake.ts";

const apps: App[] = [];
let opened = 0;

after(async () => {
    for (const app of apps) {
        await app.close();
    }

    cleanUp();
});

async function boot(options: Parameters<typeof sandboxOptions>[0] = {}) {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-round13-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(options),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round13-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

const ticks = async (count = 20) => {
    for (let turn = 0; turn < count; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

test("an open that a release revoked while it was pending is closed when it arrives, and the call fails", async () => {
    const { app, provider } = await boot({ drainMs: 2000 });
    const a = await newSession(app, folder("open-revoked"));

    await app.sandboxes.turnOn(a, owner(app));
    const hold = gate();

    provider.holdOpen = hold;
    const opening = app.envFor(a).openTextLineReader("a.txt", context);

    await ticks();
    assert.equal(app.sandboxes.leasesOf(a).length, 1, "the open holds a lease");
    const off = app.sandboxes.turnOff(a, owner(app));

    await ticks();
    hold.open();
    const result = await opening;

    assert.equal(result.ok, false, "the open that arrived after the revoke fails");
    assert.deepEqual(provider.closed, ["reader"], "and what arrived was closed");
    assert.equal(app.sandboxes.leasesOf(a).length, 0, "its lease ended");
    await off;
});

test("sessions of one folder archived or restored together all change, none refused", async () => {
    const { app } = await boot();
    const dir = folder("bulk");
    const ids = [];

    for (let each = 0; each < 5; each++) {
        ids.push(await newSession(app, dir));
    }

    await Promise.all(
        ids.map((id) => app.commands.updateSession(id, owner(app), { archived: true })),
    );

    for (const id of ids) {
        assert.equal(app.sessionMeta(id)?.archived, true);
    }

    await Promise.all(
        ids.map((id) => app.commands.updateSession(id, owner(app), { archived: false })),
    );

    for (const id of ids) {
        assert.notEqual(app.sessionMeta(id)?.archived, true);
    }
});

test("a stopped subagent outside the folder no longer blocks the turn-on, and is refused when it is given work", async () => {
    const { app } = await boot();
    const dir = folder("stopped-child");
    const outside = folder("stopped-child-outside");
    const a = await newSession(app, dir);
    const stray = await app.harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { cwd: outside } },
        context,
    );

    await app.harness.commit(async (tx) => {
        (await tx.doc(SubagentsDoc, a)).agents.stray = { conversationId: stray.id, reported: [] };
    }, context);
    // It is idle (stopped, finished): it does not count.
    await app.sandboxes.turnOn(a, owner(app));
    assert.equal(app.sandboxes.isOn(a), true);
    // Given work again, it is looked at: its VM does not serve the folder it works in.
    await assert.rejects(
        app.sandboxes.lease(stray.id, { kind: "call", revoke: () => {} }),
        /subagent #\d+ works in .*outside the session's folder/,
    );
    assert.equal(app.sandboxes.deliver(stray.id).ok, false);
});

test("a handle of a session that moved goes to its new folder, though another session now sandboxes the old one", async () => {
    const { app } = await boot();
    const from = folder("moved-from");
    const to = folder("moved-to");

    writeFileSync(join(from, "note.txt"), "from");
    writeFileSync(join(to, "note.txt"), "to");
    const mover = await newSession(app, from);
    const handle = app.envFor(mover);

    const read = async () => {
        const result = await handle.readTextFile("note.txt", context);

        return result.ok ? result.value : result.error.message;
    };

    assert.equal(await read(), "from");
    await app.commands.configure(mover, owner(app), { cwd: to });
    // Another session takes the old folder into a sandbox: a lease bound to it would be refused for the mover.
    const other = await newSession(app, from);

    await app.sandboxes.turnOn(other, owner(app));
    assert.equal(
        await read(),
        "to",
        "the stale handle is resolved again first, and the call runs in the new folder",
    );
});
