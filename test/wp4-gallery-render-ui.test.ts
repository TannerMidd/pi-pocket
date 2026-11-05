// Gallery rendering against the real temporary server; only its external index and file network are replaced.
import { cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const INDEX = "https://raw.githubusercontent.com/TannerMidd/pi-pocket-extensions/HEAD/index.json";
const NAME = "wp4-clock";
const THEME = "wp4-paper";
const served = new Map<string, string>();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const filesFor = (name: string, commit: string, files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
        served.set(
            `https://raw.githubusercontent.com/someone/pocket-${name}/${commit}/${file}`,
            text,
        );
    }

    return Object.entries(files).map(([name, text]) => ({
        name,
        sha256: sha(text),
        size: Buffer.byteLength(text),
    }));
};

function extension(version: string, commit: string) {
    const content = `/** WP4 gallery clock ${version}. */\nexport default () => undefined;\n`;

    return {
        name: NAME,
        title: "WP4 clock",
        description: "Author text",
        tags: ["test"],
        author: { name: "Author" },
        version,
        source: { repo: `someone/pocket-${NAME}`, commit },
        files: filesFor(NAME, commit, { [`${NAME}.ts`]: content }),
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
}

function theme() {
    const commit = "c".repeat(40);

    return {
        kind: "theme",
        name: THEME,
        title: "WP4 paper",
        description: "Author palette",
        tags: ["test"],
        author: { name: "Author" },
        version: "1.0.0",
        source: { repo: `someone/pocket-${THEME}`, commit },
        files: filesFor(THEME, commit, {
            [`${THEME}/theme.json`]: '{"themeApi":1,"name":"WP4 paper"}',
            [`${THEME}/theme.css`]: ":root { --accent: #123456; }\n",
            [`${THEME}/colors.toml`]:
                'mode = "dark"\nbackground = "#101010"\nforeground = "#eeeeee"\naccent = "#123456"\n',
        }),
        themeApi: 1,
        minPocket: "0.14.0",
    };
}

async function value<T>(page: BrowserPage, expression: string): Promise<T> {
    return JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;
}

async function see(page: BrowserPage, expression: string, description: string) {
    await until(() => value<boolean>(page, `Boolean(${expression})`), description, 15000);
}

after(cleanUp);

test(
    "WP4 real gallery renders palette roles, API requirements and update status in English",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
    },
    async (t) => {
        const data = mkdtempSync(join(root, "wp4-render-data-"));
        const app = await openApp(scriptedModel(), data);
        let server: Server | undefined;
        let browsers: Browsers | undefined;

        t.after(async () => {
            await browsers?.closeAll({ final: true });
            server?.closeAllConnections();
            server?.close();
            await app.close();
        });
        const paper = theme();
        const old = extension("1.0.0", "a".repeat(40));

        served.set(INDEX, JSON.stringify({ format: 1, extensions: [old, paper] }));
        app.gallery.fetch = async (url) =>
            served.has(url) ? new Response(served.get(url)) : new Response("", { status: 404 });
        const first = await app.gallery.listing(true);
        const pin = first.entries.find((item) => item.name === NAME)?.pin;

        assert.ok(pin, "the test extension is listed");
        await app.gallery.install(NAME, pin);
        const update = extension("2.0.0", "b".repeat(40));

        served.set(INDEX, JSON.stringify({ format: 1, extensions: [update, paper] }));
        await app.gallery.listing(true);
        const id = await newSession(app);

        server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "wp4-render-browser-")),
            load: async () => undefined,
            save: () => {},
        });
        const page = await browsers.open(1);

        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${id}`);
        await see(
            page,
            `(await import('/store.js')).store.state.connection === 'open'`,
            "connected session",
        );

        await page.evaluate(
            `(await import('/store.js')).openSheet({ type: 'gallery-entry', id: '${THEME}', tab: 'discover', origin: 'extensions' });`,
        );
        await see(
            page,
            `document.querySelector('.ext-swatches')?.textContent.includes('#101010')`,
            "real theme palette",
        );
        const palette = await value<string>(
            page,
            `document.querySelector('.ext-swatches').textContent`,
        );

        assert.match(palette, /background\s+#101010/);
        assert.match(palette, /text\s+#eeeeee/);
        assert.match(palette, /accent\s+#123456/);
        const titles = await value<string[]>(
            page,
            `[...document.querySelectorAll('.ext-swatches i[title]')].map((node) => node.title)`,
        );

        assert.ok(
            titles.some((title) => title.includes("#101010") && title.includes("background")),
        );
        assert.ok(
            (
                await value<string>(
                    page,
                    `document.querySelector('.extension-hub-detail').textContent`,
                )
            ).includes("Pi Pocket 0.14.0 or newer · theme API 1"),
        );

        await page.evaluate(
            `(await import('/store.js')).openSheet({ type: 'gallery-entry', id: '${NAME}', tab: 'discover', origin: 'extensions' });`,
        );
        await see(
            page,
            `document.querySelector('.extension-hub-detail')?.textContent.includes('extension API 1')`,
            "extension requirements",
        );
        assert.ok(
            (
                await value<string>(
                    page,
                    `document.querySelector('.extension-hub-detail').textContent`,
                )
            ).includes("Pi Pocket 0.14.0 or newer · extension API 1"),
        );

        await page.evaluate(
            `(await import('/store.js')).openSheet({ type: 'gallery-update', id: '${NAME}', tab: 'updates', origin: 'extensions' });`,
        );
        await see(
            page,
            `document.querySelector('.gallery-change.changed')`,
            "update preview's real changed file",
        );
        assert.equal(
            await value(
                page,
                `document.querySelector('.gallery-change.changed').textContent.trim()`,
            ),
            "changed",
        );
    },
);
