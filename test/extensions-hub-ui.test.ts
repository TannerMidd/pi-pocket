// The hub's direct listing actions: installing never enables code, and updating approves the diff's exact pin.
import { cleanUp, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { parseEntry, parseThemeEntry, pinOf } from "../src/server/gallery/entry.ts";
import { createHandler } from "../src/server/http.ts";

const INDEX = "https://raw.githubusercontent.com/TannerMidd/pi-pocket-extensions/HEAD/index.json";
const NAME = "hub-clock";
const FILE = `${NAME}.ts`;
const served = new Map<string, string>([[INDEX, JSON.stringify({ format: 1, extensions: [] })]]);

after(cleanUp);

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
};

async function openHub(t: TestContext) {
    const data = mkdtempSync(join(root, "data-"));
    const app = await openApp(scriptedModel(), data);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "extensions-hub-ui-")),
        load: async () => undefined,
        save: () => {},
    });

    t.after(async () => {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        server.close();
        await app.close();
    });
    app.gallery.fetch = async (url) =>
        served.has(url) ? new Response(served.get(url)) : new Response("", { status: 404 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const page = await browsers.open(1);
    const inPage = async <T>(script: string): Promise<T> =>
        JSON.parse(await page.evaluate(script)) as T;
    const see = (expression: string, what: string) =>
        until(() => inPage<boolean>(`return JSON.stringify(${expression})`), what);

    const settle = async () => {
        await page.evaluate(`
            await Promise.all(document.getAnimations()
                .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity &&
                    !animation.effect?.target?.closest?.(".notices"))
                .map((animation) => animation.finished.catch(() => {})));
        `);
        // back.js ignores taps for 280 ms after a layer opens.
        await new Promise((resolve) => setTimeout(resolve, 450));
    };

    const click = async (label: string) => {
        await settle();
        await page.click({ label });
    };

    const session = await newSession(app);

    const enter = async (viewport: typeof VIEWPORTS.mobile) => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${session}`);
        await see(`document.querySelector('.composer') !== null`, "the conversation");
    };

    return { app, page, data, inPage, see, settle, click, enter };
}

const row = (file: string) => `.library-row[data-file="${file}"]`;
const query = ".library-search input";
const rows = `[...document.querySelectorAll('.library-row')]`;
const filter = (name: string) =>
    `[...document.querySelectorAll('.library-filters button')].find(button => button.textContent.trim().startsWith('${name}'))`;

async function menu(hub: Awaited<ReturnType<typeof openHub>>) {
    await hub.click("Tools");
    await hub.click("Extensions");
    await hub.see(`document.querySelector('.library-row') !== null`, "the installed library");
    await hub.settle();
}

test(
    "Desktop: purpose search and state filters intersect; keyboard selection never toggles a module",
    real,
    async (t) => {
        const hub = await openHub(t);
        const { app, page, enter, inPage, see, click } = hub;
        const states = async () =>
            (await app.extensions(owner(app))).modules.map(({ file, enabled }) => [file, enabled]);

        await enter(VIEWPORTS.desktop);
        await menu(hub);
        const before = await states();

        assert.equal(await inPage<number>(`return JSON.stringify(${rows}.length)`), before.length);
        await see(
            `document.querySelector('.library-detail')?.checkVisibility() === true`,
            "the desktop inspector",
        );
        await page.evaluate(
            `document.querySelector('.ext-tabs [role="tab"][aria-selected="true"]').focus()`,
        );
        await page.press("ArrowRight");
        await see(
            `document.activeElement?.textContent.trim() === 'Discover'`,
            "keyboard gallery navigation",
        );
        await page.press("Home");
        await see(`document.querySelector('.library-row') !== null`, "Home returns to Installed");
        await page.evaluate(`${filter("All")}.focus()`);
        await page.press("/");
        await see(
            `document.querySelector('${query}') === document.activeElement`,
            "slash focuses search",
        );
        await page.press("ArrowDown");
        await see(`document.activeElement === ${rows}[0]`, "Down focuses the first match");
        await page.press("End");
        await see(`document.activeElement === ${rows}.at(-1)`, "End focuses the final match");
        await page.press("Home");
        await see(`document.activeElement === ${rows}[0]`, "Home returns to the first match");
        await page.type({ selector: query }, "Tools & system");
        await see(
            `${rows}.some(b => b.dataset.file === 'anthropic-subscription.ts') && !${rows}.some(b => b.dataset.file === 'agent-teams.ts')`,
            "search by purpose",
        );
        await page.evaluate(`${filter("Off")}.focus()`);
        await page.press("Space");
        const off = await inPage<string[]>(
            `return JSON.stringify(${rows}.map(b => b.dataset.file))`,
        );

        assert.ok(off.includes("anthropic-subscription.ts"));
        assert.ok(off.every((file) => before.some(([name, on]) => name === file && !on)));
        await page.evaluate(
            `document.querySelector('${row("anthropic-subscription.ts")}').focus()`,
        );
        await page.press("Enter");
        await see(
            `document.querySelector('.library-detail')?.textContent.includes('Claude subscription billing')`,
            "keyboard selects the billing inspector",
        );
        assert.deepEqual(await states(), before);
        await page.evaluate(`${filter("On")}.focus()`);
        await page.press("Space");
        await see(
            `${rows}.length > 0 && !document.querySelector('${row("anthropic-subscription.ts")}') && ${rows}[0].getAttribute('aria-current') === 'true' && document.querySelector('.library-detail').getAttribute('aria-label') === ${rows}[0].querySelector('.library-name').textContent`,
            "On removes the off selection and inspects its first result",
        );
        await hub.settle();
        await page.type({ selector: query }, "Relay triage");
        await page.click({ selector: row("relay-triage.ts") });
        await see(
            `document.querySelector('.library-detail')?.textContent.includes('including secrets in reply text')`,
            "privacy note before changing the classifier",
        );
        await hub.settle();
        await page.click({ selector: ".ext-inspector-details summary" });
        const field = "#ext-setting-relay-triage-confidenceThreshold";

        await see(`document.querySelector('${field}') !== null`, "declared confidence setting");
        await page.type({ selector: field }, "0.91");
        await click("Save settings");
        await until(
            () => app.config.extensionSettings("relay-triage").confidenceThreshold === 0.91,
            "setting saved to the isolated server",
        );
        assert.deepEqual(await states(), before);
    },
);

test(
    "Desktop: changing search or filter reconciles the inspector without toggling a hidden module",
    real,
    async (t) => {
        const hub = await openHub(t);
        const { app, page, enter, see, click } = hub;
        const states = async () =>
            (await app.extensions(owner(app))).modules.map(({ file, enabled }) => [file, enabled]);
        const current = `document.querySelector('.library-row[aria-current="true"]')`;
        const action = `document.querySelector('.ext-inspector-toggle [role="switch"]')`;

        await enter(VIEWPORTS.desktop);
        await menu(hub);
        const before = await states();

        await page.click({ selector: row("agent-teams.ts") });
        await hub.settle();
        await page.type({ selector: query }, "Relay");
        await see(
            `${current} === ${rows}[0] && ${current}?.dataset.file === 'pocket-relay.ts' && ${action}?.getAttribute('aria-label') === 'Relay: on'`,
            "the first Relay result owns the inspector action",
        );
        await hub.settle();
        await see(`document.activeElement === document.querySelector('${query}')`, "search focus");
        await page.click({ selector: row("relay-triage.ts") });
        await hub.settle();
        await page.type({ selector: query }, "Rel");
        await see(
            `${current}?.dataset.file === 'relay-triage.ts' && ${action}?.getAttribute('aria-label') === 'Relay triage: on'`,
            "a visible explicit selection stays current",
        );
        await page.type({ selector: query }, "No such extension");
        await see(
            `${rows}.length === 0 && !${action} && document.querySelector('.library-detail .library-empty') !== null`,
            "zero matches leave no extension actions",
        );
        await page.type({ selector: query }, "Agent Teams");
        await hub.settle();
        await page.click({ selector: row("agent-teams.ts") });
        await click("Off");
        await see(`${rows}.length === 0 && !${action}`, "Off removes the hidden module's action");
        assert.deepEqual(await states(), before);

        await click("On");
        await page.click({ selector: row("agent-teams.ts") });
        await click("Agent Teams: on");
        await see(
            `${rows}.length === 0 && ${action}?.getAttribute('aria-label') === 'Agent Teams: off'`,
            "the explicit inspector shows the result of the intentional toggle",
        );
        assert.deepEqual(
            await states(),
            before.map(([file, on]) => [file, file === "agent-teams.ts" ? false : on]),
        );
    },
);

test(
    "Phone: detail Back restores the scrolled, filtered list and its focused row",
    real,
    async (t) => {
        const hub = await openHub(t);
        const { page, enter, inPage, see, click } = hub;

        await enter(VIEWPORTS.mobile);
        await menu(hub);
        await page.type({ selector: query }, "a");
        await page.evaluate(`${filter("On")}.focus()`);
        await page.press("Space");
        await page.scroll(undefined, 560);
        const top = await inPage<number>(
            `return JSON.stringify(document.querySelector('.library-groups').scrollTop)`,
        );

        assert.ok(top > 100, `the installed list scrolled to ${top}`);
        const file = await inPage<string>(
            `const pane = document.querySelector('.library-groups').getBoundingClientRect(); return JSON.stringify(${rows}.find(row => {const box = row.getBoundingClientRect(); return box.top >= pane.top && box.bottom <= pane.bottom;}).dataset.file)`,
        );

        const point = await inPage<{ x: number; y: number }>(
            `const {x,y,width,height} = document.querySelector('${row(file)}').getBoundingClientRect(); return JSON.stringify({x:x+width/2,y:y+height/2})`,
        );

        await page.click(point);
        await see(
            `document.querySelector('.library-detail')?.checkVisibility() === true`,
            "phone detail visible",
        );
        await click("Back to Installed");
        await see(
            `document.activeElement?.dataset.file === '${file}'`,
            "focus returned to the originating row",
        );
        assert.equal(
            await inPage<string>(`return JSON.stringify(document.querySelector('${query}').value)`),
            "a",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(${filter("On")}.getAttribute('aria-pressed'))`,
            ),
            "true",
        );
        const after = await inPage<number>(
            `return JSON.stringify(document.querySelector('.library-groups').scrollTop)`,
        );

        assert.ok(Math.abs(top - after) <= 1, `list position before: ${top}, after: ${after}`);
    },
);

test(
    "Installed works without an index, and gallery-off management still opens from the menu",
    real,
    async (t) => {
        const hub = await openHub(t);
        const { app, page, see, click, enter } = hub;
        let attempts = 0;

        app.gallery.fetch = async () => {
            attempts++;

            throw new Error("Offline for this test");
        };

        await enter(VIEWPORTS.mobile);
        await menu(hub);
        await click("Discover");
        await until(() => attempts > 0, "the offline index attempt");
        await click("Installed");
        await see(
            `document.querySelector('${row("guard.ts")}') !== null`,
            "local modules despite the index failure",
        );
        await page.type({ selector: query }, "gallery");
        await page.click({ selector: row("gallery.ts") });
        await click("Extension gallery: on");
        await see(
            `document.querySelector('.extension-library-sheet .library-detail .switch')?.getAttribute('aria-checked') === 'false'`,
            "standalone management after turning the gallery off",
        );
        // System Back still works while the change notice covers the top of a phone.
        await hub.settle();
        await page.evaluate(`history.back()`);
        await see(
            `document.activeElement?.dataset.file === 'gallery.ts' && document.querySelector('${query}').value === 'gallery'`,
            "the search and row focus survive the switch to standalone management",
        );
        await page.evaluate(`history.back()`);
        await see(
            `[...document.querySelectorAll('button')].some(item => item.innerText.trim() === 'All places' && item.checkVisibility())`,
            "Back to Tools",
        );
        await click("Extensions");
        await see(
            `document.querySelector('.extension-library-sheet .library-row') !== null && document.querySelector('.extension-hub') === null`,
            "Menu opens the standalone library",
        );
        await hub.settle();
        await page.click({ selector: row("guard.ts") });
        await see(
            `document.querySelector('.library-detail')?.textContent.includes('Lancet Guard')`,
            "local inspector without the gallery",
        );
    },
);

function offer(version: string, commit: string, body = "") {
    const source = `/** Hub clock ${version}. */
import { defineExtension } from "@earendil-works/pi-durable";
${body}export default (_host, web) => {
    web.settings([{ name: "caption", label: "Clock caption", type: "text", default: "Time" }]);
    return defineExtension({ name: "hub-clock" });
};
`;
    const entry = {
        name: NAME,
        title: "Hub clock",
        description: "A clock for the hub test.",
        tags: ["test"],
        author: { name: "Someone" },
        version,
        source: { repo: "someone/pocket-clock", commit },
        files: [
            {
                name: FILE,
                sha256: createHash("sha256").update(source).digest("hex"),
                size: Buffer.byteLength(source),
            },
        ],
        pocketApi: 1,
        minPocket: "0.14.0",
        declares: {
            extensions: [NAME],
            tools: [],
            readOnlyTools: [],
            hooks: [],
            sections: [],
            wraps: [],
            routes: [],
            client: null,
            access: "owner",
        },
    };

    served.set(`https://raw.githubusercontent.com/someone/pocket-clock/${commit}/${FILE}`, source);
    served.set(INDEX, JSON.stringify({ format: 1, extensions: [entry] }));

    return { source, pin: pinOf(parseEntry(entry)) };
}

test("Desktop: a matching installed theme keeps its gallery details", real, async (t) => {
    const name = "paper";
    const commit = "d".repeat(40);
    const repo = "someone/pocket-paper";
    const files = {
        "paper/theme.json": JSON.stringify({ themeApi: 1, name: "Paper" }),
        "paper/theme.css": ":root { --accent: #c2410c; }",
    };
    const entry = {
        kind: "theme",
        themeApi: 1,
        name,
        title: "Paper",
        description: "A paper theme.",
        tags: ["print"],
        version: "1.0.0",
        minPocket: "0.14.0",
        author: { name: "Someone" },
        source: { repo, commit },
        files: Object.entries(files).map(([path, body]) => {
            served.set(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`, body);

            return {
                name: path,
                sha256: createHash("sha256").update(body).digest("hex"),
                size: body.length,
            };
        }),
    };

    served.set(INDEX, JSON.stringify({ format: 1, extensions: [entry] }));
    const hub = await openHub(t);
    const { app, page, enter, see } = hub;
    const theme = '.ext-theme[data-theme-name="paper"]';

    await app.gallery.install(name, pinOf(parseThemeEntry(entry)));
    await enter(VIEWPORTS.desktop);
    await menu(hub);
    await page.click({ selector: row("agent-teams.ts") });
    await hub.settle();
    await page.type({ selector: query }, "Paper");
    await see(
        `document.querySelector('${theme}')?.getAttribute('aria-current') === 'true' && document.querySelector('.library-detail')?.textContent.includes('Use it in this browser')`,
        "the matching theme and its gallery inspector",
    );
    await hub.settle();
    await page.click({ selector: theme });
    await hub.settle();
    await page.type({ selector: query }, "Pape");
    await see(
        `document.querySelector('.library-detail')?.getAttribute('aria-label') === 'Paper'`,
        "the selected theme still matches",
    );
    await hub.click("View source");
    await see(`document.querySelector('[data-sheet="gallery-source"]') !== null`, "theme source");
    await hub.settle();
    await page.evaluate(`history.back()`);
    await see(
        `document.querySelector('${query}')?.value === 'Pape' && document.querySelector('.library-detail')?.getAttribute('aria-label') === 'Paper'`,
        "Back returns to the selected gallery detail with the edited search",
    );
    await hub.settle();
    await page.type({ selector: query }, "Relay");
    await see(
        `!document.querySelector('${theme}') && document.querySelector('.ext-inspector-toggle [aria-label="Relay: on"]') !== null`,
        "no hidden theme action after search",
    );
});

test(
    "Menu opens Installed; Discover installs off and Updates approves the exact pin",
    real,
    async (t) => {
        const first = offer("1.0.0", "1".repeat(40));
        const { app, page, data, enter, see, click, settle, inPage } = await openHub(t);
        const installed = async () =>
            (await app.gallery.installed()).items.find((item) => item.name === NAME);
        const provenance = () =>
            parseEntry(
                JSON.parse(readFileSync(join(data, "extensions", `${NAME}.gallery.json`), "utf8"))
                    .entry,
            );

        await enter(VIEWPORTS.mobile);
        await click("Menu");
        await click("App settings");
        await click("Extensions and integrations");
        await click("Extensions");
        await see(
            `document.querySelector('.extension-hub [role="tab"][aria-selected="true"]')?.textContent.includes('Installed')`,
            "Menu → Extensions opens Installed",
        );
        await click("Discover");
        await see(`document.querySelector('.ext-row-open') !== null`, "Discover's listing");
        await settle();
        await page.type({ selector: '.extension-hub input[type="search"]' }, "clock");
        await page.click({ selector: ".ext-row-open" });
        await see(
            `document.querySelector('.extension-hub-layout.has-selection') !== null`,
            "the phone's selected detail",
        );
        await click("Back");
        await see(
            `document.querySelector('.extension-hub-layout.has-selection') === null`,
            "the listing after detail Back",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('.extension-hub input[type="search"]').value)`,
            ),
            "clock",
            "phone detail Back preserves the search",
        );
        await click("Install");
        await until(async () => (await installed())?.version === "1.0.0", "the listing install");
        assert.equal((await installed())?.enabled, false);
        assert.equal(pinOf(provenance()), first.pin);
        await see(
            `document.querySelector('.ext-row')?.textContent.toLowerCase().includes('installed') === true`,
            "the listing's installed state without reopening",
        );

        const second = offer("2.0.0", "2".repeat(40));

        await click("Updates");
        await click("Refresh");
        await see(
            `[...document.querySelectorAll('.ext-row button')].some((button) => button.textContent.trim() === 'Update')`,
            "the update's direct review action",
        );
        await click("Update");
        await see(
            `document.querySelector('[data-part="diff"], .diff')?.textContent.includes('2.0.0') === true`,
            "the update diff",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify((await import('/store.js')).store.state.sheet?.type)`,
            ),
            "gallery-update",
            "Review update goes to the diff, not entry details",
        );
        await click("Apply update");
        await until(async () => (await installed())?.version === "2.0.0", "the approved update");
        assert.equal((await installed())?.enabled, false, "an update leaves an off extension off");
        assert.notEqual(second.pin, first.pin);
        assert.equal(pinOf(provenance()), second.pin, "the approved manifest is now pinned");
        assert.equal(readFileSync(join(data, "extensions", FILE), "utf8"), second.source);
    },
);

test(
    "Installed gallery detail combines settings with source and uninstall, and uses one activation path",
    real,
    async (t) => {
        const { pin } = offer("1.2.3", "a".repeat(40));
        const hub = await openHub(t);
        const { app, page, enter, inPage, see, click } = hub;

        await app.gallery.install(NAME, pin);
        await enter(VIEWPORTS.desktop);
        await menu(hub);
        await page.click({ selector: row(FILE) });
        const buttons = `[...document.querySelectorAll('.library-detail button')]`;

        await see(
            `${buttons}.some(b => b.textContent.trim() === 'Turn on')`,
            "gallery activation action",
        );
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(${buttons}.filter(b => b.getAttribute('role') === 'switch' || b.textContent.trim() === 'Turn on').length)`,
            ),
            1,
        );
        await hub.settle();
        await page.click({ selector: ".library-detail .ext-actions .primary" });
        await see(`document.querySelector('.ext-dialog') !== null`, "gallery enable asks first");
        await hub.settle();
        await page.click({ selector: ".ext-dialog .primary" });
        await see(`${buttons}.some(b => b.textContent.trim() === 'Turn off')`, "gallery enabled");
        await see(
            `document.querySelector('#ext-setting-hub-clock-caption') !== null`,
            "installed module settings",
        );
        await page.click({ selector: ".ext-inspector-details summary" });
        await page.type({ selector: "#ext-setting-hub-clock-caption" }, "Local time");
        await click("Save settings");
        await until(
            () => app.config.extensionSettings(NAME).caption === "Local time",
            "the gallery module setting saved",
        );
        const actions = await inPage<string[]>(
            `return JSON.stringify(${buttons}.map(b => b.textContent.trim()))`,
        );

        for (const label of [
            "Turn off",
            "View source",
            "Ask Pi to review",
            "Reload",
            "Uninstall",
        ]) {
            assert.equal(actions.filter((text) => text === label).length, 1, label);
        }
    },
);

test(
    "Find extensions opens Discover; Install and turn on asks before the code runs",
    real,
    async (t) => {
        offer("3.0.0", "3".repeat(40), 'const NOW = "https://time.example.net/now";\n');
        const { app, page, enter, see, settle, inPage } = await openHub(t);
        const installed = async () =>
            (await app.gallery.installed()).items.find((item) => item.name === NAME);

        await app.gallery.listing(true);

        await enter(VIEWPORTS.desktop);
        await settle();
        await page.press("Control+K");
        await see(`document.querySelector('.launcher input:focus') !== null`, "the launcher field");
        await page.type({ selector: ".launcher input" }, "Find extensions");
        await see(
            `document.querySelector('.launcher-item.on')?.textContent.includes('Find extensions')`,
            "the gallery shortcut",
        );
        await settle();
        await page.press("Enter");
        await see(
            `document.querySelector('.extension-hub [role="tab"][aria-selected="true"]')?.textContent.includes('Discover')`,
            "Find extensions opens Discover",
        );
        await see(`document.querySelector('.ext-row-open') !== null`, "the gallery entry");
        await settle();
        await page.click({ selector: ".ext-row-open" });
        await see(
            `document.querySelector('.ext-row .ext-facts')?.textContent.includes('time.example.net') === true`,
            "the row's fact from the scan of its code",
        );
        await settle();
        await page.click({ selector: ".extension-hub-detail .ext-actions .primary" });
        await see(
            `document.querySelector('.ext-dialog')?.textContent.includes('Talks to time.example.net') === true`,
            "the question, with what its code reaches",
        );
        assert.equal(await installed(), undefined, "asking installs nothing");
        await page.press("Escape");
        await see(`document.querySelector('.ext-dialog') === null`, "Escape closes the question");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.extension-hub') !== null)`,
            ),
            true,
            "and leaves the sheet open",
        );
        assert.equal(await installed(), undefined);
        await page.click({ selector: ".extension-hub-detail .ext-actions .primary" });
        await see(`document.querySelector('.ext-dialog') !== null`, "the question again");
        await page.click({ selector: ".ext-dialog .primary" });
        await until(async () => (await installed())?.enabled === true, "installed and turned on");
        await see(
            `document.querySelector('.ext-standing')?.textContent.includes('On') === true`,
            "the entry's standing",
        );
    },
);
