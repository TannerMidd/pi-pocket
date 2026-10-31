// A background task's end message (src/server/background.ts) shows as a card with its output folded away.
import {
    type App,
    cleanUp,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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

/** The owner asks for a background task (`start a background task: <command>`); everything else answers "done". */
const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    if (text?.startsWith("start a background task")) {
        const command = text.split(": ")[1] ?? "seq 1000 1200";

        return fauxAssistantMessage([fauxToolCall("background", { action: "start", command })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("done")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const see = (script: string, what: string, timeoutMs = 10_000) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(route));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "background-ui-")),
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

test("a background task's end shows as a card with its last lines", real, async () => {
    const id = await newSession(app);

    await loadTools(app, id, "background");

    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
        "the session",
    );
    await app.commands.submit(id, owner(app), {
        text: "start a background task",
        requestId: `go-${id}`,
    });

    // The watch tells Pi within a few seconds of the command ending.
    await see(
        `return JSON.stringify(document.querySelector(".background-report") !== null)`,
        "the background card",
        20_000,
    );

    const head = await inPage<string>(
        `return JSON.stringify(document.querySelector(".background-report .report-head")?.textContent.replace(/\\s+/g, " ").trim())`,
    );

    assert.match(head, /^[0-9a-f]{6} exited with code 0 · \d+s$/);

    const card = () =>
        inPage<string>(
            `return JSON.stringify(document.querySelector(".background-report")?.textContent.replace(/\\s+/g, " ").trim())`,
        );

    // Its command, and the last lines of its output as printed: the rest (and Pi's words about the tool) stay folded.
    assert.match(await card(), /seq 1000 1200/);
    assert.match(await card(), /1193 1194 1195 1196 1197 1198 1199 1200/);
    assert.doesNotMatch(await card(), /1192/);
    assert.doesNotMatch(await card(), /Read the rest with the background tool/);
    assert.equal(
        await inPage(
            `return JSON.stringify(document.querySelector(".background-output pre")?.textContent.split("\\n").length)`,
        ),
        8,
    );

    const link = ".background-report .background-output .link";

    assert.equal(
        await inPage(
            `return JSON.stringify(document.querySelector("${link}")?.textContent.trim())`,
        ),
        "Show all 201 lines",
    );

    // Show all opens the whole output.
    await page.click({ selector: link });
    await see(
        `return JSON.stringify(document.querySelector("${link}")?.textContent.trim() === "Show less")`,
        "the output open",
    );
    assert.match(await card(), /^.*\b1000 1001\b/);
});

test("output whose own line says it is the end is not taken for a cut one", real, async () => {
    const id = await newSession(app);

    await loadTools(app, id, "background");

    await page.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
        "the session",
    );
    await app.commands.submit(id, owner(app), {
        text: "start a background task: printf 'one\\nThe end of its output\\n'",
        requestId: `quiet-${id}`,
    });
    await see(
        `return JSON.stringify(document.querySelector(".background-output pre") !== null)`,
        "the background card",
        20_000,
    );
    assert.equal(
        await inPage(
            `return JSON.stringify(document.querySelector(".background-output pre").textContent)`,
        ),
        "one\nThe end of its output",
    );
    // All of it reached Pi: no "The end of its output:" label above it.
    assert.equal(
        await inPage(`return JSON.stringify(document.querySelector(".background-output .muted"))`),
        null,
    );
});
