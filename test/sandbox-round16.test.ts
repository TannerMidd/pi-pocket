// An admission decides on one state, after its last await: a reservation that appears while `enter` reads its documents is seen.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Tx } from "@earendil-works/pi-durable";
import { SandboxDoc, SessionsDoc } from "../src/server/docs.ts";
import { cleanUp, newSession, openApp, owner, root, scriptedModel, type App } from "./helpers.ts";
import { FakeProvider, gate, sandboxOptions } from "./sandbox-fake.ts";

let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

test("a turn-on reservation that appears while `enter` is awaiting its documents makes `enter` refuse", async () => {
    app = await openApp(
        scriptedModel(),
        join(root, "data-round16"),
        undefined,
        undefined,
        sandboxOptions(),
    );
    await app.sandboxes.register(new FakeProvider(), "fake.ts");
    const dir = join(root, "round16-folder");
    const other = join(root, "round16-other");

    mkdirSync(dir);
    mkdirSync(other);
    // A sandbox exists elsewhere, so groups are looked at; X is archived and plain, Y is live and plain in X's folder.
    await app.sandboxes.turnOn(await newSession(app, other), owner(app));
    const x = await newSession(app, dir);
    const y = await newSession(app, dir);

    await app.commands.updateSession(x, owner(app), { archived: true });
    const items = structuredClone(app.sessionCatalogue()) as Record<string, never>;
    const reading = gate();
    // A transaction whose reads of the sandbox documents wait: the awaits of the admission.
    const tx = {
        doc: async (kind: unknown, id?: unknown) => {
            if (kind === SessionsDoc) {
                return { items };
            }

            if (kind === SandboxDoc) {
                await reading.wait();

                return { on: false, by: undefined, at: undefined };
            }

            throw new Error(`unexpected document ${String(id)}`);
        },
    } as unknown as Tx;
    const entering = app.sandboxes.admit(tx, { kind: "enter", id: x });
    const refused = assert.rejects(entering, /under way|changing/);

    await reading.reached;
    // While `enter` waits, a turn-on of the live neighbour reserves the folder, and is held at its commit.
    const commit = app.harness.commit.bind(app.harness);
    const commitGate = gate();

    app.harness.commit = (async (...args: Parameters<typeof commit>) => {
        app!.harness.commit = commit;
        await commitGate.wait();

        return commit(...args);
    }) as typeof commit;
    const turning = app.sandboxes.turnOn(y, owner(app));

    await commitGate.reached;
    assert.equal(app.sandboxes.phaseOf(y), "turning-on");
    reading.open();
    await refused;
    commitGate.open();
    await turning.catch(() => undefined);
});
