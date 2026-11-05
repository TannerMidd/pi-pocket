// Code in a person's message, in a real browser: `spans` and ``` fences show as code, and nothing else in the
// message changes from what was typed.
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
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "user-code-ui-")),
        load: async () => undefined,
        save: () => {},
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

test("a person's spans and fences show as code, and the rest as typed", real, async () => {
    const id = await newSession(app);
    const text = [
        "Run `npm test` and ``a ` b`` in @src/app.ts, *not* bold.",
        "```js",
        "const x = 1;",
        "```",
        "A stray ` and an open ``` stay text.",
    ].join("\n");

    await say(app, id, text);
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () => (await inPage<string>(TEXT)) !== "",
        "the message in the conversation",
        20_000,
    );

    const shown = await inPage<{
        spans: string[];
        blocks: string[];
        lang: string;
        text: string;
        mention: string;
    }>(SHOWN);

    assert.deepEqual(shown.spans, ["npm test", "a ` b"]);
    assert.deepEqual(shown.blocks, ["const x = 1;"]);
    assert.ok(shown.lang !== "", "the js fence is colored");
    assert.equal(shown.mention, "@src/app.ts");
    assert.equal(
        shown.text,
        "Run npm test and a ` b in @src/app.ts, *not* bold.const x = 1;A stray ` and an open ``` stay text.",
    );
});

/** The first message's text, once it shows. */
const TEXT = `return JSON.stringify(document.querySelector(".user-text")?.textContent ?? "")`;
/** What the first message shows: its spans, its blocks, whether a block is colored, its mention, and its text. */
const SHOWN = `
    const message = document.querySelector(".user-text");

    return JSON.stringify({
        spans: [...message.querySelectorAll(":scope > code")].map((each) => each.textContent),
        blocks: [...message.querySelectorAll("pre.user-code")].map((each) => each.textContent),
        lang: message.querySelector("pre.user-code span")?.className ?? "",
        mention: message.querySelector(".file-mention")?.textContent.trim() ?? "",
        text: message.textContent,
    });
`;
