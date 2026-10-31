// The hub's direct listing actions: installing never enables code, and updating approves the diff's exact pin.
import { cleanUp, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { parseEntry, pinOf } from "../src/server/gallery/entry.ts";
import { createHandler } from "../src/server/http.ts";

const INDEX = "https://raw.githubusercontent.com/TannerMidd/pi-pocket-extensions/HEAD/index.json";
const NAME = "hub-clock";
const FILE = `${NAME}.ts`;
const served = new Map<string, string>();

after(cleanUp);

function offer(version: string, commit: string, body = "") {
    const source = `/** Hub clock ${version}. */
import { defineExtension } from "@earendil-works/pi-durable";
${body}export default () => defineExtension({ name: "hub-clock" });
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

test(
    "Menu opens Discover; listing installs off and reviews an update directly, preserving off",
    { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false },
    async (t) => {
        const first = offer("1.0.0", "1".repeat(40));
        const app = await openApp(scriptedModel());
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

        const installed = async () =>
            (await app.gallery.installed()).items.find((item) => item.name === NAME);
        const provenance = () =>
            parseEntry(
                JSON.parse(
                    readFileSync(join(root, "data", "extensions", `${NAME}.gallery.json`), "utf8"),
                ).entry,
            );

        await page.setViewport(VIEWPORTS.mobile);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        const session = await newSession(app);

        await page.navigate(`${base}/s/${session}`);
        await see(`document.querySelector('[aria-label="Menu"]') !== null`, "the menu button");
        await click("Menu");
        await see(
            `[...document.querySelectorAll('.list-item')].some((item) => item.firstElementChild?.textContent === 'Extensions')`,
            "the Extensions menu item",
        );
        await click("Extensions");
        await see(`document.querySelector('.ext-row') !== null`, "Discover's listing");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent.trim() === 'Discover' && tab.getAttribute('aria-selected') === 'true'))`,
            ),
            true,
            "Menu → Extensions goes directly to Discover",
        );
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
        assert.equal(readFileSync(join(root, "data", "extensions", FILE), "utf8"), second.source);

        await inPage(
            `(await import('/store.js')).openSheet({ type: 'extensions', tab: 'installed' }); return 'null';`,
        );
        await app.setExtensionEnabled(owner(app), "gallery.ts", false);
        await see(
            `document.querySelector('.extension-hub') === null`,
            "standalone management with gallery off",
        );
        await click("Back");
        await see(
            `(await import('/store.js')).store.state.sheet?.type === 'menu'`,
            "Back leaves Extensions after disabling the gallery",
        );
    },
);

test(
    "Install and turn on asks once, with what its code reaches, and Escape closes only the question",
    { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false },
    async (t) => {
        offer("3.0.0", "3".repeat(40), 'const NOW = "https://time.example.net/now";\n');
        const app = await openApp(scriptedModel());
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "extensions-hub-ask-")),
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
        const installed = async () =>
            (await app.gallery.installed()).items.find((item) => item.name === NAME);
        const settle = () => new Promise((resolve) => setTimeout(resolve, 450));

        // The test before leaves the gallery off and the extension installed, in the shared data folder.
        await app.setExtensionEnabled(owner(app), "gallery.ts", true);

        if ((await installed()) !== undefined) {
            await app.gallery.uninstall(owner(app), NAME);
        }

        await app.gallery.listing(true);

        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        const session = await newSession(app);

        await page.navigate(`${base}/s/${session}`);
        await see(`document.querySelector('.composer') !== null`, "the conversation");
        await inPage(
            `(await import('/store.js')).openSheet({ type: 'gallery-entry', id: '${NAME}', tab: 'discover', origin: 'extensions' }); return 'null';`,
        );
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
