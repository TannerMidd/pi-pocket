// Browser-local recall keeps each person's sessions separate without assigning old history to a session.
import assert from "node:assert/strict";
import { test } from "node:test";

type Scope = { person: string; conversation: number };
const history = (await import(new URL("../web/history.js", import.meta.url).href)) as {
    remember(text: string, scope: Scope): void;
    sentHistory(scope: Scope): string[];
    searchHistory(query: string, scope: Scope): string[];
};

test("recall keeps the same text in each session and leaves old unscoped history alone", (t) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const saved = new Map([["pocket.history", JSON.stringify(["old unscoped text"])]]);

    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => saved.get(key) ?? null,
            setItem: (key: string, value: string) => saved.set(key, value),
        },
    });
    t.after(() => {
        if (original) {
            Object.defineProperty(globalThis, "localStorage", original);
        } else {
            Reflect.deleteProperty(globalThis, "localStorage");
        }
    });
    const a = { person: "owner", conversation: 1 };
    const b = { person: "owner", conversation: 2 };

    history.remember("shared text", a);
    history.remember("shared text", b);
    history.remember("newer B text", b);
    history.remember("another person's text", { person: "guest", conversation: 1 });
    assert.deepEqual(history.sentHistory(a), ["shared text"]);
    assert.deepEqual(history.sentHistory(b), ["shared text", "newer B text"]);
    assert.deepEqual(history.searchHistory("TEXT shared", a), ["shared text"]);
    assert.equal(saved.get("pocket.history"), JSON.stringify(["old unscoped text"]));
});
