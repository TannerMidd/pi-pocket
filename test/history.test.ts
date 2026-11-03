// Browser-local recall keeps each session separate, in the storage of the person signed in.
import assert from "node:assert/strict";
import { test } from "node:test";

type Scope = { person: string; conversation: number };
const { personStorage } = (await import(
    new URL("../web/person-storage.js", import.meta.url).href
)) as {
    personStorage: { identify(person: string | null): void };
};
const history = (await import(new URL("../web/history.js", import.meta.url).href)) as {
    remember(text: string, scope: Scope): void;
    sentHistory(scope: Scope): string[];
    searchHistory(query: string, scope: Scope): string[];
};

test("recall keeps each person and session separate", (t) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const saved = new Map<string, string>();

    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => saved.get(key) ?? null,
            setItem: (key: string, value: string) => saved.set(key, value),
        },
    });
    personStorage.identify("owner");
    t.after(() => {
        personStorage.identify(null);

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
    assert.ok(saved.get("pocket.person.owner:history")?.includes("newer B text"));
});
