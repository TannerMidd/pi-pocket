import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
};
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const waitInPage = (expression: string, what: string) =>
    until(
        () => inPage<boolean>(`return JSON.stringify(${expression})`).catch(() => false),
        what,
        20_000,
    );

async function go(id: ConversationId): Promise<void> {
    await page.evaluate(`(await import("/store.js")).navigate(${Number(id)})`);
    await waitInPage(
        `(await import("/store.js")).store.state.view.conversation?.id === ${Number(id)} && (await import("/store.js")).store.state.notes !== null`,
        "the session and its saved notes",
    );
}

async function openNotes(): Promise<void> {
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "chat", tab: "notes" })`);
    await waitInPage(`document.querySelector(".people-content .tabs") !== null`, "the People tabs");
    // A sheet retained for its exit animation can still have its previous tab selected.
    await press("Notes");
    await waitInPage(`document.querySelector("textarea.notes") !== null`, "the Notes tab");
}

async function closeNotes(): Promise<void> {
    await page.evaluate(`(await import("/store.js")).closeSheet()`);
    await waitInPage(`document.querySelector(".people-sheet") === null`, "the closed People sheet");
}

async function edit(text: string): Promise<void> {
    await page.evaluate(`
        const box = document.querySelector("textarea.notes");

        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await waitInPage(`document.body.textContent.includes("unsaved changes")`, "the unsaved mark");
}

const notes = () =>
    inPage<{ text: string; unsaved: boolean; conflict: boolean }>(`
        return JSON.stringify({
            text: document.querySelector("textarea.notes")?.value,
            unsaved: document.body.textContent.includes("unsaved changes"),
            conflict: document.body.textContent.includes("Use theirs"),
        });
    `);

const press = (label: string) =>
    page.evaluate(`
        [...document.querySelectorAll(".people-content button")]
            .find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click();
    `);

async function reload(id: ConversationId): Promise<void> {
    await page.navigate(`${base}/s/${id}`);
    await waitInPage(
        `(await import("/store.js")).store.state.view.conversation?.id === ${Number(id)} && (await import("/store.js")).store.state.notes !== null`,
        "the reloaded session and its notes",
    );
    await openNotes();
}

async function signIn(token: string, userId: string): Promise<void> {
    await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
    await waitInPage(
        `document.querySelector('form[action="/login"], script[type="importmap"]') !== null`,
        "the app or account-switch confirmation",
    );

    if (
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('form[action="/login"]') !== null)`,
        )
    ) {
        await page.click({ selector: 'form[action="/login"] button' });
    }

    await waitInPage(
        `document.readyState === "complete" && location.pathname !== "/login" && document.querySelector('script[type="importmap"]') !== null && (await import("/store.js")).store.state.me?.id === ${JSON.stringify(userId)}`,
        "the signed-in account",
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
    base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "notes-draft-browser-")),
        args: ["--renderer-process-limit=2"],
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await signIn(app.config.ownerToken, owner(app).id);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("unsaved notes survive tabs, panel closure, session changes, and a reload", real, async () => {
    const first = await newSession(app);
    const second = await newSession(app);

    await app.collab.saveNotes(first, owner(app), "Saved notes", 0);
    await go(first);
    await openNotes();
    await edit("My unfinished notes");
    await press("Chat");
    await waitInPage(`document.querySelector("textarea.notes") === null`, "the Chat tab");
    await press("Notes");
    await waitInPage(`document.querySelector("textarea.notes") !== null`, "the reopened Notes tab");
    assert.deepEqual(await notes(), {
        text: "My unfinished notes",
        unsaved: true,
        conflict: false,
    });

    await closeNotes();
    await openNotes();
    assert.equal((await notes()).text, "My unfinished notes");
    await go(second);
    await openNotes();
    assert.deepEqual(await notes(), { text: "", unsaved: false, conflict: false });
    await edit("Notes for another session");
    await go(first);
    await openNotes();
    assert.equal((await notes()).text, "My unfinished notes");
    await reload(first);
    assert.deepEqual(await notes(), {
        text: "My unfinished notes",
        unsaved: true,
        conflict: false,
    });
    await go(second);
    await openNotes();
    assert.equal((await notes()).text, "Notes for another session");
});

test("Save and Cancel clear kept drafts, including an empty edit", real, async () => {
    const id = await newSession(app);

    await go(id);
    await openNotes();
    await edit("Save this draft");
    await press("Save");
    await waitInPage(
        `(await import("/store.js")).store.state.notes?.text === "Save this draft" && !document.body.textContent.includes("unsaved changes")`,
        "the saved draft",
    );
    await reload(id);
    assert.deepEqual(await notes(), { text: "Save this draft", unsaved: false, conflict: false });

    await edit("");
    await reload(id);
    assert.deepEqual(await notes(), { text: "", unsaved: true, conflict: false });
    await press("Cancel");
    await reload(id);
    assert.deepEqual(await notes(), { text: "Save this draft", unsaved: false, conflict: false });
});

test("a restored draft keeps its base revision for Use theirs and Keep mine", real, async () => {
    const id = await newSession(app);
    const other = app.config.addUser("Another editor", "guest", [String(id)]).user;

    await app.collab.saveNotes(id, owner(app), "Original", 0);
    await go(id);
    await openNotes();
    await edit("My first draft");
    await closeNotes();
    await app.collab.saveNotes(id, other, "Their first change", 1);
    await reload(id);
    assert.deepEqual(await notes(), { text: "My first draft", unsaved: true, conflict: true });
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector(".notes + .row button.primary").disabled)`,
        ),
        true,
    );
    await press("Use theirs");
    await reload(id);
    assert.deepEqual(await notes(), {
        text: "Their first change",
        unsaved: false,
        conflict: false,
    });

    await edit("My second draft");
    await closeNotes();
    await app.collab.saveNotes(id, other, "Their second change", 2);
    await reload(id);
    assert.deepEqual(await notes(), { text: "My second draft", unsaved: true, conflict: true });
    await press("Keep mine");
    await waitInPage(
        `(await import("/store.js")).store.state.notes?.text === "My second draft" && !document.body.textContent.includes("unsaved changes")`,
        "the explicit overwrite",
    );
    await reload(id);
    assert.deepEqual(await notes(), { text: "My second draft", unsaved: false, conflict: false });
});

test(
    "different accounts in the same browser never inherit each other's notes draft",
    real,
    async () => {
        const id = await newSession(app);
        const guest = app.config.addUser("Guest editor", "guest", [String(id)]);

        await app.collab.saveNotes(id, owner(app), "Shared saved notes", 0);
        await go(id);
        await openNotes();
        await edit("Owner's unfinished notes");
        await page.evaluate(`void (await import("/store.js")).signOut(); "started"`);
        // me becomes null in the outgoing document. Wait for the new document before the next sign-in.
        await waitInPage(
            `document.readyState === "complete" && new URL(performance.getEntriesByType("navigation")[0].name).pathname === "/" && (await import("/store.js")).store.state.me === null`,
            "sign-out navigation to Home",
        );
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(Object.keys(localStorage)
            .some((key) => key.startsWith("pocket.person.") && key.includes(":notesDraft.")))`),
            false,
        );
        await signIn(guest.token, guest.user.id);
        await go(id);
        await openNotes();
        assert.deepEqual(await notes(), {
            text: "Shared saved notes",
            unsaved: false,
            conflict: false,
        });
        await edit("Guest's unfinished notes");
        await signIn(app.config.ownerToken, owner(app).id);
        await go(id);
        await openNotes();
        assert.deepEqual(await notes(), {
            text: "Shared saved notes",
            unsaved: false,
            conflict: false,
        });
        await signIn(guest.token, guest.user.id);
        await go(id);
        await openNotes();
        assert.deepEqual(await notes(), {
            text: "Guest's unfinished notes",
            unsaved: true,
            conflict: false,
        });
        await signIn(app.config.ownerToken, owner(app).id);
    },
);

for (const mode of ["blocked", "full"]) {
    test(
        `notes survive panel changes with ${mode} storage and warn about reload`,
        real,
        async () => {
            const id = await newSession(app);

            await go(id);
            await page.evaluate(`
            const methods = ["getItem", "setItem", "removeItem"];
            const original = Object.fromEntries(methods.map((name) => [name, Storage.prototype[name]]));

            window.__restoreNotesStorage = () => {
                for (const name of methods) {
                    Storage.prototype[name] = original[name];
                }
            };

            for (const name of methods) {
                Storage.prototype[name] = function (key, ...args) {
                    if (String(key).includes(":notesDraft.") && (${JSON.stringify(mode)} === "blocked" || name === "setItem")) {
                        throw new DOMException("Notes draft storage unavailable", ${JSON.stringify(mode === "blocked" ? "SecurityError" : "QuotaExceededError")});
                    }

                    return original[name].call(this, key, ...args);
                };
            }
        `);

            try {
                await openNotes();
                await edit(`Keep this with ${mode} storage`);
                await waitInPage(
                    `document.body.textContent.includes("This browser cannot keep this draft after a reload")`,
                    "the storage warning",
                );
                await press("Chat");
                await waitInPage(
                    `document.querySelector("textarea.notes") === null`,
                    "the Chat tab",
                );
                await press("Notes");
                await waitInPage(
                    `document.querySelector("textarea.notes") !== null`,
                    "the Notes tab",
                );
                assert.equal((await notes()).text, `Keep this with ${mode} storage`);
                await closeNotes();
                await openNotes();
                assert.equal((await notes()).text, `Keep this with ${mode} storage`);
            } finally {
                await page.evaluate(`window.__restoreNotesStorage()`);
            }

            await press("Cancel");
        },
    );
}

test("a failed notes save keeps the draft across a reload", real, async () => {
    const id = await newSession(app);

    await go(id);
    await openNotes();
    await edit("Keep this when saving fails");
    await page.evaluate(`
        const original = window.fetch;

        window.__restoreNotesFetch = () => { window.fetch = original; };
        window.fetch = (url, ...args) => String(url).endsWith("/notes")
            ? Promise.resolve(new Response(JSON.stringify({ error: "Notes save unavailable" }), {
                status: 503, headers: { "content-type": "application/json" },
            }))
            : original(url, ...args);
    `);

    try {
        await press("Save");
        await waitInPage(
            `document.body.textContent.includes("Notes save unavailable") && !document.querySelector(".notes + .row button.primary").disabled`,
            "the failed save with an editable draft",
        );
        assert.deepEqual(await notes(), {
            text: "Keep this when saving fails",
            unsaved: true,
            conflict: false,
        });
    } finally {
        await page.evaluate(`window.__restoreNotesFetch()`);
    }

    await reload(id);
    assert.deepEqual(await notes(), {
        text: "Keep this when saving fails",
        unsaved: true,
        conflict: false,
    });
});

test(
    "a late successful save clears only its original draft after panel and session changes",
    real,
    async () => {
        const first = await newSession(app);
        const second = await newSession(app);

        await go(first);
        await openNotes();
        await edit("Save while the panel is closed");
        await page.evaluate(`
        const original = window.fetch;
        let release;
        const held = new Promise((resolve) => { release = resolve; });

        window.__releaseNotesSave = release;
        window.__restoreNotesFetch = () => { window.fetch = original; };
        window.fetch = async (url, ...args) => {
            const response = await original(url, ...args);

            if (String(url).endsWith("/notes")) {
                window.__notesResponseHeld = true;
                await held;
            }

            return response;
        };
    `);

        try {
            await page.evaluate(`document.querySelector("textarea.notes").focus()`);
            await press("Save");
            await waitInPage(`window.__notesResponseHeld === true`, "the delayed Save response");
            assert.equal(
                await inPage<boolean>(`return JSON.stringify(
                document.activeElement === document.querySelector("textarea.notes") &&
                document.querySelector("textarea.notes").readOnly &&
                !document.querySelector("textarea.notes").disabled)`),
                true,
                "saving keeps the textarea focused",
            );
            await closeNotes();
            await openNotes();
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector("textarea.notes").readOnly)`,
                ),
                true,
                "reopening must not allow a second save or a replacement edit while Save is pending",
            );
            await go(second);
            await openNotes();
            await edit("Another session's unfinished notes");
            await page.evaluate(`window.__releaseNotesSave()`);
            await waitInPage(
                `(await import("/notes-drafts.js")).notesDrafts.get(${JSON.stringify(owner(app).id)}, ${Number(first)}).draft === null`,
                "the original draft's completion",
            );
            assert.deepEqual(await notes(), {
                text: "Another session's unfinished notes",
                unsaved: true,
                conflict: false,
            });
            await go(first);
            await openNotes();
            assert.deepEqual(await notes(), {
                text: "Save while the panel is closed",
                unsaved: false,
                conflict: false,
            });
        } finally {
            await page.evaluate(`window.__releaseNotesSave(); window.__restoreNotesFetch()`);
        }
    },
);
