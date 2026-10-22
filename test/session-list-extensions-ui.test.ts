// The session list's extension points in a real Chromium (`pocket.sessionChips`, `sessionSearch`, `sessionFilter`, and
// `sessionAction`), through a drop-in that uses them all; and Session tags, the built-in module that uses them.
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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const dropIns = join(root, "data", "extensions");

/** Chips, words, a filter, and an action: what each gets and does goes on `globalThis`, for the test to read. */
const LABELS_JS = `export default (pocket) => {
	globalThis.labelsChips = pocket.sessionChips({
		id: "ids",
		chips: (session) => [{ label: "id" + session.id, title: session.title, run: () => (globalThis.chipRan = session.id) }],
	});
	globalThis.labelsWords = pocket.sessionSearch({ id: "words", words: (session) => { globalThis.wordsRead = (globalThis.wordsRead ?? 0) + 1; return ["word" + session.id]; } });
	globalThis.labelsFilter = pocket.sessionFilter({ id: "one", title: "Only one", icon: "grid", run: () => (globalThis.filterRan = true), started: (id) => (globalThis.started = id) });
	pocket.sessionAction({ id: "note", label: "Note", icon: "pin", run: (ids) => (globalThis.noted = [...ids]) });
};
`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let first: ConversationId;
let second: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** The ids of the rows the sidebar's list shows now. */
const rows = () =>
    inPage<number[]>(
        `return JSON.stringify([...document.querySelectorAll(".sidebar .session-row")].map((row) => Number(row.dataset.id)))`,
    );

const chipsOf = (id: ConversationId) =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll('.sidebar .session-row[data-id="${id}"] .session-chip')].map((chip) => chip.textContent.trim()))`,
    );

const value = <T>(name: string) => inPage<T>(`return JSON.stringify(globalThis.${name} ?? null)`);

/** Type into the sidebar's search as a person does. */
const search = (text: string) =>
    inPage(`
        const input = document.querySelector(".sidebar .search input");
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);

/** Ctrl/⌘+click rows, which selects them. */
const select = (ids: ConversationId[]) =>
    inPage(`
        for (const id of ${JSON.stringify(ids)}) {
            const button = document.querySelector('.sidebar .session-row[data-id="' + id + '"] .session');
            const box = button.getBoundingClientRect();
            const at = { bubbles: true, cancelable: true, ctrlKey: true, button: 0, buttons: 1, pointerType: "mouse", isPrimary: true, clientX: box.x + 30, clientY: box.y + 10, detail: 1 };
            button.dispatchEvent(new PointerEvent("pointerdown", at));
            window.dispatchEvent(new PointerEvent("pointerup", at));
            button.dispatchEvent(new MouseEvent("click", at));
        }
        return "null";
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(dropIns, "labels.ts"),
        `/** Labels: chips, words, a filter, and an action on sessions. */\nexport default (_host, web) => { web.client("labels.js", { access: "view" }); };\n`,
    );
    writeFileSync(join(dropIns, "labels.js"), LABELS_JS);
    app = await openApp(scriptedModel());
    first = await newSession(app);
    second = await newSession(app);
    await app.setExtensionEnabled(owner(app), "labels.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "session-list-ui-")),
        load: async () => undefined,
        save: () => {},
        // A mouse, whatever this machine has: rows draw their buttons only where a pointer can hover.
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(async () => (await chipsOf(first)).length > 0, "the labels' chips");
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "chips show under each row's title, and a chip with run is a button of its own",
    real,
    async () => {
        assert.deepEqual(await chipsOf(first), [`id${first}`]);
        assert.deepEqual(await chipsOf(second), [`id${second}`]);
        await page.click({ selector: `.sidebar .session-row[data-id="${second}"] .session-chip` });
        await until(async () => (await value<number>("chipRan")) === second, "the chip's run");
        assert.equal(
            await inPage<string>(`return JSON.stringify(location.pathname)`),
            "/",
            "a chip's tap does not open the session",
        );
    },
);

test("an actionable chip joins the keyboard focus order and Enter runs it", real, async () => {
    await inPage(
        `document.querySelector('.sidebar .session-row[data-id="${first}"] .session').focus(); return "null"`,
    );
    await page.press("Tab");
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.activeElement.matches('.session-chip'))`,
        ),
        true,
    );
    await page.press("Enter");
    await until(
        async () => (await value<number>("chipRan")) === first,
        "the chip's keyboard action",
    );
});

test("extension words are reused while typing and refreshed on update", real, async () => {
    await search("word");
    await until(async () => (await value<number>("wordsRead")) > 0, "the initial words");
    const before = await value<number>("wordsRead");

    for (const query of ["w", "wo", "wor", ""]) {
        await search(query);
    }

    assert.equal(await value<number>("wordsRead"), before);
    await inPage(`
        const { sessionWords } = await import('/extension-ui.js');
        const { store } = await import('/store.js');
        const session = store.state.sessions[0];
        sessionWords(session);
        sessionWords({ ...session, updatedAt: session.updatedAt + 1 });
        return "null";
    `);
    assert.equal(
        await value<number>("wordsRead"),
        before + 1,
        "a new session version gets new words",
    );
    await inPage(
        `globalThis.labelsWords.update({ words: (session) => ["newword" + session.id] }); return "null"`,
    );
    await search(`newword${second}`);
    await until(async () => (await rows()).join() === String(second), "updated words");
    await search("");
    await inPage(
        `globalThis.labelsWords.update({ words: (session) => ["word" + session.id] }); return "null"`,
    );
    await search(`word${second}`);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(document.querySelector('.sidebar .session-hit')?.textContent.trim() === 'word${second}')`,
            ),
        "the original words restored",
    );
    await search("");
});

test("the search and the launcher find a session by an extension's words", real, async () => {
    await search(`word${second}`);
    await until(async () => (await rows()).join() === String(second), "only the second session");
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".sidebar .session-hit")?.textContent.trim())`,
        ),
        `word${second}`,
        "the row says which word matched",
    );
    await search("");

    await inPage(`(await import("/store.js")).store.set({ launcher: true }); return "null"`);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(document.querySelector(".launcher input") !== null)`,
            ),
        "the launcher",
    );
    await inPage(`
        const input = document.querySelector(".launcher input");
        input.value = "word${first}";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);
    await until(
        async () =>
            (
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".launcher [role=listbox]")?.textContent ?? "")`,
                )
            ).includes(`word${first}`),
        "the session, with the word that matched",
    );
    await inPage(`(await import("/store.js")).store.set({ launcher: false }); return "null"`);
    // A click soon after a layer closed is let go (back.js): wait it out.
    await new Promise((resolve) => setTimeout(resolve, 600));
});

test(
    "a filter's button does its one thing, and while its match is set the list keeps only what it keeps",
    real,
    async () => {
        const button = '.sidebar [data-part="session-filter"]';

        await page.click({ selector: button });
        await until(async () => (await value<boolean>("filterRan")) === true, "the filter's run");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('${button}').getAttribute("data-state"))`,
            ),
            "off",
        );

        await inPage(
            `globalThis.labelsFilter.update({ match: (session) => session.id === ${first}, badge: 1 }); return "null"`,
        );
        await until(async () => (await rows()).join() === String(first), "only the first session");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('${button}').getAttribute("data-state"))`,
            ),
            "on",
        );

        await inPage(`globalThis.labelsFilter.update({ match: () => false }); return "null"`);
        await until(
            async () =>
                (await inPage<string>(
                    `return JSON.stringify(document.querySelector(".sidebar .sessions-empty")?.textContent.trim() ?? "")`,
                )) === "No sessions match the filters.",
            "the empty list's words",
        );

        await inPage(`globalThis.labelsFilter.update({ match: null, badge: null }); return "null"`);
        await until(async () => (await rows()).length === 2, "both sessions again");
    },
);

test(
    "an action on sessions shows in the selection bar, and gets the selected sessions",
    real,
    async () => {
        await select([first, second]);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".sidebar .select-bar")?.textContent.includes("Note") ?? false)`,
                ),
            "the action in the bar",
        );
        // The bar's: each row has a Note button too, where a mouse hovers.
        await inPage(
            `[...document.querySelectorAll(".sidebar .select-bar .button")].find((each) => each.textContent.trim() === "Note").click(); return "null"`,
        );
        await until(
            async () => ((await value<number[]>("noted")) ?? []).length === 2,
            "the action's run",
        );
        assert.deepEqual(((await value<number[]>("noted")) ?? []).sort(), [first, second].sort());
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".sidebar .select-bar") !== null)`,
            ),
            false,
            "the selection ends",
        );
    },
);

test("an action with an icon is a button on each row too", real, async () => {
    await inPage(`globalThis.noted = null; return "null"`);
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector('.sidebar .session-row[data-id="${first}"] .session-ext-act')?.getAttribute("aria-label") ?? null)`,
        ),
        "Note",
    );
    await inPage(
        `document.querySelector('.sidebar .session-row[data-id="${first}"] .session-ext-act').click(); return "null"`,
    );
    await until(
        async () => ((await value<number[]>("noted")) ?? []).join() === String(first),
        "the action on that row",
    );
});

test(
    "New in the list, while a filter is on, gives the new session to the filter's started",
    real,
    async () => {
        await inPage(`globalThis.labelsFilter.update({ match: () => true }); return "null"`);
        await page.click({ selector: ".sidebar .new-button" });
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll(".sheet button")].some((each) => each.textContent.trim() === "Open"))`,
                ),
            "the folder picker",
        );
        // A click soon after a layer opened is let go (back.js): wait it out.
        await new Promise((resolve) => setTimeout(resolve, 600));
        await page.click({ label: "Open" });
        await until(
            async () => typeof (await value<number>("started")) === "number",
            "the filter's started",
        );

        const started = await value<number>("started");

        assert.equal(
            await inPage<string>(`return JSON.stringify(location.pathname)`),
            `/s/${started}`,
        );
        await inPage(`globalThis.labelsFilter.update({ match: null }); return "null"`);
        await page.navigate(`${base}/`);
        await until(async () => (await rows()).length === 3, "the three sessions");
    },
);

test("async session readers report a module error without hiding the list", real, async () => {
    for (const [handle, field] of [
        ["labelsChips", "chips"],
        ["labelsFilter", "match"],
        ["labelsWords", "words"],
    ]) {
        await inPage(
            `globalThis.${handle}.update({ ${field}: async () => { throw new Error("async reader"); } }); return "null"`,
        );

        if (field === "words") {
            await search("word");
        }

        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify((await import("/extension-ui.js")).browserModuleState("labels")?.status === "failed")`,
                ),
            "the async reader's module stopped",
        );
        await search("");
        await until(async () => (await rows()).length === 3, "a bad reader does not hide sessions");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.body.textContent.includes("must return its value directly, not a promise"))`,
            ),
            true,
        );
        await page.navigate(`${base}/`);
        await until(async () => (await chipsOf(first)).length > 0, "the module loaded again");
    }
});

test("chips that throw stop their module, and the list draws without them", real, async () => {
    await inPage(
        `globalThis.labelsChips.update({ chips: () => { throw new Error("boom"); } }); return "null"`,
    );
    await until(async () => (await chipsOf(first)).length === 0, "no chips");
    await until(
        async () =>
            (
                await inPage<{ status: string } | null>(
                    `return JSON.stringify((await import("/extension-ui.js")).browserModuleState("labels") ?? null)`,
                )
            )?.status === "failed",
        "the module stopped",
    );
    assert.equal((await rows()).length, 3, "the list still shows every session");
});

test(
    "Session tags: tags show as chips, and a tap on one filters the list by it",
    real,
    async () => {
        await app.setExtensionEnabled(owner(app), "labels.ts", false);
        await app.setExtensionEnabled(owner(app), "session-tags.ts", true);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.sidebar [data-part="session-filter"]') !== null)`,
                ),
            "the tag filter",
        );

        const tagged = await inPage<number>(`
        const answer = await fetch("/api/x/session-tags/tags", {
            method: "POST",
            headers: { "content-type": "application/json", "x-pocket": "1" },
            body: JSON.stringify({ ids: [${first}], add: ["Review"] }),
        });
        return JSON.stringify(answer.status);
    `);

        assert.equal(tagged, 200);
        await until(async () => (await chipsOf(first)).join() === "review", "the tag on its row");
        assert.deepEqual(await chipsOf(second), []);
        await page.click({ selector: `.sidebar .session-row[data-id="${first}"] .session-chip` });
        await until(async () => (await rows()).join() === String(first), "only the tagged session");
        await inPage(`sessionStorage.removeItem("pocket.session-tags.filter"); return "null"`);
    },
);
