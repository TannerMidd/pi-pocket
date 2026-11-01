import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

// A 1×1 PNG.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);
const picture = join(work, "dot.png");

const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    if (text === "read the picture") {
        return fauxAssistantMessage([fauxToolCall("read", { path: picture })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("seen")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string, timeoutMs = 10_000) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(work, { recursive: true });
    writeFileSync(picture, PNG);
    app = await openApp(scriptedModel(route));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "read-image-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("an image a read returned shows only once the read is opened", real, async () => {
    const id = await newSession(app);

    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
        "the session",
    );
    await app.commands.submit(id, owner(app), {
        text: "read the picture",
        requestId: `read-${id}`,
    });
    await see(
        `return JSON.stringify(document.body.textContent.includes("seen"))`,
        "Pi's answer",
        20_000,
    );

    await inPage(`
        const group = document.querySelector('[data-part="activity"]:not(.open) .activity-head');
        group?.click();
        return "null";
    `);

    const step = "[data-part=tool-call][data-status=done]";

    await see(
        `return JSON.stringify(document.querySelector('${step} .step-meta')?.textContent.trim() === "image")`,
        "the read's line",
    );
    assert.equal(
        await inPage(`return JSON.stringify(document.querySelectorAll("${step} .thumbs").length)`),
        0,
        "no picture under the closed read",
    );

    await inPage(`document.querySelector('${step} .step-head').click(); return "null";`);
    await see(
        `return JSON.stringify(document.querySelector('${step} .step-body .thumbs img') !== null)`,
        "the picture in the opened read",
    );
    assert.equal(
        await inPage(`return JSON.stringify(document.querySelectorAll("${step} .thumbs").length)`),
        1,
        "the picture once, not twice",
    );
});
