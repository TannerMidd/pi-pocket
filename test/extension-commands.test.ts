import {
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { defineDoc } from "@earendil-works/pi-durable";

// What the commands' handlers changed: how many times each ran, in its session.
const Runs = defineDoc<{ count: number }>({
    kind: "x.counter.runs",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ count: 0 }),
});

const FILE = "counter.ts";
const MODULE = `/** Counts. */
import { defineDoc } from "@earendil-works/pi-durable";
const Runs = defineDoc({
    kind: "x.counter.runs", version: 1, scope: "conversation", history: "latest", fork: "current",
    initial: () => ({ count: 0 }),
});
const count = (ctx) => ctx.commit(async (tx) => { (await tx.doc(Runs, ctx.conversationId)).count++; });
export default (_host, web) => {
    web.command("count-here", {
        description: "Count", scope: "conversation",
        handler: async (args, ctx) => {
            if (args === "throw") {
                throw new Error("a secret path");
            }
            await count(ctx);
            if (args === "hold") {
                await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
            }
            return args === "card"
                ? { type: "card", output: "CARD_SENTINEL" }
                : { type: "toast", level: "info", message: "Counted." };
        },
    });
    web.command("count-all", {
        description: "Count for the owner", scope: "global",
        handler: async (_args, ctx) => {
            await count(ctx);
            return { type: "toast", level: "info", message: "Counted." };
        },
    });
};
`;

const model = scriptedModel();
let app: App;

before(async () => {
    app = await openApp(model);
    writeFileSync(join(app.dataDir, "extensions", FILE), MODULE);
    await app.setExtensionEnabled(owner(app), FILE, true);
});

after(async () => {
    await app.close();
    cleanUp();
});

const commandId = (name: string) => app.webs.commands().find((each) => each.name === name)?.id;
const runs = async (id: Parameters<App["conversation"]>[0]) =>
    (await app.harness.snapshot(Runs, id, context))?.count ?? 0;
const request = (name: string, args = "") => ({
    commandId: commandId(name),
    args,
    requestId: crypto.randomUUID(),
});

test("a retried request runs its handler once, and a restart does not run it again", async () => {
    const id = await newSession(app);
    const once = request("count-here");
    const [first, second] = await Promise.all([
        app.extensionCommands.run(id, owner(app), once),
        app.extensionCommands.run(id, owner(app), once),
    ]);

    assert.deepEqual(second, first);
    assert.equal(await runs(id), 1);

    // A handler that changed something, cut off by a restart, comes back interrupted and is not run again.
    const held = request("count-here", "hold");

    void app.extensionCommands.run(id, owner(app), held).catch(() => {});
    await until(async () => (await runs(id)) === 2, "the held command");
    await app.close();
    app = await openApp(model, app.dataDir);

    const resumed = await app.extensionCommands.run(id, owner(app), held);

    assert.equal(resumed.status, "interrupted");
    assert.equal(await runs(id), 2);
});

test("a viewer runs no command, and a global command is the owner's alone", async () => {
    const id = await newSession(app);
    const viewer = app.config.addUser("Viewer", "viewer").user;
    const guest = app.config.addUser("Guest", "guest").user;

    await assert.rejects(app.extensionCommands.run(id, viewer, request("count-here")), {
        status: 403,
    });
    await assert.rejects(app.extensionCommands.run(id, guest, request("count-all")), {
        status: 403,
    });
    // While people take turns, a guest who does not drive runs no conversation command.
    await app.collab.turns(id, owner(app), { action: "on" });
    await assert.rejects(app.extensionCommands.run(id, guest, request("count-here")), {
        status: 409,
    });
    await app.collab.turns(id, owner(app), { action: "off" });
    assert.equal(await runs(id), 0);
    // A handler's own error words are the owner's to read, not the guest's.
    assert.equal(
        (
            (await app.extensionCommands.run(id, guest, request("count-here", "throw"))) as {
                message?: string;
            }
        ).message,
        "The command failed.",
    );
    assert.equal(
        (await app.extensionCommands.run(id, guest, request("count-here"))).status,
        "done",
    );
    assert.equal(await runs(id), 1);
});

test("a card shows in the transcript, never in Pi's context, and does not change whom Pi works for", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Card guest", "guest").user;

    await say(app, id, "Hello");
    assert.equal(
        (await app.extensionCommands.run(id, guest, request("count-here", "card"))).type,
        "card",
    );

    const entries = (await (await app.conversation(id)).context(context)).entries;

    assert.ok(entries.some((entry) => entry.kind === "pocket.extension-command"));
    assert.equal(app.attribution.requesterOf(id), owner(app).id);
    await say(app, id, "Again");
    assert.ok(!(await modelTexts(app, id)).some((text) => text.includes("CARD_SENTINEL")));
});

test("a failed reload keeps the commands, and turning the module off takes them away", async () => {
    const before = commandId("count-here");

    // A version that registers, then fails: what it registered never counts.
    writeFileSync(
        join(app.dataDir, "extensions", FILE),
        `export default (_host, web) => {
            web.command("count-here", { description: "Count", scope: "global", handler() {} });
            throw new Error("broken");
        };`,
    );
    await assert.rejects(app.loader.reload(FILE));
    assert.equal(commandId("count-here"), before);

    writeFileSync(join(app.dataDir, "extensions", FILE), MODULE);
    await app.setExtensionEnabled(owner(app), FILE, false);
    assert.deepEqual(app.webs.commands(), []);

    const id = await newSession(app);

    await assert.rejects(
        app.extensionCommands.run(id, owner(app), { ...request("count-here"), commandId: before }),
        { status: 404 },
    );
});
