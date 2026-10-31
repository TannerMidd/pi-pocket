import { cleanUp, context, newSession, openApp, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { readBundle } from "../src/server/design/bundle.ts";
import { loadDesignSystem, writeDesignSystem } from "../src/server/design/tokens.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createPublicFetch } from "../src/server/public-fetch.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let conversation: ConversationId;
let calls = 0;
const host = { fetchPublic: createPublicFetch() } as PocketHost;
const [artifact, inline] = createArtifacts(host).tools!;

const page = (links: string) =>
    `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">${links}<h1 data-pid="t">Hi</h1>`;
const tokens = (accent: string) => ({
    color: {
        $type: "color",
        bg: { page: { $value: "#ffffff" } },
        accent: { default: { $value: accent } },
    },
});
const specimen =
    '<style>.btn{background:var(--color-accent-default)}</style><template data-state="default"><button class="btn">Go</button></template>';

/** One publish call, with its own call id (a replay would repeat it). */
async function publish(tool: typeof artifact, args: object, callId = `attach-${++calls}`) {
    const api = {
        conversationId: conversation,
        taskId: 7100,
        callId,
        agent: async () => ({ cwd: work }),
        snapshot: app.harness.snapshot.bind(app.harness),
        commit: app.harness.commit.bind(app.harness),
    };
    const result = await tool!.execute(args as never, api as never, context);

    return (result.output![0] as { text: string }).text;
}

const bundle = (id: string, version?: number) =>
    readBundle(host, app.harness.snapshot.bind(app.harness), conversation, id, version, context);
const names = async (id: string, version?: number) =>
    (await bundle(id, version)).assets.map((asset) => asset.name).sort();

before(async () => {
    app = await openApp(scriptedModel());
    conversation = await newSession(app);
});

after(async () => {
    await app.close();
    cleanUp();
});

test("with no design system, the link gets a note that says how to make one", async () => {
    assert.equal(loadDesignSystem(work), undefined);

    const reply = await publish(artifact, {
        id: "no-system",
        title: "No system",
        content: page('<link rel="stylesheet" href="ds/tokens.css">'),
    });

    assert.match(
        reply,
        /The page links ds\/tokens\.css, but this project has no design system \(\.pi\/design\/\)/,
    );
    assert.match(reply, /design_system init/);
    assert.deepEqual(await names("no-system"), []);
});

test("a page that links the tokens gets the compiled file, byte for byte", async () => {
    const system = writeDesignSystem(work, {
        tokens: tokens("#3b82f6"),
        components: { button: specimen },
    });
    const reply = await publish(artifact, {
        id: "uses-tokens",
        title: "Uses tokens",
        content: page('<link rel="stylesheet" href="ds/tokens.css">'),
    });

    assert.match(
        reply,
        /Attached ds\/tokens\.css from the design system "[^"]+" \(a snapshot of now; publish again to refresh\)\./,
    );
    assert.deepEqual(await names("uses-tokens"), ["ds/tokens.css"]);

    const found = await bundle("uses-tokens");
    const file = found.assets[0]!;

    assert.equal(file.bytes.toString("utf8"), system.compiled.css);
    assert.match(file.type, /^text\/css/);
});

test("all three files are attached when a page links them, and a page that links none gets none", async () => {
    await publish(artifact, {
        id: "uses-all",
        title: "Uses all",
        content: page(
            '<link rel="stylesheet" href="ds/tokens.css"><link rel="stylesheet" href="./ds/tailwind.css"><style>@import url("ds/components.css");</style>',
        ),
    });
    assert.deepEqual(await names("uses-all"), [
        "ds/components.css",
        "ds/tailwind.css",
        "ds/tokens.css",
    ]);

    const reply = await publish(artifact, { id: "plain", title: "Plain", content: page("") });

    assert.doesNotMatch(reply, /Attached|design system/);
    assert.deepEqual(await names("plain"), []);
});

test("the call's own asset of that name wins, and removeAssets keeps it out", async () => {
    await publish(artifact, {
        id: "own",
        title: "Own",
        content: page('<link rel="stylesheet" href="ds/tokens.css">'),
        assets: [{ name: "ds/tokens.css", content: ":root { --mine: 1 }" }],
    });

    const found = await bundle("own");

    assert.equal(found.assets.length, 1);
    assert.equal(found.assets[0]!.bytes.toString("utf8"), ":root { --mine: 1 }");

    const reply = await publish(artifact, {
        id: "dropped",
        title: "Dropped",
        content: page('<link rel="stylesheet" href="ds/tokens.css">'),
        removeAssets: ["ds/tokens.css"],
    });

    assert.doesNotMatch(reply, /Attached/);
    assert.deepEqual(await names("dropped"), []);
});

test("a new version refreshes the snapshot; a version that no longer links keeps the one it has", async () => {
    await publish(artifact, {
        id: "refresh",
        title: "Refresh",
        content: page('<link rel="stylesheet" href="ds/tokens.css">'),
    });

    const first = (await bundle("refresh")).assets[0]!.bytes.toString("utf8");

    assert.match(first, /--color-accent-default: #3b82f6;/);
    writeDesignSystem(work, {
        set: [{ mode: "light", token: "color.accent.default", value: "#ef4444" }],
    });

    const reply = await publish(artifact, {
        id: "refresh",
        title: "Refresh",
        edits: [{ oldText: "<h1", newText: "<h2" }],
    });

    assert.match(reply, /version 2/);

    const second = await bundle("refresh", 2);

    assert.match(second.assets[0]!.bytes.toString("utf8"), /--color-accent-default: #ef4444;/);
    assert.match(
        (await bundle("refresh", 1)).assets[0]!.bytes.toString("utf8"),
        /#3b82f6/,
        "version 1 keeps its own",
    );

    await publish(artifact, { id: "refresh", title: "Refresh", content: page("") });
    assert.deepEqual(await names("refresh", 3), ["ds/tokens.css"]);
});

test("artifact_inline attaches too, and a replayed call finds the version it made", async () => {
    const args = {
        id: "inline-ds",
        title: "Inline",
        content: page('<link rel="stylesheet" href="ds/tokens.css">'),
    };
    const first = await publish(inline, args, "replay-1");
    const again = await publish(inline, args, "replay-1");

    assert.match(first, /version 1/);
    assert.match(first, /Attached ds\/tokens\.css/);
    assert.match(again, /version 1/, "the replay did not write version 2");
    assert.doesNotMatch(again, /Attached/, "and did not read the folder again");
    assert.deepEqual(await names("inline-ds"), ["ds/tokens.css"]);
});

test("a design system with errors is attached, and the note says to validate", async () => {
    writeDesignSystem(work, {});
    rmSync(join(work, ".pi", "design", "tokens.json"));
    const { writeFileSync } = await import("node:fs");

    writeFileSync(join(work, ".pi", "design", "tokens.json"), "{ nope");

    const reply = await publish(artifact, {
        id: "broken",
        title: "Broken",
        content: page('<link rel="stylesheet" href="ds/tokens.css">'),
    });

    assert.match(
        reply,
        /Attached ds\/tokens\.css.*The system has 1 error: run design_system validate\./,
    );
});
