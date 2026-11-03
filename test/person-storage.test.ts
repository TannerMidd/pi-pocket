// Local local content has an authenticated owner, a safe upgrade boundary, and a memory-only fallback.
import assert from "node:assert/strict";
import { test } from "node:test";

const { createPersonStorage } = (await import(
    new URL("../web/person-storage.js", import.meta.url).href
)) as {
    createPersonStorage(storage: () => Storage): {
        identify(person: string | null): void;
        get(key: string, person?: string): string | null;
        set(key: string, value: string | null, person?: string): boolean;
        clear(): void;
    };
};

function memoryStorage() {
    const saved = new Map<string, string>();
    const disk: Storage = {
        get length() {
            return saved.size;
        },
        key: (index) => [...saved.keys()][index] ?? null,
        getItem: (key) => saved.get(key) ?? null,
        setItem: (key, value) => {
            saved.set(key, value);
        },
        removeItem: (key) => {
            saved.delete(key);
        },
        clear: () => saved.clear(),
    };

    return { disk, saved };
}

test("local keys are unreadable before authentication and stay with their person across reloads and account switches", () => {
    const { disk } = memoryStorage();
    const drafts = createPersonStorage(() => disk);

    assert.equal(drafts.get("draft.home"), null);
    assert.equal(drafts.get("draft.home", "owner"), null);
    assert.equal(drafts.set("draft.home", "unknown author"), false);
    assert.equal(drafts.set("history", "unknown author", "owner"), false);
    drafts.identify("owner");
    drafts.set("draft.home", "owner's draft");
    drafts.identify("guest");
    assert.equal(drafts.get("draft.home"), null);
    assert.equal(drafts.get("draft.home", "owner"), null);
    assert.equal(drafts.set("history", "late local content", "owner"), false);
    drafts.set("draft.home", "guest's draft");
    drafts.identify("owner");
    assert.equal(drafts.get("draft.home"), "owner's draft");
    const reloaded = createPersonStorage(() => disk);

    reloaded.identify("owner");
    assert.equal(reloaded.get("draft.home"), "owner's draft");
});

test("unknown legacy content is discarded, and signing out erases every person's content but not browser preferences", () => {
    const { disk, saved } = memoryStorage();
    const drafts = createPersonStorage(() => disk);
    const old = [
        "pocket.draft.1",
        "pocket.draft.home",
        "pocket.draft.chat-1",
        "pocket.pastes.1",
        "pocket.attached.1",
        "pocket.history",
        "pocket.history.v2",
        "pocket.pip.draft",
        "pocket.viewed.1",
    ];

    for (const key of old) {
        disk.setItem(key, "previous person's secret");
    }

    disk.setItem("pocket.prefs", "theme and layout");
    disk.setItem("pocket.pip", "window size");
    disk.setItem("x.design.prefs", "canvas preferences");
    drafts.identify("guest");
    assert.equal(drafts.get("draft.1"), null);
    assert.equal(
        old.some((key) => saved.has(key)),
        false,
    );
    drafts.set("draft.1", "guest draft");
    drafts.identify("owner");
    drafts.set("draft.1", "owner draft");
    drafts.clear();
    assert.deepEqual(
        [...saved],
        [
            ["pocket.prefs", "theme and layout"],
            ["pocket.pip", "window size"],
            ["x.design.prefs", "canvas preferences"],
        ],
    );
    // A late callback from the old page must not recreate an erased history record.
    assert.equal(drafts.set("history", "late local content", "owner"), false);
    drafts.identify("owner");
    assert.equal(drafts.get("draft.1"), null);
});

test("blocked storage keeps drafts in memory and clears that fallback on sign-out", () => {
    const drafts = createPersonStorage(() => {
        throw new Error("SecurityError");
    });

    drafts.identify("owner");
    assert.equal(drafts.get("draft.1"), null);
    assert.equal(drafts.set("draft.1", "memory-only draft"), false);
    drafts.identify("owner"); // An SSE reconnect must not discard the memory fallback.
    assert.equal(drafts.get("draft.1"), "memory-only draft");
    drafts.clear();
    drafts.identify("guest");
    assert.equal(drafts.get("draft.1"), null);
});

test("a full store keeps the newest draft, paste, and deletions rather than returning stale persisted text", () => {
    const { disk } = memoryStorage();
    const drafts = createPersonStorage(() => disk);

    drafts.identify("owner");
    drafts.set("draft.home", "old persisted text");

    disk.setItem = () => {
        throw new Error("QuotaExceededError");
    };

    disk.removeItem = () => {
        throw new Error("SecurityError");
    };

    assert.equal(drafts.set("draft.home", "new draft"), false);
    assert.equal(drafts.get("draft.home"), "new draft");
    assert.equal(drafts.set("pastes.home", '{"1":"new pasted text"}'), false);
    assert.equal(drafts.get("pastes.home"), '{"1":"new pasted text"}');
    assert.equal(drafts.set("draft.home", null), false);
    assert.equal(drafts.get("draft.home"), null);
});
