// The owner's models for subagents in a real browser, where this machine has Chromium: every model, by provider, each
// checked or not on its own, with a box to find one when there are many. Quick taps, and two tabs at once, keep every
// choice, and what is kept shows after a reload, at phone and desktop sizes.
import { type App, cleanUp, openApp, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** More models than the checklist shows without a box to find them by. */
const faux = fauxProvider({
    models: Array.from({ length: 10 }, (_, index) => ({ id: `model-${String(index + 1)}` })),
});

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

/** Run a script in a page and read back the JSON it returns. */
async function inPage<T>(script: string, on = page): Promise<T> {
    return JSON.parse(await on.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const see = (script: string, what: string, on = page) =>
    until(async () => (await inPage<boolean>(script, on)) === true, what);

/** Past a sheet's rise, as a person's next tap is (`back.js` lets go of a tap on what just slid in). */
const settled = () => new Promise((resolve) => setTimeout(resolve, 450));

/** The models the server keeps for subagents, in order. */
const kept = () => [...app.config.subagentModels].sort();

/** The models a page shows checked, in order. */
const checked = (on = page) =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".subagent-model input:checked")].map((box) => box.value).sort())`,
        on,
    );

/** Tap these models' boxes one after another, each before the one before it is answered. */
const tap = (models: string[], on = page) =>
    on.evaluate(`
        for (const model of ${JSON.stringify(models)}) {
            document.querySelector(\`.subagent-model input[value="\${model}"]\`).click();
        }

        return "true";
    `);

/** Sign a page in as the owner, at a size, and open the Providers sheet. */
async function providers(on: BrowserPage, size: keyof typeof VIEWPORTS): Promise<void> {
    await on.setViewport(VIEWPORTS[size]);
    await on.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
        on,
    );
    await on.evaluate(
        `(await import("/store.js")).openSheet({ type: "providers" }); return "true"`,
    );
    await see(
        `return JSON.stringify(document.querySelectorAll(".subagent-model").length === 10)`,
        "every model listed",
        on,
    );
    await settled();
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(faux);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "providers-ui-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the owner checks many models for subagents, quickly and from two tabs, and every one is kept",
    real,
    async () => {
        await providers(page, "mobile");
        assert.deepEqual(await checked(), []);
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".subagent-models-chosen").textContent)`,
            ),
            /None allowed/,
        );

        // Three quick taps: each shows at once, and the server keeps all three.
        await tap(["faux/model-1", "faux/model-2", "faux/model-3"]);
        assert.deepEqual(await checked(), ["faux/model-1", "faux/model-2", "faux/model-3"]);
        await until(() => kept().length === 3, "three kept");
        assert.deepEqual(kept(), ["faux/model-1", "faux/model-2", "faux/model-3"]);
        await see(
            `return JSON.stringify(document.querySelector(".subagent-models-chosen").textContent.startsWith("3 allowed"))`,
            "the count",
        );

        // Found with the box, then a finger's tap.
        await page.type({ selector: ".subagent-models .search input" }, "model-10");
        await see(
            `return JSON.stringify(document.querySelectorAll(".subagent-model").length === 1)`,
            "one model found",
        );
        await page.click({ selector: `.subagent-model input[value="faux/model-10"]` });
        await until(() => kept().includes("faux/model-10"), "the one found kept");
        await page.type({ selector: ".subagent-models .search input" }, "");

        // A second tab, at the same time: one takes a model off as the other allows another.
        const other = await browsers.open(2);

        try {
            await providers(other, "mobile");
            assert.deepEqual(await checked(other), await checked());
            await Promise.all([tap(["faux/model-5"]), tap(["faux/model-2"], other)]);
            await until(() => kept().length === 4 && !kept().includes("faux/model-2"), "both kept");
            assert.deepEqual(kept(), [
                "faux/model-1",
                "faux/model-10",
                "faux/model-3",
                "faux/model-5",
            ]);

            for (const tab of [page, other]) {
                await until(
                    async () => JSON.stringify(await checked(tab)) === JSON.stringify(kept()),
                    "each tab shows what is kept",
                );
            }
        } finally {
            await browsers.close(2);
        }

        // Nothing runs past a phone's width.
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".sheet-body").scrollWidth <= document.querySelector(".sheet-body").clientWidth + 1)`,
            ),
            true,
        );

        // One taken off, and a reload, at a phone's size and a desktop's: the rest are still checked.
        await page.click({ selector: `.subagent-model input[value="faux/model-1"]` });
        await until(() => !kept().includes("faux/model-1"), "one taken off");

        for (const size of ["mobile", "desktop"] as const) {
            await providers(page, size);
            assert.deepEqual(
                await checked(),
                ["faux/model-10", "faux/model-3", "faux/model-5"],
                size,
            );
        }

        assert.deepEqual(kept(), ["faux/model-10", "faux/model-3", "faux/model-5"]);
    },
);
