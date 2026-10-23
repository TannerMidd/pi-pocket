// Keys that extensions give the message boxes (`pocket.composerKey`), in a real Chromium, through a drop-in: Ctrl+W
// deletes a word and keeps the draft, a key that returns false goes through, and the shortcuts sheet lists them.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { owner } from "./helpers.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const dropIns = join(root, "data", "extensions");

/** Ctrl+W as in a terminal, and Ctrl+E, which only counts and lets the key through. */
const KEYS_JS = `export default (pocket) => {
    pocket.composerKey({
        id: "conflicts", keys: ["Alt+N", "Mod+K"], label: "Take an app key",
        run(box) { globalThis.conflictWhere = box.where; globalThis.conflicts = (globalThis.conflicts ?? 0) + 1; },
    });
	pocket.composerKey({
		id: "delete-word",
		keys: "Ctrl+W",
		label: "Delete the word before the caret",
		run(box) {
			globalThis.where = box.where;
			const start = box.start === box.end ? box.text.slice(0, box.start).replace(/\\S+\\s*$|\\s+$/, "").length : box.start;
			box.set(box.text.slice(0, start) + box.text.slice(box.end), start);
		},
	});
	pocket.composerKey({
		id: "count",
		keys: ["Ctrl+E", "Alt+Backspace"],
		label: "Count",
		run() {
			globalThis.counted = (globalThis.counted ?? 0) + 1;
			return false;
		},
	});
};
`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Type into the session's message box as a person does, with the caret at the end. */
const typeInBox = (text: string) =>
    inPage(`
        const box = document.querySelector(".composer textarea");
        box.focus();
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.setSelectionRange(box.value.length, box.value.length);
        return "null";
    `);

/** A keydown in the box: whether the page let it through (not prevented). */
const key = (init: KeyboardEventInit) =>
    inPage<boolean>(`
        const box = document.querySelector(".composer textarea");
        return JSON.stringify(box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...${JSON.stringify(init)} })));
    `);

const boxText = () =>
    inPage<string>(`return JSON.stringify(document.querySelector(".composer textarea").value)`);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(dropIns, "keys.ts"),
        `/** Keys: Ctrl+W in the message box. */\nexport default (_host, web) => { web.client("keys.js", { access: "view" }); };\n`,
    );
    writeFileSync(join(dropIns, "keys.js"), KEYS_JS);
    app = await openApp(scriptedModel());
    session = await newSession(app);
    await app.setExtensionEnabled(owner(app), "keys.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "composer-keys-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".composer textarea")) && performance.getEntriesByType("resource").some((each) => each.name.includes("keys.js")))`,
            ),
        "the keys' browser module",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "Ctrl+W from a module deletes the word before the caret, and the box keeps it",
    real,
    async () => {
        await typeInBox("one two three");
        assert.equal(
            await key({ key: "w", code: "KeyW", ctrlKey: true }),
            false,
            "it took the key",
        );
        await until(async () => (await boxText()) === "one two ", "the word deleted");
        assert.equal(await key({ key: "w", code: "KeyW", ctrlKey: true }), false);
        await until(async () => (await boxText()) === "one ", "the next word deleted");
        assert.equal(await inPage<string>(`return JSON.stringify(globalThis.where)`), "session");
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelector(".composer textarea").selectionStart)`,
            ),
            4,
            "the caret where the word was",
        );
    },
);

test(
    "a key whose run returns false goes through, and Ctrl+Shift+W is not Ctrl+W",
    real,
    async () => {
        await typeInBox("keep this");
        assert.equal(await key({ key: "e", code: "KeyE", ctrlKey: true }), true, "let through");
        assert.equal(await key({ key: "Backspace", code: "Backspace", altKey: true }), true);
        assert.equal(await inPage<number>(`return JSON.stringify(globalThis.counted)`), 2);
        assert.equal(await key({ key: "W", code: "KeyW", ctrlKey: true, shiftKey: true }), true);
        assert.equal(await boxText(), "keep this");
    },
);

test("a taken app key opens neither a sheet nor the launcher, in both boxes", real, async () => {
    for (const where of ["session", "pip"]) {
        if (where === "pip") {
            await inPage(`(await import("/pip.js")).openPip(); return "null"`);
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(Boolean(document.querySelector(".pip-composer textarea")))`,
                    ),
                "PiP's box",
            );
        }

        const selector = where === "pip" ? ".pip-composer textarea" : ".composer textarea";

        for (const init of [
            { key: "n", code: "KeyN", altKey: true },
            { key: "k", code: "KeyK", ctrlKey: true },
        ]) {
            await inPage(`
                document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...${JSON.stringify(init)} }));
                return "null";
            `);
            assert.equal(
                await inPage<string>(`return JSON.stringify(globalThis.conflictWhere)`),
                where,
            );
            assert.equal(
                await inPage<boolean>(
                    `const { store } = await import("/store.js"); return JSON.stringify(Boolean(store.state.sheet || store.state.launcher))`,
                ),
                false,
            );
        }
    }

    assert.equal(await inPage<number>(`return JSON.stringify(globalThis.conflicts)`), 4);
    await inPage(`(await import("/pip.js")).closePip(); return "null"`);
});

test("the Keyboard shortcuts sheet lists the modules' keys", real, async () => {
    await inPage(`document.activeElement?.blur(); return "null"`);
    await page.press("?");
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.body.textContent.includes("Message box: from extensions"))`,
            ),
        "the extensions' group",
    );
    const text = await inPage<string>(`return JSON.stringify(document.body.textContent)`);

    assert.match(text, /Delete the word before the caret \(keys\)/);
    assert.match(text, /Count \(keys\)/);
});

test(
    "Alt+↓ in the model menu still switches sessions: the list keeps only plain arrows",
    real,
    async () => {
        const other = await newSession(app);

        await until(
            () =>
                inPage<boolean>(
                    `const { store } = await import("/store.js"); return JSON.stringify(store.state.sessions.some((each) => each.id === ${Number(other)}))`,
                ),
            "the second session in the list",
        );
        await inPage(`(await import("/store.js")).openSheet({ type: "model" }); return "null"`);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector('[role="dialog"][aria-label="Model"]')))`,
                ),
            "the model menu",
        );
        const before = await inPage<number>(
            `return JSON.stringify((await import("/store.js")).store.state.conversationId)`,
        );

        await inPage(`
        const menu = document.querySelector('[role="dialog"][aria-label="Model"]');
        const at = menu.querySelector(".pop-menu-search input") ?? menu;
        at.focus();
        at.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
        return "null";
    `);
        await until(
            async () =>
                (await inPage<number>(
                    `return JSON.stringify((await import("/store.js")).store.state.conversationId)`,
                )) !== before,
            "another session open",
        );
        await inPage(`(await import("/store.js")).closeSheet(); return "null"`);
    },
);
