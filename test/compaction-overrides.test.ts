// Each model's own compaction values (Pi's `compaction.modelOverrides`) reach Pi Durable (src/server/compaction.ts).
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import { compactionReader } from "../src/server/compaction.ts";

let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

test("each model's own values are read, and one that Pi refuses is left out once", () => {
    const warnings: string[] = [];
    const read = compactionReader(
        SettingsManager.inMemory({
            compaction: {
                reserveTokens: 16_384,
                modelOverrides: {
                    "openai-codex/gpt-6.1-sol": { reserveTokens: 350_000 },
                    "openrouter/anthropic/claude": { keepRecentTokens: 5_000 },
                    "faux/broken": { reserveTokens: -1 },
                    "no-provider": { reserveTokens: 1 },
                },
            },
        }),
        (line) => warnings.push(line),
    );

    const settings = read();

    assert.equal(settings.reserveTokens, 16_384);
    assert.deepEqual(settings.modelOverrides, {
        "openai-codex/gpt-6.1-sol": { reserveTokens: 350_000, keepRecentTokens: 20_000 },
        "openrouter/anthropic/claude": { reserveTokens: 16_384, keepRecentTokens: 5_000 },
    });
    read();
    assert.equal(warnings.length, 2, warnings.join("\n"));
    assert.match(warnings[0]!, /modelOverrides\["faux\/broken"\] is left out/);
    assert.match(warnings[1]!, /modelOverrides\["no-provider"\] is left out/);
});

test("one refused general value leaves out only itself", () => {
    const warnings: string[] = [];
    const read = compactionReader(
        SettingsManager.inMemory({
            compaction: {
                enabled: false,
                reserveTokens: -1,
                keepRecentTokens: 7_000,
                modelOverrides: {
                    "faux/own": { reserveTokens: 5_000 },
                    "faux/broken": { keepRecentTokens: -1 },
                },
            },
        }),
        (line) => warnings.push(line),
    );
    const settings = read();

    read();
    assert.equal(settings.enabled, false, "the owner's switch stays");
    assert.equal(settings.reserveTokens, undefined, "Pi Durable's value stands in");
    assert.equal(settings.keepRecentTokens, 7_000);
    assert.deepEqual(settings.modelOverrides, {
        "faux/own": { reserveTokens: 5_000, keepRecentTokens: 7_000 },
    });
    assert.equal(warnings.length, 2, warnings.join("\n"));
    assert.match(warnings[0]!, /compaction\.reserveTokens is left out/);
});

test("a refused name with a line break stays on one line of the log", () => {
    const warnings: string[] = [];
    const read = compactionReader(
        SettingsManager.inMemory({
            compaction: { modelOverrides: { "bad\nline\u001b[2J": { reserveTokens: 1 } } },
        }),
        (line) => warnings.push(line),
    );

    read();
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0]!, /[\n\u001b]/);
    assert.match(warnings[0]!, /modelOverrides\["bad\\nline\\u001b\[2J"\] is left out/);
});

test("with no model of its own, the settings are Pi's as before", () => {
    const read = compactionReader(
        SettingsManager.inMemory({ compaction: { reserveTokens: 9_000 } }),
        () => {},
    );

    assert.equal(read().modelOverrides, undefined);
    assert.equal(read().reserveTokens, 9_000);
});

/** Whether a conversation was compacted. */
async function compacted(id: ConversationId): Promise<boolean> {
    return (await app!.transcripts.allEntries(id, true)).some(
        (entry) => entry.kind === "compaction",
    );
}

test("a session compacts at its model's own threshold, and another model keeps the general one", async () => {
    app = await openApp(scriptedModel(), join(root, "compaction-overrides"));
    // The scripted models have 128,000 tokens of context: faux-1 compacts past about 1,000, faux-2 past about 111,000.
    app.settings.applyOverrides({
        compaction: {
            enabled: true,
            keepRecentTokens: 50,
            modelOverrides: { "faux/faux-1": { reserveTokens: 127_000 } },
        },
    });

    const own = await newSession(app);
    const general = await newSession(app);

    await app.commands.configure(general, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
    });

    for (const id of [own, general]) {
        for (const word of ["first", "second", "third"]) {
            await say(app, id, `${word} message `.repeat(300));
        }
    }

    assert.equal(await compacted(own), true, "faux-1 compacted at its own threshold");
    assert.equal(await compacted(general), false, "faux-2 kept the general threshold");
});
