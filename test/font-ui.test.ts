// The app's fonts, in a real browser where this machine has Chromium: the default look unchanged but for real italics
// and the Nerd Fonts icons, and an owner's theme that names the app's other fonts and turns ligatures on, which a guest
// chooses and sees, with only those files fetched, preloaded on a reload, and the message box measured again.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    say,
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
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script).catch(() => false)) === true, what);

type Look = {
    prose: string;
    code: string;
    ligatures: string;
    preloads: string[];
    loaded: string[];
    italics: string[];
};

/** Open the session afresh, as a reload would, and say which fonts it uses where. */
let opened = 0;

async function open(): Promise<Look> {
    await page.evaluate(`window.fontTestOldPage = true`);
    // A sheet just closed goes back through history a moment later, which cancels a navigation under way.
    await until(
        async () =>
            (await page.navigate(`${base}/s/${session}?open=${++opened}`)).error === undefined,
        "a navigation that is not cancelled",
    );
    await see(
        `return JSON.stringify(window.fontTestOldPage === undefined)`,
        "the page loaded again",
    );
    await see(
        `return JSON.stringify(document.querySelector(".md pre code .hl-com") !== null && document.fonts.status === "loaded")`,
        "the reply's code, and the fonts",
    );

    return inPage<Look>(`
        const first = (element) => getComputedStyle(element).fontFamily.split(",")[0].trim().replace(/"/g, "");
        const faces = [...document.fonts].filter((face) => face.status === "loaded");

        return JSON.stringify({
            prose: first(document.querySelector(".md p")),
            code: first(document.querySelector(".md pre code")),
            ligatures: getComputedStyle(document.querySelector(".md pre code")).fontVariantLigatures,
            preloads: [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((link) =>
                link.getAttribute("href").replace(/^\\/themes\\/[^/]+\\/[^/]+\\//, "theme:"),
            ),
            loaded: [...new Set(faces.map((face) => face.family))].toSorted(),
            italics: [...new Set(faces.filter((face) => face.style === "italic").map((face) => face.family))],
        });
    `);
}

/** Choose a theme in Appearance, as a person does. */
async function choose(name: string): Promise<void> {
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
    await see(
        `return JSON.stringify([...document.querySelectorAll(".look-grid > *")].some((card) => card.textContent.includes(${JSON.stringify(name)})))`,
        `the ${name} theme`,
    );
    await page.evaluate(`
        const card = [...document.querySelectorAll(".look-grid > *")].find((each) => each.textContent.includes(${JSON.stringify(name)}));

        (card.querySelector("button") ?? card).click();
    `);
    await see(
        `return JSON.stringify(document.documentElement.dataset.theme !== "pocket")`,
        `${name} in use`,
    );
    await page.evaluate(`(await import("/store.js")).closeSheet()`);
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    // The owner's theme: the app's own look, in Inter and Fira Code, with ligatures.
    const theme = join(app.dataDir, "themes", "reader");

    mkdirSync(theme, { recursive: true });
    writeFileSync(join(theme, "theme.json"), JSON.stringify({ themeApi: 1, name: "Reader" }));
    writeFileSync(
        join(theme, "theme.css"),
        `:root { --sans: "Pocket Inter", sans-serif; --mono: "Pocket Fira Code", "Pocket Nerd Symbols", monospace; --ligatures: contextual; }\n`,
    );
    await app.themes.load();

    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "font-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    session = await newSession(app);
    // The scripted model echoes it: a reply with words, and code with a comment (italic) and an arrow (a ligature).
    await say(
        app,
        session,
        "Some prose, then code:\n\n```js\n// a comment\nconst f = (x) => x !== 42;\n```",
    );
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    // A guest: the owner made the theme, anyone may choose it.
    const { token } = app.config.addUser("Guest", "guest");

    await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "guest")`,
        "signed in as a guest",
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
    "the default look keeps its fonts, with JetBrains Mono's own italic for comments",
    real,
    async () => {
        await page.evaluate(`localStorage.clear()`);

        const shown = await open();

        assert.equal(shown.prose, "Pocket Sans");
        assert.equal(shown.code, "Pocket Mono");
        assert.equal(shown.ligatures, "none");
        assert.deepEqual(shown.preloads, ["/fonts/Geist.woff2", "/fonts/JetBrainsMono.woff2"]);
        assert.deepEqual(shown.italics, ["Pocket Mono"], "the comment from its italic file");
        assert.ok(
            !shown.loaded.includes("Pocket Inter") && !shown.loaded.includes("Pocket Fira Code"),
            "no font unused",
        );
    },
);

test(
    "a guest who chooses the owner's theme gets its fonts and ligatures, preloaded on a reload",
    real,
    async () => {
        await page.evaluate(`localStorage.clear()`);
        await open();
        await choose("Reader");

        const shown = await open();

        assert.equal(shown.prose, "Pocket Inter");
        assert.equal(shown.code, "Pocket Fira Code");
        assert.equal(shown.ligatures, "contextual");
        assert.deepEqual(shown.preloads, [
            "/fonts/InterVariable.woff2",
            "/fonts/FiraCode-VF.woff2",
        ]);
        // JetBrains Mono may come too, for a character Fira Code lacks; Geist never.
        assert.ok(
            !shown.loaded.includes("Pocket Sans"),
            "the default font for words is not fetched",
        );
    },
);

test(
    "the message box measures again when a theme's font changes how its text wraps",
    real,
    async () => {
        await page.evaluate(`localStorage.clear()`);
        await open();
        // Wide letters: Inter's are wider than Geist's, so the text wraps onto more lines and the box must grow.
        await page.type({ selector: ".composer textarea" }, "WWWW ".repeat(30));

        // The height the box should have: its text's own, measured with nothing else on the page changing it. Its own
        // height is put back as it was: a fixed one would keep the box from sizing itself (`field-sizing`) after.
        const fits = `
        const box = document.querySelector(".composer textarea");
        const height = box.offsetHeight;
        const inline = box.style.height;

        box.style.height = "auto";
        const wanted = Math.min(box.scrollHeight, innerHeight * 0.4);
        box.style.height = inline;

        return JSON.stringify(Math.abs(height - wanted) <= 1 ? height : -1);
    `;
        const before = await inPage<number>(fits);

        assert.ok(before > 0, "the box fits its text in the default font");
        await choose("Reader");
        await see(
            `return JSON.stringify(getComputedStyle(document.querySelector(".composer textarea")).fontFamily.includes("Pocket Inter") && document.fonts.status === "loaded")`,
            "the box in the theme's font",
        );

        const after = await inPage<number>(fits);

        assert.ok(
            after > 0,
            "the box fits its text in the theme's font, with no typing to make it measure",
        );
        assert.ok(after > before, "the box grew with the wider font");
    },
);

test(
    "the Nerd Fonts icons come from a file that loads only for them, one cell wide",
    real,
    async () => {
        await page.evaluate(`localStorage.clear()`);

        const plain = await open();

        assert.ok(!plain.loaded.includes("Pocket Nerd Symbols"), "no icons, no icon file");

        const drawn = await inPage<{ width: number; loaded: boolean }>(`
        const icon = document.createElement("code");

        icon.textContent = "\\u{F07C}\\u{E0A0}";
        document.querySelector(".md").append(icon);
        await document.fonts.load("14px " + getComputedStyle(icon).fontFamily, icon.textContent);
        const width = icon.getBoundingClientRect().width;

        icon.textContent = "ab";
        const letters = icon.getBoundingClientRect().width;
        icon.remove();

        return JSON.stringify({
            width: Math.round((width / letters) * 100) / 100,
            loaded: [...document.fonts].some((face) => face.family === "Pocket Nerd Symbols" && face.status === "loaded"),
        });
    `);

        assert.ok(drawn.loaded, "the icons' file loads for an icon");
        assert.equal(drawn.width, 1, "each icon one letter wide, so columns line up");
    },
);

test(
    "the owner picks a theme's fonts in Appearance: they show at once, for whoever uses it, and stay",
    real,
    async () => {
        // A sheet just closed goes back through history a moment later, which cancels a navigation under way.
        await until(
            async () =>
                (
                    await page.navigate(
                        `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
                    )
                ).error === undefined,
            "a sign-in that is not cancelled",
        );
        // Signed in as the guest, the link asks first.
        await page.click({ selector: "form button" });
        await see(
            `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
            "signed in as the owner",
        );
        await page.evaluate(`localStorage.clear()`);
        await open();
        // The app's own look: its fonts, and a way to a copy that can change, not menus.
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
        await see(
            `const tools = document.querySelector(".font-tools");

            return JSON.stringify(tools?.querySelector(".font-title").textContent === "Fonts for Pocket" && tools.querySelector("select") === null && tools.textContent.includes("Geist") && tools.textContent.includes("JetBrains Mono") && tools.textContent.includes("Duplicate to change"))`,
            "Pocket's fonts, to duplicate",
        );
        await page.evaluate(`(await import("/store.js")).closeSheet()`);
        await choose("Reader");
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
        await see(
            `return JSON.stringify(document.querySelector(".font-title")?.textContent === "Fonts for Reader" && [...document.querySelectorAll(".font-tools select")].map((menu) => menu.value).join() === "Pocket Inter,Pocket Fira Code")`,
            "the menus showing the theme's fonts",
        );
        await page.select({ selector: ".font-tools .font-menu:nth-of-type(2) select" }, "Iosevka");
        await see(
            `return JSON.stringify(getComputedStyle(document.querySelector(".font-preview code")).fontFamily.startsWith('"Pocket Iosevka"'))`,
            "the preview in the new code font",
        );
        await page.evaluate(`document.querySelector('.font-tools [role="switch"]').click()`);
        await see(
            `return JSON.stringify(getComputedStyle(document.querySelector(".font-preview code")).fontVariantLigatures === "none")`,
            "ligatures switched off",
        );
        await page.evaluate(
            `[...document.querySelectorAll('.font-tools button')].find((button) => button.textContent.trim() === "Theme's own").click()`,
        );
        await see(
            `return JSON.stringify(getComputedStyle(document.querySelector(".font-preview code")).fontVariantLigatures === "contextual")`,
            "the theme's own ligatures restored",
        );
        await page.evaluate(`(await import("/store.js")).closeSheet()`);

        const shown = await open();

        assert.equal(shown.prose, "Pocket Inter", "the text font as it was");
        assert.equal(shown.code, "Pocket Iosevka");
        assert.equal(shown.ligatures, "contextual");
        assert.ok(
            shown.preloads.includes("/fonts/Iosevka-Regular.woff2"),
            "the new font preloaded",
        );
    },
);

test("message jumps use the app's motion choice instead of the OS query", real, async () => {
    await open();
    const modes = await inPage<string[]>(`
        const { setPrefs } = await import('/theme.js');
        const { jumpToEntry } = await import('/chat.js');
        const id = Number(document.querySelector('[id^="entry-"]').id.slice(6));
        const scroll = Element.prototype.scrollIntoView;
        const query = window.matchMedia;
        const modes = [];
        Element.prototype.scrollIntoView = (options) => modes.push(options.behavior);
        try {
            window.matchMedia = (text) => text === '(prefers-reduced-motion: reduce)' ? { matches: false } : query(text);
            setPrefs({ motion: 'reduced' });
            await jumpToEntry(id);
            window.matchMedia = (text) => text === '(prefers-reduced-motion: reduce)' ? { matches: true } : query(text);
            setPrefs({ motion: 'full' });
            await jumpToEntry(id);
        } finally {
            Element.prototype.scrollIntoView = scroll;
            window.matchMedia = query;
            setPrefs({ motion: 'auto' });
        }
        return JSON.stringify(modes);
    `);

    assert.deepEqual(modes, ["auto", "smooth"]);
});

/** Wait until the sheet stops moving: it rises as it opens, and a click mid-rise misses. */
const settled = () =>
    see(
        `const at = () => document.querySelector(".text-size-field input").getBoundingClientRect().top;
        const before = at();

        await new Promise((resolve) => setTimeout(resolve, 150));

        return JSON.stringify(document.getAnimations().length === 0 && at() === before);`,
        "the sheet at rest",
    );

test("any text size from 10 to 32 px can be typed, and stays", real, async () => {
    await page.evaluate(`localStorage.clear()`);
    await open();
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
    await see(
        `return JSON.stringify(document.querySelector(".text-size-field input") !== null)`,
        "the size field",
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('[role="group"][aria-label="Text size"]')?.contains(document.querySelector('.text-size-field input')))`,
        ),
        true,
    );
    await page.scroll({ selector: ".text-size-field input" });
    await settled();
    await page.type({ selector: ".text-size-field input" }, "27.5", { submit: true });
    await page.evaluate(`(await import("/store.js")).closeSheet()`);
    await open();

    const size = await inPage<string>(
        `return JSON.stringify(getComputedStyle(document.querySelector(".md p")).fontSize)`,
    );

    assert.equal(size, "27.5px");
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
    await see(
        `return JSON.stringify(document.querySelector(".text-size-field input") !== null)`,
        "the size field",
    );
    await page.scroll({ selector: ".text-size-field input" });
    await settled();
    await page.type({ selector: ".text-size-field input" }, "99", { submit: true });
    await see(
        `return JSON.stringify(document.querySelector(".text-size-field input").value === "32")`,
        "a size past the largest kept to it",
    );
});
