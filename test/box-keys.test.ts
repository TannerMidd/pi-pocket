// Keys that extensions give the message boxes (web/box-keys.js): how a key is written, what it matches, and the box.
import assert from "node:assert/strict";
import { test } from "node:test";

type Key = { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; key: string };
type Event = Partial<Key> & { code?: string; isComposing?: boolean; keyCode?: number };
type Box = {
    where: string;
    text: string;
    start: number;
    end: number;
    set(text: string, start?: number, end?: number): void;
};
type Source = {
    keys: Key[];
    keysText: string | string[];
    label: string;
    module: string;
    run: (box: Box) => unknown;
    failed: (error: unknown) => void;
};
type BoxKeys = {
    parseKey(text: unknown, apple?: boolean): Key | null;
    parseKeys(keys: unknown, apple?: boolean): Key[] | null;
    matchesKey(key: Key, event: Event): boolean;
    keysLabel(keys: string | string[]): string;
    keyBox(
        element: { value: string; selectionStart: number; selectionEnd: number },
        where: string,
        write: (text: string, start: number, end: number) => void,
    ): Box;
    setBoxKeys(list: () => Source[]): void;
    boxKey(event: Event, box: Box): boolean;
    boxKeyRows(): [string, string][];
};

const keys = (await import(new URL("../web/box-keys.js", import.meta.url).href)) as BoxKeys;
const event = (key: string, flags: Partial<Key> = {}, code?: string): Event => ({
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...flags,
    key,
    code,
});

test("a key is modifiers, then a character or a named key", () => {
    assert.deepEqual(keys.parseKey("Ctrl+W"), {
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        key: "w",
    });
    assert.equal(keys.parseKey("alt+backspace")?.key, "Backspace");
    assert.equal(keys.parseKey("Ctrl+Space")?.key, " ");
    assert.equal(keys.parseKey("Ctrl++")?.key, "+");
    assert.equal(keys.parseKey("Mod+K", true)?.metaKey, true);
    assert.equal(keys.parseKey("Mod+K", false)?.ctrlKey, true);
    assert.equal(keys.parseKey("Ctrl+Ctrl+W"), null, "a modifier twice");
    assert.equal(keys.parseKey("Hyper+W"), null, "no such modifier");
    assert.equal(keys.parseKey("Ctrl+Wobble"), null, "no such key");
    assert.equal(keys.parseKey(7), null);
    assert.equal(keys.parseKeys(["Ctrl+W", "Alt+Backspace"])?.length, 2);
    assert.equal(keys.parseKeys([]), null);
    assert.equal(keys.parseKeys(["Ctrl+W", "nope+"]), null);
});

test("a key matches only with exactly its modifiers, and a letter with Alt by its place", () => {
    const ctrlW = keys.parseKey("Ctrl+W")!;

    assert.equal(keys.matchesKey(ctrlW, event("w", { ctrlKey: true })), true);
    assert.equal(keys.matchesKey(ctrlW, event("W", { ctrlKey: true })), true);
    assert.equal(keys.matchesKey(ctrlW, event("w", { ctrlKey: true, shiftKey: true })), false);
    assert.equal(keys.matchesKey(ctrlW, event("w")), false);

    const altB = keys.parseKey("Alt+B")!;

    assert.equal(keys.matchesKey(altB, event("∫", { altKey: true }, "KeyB")), true);
    assert.equal(keys.matchesKey(altB, event("∫", { altKey: true }, "KeyC")), false);
    assert.equal(keys.matchesKey(keys.parseKey("Enter")!, event("Enter")), true);
    assert.equal(
        keys.matchesKey(keys.parseKey("Enter")!, event("Enter", { shiftKey: true })),
        false,
    );
    assert.equal(keys.keysLabel(["Ctrl+W", "Alt+Backspace"]), "Ctrl W or Alt Backspace");
});

test("the first module's key takes it; false lets it through; a throw lets it through and says so", () => {
    const failures: unknown[] = [];
    const ran: string[] = [];
    const source = (name: string, text: string, run: (box: Box) => unknown): Source => ({
        keys: keys.parseKeys(text)!,
        keysText: text,
        label: name,
        module: "Mod",
        run: (box) => {
            ran.push(name);

            return run(box);
        },
        failed: (error) => failures.push(error),
    });
    const box = keys.keyBox({ value: "", selectionStart: 0, selectionEnd: 0 }, "session", () => {});

    keys.setBoxKeys(() => [
        source("first", "Ctrl+W", () => undefined),
        source("second", "Ctrl+W", () => undefined),
        source("through", "Ctrl+E", () => false),
        source("throws", "Ctrl+T", () => {
            throw new Error("no");
        }),
    ]);

    assert.equal(keys.boxKey(event("w", { ctrlKey: true }), box), true);
    assert.deepEqual(ran, ["first"]);
    assert.equal(keys.boxKey(event("e", { ctrlKey: true }), box), false);
    assert.equal(keys.boxKey(event("t", { ctrlKey: true }), box), false);
    assert.equal(failures.length, 1);
    assert.equal(keys.boxKey({ ...event("w", { ctrlKey: true }), isComposing: true }, box), false);
    assert.equal(keys.boxKey(event("x", { ctrlKey: true }), box), false);
    assert.deepEqual(keys.boxKeyRows()[0], ["Ctrl W", "first (Mod)"]);
    keys.setBoxKeys(() => []);
});

test("set writes through the box's own editing, with the caret kept in the text", () => {
    const writes: [string, number, number][] = [];
    const box = keys.keyBox(
        { value: "one two", selectionStart: 7, selectionEnd: 7 },
        "pip",
        (...args) => writes.push(args),
    );

    assert.equal(box.where, "pip");
    assert.equal(box.text, "one two");
    box.set("one ", 4);
    box.set("abc");
    box.set("abc", 1, 99);
    box.set("abc", -5);
    assert.deepEqual(writes, [
        ["one ", 4, 4],
        ["abc", 3, 3],
        ["abc", 1, 3],
        ["abc", 0, 0],
    ]);
    assert.throws(() => box.set(5 as unknown as string));
});
