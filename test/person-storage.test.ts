// Drafts kept per person (`web/person-storage.js`): none before sign-in, none of another person, and in memory when
// the browser refuses to store them.
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

function memory(entries: Record<string, string> = {}): Storage {
    const saved = new Map(Object.entries(entries));

    return {
        get length() {
            return saved.size;
        },
        key: (index) => [...saved.keys()][index] ?? null,
        getItem: (key) => saved.get(key) ?? null,
        setItem: (key, value) => void saved.set(key, value),
        removeItem: (key) => void saved.delete(key),
        clear: () => saved.clear(),
    };
}

const keys = (disk: Storage) => Array.from({ length: disk.length }, (_, index) => disk.key(index));

test("a person reads only their own drafts, and only once known", () => {
    const disk = memory();
    const drafts = createPersonStorage(() => disk);

    assert.equal(drafts.set("draft.home", "nobody's"), false);
    drafts.identify("owner");
    drafts.set("draft.home", "the owner's draft");
    drafts.identify("guest");
    assert.equal(drafts.get("draft.home"), null);
    // A late callback of the owner's page writes nothing while the guest is signed in.
    assert.equal(drafts.set("history", "late", "owner"), false);
    const reloaded = createPersonStorage(() => disk);

    reloaded.identify("owner");
    assert.equal(reloaded.get("draft.home"), "the owner's draft");
    assert.equal(reloaded.get("history"), null);
});

test("old drafts of no known person go, and sign-out clears all drafts but not preferences", () => {
    const disk = memory({
        "pocket.draft.1": "whose?",
        "pocket.history.v2": "[]",
        "pocket.pip.draft": "whose?",
        "pocket.prefs": "theme",
    });
    const drafts = createPersonStorage(() => disk);

    drafts.identify("guest");
    assert.deepEqual(keys(disk), ["pocket.prefs"]);
    drafts.set("draft.1", "the guest's draft");
    drafts.identify("owner");
    drafts.set("draft.1", "the owner's draft");
    drafts.clear();
    assert.deepEqual(keys(disk), ["pocket.prefs"]);
});

test("storage that fails keeps the newest value in memory, a removal too", () => {
    const disk = memory();
    const drafts = createPersonStorage(() => disk);

    drafts.identify("owner");
    drafts.set("draft.home", "saved");

    disk.setItem = disk.removeItem = () => {
        throw new Error("QuotaExceededError");
    };

    assert.equal(drafts.set("draft.home", "newer"), false);
    // The same person again, as a reconnect's hello says.
    drafts.identify("owner");
    assert.equal(drafts.get("draft.home"), "newer");
    drafts.set("draft.home", null);
    assert.equal(drafts.get("draft.home"), null);

    const blocked = createPersonStorage(() => {
        throw new Error("SecurityError");
    });

    blocked.identify("owner");
    blocked.set("draft.home", "in memory");
    assert.equal(blocked.get("draft.home"), "in memory");
});
