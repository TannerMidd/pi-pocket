// A Markdown table in a reply must stay inside the text column: it may scroll inside its own card, but it must
// never run past the reply's words and the composer, and it must never widen the transcript, even when a cell holds
// an unbreakable run or the table has more columns than fit.
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
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const WIDE_TABLES = `A table with prose in its cells:

| Opportunity | What it would add |
| --- | --- |
| Browser acceptance checks | After an update, check that the confirmation is visible, the loading state has ended, and the expected controls are enabled. Check that the content still fits on a phone and a wide desktop. |
| Run outcomes | A completion notification can say what the assistant reported without changing whether the notification is sent. |

A wide table, and a cell that cannot break:

| Col one | Col two | Col three | Col four | Col five | Col six | Col seven | Col eight | Col nine | Col ten | Col eleven | Col twelve |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| words in the first cell | b | c | d | e | f | g | h | i | j | k | l |
| one-unbreakable-run-of-characters-far-longer-than-any-cell-could-hold | x | y | z | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let one: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Where the table sits against its reply's words and the pane, once the reply is drawn. */
const bounds = () =>
    inPage<{
        tables: {
            tableRight: number;
            wordsRight: number;
            scrollWidth: number;
            clientWidth: number;
        }[];
        scrollerScrollW: number;
        scrollerClientW: number;
    }>(`
        const scroller = document.querySelector('.scroller');

        return JSON.stringify({
            tables: Array.from(document.querySelectorAll('[data-part~="reply"] .md table'), (table) => ({
                tableRight: Math.round(table.getBoundingClientRect().right),
                wordsRight: Math.round(table.closest('.md').getBoundingClientRect().right),
                scrollWidth: table.scrollWidth,
                clientWidth: table.clientWidth,
            })),
            scrollerScrollW: scroller.scrollWidth,
            scrollerClientW: scroller.clientWidth,
        });
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    one = await newSession(app);
    await say(app, one, WIDE_TABLES);
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
        dataDir: mkdtempSync(join(root, "table-bounds-ui-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const viewports: Record<string, Viewport> = {
    ...VIEWPORTS,
    "wide desktop": { width: 2560, height: 1440, scale: 1, mobile: false },
};

for (const [name, viewport] of Object.entries(viewports)) {
    test(`a reply's Markdown table stays in the column on ${name}`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${Number(one)}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelectorAll('[data-part~="reply"] .md table').length === 2)`,
                ),
            "both reply tables",
            20_000,
        );

        const b = await bounds();

        for (const [index, table] of b.tables.entries()) {
            assert.ok(
                table.tableRight <= table.wordsRight + 1,
                `table ${index + 1} ends at ${table.tableRight}, words at ${table.wordsRight}`,
            );
            assert.ok(table.clientWidth > 0, "the table has a visible width");
        }

        assert.equal(b.scrollerScrollW, b.scrollerClientW, "the transcript is not widened");
        const wide = b.tables[1]!;

        assert.ok(
            wide.scrollWidth > wide.clientWidth,
            "the many-column table scrolls inside its box",
        );
    });
}
