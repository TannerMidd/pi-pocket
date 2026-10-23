// Focus regressions include #62, reported by @arunsathiya: reopening must focus the native search input, and an
// action's new sheet must keep its focus when the old launcher finishes leaving.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const INPUT = ".launcher input";
const TITLES = ["Alpha notes", "Alpha release"];

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
const sessions: ConversationId[] = [];

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (script: string, what: string) =>
    until(async () => await inPage<boolean>(script), what);
const focused = () =>
    inPage<boolean>(
        `return JSON.stringify(document.activeElement === document.querySelector(${JSON.stringify(INPUT)}))`,
    );
const value = () =>
    inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(INPUT)}).value)`);

const settle = () =>
    page.evaluate(`
        await Promise.all(document.getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map((animation) => animation.finished.catch(() => {})));
        for (let frame = 0; frame < 3; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    `);

async function home(viewport: Viewport = VIEWPORTS.desktop, session = false): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/${session ? `s/${sessions[0]}` : ""}`);
    await see(
        `
        const { store } = await import("/store.js");

        return JSON.stringify(store.state.sessions.length === ${TITLES.length} &&
            ( ${session} ? document.querySelector(".composer textarea") !== null :
                document.querySelector(".home-list") !== null));
    `,
        "the isolated session list",
    );
    await settle();
}

async function open(): Promise<void> {
    await page.press("Control+K");
    await until(focused, "the launcher's native input focused");
    await settle();
}

/** Use an input event for replacement, not key aliases which the launcher intentionally intercepts. */
async function search(text: string): Promise<void> {
    await page.evaluate(`
        const input = document.querySelector(${JSON.stringify(INPUT)});

        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await see(
        `return JSON.stringify(document.querySelector(${JSON.stringify(INPUT)}).value === ${JSON.stringify(text)})`,
        "the new query rendered",
    );
    await settle();
}

async function closed(): Promise<void> {
    await see(
        `return JSON.stringify(document.querySelector(".launcher") === null)`,
        "the launcher removed",
    );
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());

    for (const [index, title] of TITLES.entries()) {
        const cwd = join(work, `project-${index}`);

        mkdirSync(cwd);
        const id = await newSession(app, cwd);

        sessions.push(id);
        await app.commands.updateSession(id, owner(app), {
            title,
        });
    }

    server = createServer(
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "launcher-ui-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("open resets query and focus", real, async () => {
    await home(VIEWPORTS.desktop, true);
    await page.evaluate(`document.querySelector('.composer textarea').focus()`);
    await open();

    await search("@ alpha");
    await page.press("ArrowDown");
    const reopened = await inPage<boolean>(`
                const { store } = await import('/store.js');

                store.set({ launcher: false });

                // Observe the inert leaving node and reopen within the page, not over two CDP round trips.
                for (let frame = 0; frame < 10; frame++) {
                    await new Promise((resolve) => requestAnimationFrame(resolve));

                    if (document.querySelector('.launcher-overlay')?.inert === true) {
                        store.set({ launcher: true });

                        return JSON.stringify(true);
                    }
                }

                return JSON.stringify(false);
            `);

    assert.equal(reopened, true, "the leaving state was observed before reopening");

    await until(focused, "reopened launcher focused");
    await settle();
    assert.equal(await value(), "", "leaving reopen resets query");
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('.launcher-overlay').inert)`,
        ),
        false,
    );

    await page.press("Escape");
    await closed();
    await see(
        `return JSON.stringify(document.activeElement === document.querySelector('.composer textarea'))`,
        "Escape restores composer focus after launcher cleanup",
    );
});

test(
    "New session opens the folder sheet and its final focus is not stolen by launcher cleanup",
    real,
    async () => {
        await home(VIEWPORTS.desktop, true);
        await page.evaluate(`document.querySelector('.composer textarea').focus()`);
        await open();
        await search("> new session");
        await page.press("Enter");
        await see(
            `return JSON.stringify((await import('/store.js')).store.state.sheet?.type === 'cwd' && document.querySelector('.sheet-host:not(.leaving) .sheet') !== null)`,
            "the New session folder sheet",
        );
        await closed();
        await settle();
        assert.equal(
            await inPage<boolean>(`
        const sheet = document.querySelector('.sheet-host:not(.leaving) .sheet');

        return JSON.stringify(sheet === document.activeElement || sheet.contains(document.activeElement));
    `),
            true,
            "the folder sheet retains focus after the leaving launcher unmounts",
        );
        await page.evaluate(`(await import('/store.js')).closeSheet()`);
        await settle();
    },
);

test("Peeks finds the action by its feature name", real, async () => {
    await home();
    await open();
    await search("Peeks");
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify([...document.querySelectorAll('.launcher-item')].some((row) => /peek tiles/i.test(row.textContent)))`,
        ),
        true,
    );
    await page.press("Escape");
    await closed();
});

test(
    "rapid Fluid layout changes handle skipped transitions and stop the sidebar's own transition",
    real,
    async () => {
        await home(VIEWPORTS.desktop, true);
        const result = await inPage<{ errors: string[]; durations: string[]; active: boolean }>(`
        const { setPrefs, prefs, chooseTheme } = await import('/theme.js');
        const originalTheme = prefs().theme;
        const errors = [];
        const durations = [];
        const rejected = (event) => errors.push(String(event.reason));
        addEventListener('unhandledrejection', rejected);
        setPrefs({ motion: 'fluid' });
        const observer = new MutationObserver(() => {
            if (document.documentElement.classList.contains('layout-vt')) {
                durations.push(getComputedStyle(document.querySelector('.sidebar')).transitionDuration);
            }
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        for (let i = 0; i < 12; i++) {
            setPrefs({ sidebar: prefs().sidebar === 'rail' ? 'open' : 'rail' });
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        chooseTheme('nord');
        await new Promise((resolve) => setTimeout(resolve, 25));
        chooseTheme('catppuccin');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        observer.disconnect();
        removeEventListener('unhandledrejection', rejected);
        const active = document.documentElement.matches('.layout-vt, .theme-vt');
        setPrefs({ motion: 'auto', sidebar: 'open', theme: originalTheme });
        return JSON.stringify({ errors, durations, active });
    `);

        assert.deepEqual(result.errors, []);
        assert.ok(result.durations.length > 0, "the layout morphed");
        assert.ok(result.durations.every((duration) => duration === "0s"));
        assert.equal(result.active, false, "the morph class was removed");
    },
);

// Last: it starts a session, and home() counts them. PR #92 by @elithecho.
test(
    "a favorite folder shows while the launcher is open and starts a session there",
    real,
    async () => {
        const folder = join(work, "project-1");

        await home();
        await open();
        await search("> project-1");
        await page.evaluate(
            `(await import('/store.js')).api('folder-favorites', { path: ${JSON.stringify(folder)}, starred: true })`,
        );
        await see(
            `return JSON.stringify(!!document.querySelector('.launcher-item.on')?.textContent.includes('project-1'))`,
            "the favorite's action",
        );
        await page.press("Enter");
        await see(
            `const { store } = await import('/store.js');

        return JSON.stringify(store.state.view.agent?.cwd === ${JSON.stringify(folder)} && !store.state.sheet);`,
            "a session in the favorite, without the folder picker",
        );
    },
);

// Last too: it starts a session. Issue #96, reported by @poncardasm: New never used the folder you were in.
test("New session here starts in the open session's folder", real, async () => {
    const folder = join(work, "project-0");

    await page.navigate(`${base}/s/${sessions[0]}`);
    await see(
        `const { store } = await import('/store.js');

        return JSON.stringify(store.state.view.agent?.cwd === ${JSON.stringify(folder)} && !store.state.sheet);`,
        "the session in project-0",
    );
    await settle();

    // New itself opens the picker there, with no walking to the folder.
    await page.press("Alt+n");
    await see(
        `
        const { store } = await import('/store.js');
        const { shortPath } = await import('/ui.js');

        // As the picker shows it: a folder under the home folder is ~/…, and a build's sandbox puts the
        // test's folder there.
        return JSON.stringify(document.querySelector('.fp-target .mono')?.textContent ===
            shortPath(${JSON.stringify(folder)}, store.state.server?.home));
    `,
        "the New session picker at the session's folder",
    );
    await page.evaluate(`(await import('/store.js')).closeSheet()`);
    await settle();

    // And the launcher starts there, without the picker.
    await open();
    await search("> new session here");
    await page.press("Enter");
    await see(
        `const { store } = await import('/store.js');

        return JSON.stringify(store.state.view.agent?.cwd === ${JSON.stringify(folder)} &&
            store.state.sessions.filter((session) => session.cwd === ${JSON.stringify(folder)}).length === 2 &&
            !store.state.sheet);`,
        "a session in the same folder, without the folder picker",
    );
});
