// Derived-reply retry phases changed durable task checkpoint schemas from version 1 to version 2.
import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateBackgroundV1 } from "../src/server/background.ts";
import { migrateCourierV1 } from "../src/server/extensions/subagents.ts";

test("background task migration preserves every version-1 checkpoint", () => {
    for (const phase of ["watch", "tell"] as const) {
        assert.deepEqual(migrateBackgroundV1({ backgroundId: "task-a" }, { phase }, 1), {
            input: { backgroundId: "task-a" },
            checkpoint: { phase },
        });
    }
});

test("background task migration rejects unknown versions and checkpoints", () => {
    assert.throws(() => migrateBackgroundV1({ backgroundId: "task-a" }, { phase: "watch" }, 0));
    assert.throws(() => migrateBackgroundV1({ backgroundId: "task-a" }, { phase: "retryTell" }, 1));
    assert.throws(() => migrateBackgroundV1({}, { phase: "watch" }, 1));
});

test("courier task migration preserves every version-1 checkpoint", () => {
    for (const checkpoint of [
        { phase: "gather" },
        { phase: "next" },
        { phase: "hold" },
        { phase: "send" },
        { phase: "send", batch: 4, text: "legacy report" },
    ]) {
        assert.deepEqual(migrateCourierV1(null, checkpoint, 1), { input: null, checkpoint });
    }
});

test("courier task migration rejects unknown versions and checkpoints", () => {
    assert.throws(() => migrateCourierV1(null, { phase: "next" }, 2));
    assert.throws(() => migrateCourierV1(null, { phase: "capacity" }, 1));
    assert.throws(() => migrateCourierV1(null, { phase: "send", batch: "4" }, 1));
    assert.throws(() => migrateCourierV1({}, { phase: "next" }, 1));
});
