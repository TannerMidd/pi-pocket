// Extensions' browser modules in a real Chromium: what they add shows in the app (the rail, a page in the conversation's
// place), hears its module's events, fails alone, and goes when turned off.
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
import type { ExtensionWeb } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import type { Pocket } from "../types/pocket.d.ts";
import { pocketVersion } from "../src/server/versions.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const dropIns = join(root, "data", "extensions");
const seen = globalThis as unknown as { meterWeb?: ExtensionWeb };

/** `Pocket`'s members in the public types: `npm run check` holds this to them, and the first test holds `pocket` to it. */
const POCKET_MEMBERS: Record<keyof Pocket, true> = {
    version: true,
    pocketVersion: true,
    module: true,
    title: true,
    h: true,
    html: true,
    Fragment: true,
    useState: true,
    useEffect: true,
    useLayoutEffect: true,
    useRef: true,
    useMemo: true,
    useCallback: true,
    useReducer: true,
    Icon: true,
    Spinner: true,
    Loader: true,
    Markdown: true,
    Switch: true,
    me: true,
    conversationId: true,
    openConversation: true,
    api: true,
    on: true,
    notify: true,
    rail: true,
    menu: true,
    launcher: true,
    page: true,
    sheet: true,
    toolCall: true,
    openPage: true,
    closePage: true,
    openSheet: true,
    closeSheet: true,
    style: true,
    onDispose: true,
};

/** The owner's meter: a route, events, and a browser module with a rail button and a page. */
const METER = `/** Meter: a reading on a page of its own. */
export default function (_host, web) {
	let reading = 41;
	web.route("GET", "reading", () => ({ reading: ++reading }));
	web.client("meter.js");
	globalThis.meterWeb = web;
}
`;

const METER_JS = `export const pocketApi = 1;

export default function (pocket) {
	const { html, useEffect, useState } = pocket;

	function Meter() {
		const [reading, setReading] = useState(null);

		useEffect(() => {
			pocket.api("reading").then((answer) => setReading(answer.reading));

			return pocket.on("reading", (value) => setReading(value));
		}, []);

		return html\`<p class="meter">Reading: \${reading ?? "…"}</p>\`;
	}

	pocket.page({ id: "meter", title: "Meter", component: Meter });
	const rail = pocket.rail({ id: "meter", title: "Meter", icon: "pulse", page: "meter" });
	// The tests reach this version's pocket, and its rail button, through these.
	globalThis.meterPocket = pocket;
	globalThis.meterRail = rail;
}
`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string, on: BrowserPage = page): Promise<T> {
    return JSON.parse(await on.evaluate(script)) as T;
}

/**
 * Wait for the page's own finite animations (sheets rising, the page fading in), so clicks land where they aim. Not
 * the notices': their countdown runs for seconds.
 */
async function settled(on: BrowserPage = page): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.getAnimations().every((each) => each.effect?.getComputedTiming().endTime === Infinity || each.playState !== "running" || each.effect?.target?.closest?.(".notices")))`,
                on,
            ),
        "animations to finish",
    );
    // A click soon after a layer opened is let go (back.js): wait it out.
    await new Promise((resolve) => setTimeout(resolve, 450));
}

const has = (selector: string, on: BrowserPage = page) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
        on,
    );

const text = (selector: string) =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? "")`,
    );

const notices = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".notice")].map((each) => each.textContent.trim()))`,
    );

/** Run `script` in the page with the meter's `pocket` (the version loaded now) and `html`; what it returns. */
const withMeter = <T>(script: string) =>
    inPage<T>(`const pocket = globalThis.meterPocket; const { html } = pocket; ${script}`);

/** How this tab's copy of a module's browser module stands, as the Extensions sheet reads it. */
const stateOf = (module: string) =>
    inPage<unknown>(
        `return JSON.stringify((await import("/extension-ui.js")).browserModuleState(${JSON.stringify(module)}) ?? null)`,
    );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Time, in the page, from now until the meter stops, kept as `globalThis.meterTook`. */
const timeTheStop = () =>
    inPage<null>(`
        const { store } = await import("/store.js");
        const { browserModuleState } = await import("/extension-ui.js");
        const started = performance.now();
        const stop = store.subscribe(() => {
            if (browserModuleState("meter")?.status === "failed") {
                globalThis.meterTook = performance.now() - started;
                stop();
            }
        });

        globalThis.meterTook = null;

        return "null";
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(join(dropIns, "meter.ts"), METER);
    writeFileSync(join(dropIns, "meter.js"), METER_JS);
    // A second module, for everyone who sees every session, from a folder.
    writeFileSync(
        join(dropIns, "shared.ts"),
        `/** Shared: a rail button for everyone. */\nexport default (_host, web) => { web.client("shared", { access: "view" }); };\n`,
    );
    mkdirSync(join(dropIns, "shared"));
    writeFileSync(
        join(dropIns, "shared", "index.js"),
        `export default (pocket) => {
	pocket.rail({ id: "hi", title: "Shared", run: () => pocket.notify("info", "hi from shared") });
};
`,
    );
    // Fails while it sets up: the app goes on without it.
    writeFileSync(
        join(dropIns, "broken.ts"),
        `/** Broken: a browser module that throws. */\nexport default (_host, web) => { web.client("broken.js"); };\n`,
    );
    writeFileSync(
        join(dropIns, "broken.js"),
        `export default (pocket) => {
	pocket.rail({ id: "x", title: "Broken", run() {} });
	throw new Error("broken on purpose");
};
`,
    );
    app = await openApp(scriptedModel());

    // Broken is turned on in its own test: its notice would cover the top bar's buttons in the others.
    for (const file of ["meter.ts", "shared.ts"]) {
        await app.setExtensionEnabled(owner(app), file, true);
    }

    session = await newSession(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "extension-ui-")),
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

const rail = (title: string) => `.sidebar .rail-ext[title="${title}"]`;

test(
    "a browser module's rail button opens its page, which calls its route and hears its events",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        assert.deepEqual(
            await withMeter<string[]>(`return JSON.stringify(Object.keys(pocket).sort())`),
            Object.keys(POCKET_MEMBERS).sort(),
            "pocket has the members of Pocket in types/pocket.d.ts",
        );
        await settled();
        await page.click({ selector: rail("Meter") });
        await until(
            async () => (await text(".ext-page .meter")) === "Reading: 42",
            "the reading from its route",
        );

        assert.equal(
            await withMeter<string>(`return JSON.stringify(pocket.pocketVersion)`),
            pocketVersion(),
        );
        seen.meterWeb!.send("reading", 7);
        await until(
            async () => (await text(".ext-page .meter")) === "Reading: 7",
            "the reading the server sent",
        );
        await withMeter(`pocket.openConversation("${session}"); return "null"`);
        await until(
            async () => (await has(".composer")) && !(await has(".ext-page")),
            "normal conversation navigation",
        );
    },
);

test("a browser module that fails says so, and the rest of the app goes on", real, async () => {
    await app.setExtensionEnabled(owner(app), "broken.ts", true);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            (await notices()).some((each) =>
                each.includes("broken failed to load in this browser: broken on purpose"),
            ),
        "the failure's notice",
    );
    // What it added before it threw is gone; the others' stay.
    assert.equal(await has(rail("Broken")), false);
    assert.equal(await has(rail("Meter")), true);
    assert.equal(await has(".composer"), true);
    await app.setExtensionEnabled(owner(app), "broken.ts", false);
});

test(
    "an endless loop of microtasks that calls pocket is stopped in about a second",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await timeTheStop();
        // Each turn of the loop after an await. The page answers again only once the loop ends.
        await withMeter<null>(`
            globalThis.spinEnded = null;
            (async () => {
                let count = 0;

                try {
                    for (;;) {
                        await Promise.resolve();
                        globalThis.meterRail.update({ badge: (++count % 50) + 1 });
                    }
                } catch (error) {
                    globalThis.spinEnded = error.message;
                }
            })();

            return "null";
        `);
        await until(
            () => inPage<boolean>(`return JSON.stringify(globalThis.spinEnded !== null)`),
            "the loop ended",
        );
        assert.deepEqual(await stateOf("meter"), {
            status: "failed",
            error: "it redraws without end",
        });

        const took = await inPage<number | null>(`return JSON.stringify(globalThis.meterTook)`);

        assert.ok(typeof took === "number" && took < 2000, `stopped after ${took} ms`);
    },
);

test("safe mode: ?noext=1 loads no browser modules in the tab, across a reload", real, async () => {
    try {
        await page.navigate(`${base}/s/${session}?noext=1`);
        await until(() => has(".composer"), "the conversation");
        await until(
            async () =>
                (await notices()).some((each) =>
                    each.includes("Extensions' browser parts are off in this tab"),
                ),
            "the notice",
        );
        assert.equal(await has(".rail-ext"), false);

        // A reload in the same tab keeps it.
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(".composer"), "the conversation again");
        await sleep(500);
        assert.equal(await has(".rail-ext"), false);
    } finally {
        await inPage<null>(`sessionStorage.removeItem("pocket.noext"); return "null"`);
    }
});

test("Lancet Guard stays on until its inline confirmation is accepted", real, async () => {
    await app.setExtensionEnabled(owner(app), "guard.ts", true);
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(".composer"), "the conversation");
    await inPage(
        `(await import("/store.js")).openSheet({ type: "extensions", tab: "installed" }); return "null";`,
    );
    await until(() => has('.switch[aria-label="Lancet Guard: on"]'), "the guard switch");
    await settled();
    await inPage(
        `document.querySelector('.switch[aria-label="Lancet Guard: on"]').focus(); return "null";`,
    );
    await page.press("Space");
    await until(() => has(".guard-confirm"), "the inline confirmation");
    assert.equal(await has('.switch[aria-label="Lancet Guard: on"]'), true);
    await page.press("Enter");
    await until(async () => !(await has(".guard-confirm")), "Keep it on cancels");
    assert.equal(await has('.switch[aria-label="Lancet Guard: on"]'), true);
    await page.press("Space");
    await until(() => has(".guard-confirm"), "the confirmation to accept");
    await page.press("Tab");
    await page.press("Enter");
    await until(
        () => has('.switch[aria-label="Lancet Guard: off"]:focus'),
        "guard off and focus restored",
    );
});

test("turning the module off takes away its button and closes its page", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(rail("Meter")), "the meter's rail button");
    await settled();
    await page.click({ selector: rail("Meter") });
    await until(() => has(".ext-page .meter"), "the page");
    await app.setExtensionEnabled(owner(app), "meter.ts", false);
    await until(
        async () => !(await has(".ext-page")) && !(await has(rail("Meter"))),
        "the page and button gone",
    );
    assert.equal(await has(rail("Shared")), true);
});
