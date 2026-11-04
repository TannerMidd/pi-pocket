// Drafts kept per person (`web/person-storage.js`): none before sign-in, none of another person, and in memory when
// the browser refuses to store them. A notes draft (`web/notes-drafts.js`) also keeps its first revision.
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

type Draft = { text: string; base: number };
const { createNotesDrafts } = (await import(
    new URL("../web/notes-drafts.js", import.meta.url).href
)) as {
    createNotesDrafts(storage: unknown): {
        get(person: string, id: number): { draft: Draft | null; error: string | null };
        edit(person: string, id: number, text: string, base: number): void;
        discard(person: string, id: number): void;
        beginSave(person: string, id: number): Draft | null;
        finishSave(person: string, id: number, submitted: Draft, success: boolean): void;
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

function notesOf(disk: Storage, person = "owner") {
    const storage = createPersonStorage(() => disk);

    storage.identify(person);

    return createNotesDrafts(storage);
}

const NOTES = "pocket.person.owner:notesDraft.1";

test("a notes draft keeps its first revision, and Cancel leaves another tab's newer draft", () => {
    const disk = memory({
        "pocket.person.owner:notesDraft.2": "{",
        "pocket.person.owner:notesDraft.3": '{"text":"","base":1.5}',
    });
    const tab = notesOf(disk);

    tab.edit("owner", 1, "Mine", 4);
    tab.edit("owner", 1, "Mine, longer", 5);
    assert.deepEqual(notesOf(disk).get("owner", 1).draft, { text: "Mine, longer", base: 4 });
    assert.equal(notesOf(disk, "guest").get("guest", 1).draft, null);
    assert.equal(tab.get("owner", 2).draft, null);
    assert.equal(tab.get("owner", 3).draft, null);
    notesOf(disk).edit("owner", 1, "Another tab", 6);
    tab.discard("owner", 1);
    assert.deepEqual(notesOf(disk).get("owner", 1).draft, { text: "Another tab", base: 4 });
});

test("a pending notes Save locks its draft, a failure keeps it, and a success clears it", () => {
    const disk = memory();
    const tab = notesOf(disk);

    tab.edit("owner", 1, "Draft", 2);
    const submitted = tab.beginSave("owner", 1)!;

    tab.edit("owner", 1, "Typed while saving", 2);
    tab.discard("owner", 1);
    assert.equal(tab.beginSave("owner", 1), null);
    tab.finishSave("owner", 1, submitted, false);
    assert.deepEqual(notesOf(disk).get("owner", 1).draft, { text: "Draft", base: 2 });
    tab.finishSave("owner", 1, tab.beginSave("owner", 1)!, true);
    assert.equal(disk.getItem(NOTES), null);
});

test("a notes draft stays in memory when storage fails, and warns only if it can return", () => {
    const disk = memory();
    const tab = notesOf(disk);

    tab.edit("owner", 1, "Stored", 0);

    disk.setItem = () => {
        throw new Error("QuotaExceededError");
    };

    tab.edit("owner", 1, "In memory", 0);
    assert.deepEqual(tab.get("owner", 1).draft, { text: "In memory", base: 0 });
    assert.equal(tab.get("owner", 1).error, "write");
    tab.discard("owner", 1);
    assert.deepEqual([disk.getItem(NOTES), tab.get("owner", 1).error], [null, null]);

    const stuck = memory({ [NOTES]: JSON.stringify({ text: "Stored", base: 0 }) });
    const stuckTab = notesOf(stuck);

    stuck.removeItem = () => {
        throw new Error("SecurityError");
    };

    stuckTab.discard("owner", 1);
    assert.equal(stuckTab.get("owner", 1).error, "clear");

    const blocked = createPersonStorage(() => {
        throw new Error("SecurityError");
    });

    blocked.identify("owner");
    const blockedTab = createNotesDrafts(blocked);

    blockedTab.edit("owner", 1, "Never stored", 0);
    blockedTab.discard("owner", 1);
    assert.equal(blockedTab.get("owner", 1).error, null);
});
