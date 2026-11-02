import assert from "node:assert/strict";
import { test } from "node:test";

type Draft = { text: string; base: number };
type State = { draft: Draft | null; saving: Draft | null; error: "write" | "clear" | null };
type PersonStorage = {
    identify(account: string | null): void;
    get(key: string, account?: string): string | null;
    set(key: string, value: string | null, account?: string): boolean;
    removeIf(key: string, values: (string | null)[], account?: string): boolean;
    clear(): void;
};
type NotesDrafts = {
    get(account: string, id: number): State;
    subscribe(listener: () => void): () => void;
    clear(): void;
    edit(account: string, id: number, text: string, base: number): void;
    discard(account: string, id: number): void;
    beginSave(account: string, id: number): Draft | null;
    finishSave(account: string, id: number, submitted: Draft, success: boolean): void;
};
const { createPersonStorage } = (await import(
    new URL("../web/person-storage.js", import.meta.url).href
)) as { createPersonStorage(storage: () => Storage): PersonStorage };
const { createNotesDrafts } = (await import(
    new URL("../web/notes-drafts.js", import.meta.url).href
)) as { createNotesDrafts(storage: PersonStorage): NotesDrafts };

function memoryStorage(): Storage {
    const items = new Map<string, string>();

    return {
        get length() {
            return items.size;
        },
        key: (index) => [...items.keys()][index] ?? null,
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, text) => {
            items.set(key, text);
        },
        removeItem: (key) => {
            items.delete(key);
        },
        clear: () => items.clear(),
    };
}

function forPerson(disk: Storage, person = "owner") {
    const storage = createPersonStorage(() => disk);

    storage.identify(person);

    return storage;
}

test("notes drafts persist text and the original revision, including an empty edit", () => {
    const disk = memoryStorage();
    const drafts = createNotesDrafts(forPerson(disk));

    drafts.edit("owner", 1, "An edit", 4);
    drafts.edit("owner", 1, "", 5);
    assert.deepEqual(drafts.get("owner", 1).draft, { text: "", base: 4 });
    assert.deepEqual(createNotesDrafts(forPerson(disk)).get("owner", 1).draft, {
        text: "",
        base: 4,
    });
    assert.equal(drafts.get("guest", 1).draft, null);
    assert.equal(drafts.get("owner", 2).draft, null);
});

test("discard and successful Save remove only their person's and conversation's draft", () => {
    const disk = memoryStorage();
    const owner = createNotesDrafts(forPerson(disk));
    const guest = createNotesDrafts(forPerson(disk, "guest"));

    owner.edit("owner", 1, "Owner edit", 0);
    guest.edit("guest", 1, "Guest edit", 0);
    owner.edit("owner", 2, "Another conversation", 0);
    guest.discard("guest", 1);
    const submitted = owner.beginSave("owner", 1)!;

    owner.finishSave("owner", 1, submitted, true);
    const reloaded = createNotesDrafts(forPerson(disk));

    assert.equal(reloaded.get("owner", 1).draft, null);
    assert.equal(createNotesDrafts(forPerson(disk, "guest")).get("guest", 1).draft, null);
    assert.deepEqual(reloaded.get("owner", 2).draft, { text: "Another conversation", base: 0 });
    assert.equal(disk.length, 1);
});

for (const action of ["Save", "Cancel", "Use theirs"]) {
    test(`${action} leaves a newer draft from another tab intact`, () => {
        const disk = memoryStorage();
        const first = createNotesDrafts(forPerson(disk));
        const second = createNotesDrafts(forPerson(disk));

        first.edit("owner", 1, "The first tab's edit", 2);
        const submitted = action === "Save" ? first.beginSave("owner", 1)! : null;

        second.edit("owner", 1, "A newer edit in the second tab", 2);

        if (submitted) {
            first.finishSave("owner", 1, submitted, true);
        } else {
            first.discard("owner", 1);
        }

        assert.equal(first.get("owner", 1).draft, null);
        assert.deepEqual(createNotesDrafts(forPerson(disk)).get("owner", 1).draft, {
            text: "A newer edit in the second tab",
            base: 2,
        });
    });
}

for (const action of ["Save", "Cancel", "Use theirs"]) {
    test(`${action} clears the last stored draft after a full-store edit`, () => {
        for (const reopen of [false, true]) {
            const disk = memoryStorage();
            const storage = forPerson(disk);
            let drafts = createNotesDrafts(storage);

            drafts.edit("owner", 1, "Old stored draft", 0);

            if (reopen) {
                drafts = createNotesDrafts(storage);
            }

            disk.setItem = () => {
                throw new Error("QuotaExceededError");
            };

            drafts.edit("owner", 1, "Memory-only edit", 0);
            const submitted = action === "Save" ? drafts.beginSave("owner", 1)! : null;

            if (submitted) {
                drafts.finishSave("owner", 1, submitted, true);
            } else {
                drafts.discard("owner", 1);
            }

            assert.equal(drafts.get("owner", 1).draft, null);
            assert.equal(drafts.get("owner", 1).error, null);
            assert.equal(storage.get("notesDraft.1"), null);
            assert.equal(disk.getItem("pocket.person.owner:notesDraft.1"), null);
            assert.equal(createNotesDrafts(forPerson(disk)).get("owner", 1).draft, null);
        }
    });

    test(`${action} of a memory-only edit leaves a newer stored draft intact`, () => {
        const disk = memoryStorage();
        const setItem = disk.setItem;
        const storage = forPerson(disk);
        const first = createNotesDrafts(storage);
        const second = createNotesDrafts(forPerson(disk));

        first.edit("owner", 1, "Old stored draft", 0);

        disk.setItem = () => {
            throw new Error("QuotaExceededError");
        };

        first.edit("owner", 1, "Memory-only edit", 0);
        const submitted = action === "Save" ? first.beginSave("owner", 1)! : null;

        disk.setItem = setItem;
        second.edit("owner", 1, "The other tab's newer stored edit", 0);

        if (submitted) {
            first.finishSave("owner", 1, submitted, true);
        } else {
            first.discard("owner", 1);
        }

        assert.deepEqual(createNotesDrafts(storage).get("owner", 1).draft, {
            text: "The other tab's newer stored edit",
            base: 0,
        });
    });

    for (const method of ["getItem", "removeItem"] as const) {
        test(`${action} warns when ${method} cannot confirm a full-store draft's cleanup`, () => {
            const disk = memoryStorage();
            const storage = forPerson(disk);
            const drafts = createNotesDrafts(storage);

            drafts.edit("owner", 1, "Old stored draft", 0);

            disk.setItem = () => {
                throw new Error("QuotaExceededError");
            };

            drafts.edit("owner", 1, "Memory-only edit", 0);
            const original = disk[method];

            disk[method] = () => {
                throw new Error("Storage is blocked");
            };

            const submitted = action === "Save" ? drafts.beginSave("owner", 1)! : null;

            if (submitted) {
                drafts.finishSave("owner", 1, submitted, true);
            } else {
                drafts.discard("owner", 1);
            }

            assert.equal(drafts.get("owner", 1).draft, null);
            assert.equal(drafts.get("owner", 1).error, "clear");
            Object.assign(disk, { [method]: original });
            assert.equal(storage.get("notesDraft.1"), null);
            assert.equal(
                disk.getItem("pocket.person.owner:notesDraft.1"),
                JSON.stringify({ text: "Old stored draft", base: 0 }),
            );
        });
    }
}

test("a pending save locks its draft across mounts, and failure keeps it", () => {
    const disk = memoryStorage();
    const drafts = createNotesDrafts(forPerson(disk));

    drafts.edit("owner", 1, "Keep on failure", 2);
    const submitted = drafts.beginSave("owner", 1)!;

    assert.equal(drafts.get("owner", 1).saving, submitted);
    assert.equal(drafts.beginSave("owner", 1), null);
    drafts.edit("owner", 1, "Cannot replace a pending save", 3);
    drafts.discard("owner", 1);
    assert.equal(drafts.get("owner", 1).draft, submitted);
    drafts.finishSave("owner", 1, submitted, false);
    assert.equal(drafts.get("owner", 1).saving, null);
    assert.deepEqual(createNotesDrafts(forPerson(disk)).get("owner", 1).draft, submitted);
    const retried = drafts.beginSave("owner", 1)!;

    drafts.finishSave("owner", 1, retried, true);
    drafts.edit("owner", 1, "A later edit", 3);
    drafts.finishSave("owner", 1, submitted, true);
    assert.deepEqual(drafts.get("owner", 1).draft, { text: "A later edit", base: 3 });
});

test("sign-out clears persisted notes and memory, and a late save cannot restore them", () => {
    const disk = memoryStorage();
    const storage = forPerson(disk);
    const drafts = createNotesDrafts(storage);

    drafts.edit("owner", 1, "Owner's unfinished notes", 0);
    const submitted = drafts.beginSave("owner", 1)!;

    assert.equal(disk.getItem("pocket.person.owner:notesDraft.1"), JSON.stringify(submitted));
    storage.clear();
    drafts.clear();
    storage.identify("guest");
    drafts.finishSave("owner", 1, submitted, true);
    assert.equal(drafts.get("owner", 1).draft, null);
    assert.equal(drafts.get("guest", 1).draft, null);
    storage.identify("owner");
    drafts.clear();
    assert.equal(drafts.get("owner", 1).draft, null);
    assert.equal(disk.length, 0);
});

test("subscriptions follow edits, saves, and memory clearing, and can be removed", () => {
    const drafts = createNotesDrafts(forPerson(memoryStorage()));
    let changes = 0;
    const unsubscribe = drafts.subscribe(() => {
        changes++;
    });

    drafts.edit("owner", 1, "Edit", 0);
    const submitted = drafts.beginSave("owner", 1)!;

    drafts.finishSave("owner", 1, submitted, false);
    assert.equal(changes, 3);
    drafts.clear();
    assert.equal(changes, 4);
    unsubscribe();
    drafts.discard("owner", 1);
    assert.equal(changes, 4);
});

test("blocked storage falls back to memory without losing a draft or throwing", () => {
    const storage = createPersonStorage(() => {
        throw new Error("Storage is blocked");
    });

    storage.identify("owner");
    const drafts = createNotesDrafts(storage);

    assert.equal(drafts.get("owner", 1).draft, null);
    drafts.edit("owner", 1, "Still editable", 8);
    assert.deepEqual(drafts.get("owner", 1).draft, { text: "Still editable", base: 8 });
    assert.equal(drafts.get("owner", 1).error, "write");
    drafts.discard("owner", 1);
    assert.equal(drafts.get("owner", 1).draft, null);
    assert.equal(drafts.get("owner", 1).error, "clear");
});

test("a full store keeps the latest edit in memory and can recover", () => {
    const disk = memoryStorage();
    const setItem = disk.setItem;
    const drafts = createNotesDrafts(forPerson(disk));

    drafts.edit("owner", 1, "Old edit", 1);

    disk.setItem = () => {
        throw new Error("QuotaExceededError");
    };

    drafts.edit("owner", 1, "Latest edit", 1);
    assert.deepEqual(drafts.get("owner", 1).draft, { text: "Latest edit", base: 1 });
    assert.equal(drafts.get("owner", 1).error, "write");
    disk.setItem = setItem;
    drafts.edit("owner", 1, "Storage works again", 2);
    assert.equal(drafts.get("owner", 1).error, null);
    assert.deepEqual(createNotesDrafts(forPerson(disk)).get("owner", 1).draft, {
        text: "Storage works again",
        base: 1,
    });
});

test("malformed stored drafts are ignored instead of breaking the Notes tab", () => {
    for (const saved of [
        "{",
        "null",
        '"text"',
        '{"text":1,"base":0}',
        '{"text":"bad","base":-1}',
        '{"text":"bad","base":1.5}',
    ]) {
        const disk = memoryStorage();

        disk.setItem("pocket.person.owner:notesDraft.1", saved);
        assert.equal(createNotesDrafts(forPerson(disk)).get("owner", 1).draft, null, saved);
    }
});
