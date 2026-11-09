// A presented input's chip is this browser's choice: folded unless a module sets another mode.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a browser module, without types.
import * as presented from "../web/entry-presentation.js";

const {
    choosePresentationMode,
    modulePresentationMode,
    noteRevealed,
    onPresentationMode,
    onRevealed,
    PRESENTATION_STORAGE_KEY,
    presentationDraw,
    presentationLine,
    presentationMode,
    promptBefore,
    resendable,
    setPresentationMode,
    storageChanged,
    wasRevealed,
} = presented;

type Mode = "open" | "folded" | "hidden";

type Storage = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
};

const memory = (): Storage => {
    const data = new Map<string, string>();

    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
            data.set(key, String(value));
        },
    };
};

const options = (storage: Storage) => ({ storage, module: "quiet-input" });

test("the chip is folded until this browser asks otherwise", () => {
    const storage = memory();

    assert.equal(presentationMode("x.quiet-input.note", storage), "folded");
    assert.equal(presentationDraw("folded"), "chip");
    assert.equal(presentationDraw("folded", true), "text");
    assert.equal(presentationDraw("open"), "message");
    assert.equal(presentationDraw("hidden"), "anchor");
    assert.equal(presentationDraw("hidden", true), "text");
    assert.equal(presentationLine("Note", "saved"), "Note · saved");
    assert.equal(presentationLine("Note", ""), "Note");

    setPresentationMode("x.quiet-input.note", "hidden", options(storage));
    assert.equal(presentationMode("x.quiet-input.note", storage), "hidden");
    assert.equal(storage.getItem(PRESENTATION_STORAGE_KEY)?.startsWith("pocket."), false);
    assert.match(storage.getItem(PRESENTATION_STORAGE_KEY) ?? "", /x\.quiet-input\.note/);

    storage.setItem(PRESENTATION_STORAGE_KEY, "{");
    assert.equal(presentationMode("x.quiet-input.note", storage), "folded");
});

test("a module sets only its own kinds, and the same mode again is quiet", () => {
    const storage = memory();
    const seen: [string, Mode][] = [];
    const stop = onPresentationMode((kind: string, mode: Mode) => seen.push([kind, mode]));

    try {
        assert.throws(
            () => setPresentationMode("x.other-input.note", "open", options(storage)),
            /x\.quiet-input\.<name>/,
        );
        assert.throws(
            () => setPresentationMode("x.quiet-input.note", "away", options(storage)),
            /open, folded, or hidden/,
        );
        setPresentationMode("x.quiet-input.note", "open", options(storage));
        setPresentationMode("x.quiet-input.note", "open", options(storage));
        assert.equal(presentationMode("x.quiet-input.note", storage), "open");
        assert.deepEqual(seen, [["x.quiet-input.note", "open"]]);
    } finally {
        stop();
    }
});

test("a module reads its own choice, to set a mode only when the person has none", () => {
    const storage = memory();
    const read = (kind: string) => modulePresentationMode(kind, options(storage));

    assert.equal(read("x.quiet-input.note"), undefined);
    assert.throws(() => read("x.other-input.note"), /x\.quiet-input\.<name>/);

    // The person chose on the row (the app's control, for any module's kind): the module sees it.
    choosePresentationMode("x.quiet-input.note", "open", storage);
    assert.equal(read("x.quiet-input.note"), "open");
    assert.equal(presentationMode("x.quiet-input.note", storage), "open");
    assert.throws(() => choosePresentationMode("pi.user", "open", storage), /x\.<module>\./);
});

test("past its limit, this browser forgets the oldest choice, and blocked storage lasts the tab", () => {
    const storage = memory();

    for (let index = 0; index < 256; index++) {
        choosePresentationMode(`x.many.k${index}`, "hidden", storage);
    }

    choosePresentationMode("x.many.newest", "open", storage);

    const kept = JSON.parse(storage.getItem(PRESENTATION_STORAGE_KEY) ?? "{}");

    assert.equal(Object.keys(kept).length, 256);
    assert.equal(kept["x.many.k0"], undefined, "the oldest choice is forgotten");
    assert.equal(kept["x.many.newest"], "open");

    // A browser that refuses to store: no throw into the module, and this tab still shows the choice.
    const refusing = {
        getItem: () => null,
        setItem: () => {
            throw new Error("QuotaExceededError");
        },
    };

    choosePresentationMode("x.quiet-input.blocked", "hidden", refusing);
    assert.equal(presentationMode("x.quiet-input.blocked", refusing), "hidden");
});

test("another tab's choice reaches this one", () => {
    const storage = memory();
    const seen: [string, Mode][] = [];
    const stop = onPresentationMode((kind: string, mode: Mode) => seen.push([kind, mode]));

    try {
        const before = JSON.stringify({ "x.quiet-input.tab": "open" });

        storage.setItem(
            PRESENTATION_STORAGE_KEY,
            JSON.stringify({ "x.quiet-input.tab": "hidden" }),
        );
        storageChanged({ key: PRESENTATION_STORAGE_KEY, oldValue: before }, storage);
        storageChanged({ key: "something.else", oldValue: null }, storage);
        assert.deepEqual(seen, [["x.quiet-input.tab", "hidden"]]);
    } finally {
        stop();
    }
});

test("an input stored as a module's kind is not sent again, nor taken as the prompt before a reply", () => {
    const person = { id: 1, kind: "user", text: "hello" };
    const prefixed = {
        id: 2,
        kind: "user",
        text: "NOTE hi",
        presentation: { entryKind: "x.quiet-input.note", label: "Note", prefixed: true },
    };
    const stored = {
        id: 3,
        kind: "user",
        text: "a note",
        presentation: { entryKind: "x.quiet-input.note", label: "Note" },
    };
    const reply = { id: 4, kind: "assistant", blocks: [] };
    const entries = [person, prefixed, stored, reply];
    const view = {
        order: entries.map((entry) => entry.id),
        entries: new Map(entries.map((entry) => [entry.id, entry])),
    };

    assert.equal(resendable(person), true);
    assert.equal(resendable(prefixed), true);
    assert.equal(resendable(stored), false);
    assert.equal(resendable(reply), false);
    assert.equal(
        promptBefore(4, view)?.id,
        2,
        "the reply after a stored note resends the message before it",
    );
    view.order = [1, 3, 4];
    assert.equal(promptBefore(4, view)?.id, 1);
});

test("Find opens a hidden row and leaves the id marked", () => {
    const id = 44001;
    let heard = 0;
    const stop = onRevealed((entryId: number) => {
        heard = entryId;
    });

    try {
        assert.equal(wasRevealed(id), false);
        noteRevealed(id);
        noteRevealed("nope");
        assert.equal(wasRevealed(id), true);
        assert.equal(heard, id);
        assert.equal(presentationDraw("hidden", wasRevealed(id)), "text");
    } finally {
        stop();
    }
});
