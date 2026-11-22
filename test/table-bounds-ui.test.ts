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
const WIDE_TABLE = `A wide table, and a cell that cannot break:

| Col one | Col two | Col three | Col four | Col five | Col six | Col seven | Col eight |
| --- | --- | --- | --- | --- | --- | --- | --- |
| words in the first cell | b | c | d | e | f | g | h |
| one-unbreakable-run-of-characters-far-longer-than-any-cell-could-hold | x | y | z | 1 | 2 | 3 | 4 |`;

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
        tableRight: number;
        wordsRight: number;
        tableScrollW: number;
        tableClientW: number;
        scrollerScrollW: number;
        scrollerClientW: number;
    }>(`
        const table = document.querySelector('.md table');
        const words = table.closest('.md');
        const scroller = document.querySelector('.scroller');

        return JSON.stringify({
            tableRight: Math.round(table.getBoundingClientRect().right),
            wordsRight: Math.round(words.getBoundingClientRect().right),
            tableScrollW: table.scrollWidth,
            tableClientW: table.clientWidth,
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
    // The scripted model echoes the message back, so the reply is Markdown with the wide table in it.
    await say(app, one, WIDE_TABLE);
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

for (const [name, viewport] of Object.entries(VIEWPORTS) as [string, Viewport][]) {
    test(`a reply's Markdown table stays in the column on ${name}`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${Number(one)}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.md table') !== null)`,
                ),
            "the reply's table",
            20_000,
        );

        const b = await bounds();

        // Inside the column: the table ends no further right than its own words, so it never runs past the reply and
        // the composer below it.
        assert.ok(
            b.tableRight <= b.wordsRight + 1,
            `table ends at ${b.tableRight}, words at ${b.wordsRight}`,
        );
        // Never widens the transcript: the scroller has no sideways overflow.
        assert.equal(b.scrollerScrollW, b.scrollerClientW, "the transcript is not widened");
        // Usable: a table wider than the column scrolls inside its own card.
        assert.ok(b.tableScrollW > b.tableClientW, "the table keeps all of itself");
        assert.ok(b.tableClientW > 0, "the table is not crushed to nothing");
    });
}
