// The message box's row on a phone is one row, always: in a box up to 480 px wide Plan and the extensions' buttons are in
// a ⋯ button's sheet (and Attach too, where the model's name would be cut short). Above 480 px nothing changes.
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
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const phone = (width: number) => ({ width, height: 700, scale: 2, mobile: true });
const dropIns = join(root, "data", "extensions");

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const has = (selector: string) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
    );

/** A few frames on: the row has measured itself and drawn again. */
const frames = () =>
    page.evaluate(`
        for (let frame = 0; frame < 4; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    `);

const busy = async (on: boolean) => {
    await page.evaluate(`
        const { store } = await import("/store.js");
        store.set((state) => ({ view: { ...state.view, live: { ...state.view.live, busy: ${on} } } }));
    `);
    await frames();
};

const plan = async (on: boolean) => {
    await page.evaluate(`
        const { store } = await import("/store.js");
        store.set((state) => ({ view: { ...state.view, plan: { ...state.view.plan, on: ${on} } } }));
    `);
    await frames();
};

const planOn = () =>
    inPage<boolean>(
        `return JSON.stringify((await import("/store.js")).store.state.view.plan?.on === true)`,
    );

/** The model's name as the chip shows it: a longer one is cut sooner, a short one fits. */
const modelName = async (name: string | null) => {
    await page.evaluate(`
        const { store } = await import("/store.js");
        globalThis.realAgent ??= store.state.view.agent;
        store.set((state) => ({
            view: { ...state.view, agent: ${name === null ? "globalThis.realAgent" : `{ ...globalThis.realAgent, modelName: ${JSON.stringify(name)} }`} },
        }));
    `);
    await frames();
};

type Row = {
    scroll: number;
    client: number;
    items: { name: string; left: number; right: number; middle: number; top: number }[];
    row: { left: number; right: number };
    inline: string[];
    more: { label: string; width: number; height: number; before: string; dot: boolean } | null;
    name: { shown: number; full: number } | null;
};

/** Where everything in the row is. */
const look = () =>
    inPage<Row>(`
        const row = document.querySelector(".composer-row");
        const box = row.getBoundingClientRect();
        const kind = (each) => [...each.classList].find((name) => !["icon-button", "badge-host"].includes(name)) ?? "";
        const items = [...row.children]
            .filter((each) => each.offsetWidth > 0 && !each.classList.contains("grow"))
            .map((each) => {
                const at = each.getBoundingClientRect();

                return {
                    name: kind(each) + ":" + (each.getAttribute("aria-label") ?? ""),
                    left: at.left,
                    right: at.right,
                    middle: at.top + at.height / 2,
                    top: at.top,
                };
            });
        const more = row.querySelector(".more-button");
        const name = row.querySelector(".model-name");

        return JSON.stringify({
            scroll: row.scrollWidth,
            client: row.clientWidth,
            items,
            row: { left: box.left, right: box.right },
            inline: [...row.querySelectorAll(".plan-chip, .ext-composer-button, .attach-button")]
                .filter((each) => each.offsetWidth > 0)
                .map((each) => kind(each)),
            more: more && {
                label: more.getAttribute("aria-label"),
                width: more.offsetWidth,
                height: more.offsetHeight,
                before: [
                    getComputedStyle(more, "::before").top,
                    getComputedStyle(more, "::before").left,
                    getComputedStyle(more, "::before").width,
                ].join(" "),
                dot: more.querySelector(".more-dot") !== null,
            },
            name: name && { shown: name.clientWidth, full: name.scrollWidth },
        });
    `);

const oneRow = (what: string, row: Row) => {
    const top = Math.min(...row.items.map((each) => each.middle));

    assert.ok(
        row.items.every((each) => Math.abs(each.middle - top) < 2),
        `${what}: the row is more than one row: ${JSON.stringify(row.items)}`,
    );
    assert.ok(
        row.scroll <= row.client,
        `${what}: the row overflows: ${row.scroll} > ${row.client}`,
    );
    assert.ok(
        row.items.every((each) => each.left >= row.row.left - 1 && each.right <= row.row.right + 1),
        `${what}: something is outside the row: ${JSON.stringify(row.items)}`,
    );
};

const sheetItems = () =>
    inPage<{ name: string; state: string; pressed: string | null }[]>(`
        return JSON.stringify([...document.querySelectorAll(".more-sheet .more-item")].map((each) => ({
            name: each.querySelector("span").textContent.trim(),
            state: each.querySelector(".more-state")?.textContent.trim() ?? "",
            pressed: each.getAttribute("aria-pressed"),
        })));
    `);

const settle = async () => {
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.getAnimations().every((each) => each.effect?.getComputedTiming().endTime === Infinity || each.playState !== "running"))`,
            ),
        "animations to finish",
    );
    // A click soon after a layer opened is let go (back.js): wait it out.
    await new Promise((resolve) => setTimeout(resolve, 450));
};

/** The session open at `viewport`, its message box drawn. */
async function opened(viewport: { width: number; height: number; scale: number; mobile: boolean }) {
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${Number(session)}`);
    await until(() => has(".composer-row"), "the message box");
    await until(() => has(".ext-composer-button, .more-button"), "the extensions' buttons");
    await frames();
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(dropIns, "rowtools.ts"),
        `/** Row tools: two buttons in the message box's row. */\nexport default (_host, web) => { web.client("rowtools.js"); };\n`,
    );
    writeFileSync(
        join(dropIns, "rowtools.js"),
        `export const pocketApi = 1;

export default (pocket) => {
	globalThis.rowPocket = pocket;
	pocket.composerButton({ id: "tags", title: "Tags", icon: "tag", run: () => { globalThis.ran = [...(globalThis.ran ?? []), "tags"]; } });
	globalThis.askButton = pocket.composerButton({ id: "ask", title: "Ask someone", icon: "pulse", badge: 2, run: () => { globalThis.ran = [...(globalThis.ran ?? []), "ask"]; } });
};
`,
    );

    app = await openApp(scriptedModel());
    await app.setExtensionEnabled(owner(app), "rowtools.ts", true);
    session = await newSession(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "composer-one-row-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "on a phone the row stays one row, idle and busy, and typing never moves items",
    real,
    async () => {
        try {
            for (const width of [390, 340]) {
                await opened(phone(width));
                await plan(true);

                for (const working of [false, true]) {
                    await busy(working);

                    const signatures: string[] = [];

                    for (const words of ["", "a few words"]) {
                        await page.evaluate(`
                            const box = document.querySelector(".composer textarea");
                            const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
                            set.call(box, ${JSON.stringify(words)});
                            box.dispatchEvent(new Event("input", { bubbles: true }));
                        `);
                        await frames();

                        const what = `${width} px, ${working ? "busy" : "idle"}, ${words === "" ? "empty" : "text"}`;
                        const row = await look();

                        oneRow(what, row);
                        assert.deepEqual(
                            row.inline.filter((each) => each !== "attach-button"),
                            [],
                            what,
                        );
                        assert.ok(
                            row.items.some((each) =>
                                each.name.startsWith(working ? "stop-button:" : "send-button:"),
                            ),
                            `${what}: ${working ? "Stop" : "Send"} is not in the row`,
                        );
                        assert.ok(row.more, `${what}: no ⋯ button`);
                        assert.equal(row.more.label, "More actions, Plan on, Ask someone 2", what);
                        assert.ok(row.more.dot, `${what}: no dot on ⋯`);
                        assert.ok(row.more.width >= 32 && row.more.height >= 32, what);
                        assert.equal(row.more.before, "-4px -4px 44px", `${what}: ⋯'s tap layer`);
                        signatures.push(
                            JSON.stringify({
                                inline: row.inline,
                                more: row.more.label,
                                items: row.items
                                    .map((each) => each.name.split(":")[0] ?? "")
                                    .filter(
                                        (each) => !["send-button", "mic-button"].includes(each),
                                    ),
                            }),
                        );
                    }

                    assert.equal(signatures[0], signatures[1], `typing stability at ${width} px`);
                }

                await busy(false);
                await plan(false);
            }
        } finally {
            await busy(false);
            await plan(false);
            await page.setViewport(DESKTOP);
        }
    },
);

test("Attach folds into ⋯ only where the model's name would be cut short", real, async () => {
    try {
        await opened(phone(340));
        await busy(true);
        await modelName("Anthropic: Claude Opus 4.5 Extended Reasoning");

        const folded = await look();

        oneRow("a long model name at 340 px", folded);
        assert.deepEqual(folded.inline, [], "Attach is in ⋯ for a long name");
        assert.ok((folded.name?.shown ?? 0) >= 52 || folded.name?.shown === folded.name?.full);
        await page.click({ selector: ".more-button" });
        await until(() => has(".more-sheet"), "the sheet");
        assert.equal((await sheetItems())[0]?.name, "Attach files", "Attach is first in the sheet");
        await page.press("Escape");
        await until(async () => !(await has(".more-sheet")), "the sheet to close");
        await settle();

        await modelName("o3");
        await busy(false);

        const short = await look();

        oneRow("a short model name at 390 px", short);
        assert.deepEqual(short.inline, ["attach-button"], "a short name leaves Attach in the row");
    } finally {
        await modelName(null);
        await busy(false);
        await page.setViewport(DESKTOP);
    }
});

test(
    "the sheet lists the items in the row's order with their state, and a choice runs",
    real,
    async () => {
        try {
            await page.setViewport(DESKTOP);
            await page.navigate(`${base}/s/${Number(session)}`);
            await until(() => has(".ext-composer-button"), "the buttons on a wide box");

            // The order on a wide box, where they are in the row.
            const wide = await inPage<string[]>(`
            return JSON.stringify([...document.querySelectorAll(".composer-row .plan-chip, .composer-row .ext-composer-button")]
                .map((each) => each.classList.contains("plan-chip") ? "Plan" : each.getAttribute("aria-label").replace(/, .*/, "")));
        `);

            assert.deepEqual(wide, ["Plan", "Tags", "Ask someone"]);
            assert.equal((await look()).more, null, "no ⋯ above 480 px");

            await opened(phone(390));
            assert.equal((await look()).more?.label, "More actions, Ask someone 2");
            await page.click({ selector: ".more-button" });
            await until(() => has(".more-sheet"), "the sheet");
            await settle();
            assert.deepEqual(await sheetItems(), [
                { name: "Plan", state: "Off", pressed: "false" },
                { name: "Tags", state: "", pressed: null },
                { name: "Ask someone", state: "2", pressed: null },
            ]);

            // Plan toggles, and the sheet closes.
            await page.click({ selector: '.more-sheet [data-item="core:plan"]' });
            await until(planOn, "plan mode on");
            await until(async () => !(await has(".more-sheet")), "the sheet to close");
            await settle();
            assert.equal((await look()).more?.label, "More actions, Plan on, Ask someone 2");
            await page.click({ selector: ".more-button" });
            await until(() => has(".more-sheet"), "the sheet");
            await settle();
            assert.deepEqual((await sheetItems())[0], {
                name: "Plan",
                state: "On",
                pressed: "true",
            });

            // An extension's item runs what its button would.
            await page.click({ selector: '.more-sheet [data-item="ext:rowtools:tags"]' });
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(globalThis.ran?.includes("tags") === true)`,
                    ),
                "Tags to run",
            );
            await until(async () => !(await has(".more-sheet")), "the sheet to close");
            await settle();

            // Escape returns the focus to ⋯.
            await page.click({ selector: ".more-button" });
            await until(() => has(".more-sheet"), "the sheet");
            await settle();
            await page.press("Escape");
            await until(async () => !(await has(".more-sheet")), "the sheet to close");
            await settle();
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(document.activeElement?.classList.contains("more-button") === true)`,
                    ),
                "the focus on ⋯",
            );

            // Back closes it.
            await page.click({ selector: ".more-button" });
            await until(() => has(".more-sheet"), "the sheet");
            await settle();
            await page.evaluate(`history.back()`);
            await until(async () => !(await has(".more-sheet")), "back to close the sheet");
            assert.ok(
                new URL(await page.evaluate(`return location.href`)).pathname.startsWith("/s/"),
            );

            // Wider again: the sheet goes with the ⋯ that opened it.
            await page.click({ selector: ".more-button" });
            await until(() => has(".more-sheet"), "the sheet");
            await page.setViewport(DESKTOP);
            await until(
                async () => !(await has(".more-sheet")),
                "the sheet to close on a wide box",
            );
        } finally {
            await plan(false);
            await page.setViewport(DESKTOP);
        }
    },
);

test("above 480 px every item stays in the row, as before", real, async () => {
    try {
        for (const width of [700, 1440]) {
            await opened({ width, height: 800, scale: 1, mobile: false });
            await busy(false);

            const row = await look();

            assert.equal(row.more, null, `no ⋯ at ${width} px`);
            assert.ok(row.inline.includes("attach-button"), `Attach is in the row at ${width} px`);
            assert.ok(
                row.inline.includes("ext-composer-button"),
                `the extensions' buttons are in the row at ${width} px`,
            );
            oneRow(`${width} px`, row);
        }
    } finally {
        await page.setViewport(DESKTOP);
    }
});
