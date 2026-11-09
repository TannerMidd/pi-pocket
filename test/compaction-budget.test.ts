// A summary gets room to be written: with no reserve in Pi's settings, each model keeps enough free context that Pi
// Durable's summary budget (0.8 × reserveTokens) holds a long session's summary (src/server/compaction.ts).
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { compactionReader, summaryReserve } from "../src/server/compaction.ts";
import type { Client } from "../src/server/room.ts";
import type { EmbedderMessage } from "../src/server/push.ts";

let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

const model = (id: string, contextWindow: number, maxTokens: number) => ({
    provider: "cliproxy",
    id,
    contextWindow,
    maxTokens,
});

test("each model keeps room for its summary, within a quarter of its window and 32,768", () => {
    // The model of the session that could no longer compact: 13,107 tokens was too few, 26,214 is enough.
    assert.equal(summaryReserve(model("claude-opus-5-5", 200_000, 32_768)), 32_768);
    assert.equal(summaryReserve(model("claude-sonnet-4", 128_000, 16_384)), 20_480);
    assert.equal(summaryReserve(model("gpt-6-sol", 272_000, 128_000)), 32_768);
    // A small window keeps most of itself for the conversation, and never less than Pi Durable's default.
    assert.equal(summaryReserve(model("small", 80_000, 32_768)), 20_000);
    assert.equal(
        summaryReserve(model("tiny", 32_000, 8_192)),
        DEFAULT_COMPACTION_POLICY.reserveTokens,
    );
    assert.equal(summaryReserve(model("unknown", 0, 0)), DEFAULT_COMPACTION_POLICY.reserveTokens);
});

test("a reserve the owner set in Pi's settings wins over the room for a summary", () => {
    const models = () => [model("a", 200_000, 32_768), model("b", 200_000, 32_768)];
    const none = compactionReader(SettingsManager.inMemory({}), () => {}, models)();

    // Pi's own default stands for the models Pi Pocket does not know.
    assert.equal(none.reserveTokens, 16_384);
    assert.deepEqual(none.modelOverrides, {
        "cliproxy/a": { reserveTokens: 32_768 },
        "cliproxy/b": { reserveTokens: 32_768 },
    });

    // An override with only its own keepRecentTokens still gets the room.
    const own = compactionReader(
        SettingsManager.inMemory({
            compaction: {
                modelOverrides: {
                    "cliproxy/a": { reserveTokens: 50_000 },
                    "cliproxy/b": { keepRecentTokens: 9_000 },
                },
            },
        }),
        () => {},
        models,
    )();

    assert.deepEqual(own.modelOverrides, {
        "cliproxy/a": { reserveTokens: 50_000, keepRecentTokens: 20_000 },
        "cliproxy/b": { reserveTokens: 32_768, keepRecentTokens: 9_000 },
    });

    // A general reserve is the owner's choice for every model.
    const general = compactionReader(
        SettingsManager.inMemory({ compaction: { reserveTokens: 16_384 } }),
        () => {},
        models,
    )();

    assert.equal(general.reserveTokens, 16_384);
    assert.equal(general.modelOverrides, undefined);
});

test("a session whose summary needs more than 13,107 tokens still compacts", async () => {
    // The summary of a long session: its model writes 15,000 tokens of it (thinking included) and stops at the
    // limit with less room, as claude-opus-5-5 did with Pi Durable's 13,107.
    const NEEDED = 15_000;
    const budgets: number[] = [];
    const faux = fauxProvider({
        tokensPerSecond: 100_000,
        models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 32_768 }],
    });

    faux.setResponses(
        Array.from({ length: 50 }, () => (context, options) => {
            const system = JSON.stringify(
                context.messages.filter((each) => each.role === "system"),
            );

            if (system.includes("context summarization assistant")) {
                budgets.push(options?.maxTokens ?? 0);

                return (options?.maxTokens ?? 0) < NEEDED
                    ? fauxAssistantMessage([fauxText("## Goal\n(cut off)")], {
                          stopReason: "length",
                      })
                    : fauxAssistantMessage([fauxText("## Goal\nThe whole summary.")]);
            }

            return fauxAssistantMessage([
                fauxText(`ok: ${lastText(context as never).text.length}`),
            ]);
        }),
    );
    app = await openApp(faux as never, join(root, "compaction-budget"));
    app.settings.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 50 } });

    const id = await newSession(app);

    // 100,000 tokens of context: with Pi Durable's reserve (16,384) it compacts past about 50,000, with this one
    // (25,000, a quarter of the window) past about 42,000.
    for (const word of ["first", "second", "third", "fourth", "fifth", "sixth"]) {
        await say(app, id, `${word} message `.repeat(5_000));
    }

    await until(() => budgets.length > 0, "a summary request", 20_000);
    await until(
        async () =>
            (await app!.transcripts.allEntries(id, true)).some(
                (entry) => entry.kind === "compaction",
            ),
        `a compaction (summary budgets ${budgets.join(", ")})`,
        20_000,
    );
    assert.ok(
        budgets.every((budget) => budget >= NEEDED),
        budgets.join(", "),
    );
    assert.equal(
        app.sessions().find((each) => each.id === Number(id))?.failed,
        undefined,
        "no run failed",
    );
});

test("a run whose compaction fails says so: on the session, and in a notification, not Pi finished", async () => {
    await app?.close();
    let fail = true;
    const faux = fauxProvider({
        tokensPerSecond: 100_000,
        models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 32_768 }],
    });

    faux.setResponses(
        Array.from({ length: 50 }, () => (context) => {
            const system = JSON.stringify(
                context.messages.filter((each) => each.role === "system"),
            );

            if (system.includes("context summarization assistant")) {
                return fail
                    ? fauxAssistantMessage([fauxText("## Goal")], { stopReason: "length" })
                    : fauxAssistantMessage([fauxText("## Goal\nThe whole summary.")]);
            }

            return fauxAssistantMessage([
                fauxText(`ok: ${lastText(context as never).text.length}`),
            ]);
        }),
    );
    app = await openApp(faux as never, join(root, "compaction-failure"));
    app.settings.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 50 } });

    const id = await newSession(app);
    const tab = fakeTab(undefined, owner(app));
    const embedder: Client = { ...tab.client, embedder: "embedder-notify" };
    const sent = () =>
        tab.events
            .filter((each) => each.event === "embedder-notify")
            .map((each) => each.data as unknown as EmbedderMessage)
            .filter((each) => each.tag === `done-${String(id)}`);
    const failure = () => app!.sessions().find((each) => each.id === Number(id))?.failure;

    await app.attach(embedder);
    app.setVisible(owner(app), embedder.id, false);

    try {
        // Past the threshold: the summary is cut off at its limit, so the compaction fails, and with it the run.
        for (let turn = 0; turn < 8 && failure() === undefined; turn++) {
            await say(app, id, `turn ${turn} `.repeat(6_000));
        }

        assert.match(failure() ?? "", /Compaction failed: Summarization hit the token limit/);
        await until(
            () => sent().some((each) => each.title.startsWith("Pi stopped with an error")),
            "the failure notification",
            15_000,
        );

        const message = sent().findLast((each) => each.title.startsWith("Pi stopped"))!;

        assert.match(message.body, /Compaction failed: Summarization hit the token limit/);
        assert.equal(message.urgency, "high");

        // PiP, asked now what came of the session, says the failure, not the answer before it.
        const pip = await app.pip.ensure(owner(app));

        await app.pip.read(pip, Number(id));
        const { now } = await app.pip.follow(pip, Number(id), undefined, "follow-failed");

        assert.match(
            now ?? "",
            /stopped with an error: .*Compaction failed: Summarization hit the token limit/,
        );
        assert.doesNotMatch(now ?? "", /last answer/);

        // Followed while it runs, the next run that fails the same way reports the failure to PiP when it ends.
        const { submissionId } = await app.commands.submit(id, owner(app), {
            text: "once more",
            requestId: crypto.randomUUID(),
        });

        await until(() => app!.isBusy(id), "the run to start");
        await app.pip.follow(pip, Number(id), undefined, "follow-running");
        await (await app.harness.submission(submissionId, context))!.wait(context);

        const report = async () =>
            (await app!.transcripts.allEntries(pip, true)).findLast(
                (entry) => entry.kind === "user" && entry.text.startsWith("[report]"),
            );

        await until(async () => (await report()) !== undefined, "PiP's report", 15_000);
        const reported = await report();

        assert.match(
            reported?.kind === "user" ? reported.text : "",
            /stopped with an error: .*Compaction failed: Summarization hit the token limit/,
        );

        // A run that compacts clears it.
        fail = false;
        await say(app, id, "again");
        await until(() => failure() === undefined, "the failure to clear");
    } finally {
        app.detach(embedder);
    }
});
