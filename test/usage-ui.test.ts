// The usage item in the status line, the popover and the phone's sheet it opens, the model sheet's row, and Appearance,
// in a real Chromium with synthetic headers (no provider is ever called).
import { cleanUp, home, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");
const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1280, height: 800, scale: 1, mobile: false };
const MIN = 60_000;
const HOUR = 60 * MIN;
let app: Awaited<ReturnType<typeof PocketApp.open>>;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let sessionId = "";
const shots = process.env.USAGE_SHOTS;

const secs = (ms: number) => String(Math.round((Date.now() + ms) / 1000));
const unified = (five: string, seven: string, fiveReset = 2 * HOUR + 5 * MIN) => ({
    "anthropic-ratelimit-unified-5h-utilization": five,
    "anthropic-ratelimit-unified-5h-reset": secs(fiveReset),
    "anthropic-ratelimit-unified-7d-utilization": seven,
    "anthropic-ratelimit-unified-7d-reset": secs(3 * 24 * HOUR + 18 * HOUR),
});
const counted = (limit: number, remaining: number, reset = "37m") => ({
    "x-ratelimit-limit-requests": String(limit),
    "x-ratelimit-remaining-requests": String(remaining),
    "x-ratelimit-reset-requests": reset,
});
const record = (provider: string, headers: Record<string, string>, status = 200, ago = 0) =>
    app.usage.record(provider, { status, headers }, Date.now() - ago);

/** Synthetic data: the session's provider ("faux") is Claude-like; the others cover every state. */
function seed(): void {
    record("faux", unified("0.32", "0.59"), 200, MIN);
    record(
        "limitedco",
        {
            "x-codex-primary-used-percent": "100",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-after-seconds": String(72 * 60),
            "x-codex-secondary-used-percent": "48",
            "x-codex-secondary-window-minutes": "10080",
            "x-codex-secondary-reset-after-seconds": String(4 * 24 * 3600),
        },
        200,
        6 * MIN,
    );
    record("lowco", counted(2000, 180, "5h10m"), 200, 20_000);
    record("midco", counted(14_400, 4900, "6h40m"), 200, 12 * MIN);
    record("okco", counted(5000, 3900, "8h20m"), 200, 2 * MIN);
    record("okco-two", counted(500, 410, "37m"), 200, 4 * MIN);
    record("okco-three", counted(200_000, 182_000, "300h"), 200, 3 * HOUR);
    record("mute", { "content-type": "application/json" }, 200, 2 * MIN);
}

const ev = async <T>(script: string): Promise<T> => {
    const text = await page.evaluate(`return JSON.stringify((() => { ${script} })()) ?? "null"`);

    return JSON.parse(text) as T;
};

const wait = async (script: string, what: string, ms = 20_000) => {
    const end = Date.now() + ms;
    let last: unknown;

    while (Date.now() < end) {
        last = await ev<unknown>(script).catch(() => undefined);

        if (last) {
            return last;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.fail(`timed out: ${what}`);
};

/** The popover and sheets animate in for a moment: a click at where an element is now would miss where it ends. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

/** Keys into a field, one by one, as a person types. */
const typeKeys = async (selector: string, text: string) => {
    await page.click({ selector });

    for (const key of text) {
        await page.press(key);
    }
};

const itemText = () =>
    ev<string | null>(
        `return document.querySelector(".usage-now")?.innerText.replace(/\\s+/g, " ").trim() ?? null`,
    );
const open = (id = sessionId) => page.navigate(`${base}/s/${id}`);

before(async () => {
    if (real.skip) {
        return;
    }

    const idle = fauxProvider({ provider: "idle", models: [{ id: "idle-1" }] });
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });

    faux.setResponses(
        Array.from({ length: 50 }, () => () => fauxAssistantMessage([fauxText("ok")])),
    );
    app = await PocketApp.open({
        dataDir: join(root, "data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        configureModels: (models) => {
            models.registerNativeProvider(faux.provider);
            models.registerNativeProvider({ ...idle.provider, name: "Idle" } as never);
        },
        home,
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };

    const me = app.config.users.find((user) => user.role === "owner")!;
    const { id } = await app.commands.createSession(me, { cwd: work });

    await app.commands.configure(id, me, {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    sessionId = String(id);
    seed();
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "usage-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await open();
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the item shows the tightest window of the open session's provider, in its three forms",
    real,
    async () => {
        await wait(`return document.querySelector(".usage-now")`, "the item");
        assert.equal(await itemText(), "7d 59% used");
        assert.equal(
            await ev<string>(`return document.querySelector(".usage-now").dataset.part`),
            "status-usage",
        );

        // Between the cache and the spend, as the design has it.
        const order = await ev<string[]>(
            `return [...document.querySelector(".status-line").children].map((el) => el.className.split(" ")[0])`,
        );

        assert.ok(order.indexOf("usage-now") > order.indexOf("cache"), "after the cache");
        assert.equal(
            await ev<boolean>(
                `return document.querySelector(".usage-now").nextElementSibling.innerText.startsWith("$")`,
            ),
            true,
            "just before the spend",
        );

        // The fitting steps hide words, in the order SHORTER takes them: the window, then "used", then the meter.
        const form = (short: string) =>
            ev<{ text: string; meter: boolean; gauge: boolean }>(`
            const line = document.querySelector(".status-line");
            line.dataset.short = ${JSON.stringify(short)};
            const item = line.querySelector(".usage-now");
            const shown = (el) => el && el.getBoundingClientRect().width > 0;
            return {
                text: item.innerText.replace(/\\s+/g, " ").trim(),
                meter: shown(item.querySelector(".usage-meter")),
                gauge: shown(item.querySelector(".gauge")),
            };
        `);
        const full = "words here ext guard context";

        assert.deepEqual(await form(""), { text: "7d 59% used", meter: true, gauge: false });
        assert.deepEqual(await form(`${full} window`), {
            text: "59% used",
            meter: true,
            gauge: false,
        });
        assert.deepEqual(await form(`${full} window cache used wait`), {
            text: "59%",
            meter: true,
            gauge: false,
        });
        assert.deepEqual(await form(`${full} window cache used wait bare`), {
            text: "59%",
            meter: false,
            gauge: true,
        });
    },
);

test("the item fits a status line of a phone, and a narrow one, on one row", real, async () => {
    for (const width of [390, 340]) {
        await page.setViewport({ width, height: 844, scale: 2, mobile: true });
        await open();
        await wait(`return document.querySelector(".usage-now")`, "the item");

        const row = await ev<{ one: boolean; text: string }>(`
            const line = document.querySelector(".status-line");
            const middles = [...line.children]
                .map((el) => el.getBoundingClientRect())
                .filter((box) => box.width > 0)
                .map((box) => box.top + box.height / 2);

            return {
                one: middles.every((middle) => Math.abs(middle - middles[0]) < 2),
                text: line.querySelector(".usage-now").innerText.replace(/\\s+/g, " ").trim(),
            };
        `);

        assert.equal(row.one, true, `one row at ${width}`);
        assert.match(row.text, /59%/);
    }

    await page.setViewport(DESKTOP);
});

test("low and limited keep an icon and a word; no numbers means no item", real, async () => {
    record("faux", unified("0.32", "0.93"));
    await wait(`return document.querySelector(".usage-now")?.dataset.state === "low"`, "low");
    assert.equal(await itemText(), "Low 7d 93% used");
    assert.equal(await ev<boolean>(`return !!document.querySelector(".usage-now svg")`), true);

    record(
        "faux",
        {
            "anthropic-ratelimit-unified-5h-utilization": "1",
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-5h-reset": secs(72 * MIN + 30_000),
            "anthropic-ratelimit-unified-7d-utilization": "0.5",
            "anthropic-ratelimit-unified-7d-reset": secs(3 * 24 * HOUR),
        },
        429,
    );
    await wait(
        `return document.querySelector(".usage-now")?.dataset.state === "limited"`,
        "limited",
    );
    assert.match((await itemText()) ?? "", /^Limited 1:1\d$/);
    assert.equal(await ev<boolean>(`return !!document.querySelector(".usage-now svg")`), true);

    // Narrowest: the word goes when there is a count; the icon and the count stay.
    const narrow = await ev<string>(`
        const line = document.querySelector(".status-line");
        line.dataset.short = "words here ext guard context window cache used wait bare";
        return line.querySelector(".usage-now").innerText.replace(/\\s+/g, " ").trim();
    `);

    assert.match(narrow, /^1:1\d$/);

    // The limit gate holds a provider that no window says is limited: it shows as limited too.
    record("faux", unified("0.32", "0.59"));
    await wait(`return document.querySelector(".usage-now")?.dataset.state === "ok"`, "ok again");
});

test(
    "a click opens the popover above the status line: the session's provider in full, the others by pressure",
    real,
    async () => {
        await page.click({ selector: ".usage-now" });
        await wait(`return document.querySelector(".usage-pop")`, "the popover");
        await settle();

        const popover = await ev<{
            above: boolean;
            within: boolean;
            head: string;
            current: string;
            rows: string[];
            group: string;
            filter: boolean;
            expanded: boolean;
            item: string | null;
        }>(`
        const pop = document.querySelector(".usage-pop").getBoundingClientRect();
        const line = document.querySelector(".status-line").getBoundingClientRect();
        const box = document.querySelector('[data-part="message-box"]').getBoundingClientRect();
        const clean = (el) => el?.innerText.replace(/\\s+/g, " ").trim();

        return {
            // Above the message box, not over it: what someone types stays in view.
            above: pop.bottom <= line.top && pop.bottom <= box.top,
            within: pop.left >= 0 && pop.right <= innerWidth && pop.top >= 0,
            head: clean(document.querySelector(".usage-head-text")),
            current: clean(document.querySelector(".usage-current")),
            rows: [...document.querySelectorAll(".usage-rows > .usage-row:not(.usage-group-row) .usage-row-button")]
                .map((el) => el.querySelector(".usage-row-title").innerText),
            group: clean(document.querySelector(".usage-fold")),
            filter: !!document.querySelector(".usage-filter input"),
            expanded: !!document.querySelector(".usage-row-body"),
            item: document.querySelector(".usage-now").getAttribute("aria-expanded"),
        };
    `);

        assert.equal(popover.above, true, "above the status line");
        assert.equal(popover.within, true);
        assert.equal(popover.head, "Usage From each provider’s last response. Sends nothing.");
        assert.match(popover.current, /^\S+ (Subscription|API key)/);
        assert.match(popover.current, /as of (just now|\d+ (s|min) ago)/);
        assert.match(popover.current, /5-hour window 32% used/);
        assert.match(popover.current, /Weekly window 59% used/);
        assert.match(popover.current, /Resets in 3 d 18 h/);
        // Limited, low, then the least left.
        assert.deepEqual(popover.rows, [
            "limitedco",
            "lowco",
            "midco",
            "okco",
            "okco-two",
            "okco-three",
        ]);
        assert.match(popover.group, /^2 without usage data Idle, mute$/);
        assert.equal(popover.filter, true, "more than six others get a filter");
        assert.equal(popover.expanded, false, "all folded");
        assert.equal(popover.item, "true");

        if (shots) {
            await page.setViewport({ width: 1920, height: 1080, scale: 1, mobile: false });
            await settle();
            writeFileSync(
                join(shots, "desktop-popover.jpg"),
                Buffer.from((await page.screenshot()).data, "base64"),
            );
            await page.setViewport(DESKTOP);
            await settle();
        }

        // One at a time: a click, then Enter on another.
        await page.click({ selector: ".usage-row-button" });
        await wait(
            `return document.querySelectorAll(".usage-row-body").length === 1`,
            "one expanded",
        );
        assert.match(
            await ev<string>(`return document.querySelector(".usage-row-body").innerText`),
            /5-hour window[\s\S]*Limited[\s\S]*Weekly window/,
        );
        await ev<void>(`
        const second = document.querySelectorAll(".usage-rows > .usage-row:not(.usage-group-row) .usage-row-button")[1];
        second.focus();
    `);
        await page.press("Enter");
        await wait(
            `return document.querySelectorAll(".usage-row-body").length === 1 &&
            document.querySelector(".usage-row-body").getAttribute("aria-label").startsWith("lowco")`,
            "the second row only",
        );

        // The group of providers with no data opens on a click and shows why.
        await page.click({ selector: ".usage-fold" });
        await wait(`return document.querySelector(".usage-fold-list")`, "the group");
        assert.match(
            await ev<string>(`return document.querySelector(".usage-fold-list").innerText`),
            /Idle[\s\S]*mute/,
        );

        // The filter narrows the others; a miss says so, and Clear filter ends it.
        await typeKeys(".usage-filter input", "three");
        await wait(
            `return document.querySelectorAll(".usage-row-button").length === 1`,
            "filtered",
        );
        await typeKeys(".usage-filter input", "x");
        await wait(`return document.querySelector(".usage-empty")`, "no match");
        await page.click({ selector: ".usage-empty button" });
        await wait(`return document.querySelectorAll(".usage-row-button").length >= 6`, "cleared");

        // The list scrolls inside a fixed height; the foot stays.
        const frame = await ev<{ scrolls: boolean; foot: boolean; short: boolean }>(`
        const list = document.querySelector(".usage-list");
        const pop = document.querySelector(".usage-pop").getBoundingClientRect();

        return {
            scrolls: list.scrollHeight > list.clientHeight,
            foot: document.querySelector(".usage-foot").innerText.includes("Menu → Providers"),
            short: pop.height <= innerHeight - 24,
        };
    `);

        assert.deepEqual(frame, { scrolls: true, foot: true, short: true });

        // Escape closes it and the item has the focus.
        await page.press("Escape");
        await wait(`return !document.querySelector(".usage-pop")`, "closed");
        await settle();
        assert.equal(
            await ev<string>(`return document.activeElement.className.split(" ")[0]`),
            "usage-now",
            "Escape returns the focus to the item",
        );
    },
);

test("the foot opens Providers", real, async () => {
    await page.click({ selector: ".usage-now" });
    await wait(`return document.querySelector(".usage-foot-link")`, "the popover");
    await settle();
    await page.click({ selector: ".usage-foot-link" });
    await wait(`return document.querySelector('[data-sheet="providers"]')`, "the providers sheet");
    await page.press("Escape");
    await wait(`return !document.querySelector(".sheet-host")`, "closed");
    await settle();
});

test(
    "on a phone the list opens as a full-width bottom sheet, and Back closes it",
    real,
    async () => {
        await page.setViewport(VIEWPORTS.mobile);
        await open();
        await wait(`return document.querySelector(".usage-now")`, "the item");

        // On a coarse pointer the hit area reaches 10 px past the item's box all around, and its box is 24 px high.
        const hit = await ev<{ coarse: boolean; top: string; height: number }>(`
        const item = document.querySelector(".usage-now");

        return {
            coarse: matchMedia("(pointer: coarse)").matches,
            top: getComputedStyle(item, "::after").top,
            height: item.getBoundingClientRect().height,
        };
    `);

        assert.ok(hit.height + 20 >= 44, "a 44 px hit area");

        if (hit.coarse) {
            assert.equal(hit.top, "-10px");
        }

        await page.click({ selector: ".usage-now" });
        await wait(`return document.querySelector(".usage-sheet")`, "the sheet");
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 500));

        const sheet = await ev<{
            left: number;
            right: number;
            bottom: number;
            width: number;
            popover: boolean;
        }>(`
        const box = document.querySelector(".usage-sheet").getBoundingClientRect();

        return {
            left: box.left,
            right: box.right,
            bottom: box.bottom,
            width: innerWidth,
            popover: !!document.querySelector(".usage-pop"),
        };
    `);

        assert.equal(sheet.popover, false);
        assert.equal(Math.round(sheet.left), 0);
        assert.equal(Math.round(sheet.right), sheet.width);
        assert.equal(Math.round(sheet.bottom), 844);

        if (shots) {
            writeFileSync(
                join(shots, "phone-sheet.jpg"),
                Buffer.from((await page.screenshot()).data, "base64"),
            );
        }

        await ev<void>(`history.back()`);
        await wait(`return !document.querySelector(".usage-sheet")`, "Back closed it");
        await settle();
    },
);

test(
    "the model sheet's first row names the provider and its usage, and opens the same list, also with the item hidden",
    real,
    async () => {
        await page.click({ selector: ".model-chip" });
        await wait(`return document.querySelector(".model-usage")`, "the row");
        await settle();

        const text = () =>
            ev<string>(
                `return document.querySelector(".model-usage").innerText.replace(/\\s+/g, " ").trim()`,
            );

        assert.match(await text(), /^\S+ 7d 59% used All providers$/);

        if (shots) {
            writeFileSync(
                join(shots, "phone-model-sheet.jpg"),
                Buffer.from((await page.screenshot()).data, "base64"),
            );
        }

        // It is the first thing under the header.
        assert.equal(
            await ev<boolean>(`
            const menu = document.querySelector(".model-menu");
            const row = menu.querySelector(".model-usage");
            const header = menu.querySelector(".pop-menu-head");

            return header.nextElementSibling === row;
        `),
            true,
        );
        await page.click({ selector: ".model-usage" });
        await wait(`return document.querySelector(".usage-sheet")`, "the usage sheet");
        await page.press("Escape");
        await wait(`return !document.querySelector(".sheet-host")`, "closed");
        await settle();

        // Hide the item in Appearance: the row stays.
        await ev<void>(
            `import("/store.js").then((store) => store.openSheet({ type: "appearance" }))`,
        );
        await wait(`return document.querySelector('[data-sheet="appearance"]')`, "Appearance");
        await settle();
        await ev<void>(
            `document.querySelector('[aria-label="Show Provider usage"]').scrollIntoView()`,
        );

        const listed = await ev<{ detail: string; before: string }>(`
        const row = [...document.querySelectorAll(".setting-row")].find((each) => each.innerText.includes("Provider usage"));
        const names = [...row.parentElement.querySelectorAll(".setting-row")].map((each) => each.innerText.split("\\n")[0]);

        return { detail: row.innerText.replace(/\\s+/g, " "), before: names[names.indexOf("Provider usage") + 1] };
    `);

        assert.match(listed.detail, /Provider usage.*owner/i);
        assert.equal(listed.before, "Spend", "listed just before the spend");
        await page.click({ selector: '[aria-label="Show Provider usage"]' });
        await page.press("Escape");
        await wait(`return !document.querySelector(".sheet-host")`, "closed");
        await settle();
        await wait(`return !document.querySelector(".usage-now")`, "the item is hidden");
        await settle();
        await page.click({ selector: ".model-chip" });
        await wait(`return document.querySelector(".model-usage")`, "the row still shows");
        await page.press("Escape");
        await wait(`return !document.querySelector(".sheet-host")`, "closed");
        await settle();

        // Move it back: Appearance's Reset.
        await ev<void>(
            `import("/slots.js").then((slots) => slots.setShown("status", "core:usage", true))`,
        );
        await wait(`return document.querySelector(".usage-now")`, "the item again");
    },
);

test("a provider that sends no usage, or none yet, has no item and a plain row", real, async () => {
    await page.setViewport(DESKTOP);

    // Another session on a provider that never answered.
    const me = app.config.users.find((user) => user.role === "owner")!;
    const { id } = await app.commands.createSession(me, { cwd: work });

    await app.commands.configure(id, me, {
        model: { provider: "idle", modelId: "idle-1" },
        thinkingLevel: "off",
    });
    await open(String(id));
    await wait(`return document.querySelector(".model-chip")`, "the box");
    assert.equal(await itemText(), null, "no data, no item");
    await page.click({ selector: ".model-chip" });
    await wait(`return document.querySelector(".model-usage")`, "the row");
    await settle();
    assert.equal(
        await ev<string>(
            `return document.querySelector(".model-usage").innerText.replace(/\\s+/g, " ").trim()`,
        ),
        "Idle no usage yet All providers",
    );
    await page.click({ selector: ".model-usage" });
    await wait(`return document.querySelector(".usage-pop")`, "the popover");
    await settle();
    assert.match(
        await ev<string>(`return document.querySelector(".usage-current").innerText`),
        /No usage yet\. It updates after the next request\./,
    );
    await page.press("Escape");
    await wait(`return !document.querySelector(".sheet-host")`, "closed");
    await settle();

    // A response with no limits: "does not report usage".
    record("idle", { "content-type": "application/json" });
    await wait(`return document.querySelector(".usage-now") === null`, "still no item");
    await page.click({ selector: ".model-chip" });
    await wait(
        `return document.querySelector(".model-usage")?.innerText.includes("does not report usage")`,
        "the row says it",
    );
});

test(
    "a model's own limit is a detail, limits the item only for that model, and a hold shows without numbers",
    real,
    async (t) => {
        await page.setViewport(DESKTOP);

        const gate = (provider: string, scope: string, modelId?: string) => ({
            ...{ key: `${provider}-${scope}`, provider, scope, kind: "reset", since: 0, tries: 1 },
            ...{ until: Date.now() + 72 * MIN, reason: "the usage limit", probing: false },
            ...(modelId === undefined ? {} : { modelId }),
        });
        const gates: ReturnType<typeof gate>[] = [];

        t.mock.method(app.limits, "gates", () => gates as never);
        record("faux", unified("0.32", "0.59"));
        await open();
        await wait(`return document.querySelector(".usage-now")`, "the item");

        // Another model's limit: the session's model still answers, so the item is not limited.
        gates.push(gate("faux", "model", "claude-fable"));
        record("faux", unified("0.32", "0.60"));
        await wait(
            `return document.querySelector(".usage-now")?.innerText.includes("60%")`,
            "the new numbers",
        );
        assert.notEqual(
            await ev<string>(`return document.querySelector(".usage-now").dataset.state`),
            "limited",
        );
        await page.click({ selector: ".usage-now" });
        await wait(`return document.querySelector(".usage-current")`, "the popover");
        await settle();
        assert.match(
            await ev<string>(`return document.querySelector(".usage-current").innerText`),
            /claude-fable limited · 1:1\d/,
        );
        assert.notEqual(
            await ev<string>(`return document.querySelector(".usage-current").dataset.state`),
            "limited",
        );
        await page.press("Escape");
        await wait(`return !document.querySelector(".sheet-host")`, "closed");
        await settle();

        // The session's own model's limit does limit it.
        gates.push(gate("faux", "model", "faux-1"));
        record("faux", unified("0.32", "0.61"));
        await wait(
            `return document.querySelector(".usage-now")?.dataset.state === "limited"`,
            "limited for its own model",
        );
        assert.match((await itemText()) ?? "", /^Limited 1:1\d$/);

        // A provider with no numbers at all (after a restart) and a hold of the account: limited, with the item.
        gates.length = 0;
        gates.push(gate("fresh", "account"));

        const me = app.config.users.find((user) => user.role === "owner")!;
        const { id } = await app.commands.createSession(me, { cwd: work });
        const fresh = fauxProvider({ provider: "fresh", models: [{ id: "fresh-1" }] });

        app.models.registerNativeProvider({ ...fresh.provider, name: "Fresh" } as never);
        await app.commands.configure(id, me, {
            model: { provider: "fresh", modelId: "fresh-1" },
            thinkingLevel: "off",
        });
        await open(String(id));
        record("okco", counted(5000, 3800, "8h20m"));
        await wait(
            `return document.querySelector(".usage-now")?.dataset.state === "limited"`,
            "the item of a provider with no numbers",
        );
        assert.match((await itemText()) ?? "", /^Limited 1:1\d$/);
    },
);
