// Which panel each session shows (`web/panel-layout.js`, `web/store.js`): read from the state and shown again, kept for
// the sessions shown last, taken over once from the panel a tab kept before, and kept for the person signed in.
import { cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

type Layout = { panel: string | null; ext?: { module: string; id: string }; filesTab: string };
type Pair = [number, Layout];

const layouts = (await import(new URL("../web/panel-layout.js", import.meta.url).href)) as {
    NO_LAYOUT: Layout;
    readLayout: (kept: unknown) => Layout | null;
    layoutOf: (state: object) => Layout;
    layoutPatch: (layout: Layout) => object;
    remember: (pairs: Pair[], id: number, layout: Layout, options?: object) => Pair[];
    keptLayout: (pairs: Pair[], id: number) => Layout | null;
    layoutPairs: (kept: unknown) => Pair[];
    legacyLayout: (get: (key: string) => string | null) => Layout | null;
};

const design: Layout = { panel: "ext", ext: { module: "design", id: "design" }, filesTab: "files" };
const files: Layout = { panel: "files", filesTab: "changes" };

after(cleanUp);

test("a layout shows again as it was, and of panels asked for together, the one the app draws", () => {
    for (const layout of [
        design,
        files,
        { panel: "people", filesTab: "files" },
        layouts.NO_LAYOUT,
    ]) {
        assert.deepEqual(layouts.layoutOf(layouts.layoutPatch(layout)), layout);
    }

    const state = { ...layouts.layoutPatch(files), extPanel: design.ext, peopleOpen: true };

    assert.equal(layouts.layoutOf(state).panel, "files");
    assert.equal(layouts.layoutOf({ ...state, browserOpen: true }).panel, "browser");
});

test("each session keeps its own layout; the device forgets one with no panel", () => {
    let pairs: Pair[] = [];

    for (const id of [1, 2, 3, 1]) {
        pairs = layouts.remember(pairs, id, id === 1 ? design : files, { max: 2 });
    }

    assert.deepEqual(pairs, [
        [3, files],
        [1, design],
    ]);
    assert.equal(layouts.keptLayout(pairs, 2), null);
    assert.equal(
        layouts.keptLayout(layouts.remember(pairs, 1, layouts.NO_LAYOUT, { keepNone: false }), 1),
        null,
    );
});

test("what another version kept, or broken, counts as nothing", () => {
    assert.deepEqual(layouts.layoutPairs([[1, design], ["2", design], 3]), [[1, design]]);
    assert.deepEqual(layouts.layoutPairs("nope"), []);
    assert.equal(layouts.readLayout({ panel: "sideways" }), null);
    assert.equal(layouts.readLayout({ panel: "ext", ext: { module: "design" } }), null);
});

test("the one panel a tab kept before is taken over as it was", () => {
    const from = (kept: Record<string, string>) => layouts.legacyLayout((key) => kept[key] ?? null);

    assert.deepEqual(from({ "pocket.extPanel": JSON.stringify(design.ext) }), design);
    assert.deepEqual(from({ "pocket.files": "1", "pocket.filesTab": "changes" }), files);
    assert.equal(from({ "pocket.extPanel": "{" }), null);
});

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser here" : false };

test("a session shows again its panel, for its person only", real, async () => {
    const app = await openApp(scriptedModel());
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "panel-layout-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        const [first, second] = [Number(await newSession(app)), Number(await newSession(app))];

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const run = (script: string) => page.evaluate(`${script}; return "null"`);
        const ask = async <T>(expression: string) =>
            JSON.parse(
                await page.evaluate(
                    `const { store } = await import("/store.js"); return JSON.stringify(${expression})`,
                ),
            ) as T;
        const panel = () =>
            ask<string | null>(
                "store.state.extPanel?.module ?? (store.state.filesOpen ? store.state.filesTab : null)",
            );

        const open = async (id: number, reload = false) => {
            await (reload
                ? page.navigate(`${base}/s/${id}`)
                : run(`(await import("/store.js")).navigate(${id})`));
            await until(
                async () => await ask<boolean>(`store.state.view.conversation?.id === ${id}`),
                `session ${id}`,
            );
        };

        const signIn = async (token: string) => {
            await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);

            if ((await page.evaluate("return location.pathname")) === "/login") {
                await page.click({ selector: 'form button[type="submit"]' });
            }

            await until(
                async () => await ask<boolean>("Boolean(store.state.me)").catch(() => false),
                "in",
            );
        };

        await signIn(app.config.ownerToken);
        await open(first, true);
        await run(`(await import("/extension-ui.js")).openExtPanel("design", "design")`);
        await open(second);
        assert.equal(await panel(), null, "a session never seen shows no panel");
        await run(`(await import("/files-panel.js")).setFilesOpen(true, "changes")`);

        await open(first);
        assert.equal(await panel(), "design");
        await open(second, true);
        assert.equal(await panel(), "changes", "a reload shows it again");

        // A new tab of the device: its layouts, but not a panel closed since.
        await open(first);
        await run(`(await import("/extension-ui.js")).closeExtPanel(); sessionStorage.clear()`);
        await open(second, true);
        assert.equal(await panel(), "changes");
        await open(first, true);
        assert.equal(await panel(), null);

        // An extension turned off since shows no panel.
        await run(`(await import("/extension-ui.js")).openExtPanel("design", "design")`);
        await open(second);
        await run(
            `await (await import("/store.js")).api("extensions/design.ts", { enabled: false })`,
        );
        await until(
            async () =>
                !(await ask<string>("JSON.stringify(store.state.server.ui)")).includes('"design"'),
            "off",
        );
        await open(first);
        assert.equal(await panel(), null);

        // Another account in this browser sees none of the owner's.
        await signIn(app.config.addUser("Guest", "guest").token);
        await open(second, true);
        assert.equal(await panel(), null);
    } finally {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});
