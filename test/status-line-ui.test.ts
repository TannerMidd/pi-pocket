// The status line's reply speed, in a real browser where this machine has Chromium: off until Appearance (or the
// launcher) turns it on, in a new browser and in one that saved its appearance before the setting was there, and the
// line under the message box keeps to one row at phone widths with everything in it showing.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    recordCost,
    root,
    say,
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
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
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
/** A session whose last answer streamed long enough to have a speed. */
let measured: ConversationId;

const phone = (width: number): Viewport => ({ ...VIEWPORTS.mobile, width });

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what);

/**
 * In the page: the words an element shows, leaving out those hidden and those only a screen reader gets. Text in
 * another element is apart from the text before it ("87 tok/s 1.2s"); text in the same one runs on ("77%").
 */
const SHOWN_TEXT = `
    const shownText = (root) => {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let text = "";
        let last = null;

        while (walk.nextNode()) {
            const parent = walk.currentNode.parentElement;

            if (parent.getClientRects().length > 0 && parent.getBoundingClientRect().width > 1) {
                text += (parent === last ? "" : " ") + walk.currentNode.textContent;
                last = parent;
            }
        }

        return text.replace(/\\s+/g, " ").trim();
    };
`;

/** The status line's speed, as it shows: its words, or null when there is none. */
const speedShown = () =>
    inPage<string | null>(`
        ${SHOWN_TEXT}
        const speed = document.querySelector(".status-line .speed");

        return JSON.stringify(speed && speed.getClientRects().length > 0 ? shownText(speed) : null);
    `);

/** The whole status line's words, as they show. */
const lineShown = () =>
    inPage<string>(`
        ${SHOWN_TEXT}

        return JSON.stringify(shownText(document.querySelector(".status-line")));
    `);

/** Neither the speed nor any word of it shows. */
async function noSpeed(what: string): Promise<void> {
    assert.equal(await speedShown(), null, what);
    assert.doesNotMatch(await lineShown(), /tok|first token|TTFT/, what);
}

/** The Appearance sheet's Reply speed switch: whether it is on. */
const switchOn = () =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector('[role="switch"][aria-label="Reply speed"]').getAttribute("aria-checked") === "true")`,
    );

/** Open Appearance, and flip its Reply speed switch. */
async function flipSwitch(): Promise<void> {
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
    await see(
        `return JSON.stringify(document.querySelector('[role="switch"][aria-label="Reply speed"]') !== null)`,
        "the Reply speed switch",
    );
    await page.evaluate(
        `document.querySelector('[role="switch"][aria-label="Reply speed"]').click()`,
    );
}

/** Wait for the page's animations that end (a sheet's rise, the conversation's slide in) to end. */
const settle = () =>
    page.evaluate(`
        await Promise.all(
            document
                .getAnimations()
                .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
                .map((animation) => animation.finished.catch(() => {})),
        );
    `);

/** Open the measured session at `viewport`, and wait for its status line with the speed's figures in hand. */
async function open(viewport = VIEWPORTS.mobile): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${measured}`);
    await see(
        `
            const { store } = await import("/store.js");

            return JSON.stringify(
                document.querySelector(".status-line") !== null &&
                    store.state.view.stats?.tokensPerSec !== undefined &&
                    store.state.view.stats?.ttftMs !== undefined,
            );
        `,
        "the status line, with the last answer's speed",
    );
    await settle();
}

type Line = {
    rows: number;
    left: number;
    right: number;
    width: number;
    short: string;
    shown: string[];
};

/** How the status line lies: how many rows its items take, its ends, the shorter forms it took, and what shows. */
const line = () =>
    inPage<Line>(`
        const line = document.querySelector(".status-line");
        const shown = [...line.querySelectorAll(":scope > *, .speed > *, .meter")]
            .filter((element) => element.getClientRects().length > 0)
            .map((element) => element.className.split(" ")[0] || element.textContent.trim());
        const boxes = [...line.children]
            .map((child) => child.getBoundingClientRect())
            .filter((box) => box.width > 0);
        const middles = boxes.map((box) => box.top + box.height / 2).sort((a, b) => a - b);

        return JSON.stringify({
            rows: 1 + middles.filter((middle, n) => n > 0 && middle - middles[n - 1] > 4).length,
            left: Math.min(...boxes.map((box) => box.left)),
            right: Math.max(...boxes.map((box) => box.right)),
            width: innerWidth,
            short: line.dataset.short ?? "",
            shown,
        });
    `);

/** Wait until the line is on one row with the guard in it, and give back how it lies. */
async function oneRow(what: string): Promise<Line> {
    let last: Line | undefined;

    try {
        await until(async () => {
            last = await line();

            return last.rows === 1 && last.shown.includes("guard");
        }, what);
    } catch {
        assert.fail(`${what}: the line is ${JSON.stringify(last)}`);
    }

    return last!;
}

/**
 * Everything the line can show, with the figures of a real model: 87 tokens a second, a first token after 1.2 seconds,
 * a context 77% full (98,000 of the scripted model's 128,000 tokens), and the guard on (the scripted model is far
 * faster, and the test app has no Lancet Guard to load). `more` runs after, with `store` in hand: a spend limit, say,
 * or more people.
 */
const everything = (more = "") =>
    page.evaluate(`
        const { store } = await import("/store.js");
        const view = store.state.view;

        store.set({
            view: { ...view, stats: { ...view.stats, tokensPerSec: 87.4, ttftMs: 1240, cacheRate: 0.83, contextTokens: 98_000 } },
            guard: { available: true, enabled: true, detail: "Lancet Guard is on." },
        });
        ${more}
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "status-line-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    measured = await newSession(app);
    // Echoed back at the scripted model's 2,000 tokens a second: long enough to measure a speed.
    await say(
        app,
        measured,
        Array.from({ length: 300 }, (_, n) => `line ${n} of a long answer`).join("\n"),
    );
    await recordCost(app, measured, 12.34);
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
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

test(
    "the reply speed is off until Appearance turns it on, and goes when it is turned off",
    real,
    async () => {
        // A new browser: nothing saved.
        await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
        await open(VIEWPORTS.desktop);
        await noSpeed("a new browser shows no speed");

        // A browser that saved its appearance before the setting was there.
        await page.evaluate(
            `localStorage.setItem("pocket.appearance", JSON.stringify({ theme: "tokyo-night", peeks: false, text: 14 }))`,
        );
        await open(VIEWPORTS.desktop);
        await noSpeed("older saved settings show no speed");
        await open(VIEWPORTS.mobile);
        await noSpeed("nor on a phone");

        await open(VIEWPORTS.desktop);
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
        await see(
            `return JSON.stringify(document.querySelector('[role="switch"][aria-label="Reply speed"]') !== null)`,
            "the Reply speed switch",
        );
        assert.equal(await switchOn(), false, "the switch starts off");

        await flipSwitch();
        await until(async () => (await speedShown()) !== null, "the speed, once turned on");
        assert.equal(await switchOn(), true);
        // Wide, in full words: how many tokens a second, and how long the first token took.
        assert.match((await speedShown())!, /^\d+ tokens\/s first token \d+\.\ds$/);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(JSON.parse(localStorage.getItem("pocket.appearance")).speed)`,
            ),
            true,
            "saved in this browser",
        );

        // Kept across a reload.
        await open(VIEWPORTS.desktop);
        assert.notEqual(await speedShown(), null, "still on after a reload");

        // And gone, everywhere, once turned off again.
        await flipSwitch();
        await until(async () => (await speedShown()) === null, "the speed gone, once turned off");
        assert.equal(await switchOn(), false);
        await noSpeed("off again");
        await page.evaluate(`(await import("/store.js")).closeSheet()`);
        await open(VIEWPORTS.mobile);
        await noSpeed("off on a phone too");
    },
);

test("the launcher shows and hides the reply speed", real, async () => {
    await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
    await open(VIEWPORTS.desktop);

    for (const [label, on] of [
        ["Show reply speed", true],
        ["Hide reply speed", false],
    ] as const) {
        await page.press("Control+K");
        await see(
            `return JSON.stringify(document.activeElement === document.querySelector(".launcher input"))`,
            "the launcher",
        );
        await page.type(undefined, "reply speed");
        await see(
            `return JSON.stringify(document.querySelector(".launcher-item.on")?.textContent.includes(${JSON.stringify(label)}) === true)`,
            label,
        );
        await page.press("Enter");
        await until(
            async () => ((await speedShown()) !== null) === on,
            on ? "the speed shown" : "the speed hidden",
        );
        await see(`return JSON.stringify(document.querySelector(".launcher") === null)`, "closed");
    }
});

test(
    "with the speed on, the status line keeps to one row at phone widths, with everything showing",
    real,
    async () => {
        await page.evaluate(
            `localStorage.setItem("pocket.appearance", JSON.stringify({ speed: true }))`,
        );

        for (const width of [320, 360, 375, 390, 412, 430]) {
            await open(phone(width));
            await everything();
            const at = await oneRow(`one row at ${width}px`);

            assert.ok(
                at.left >= 0 && at.right <= at.width,
                `at ${width}px it fits the screen: ${JSON.stringify(at)}`,
            );

            // The figures that matter most never go: the speed, the context, the spend, and the guard.
            for (const part of ["speed", "rate", "context", "meter", "guard"]) {
                assert.ok(at.shown.includes(part), `at ${width}px ${part} shows: ${at.shown}`);
            }

            assert.ok(
                at.shown.some((each) => each.startsWith("$12.34")),
                `at ${width}px the spend shows: ${at.shown}`,
            );

            // An iPhone's width keeps everything: the cache, and the wait for the first token after a dot.
            if (width >= 390) {
                assert.ok(at.shown.includes("cache"), `at ${width}px the cache shows: ${at.shown}`);
                assert.equal(await speedShown(), "87 tok/s 1.2s");
                assert.equal(
                    await inPage<string>(
                        `return JSON.stringify(getComputedStyle(document.querySelector(".speed .wait"), "::before").content)`,
                    ),
                    '"·"',
                );
            }

            // The words that go still name their figures for a screen reader, and the guard, down to its shield,
            // still takes a thumb.
            if (width === 390) {
                assert.equal(
                    await inPage<string>(
                        `return JSON.stringify(document.querySelector(".status-line").innerText.replace(/\\s+/g, " ").trim())`,
                    ),
                    "87 tok/s first token 1.2s context 77% cache 83% $12.34 on",
                );
                const guard = await inPage<{ w: number; h: number; label: string }>(`
                    const guard = document.querySelector(".status-line .guard");
                    const box = guard.getBoundingClientRect();

                    return JSON.stringify({ w: box.width, h: box.height, label: guard.getAttribute("aria-label") });
                `);

                assert.ok(
                    guard.w >= 40 && guard.h >= 34,
                    `the guard takes a thumb: ${JSON.stringify(guard)}`,
                );
                assert.equal(guard.label, "Lancet Guard on");
            }
        }

        // More people, and a spend limit, at an iPhone's width, still keep to one row.
        await open(VIEWPORTS.mobile);
        await everything(`
            const now = store.state.view;

            store.set({
                presence: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
                view: { ...now, conversation: { ...now.conversation, spend: { spent: 12.34, budget: 50 } } },
            });
        `);
        const crowded = await oneRow("one row with three here and a limit");

        assert.ok(crowded.shown.includes("here"), `three here shows: ${crowded.shown}`);
        assert.ok(
            crowded.shown.some((each) => each.startsWith("$12.34/$50.00")),
            `the limit shows: ${crowded.shown}`,
        );

        // The largest text size, at an iPhone's width, keeps to one row too.
        await page.evaluate(
            `localStorage.setItem("pocket.appearance", JSON.stringify({ speed: true, text: 16 }))`,
        );
        await open(VIEWPORTS.mobile);
        await everything();
        await oneRow("one row with the largest text");

        // Wide, nothing is left out or shortened.
        await page.evaluate(
            `localStorage.setItem("pocket.appearance", JSON.stringify({ speed: true }))`,
        );
        await open(VIEWPORTS.desktop);
        await everything();
        const wide = await oneRow("one row, wide");

        assert.equal(wide.short, "", `wide, the line is whole: ${JSON.stringify(wide)}`);
        assert.match(
            await lineShown(),
            /^1 here 87 tokens\/s first token 1\.2s context 77% cache 83% \$12\.34 guard on$/,
        );

        // Narrowed and widened again on the same page, without a reload: it shortens, then is whole again.
        await page.setViewport(VIEWPORTS.mobile);
        await until(async () => (await line()).short !== "", "shortened at a phone's width");
        await oneRow("one row after narrowing");
        await page.setViewport(VIEWPORTS.desktop);
        await until(async () => (await line()).short === "", "whole again, wide");
    },
);

test(
    "turned on and off while the page is open, the phone's line stays on one row",
    real,
    async () => {
        await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
        await open(VIEWPORTS.mobile);
        await everything();
        const before = await oneRow("one row with the speed off");

        // Without the speed, an iPhone's width shows the line whole, as it was before the setting.
        assert.equal(before.short, "", `nothing shortened: ${JSON.stringify(before)}`);

        await flipSwitch();
        await page.evaluate(`(await import("/store.js")).closeSheet()`);
        await settle();
        await until(async () => (await speedShown()) === "87 tok/s 1.2s", "the speed, in short");
        await oneRow("one row with the speed turned on");

        await flipSwitch();
        await page.evaluate(`(await import("/store.js")).closeSheet()`);
        await settle();
        await until(async () => (await speedShown()) === null, "the speed gone");
        await until(async () => (await line()).short === "", "whole again");
    },
);

test("with the speed off, a narrow phone's line keeps to one row too", real, async () => {
    await page.evaluate(`localStorage.removeItem("pocket.appearance")`);

    for (const width of [320, 360]) {
        await open(phone(width));
        await everything();
        const at = await oneRow(`one row at ${width}px`);

        await noSpeed(`no speed at ${width}px`);

        for (const part of ["context", "meter", "guard"]) {
            assert.ok(at.shown.includes(part), `at ${width}px ${part} shows: ${at.shown}`);
        }
    }
});
