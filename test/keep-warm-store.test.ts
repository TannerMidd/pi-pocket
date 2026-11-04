import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { idleFiles, type IdleRecord } from "../src/server/keep-warm-store.ts";

test("keep warm files: an edited or damaged record is never warmed, and leaves nothing behind", async () => {
    const folder = await mkdtemp(join(tmpdir(), "keep-warm-"));

    try {
        const store = idleFiles(
            folder,
            () => {},
            () => 2_000_000,
        );
        const record: IdleRecord = {
            version: 1,
            key: "s",
            conversationId: 3,
            provider: "anthropic",
            modelId: "m",
            messages: [],
            options: { sessionId: "s", apiKey: "planted", headers: { x: "1" } },
            promptTokens: 10,
            payloadHash: "h",
            lastTouch: 1_000_000,
            since: 1_000_000,
            warms: 0,
            spent: 0,
            failures: 0,
        };

        store.save(record, true);
        store.save({ ...record, key: "t", options: { sessionId: "t" }, warms: -5 }, true);
        await store.flush();
        await writeFile(join(folder, "orphan.context.json"), "[]");
        await writeFile(join(folder, "cut.json.tmp"), "{");

        const loaded = await store.load();

        assert.equal(loaded.length, 1, "the record with a negative count is dropped");
        assert.deepEqual(loaded[0]?.options, { sessionId: "s" }, "no key, headers, or address");
        assert.equal(
            (await readdir(folder)).length,
            2,
            "only the good record's two files are left",
        );
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});

test("keep warm files: damaged budgets are ignored without losing the idle records", async () => {
    const folder = await mkdtemp(join(tmpdir(), "keep-warm-"));

    try {
        const store = idleFiles(
            folder,
            () => {},
            () => 2_000_000,
        );
        const record: IdleRecord = {
            version: 1,
            key: "s",
            conversationId: 3,
            provider: "anthropic",
            modelId: "m",
            messages: [],
            options: { sessionId: "s" },
            promptTokens: 10,
            payloadHash: "h",
            lastTouch: 1_000_000,
            since: 1_000_000,
            warms: 0,
            spent: 0,
            failures: 0,
        };

        store.save(record, true);
        await store.flush();

        for (const damaged of [
            "{",
            "null",
            "[]",
            '{"3": -1}',
            '{"3": "0.1"}',
            '{"3": 1e400}',
            '{"3": 0.1, "4": -1}',
        ]) {
            await writeFile(join(folder, "budgets.json"), damaged);
            assert.deepEqual(await store.load(), [record], "the idle record remains valid");
            assert.deepEqual(await store.loadBudgets(), {}, "ignore the whole damaged budget");
        }

        store.saveBudgets({ "3": 0.12, "4": 0 });
        await store.flush();
        assert.deepEqual(await store.loadBudgets(), { "3": 0.12, "4": 0 });
        assert.equal((await stat(join(folder, "budgets.json"))).mode & 0o777, 0o600);
        assert.deepEqual(await store.load(), [record], "budgets.json is not an idle record");
        assert.deepEqual(await store.loadBudgets(), { "3": 0.12, "4": 0 });
        assert.equal((await readdir(folder)).length, 3, "one record, its context, and the budgets");
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});
