// An iPhone or iPad home screen app has no browser around it: a system swipe back through its history must not leave
// the app on a blank page. The list is put under a conversation opened straight away, and kept under the list itself.
import assert from "node:assert/strict";
import { test } from "node:test";

type Listener = (event: unknown) => void;
type Entry = { state: unknown; path: string };

const globals = globalThis as unknown as Record<string, unknown>;

test("a home screen app keeps the session list under back, also at its root", async (t) => {
    const listeners = new Map<string, Set<Listener>>();

    const add = (name: string, listener: Listener) => {
        const set = listeners.get(name) ?? new Set<Listener>();

        set.add(listener);
        listeners.set(name, set);
    };

    const remove = (name: string, listener: Listener) => listeners.get(name)?.delete(listener);
    const where = { pathname: "/s/3", search: "", hash: "", href: "http://pocket.test/s/3" };

    const goTo = (path: string | undefined) => {
        const url = new URL(path ?? where.href, "http://pocket.test");

        where.pathname = url.pathname;
        where.search = url.search;
        where.hash = url.hash;
        where.href = url.href;
    };

    const entries: Entry[] = [{ state: null, path: where.href }];
    let at = 0;
    const current = () => entries[at]!;

    const fire = () => {
        for (const listener of [...(listeners.get("popstate") ?? [])]) {
            listener({ state: current().state, hasUAVisualTransition: false });
        }
    };

    const history = {
        get state() {
            return current().state;
        },
        get length() {
            return entries.length;
        },
        pushState(state: unknown, _title: string, path?: string) {
            entries.splice(at + 1);
            entries.push({ state, path: path ?? where.href });
            at = entries.length - 1;
            goTo(path);
        },
        replaceState(state: unknown, _title: string, path?: string) {
            entries[at] = { state, path: path ?? where.href };
            goTo(path);
        },
        go(delta: number) {
            at = Math.max(0, Math.min(entries.length - 1, at + delta));
            goTo(current().path);
            setTimeout(fire, 0);
        },
        back() {
            this.go(-1);
        },
    };
    const saved = {
        history: Object.getOwnPropertyDescriptor(globalThis, "history"),
        location: Object.getOwnPropertyDescriptor(globalThis, "location"),
        navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
        document: Object.getOwnPropertyDescriptor(globalThis, "document"),
        addEventListener: globals.addEventListener,
        removeEventListener: globals.removeEventListener,
    };

    t.after(() => {
        for (const name of ["history", "location", "navigator", "document"] as const) {
            const descriptor = saved[name];

            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }

        globals.addEventListener = saved.addEventListener;
        globals.removeEventListener = saved.removeEventListener;
    });

    Object.defineProperty(globalThis, "history", { configurable: true, value: history });
    Object.defineProperty(globalThis, "location", { configurable: true, value: where });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { standalone: true, userActivation: { hasBeenActive: false } },
    });
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { documentElement: { dataset: {} }, querySelector: () => null },
    });
    globals.addEventListener = add;
    globals.removeEventListener = remove;

    const back = (await import(new URL("../web/back.js", import.meta.url).href)) as {
        startHistory(options: { home: boolean }): void;
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

    const swipeBack = async () => {
        history.back();
        await settle();
    };

    back.startHistory({ home: true });
    await settle();
    assert.equal(where.pathname, "/s/3");
    assert.deepEqual(history.state, { pocket: { layers: 0, back: 1 } });

    await swipeBack();
    assert.equal(where.pathname, "/");
    assert.deepEqual(history.state, { pocket: { layers: 0, back: 0, guard: true } });

    // At the list's own guarded entry, and at the one under it: back still lands on the list, never outside it.
    await swipeBack();
    assert.equal(where.pathname, "/");
    assert.deepEqual(history.state, { pocket: { layers: 0, back: 0, guard: true } });
    await swipeBack();
    assert.equal(where.pathname, "/");

    // The route's slide mark is cleared by a timer: let it run before the page's parts go.
    await new Promise((resolve) => setTimeout(resolve, 650));
});
