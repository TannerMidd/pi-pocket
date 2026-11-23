// The desktop host bridge's page side, in a real Chromium: a page in a embedder names the host events it handles as
// it subscribes, and a `newSession` event opens the New session sheet, as Alt+N does.
import { type App, cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Chromium, type Json } from "../src/server/browser/cdp.ts";
import { findBrowser, profileFolder } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const executable = findBrowser();
const real = {
    skip: executable === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/**
 * An embedder's `window.pocketHost`, as its preload puts it in the page before the page's own scripts run. It keeps
 * what the page subscribed with, so the test can send events and read the events the page named.
 */
const fakeHost = (capabilities: string[]) => `(() => {
    window.pocketHost = {
        kind: "test",
        apiVersion: 1,
        capabilities: ${JSON.stringify(capabilities)},
        subscribe(listener, events) {
            window.hostListener = listener;
            window.hostEvents = events;
        },
    };
})();`;

let app: App;
let server: Server;
let browser: Chromium | undefined;
let base = "";

/** A page of its own, with its own cookies, and the given host in it. */
async function openPage(capabilities: string[]) {
    const connection = browser!.connection;
    const context = await connection.send("Target.createBrowserContext");
    const target = await connection.send("Target.createTarget", {
        url: "about:blank",
        browserContextId: context.browserContextId,
    });
    const { sessionId } = await connection.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<Json> =>
        connection.send(method, params, sessionId);

    const evaluate = async <T>(expression: string): Promise<T> => {
        const result = await send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });

        if (result.exceptionDetails !== undefined) {
            throw new Error(String(result.exceptionDetails.exception?.description));
        }

        return result.result.value as T;
    };

    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: fakeHost(capabilities) });

    const go = async (url: string) => {
        await send("Page.navigate", { url });
        await until(
            async () => (await evaluate<string>("document.readyState")) === "complete",
            url,
        );
    };

    await go(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await go(`${base}/`);
    // Signed in, and the app's modules running.
    await until(
        () =>
            evaluate<boolean>(
                `import("/store.js").then(({ store }) => Boolean(store.state.me && store.state.server))`,
            ),
        "the signed-in app",
    );

    return {
        evaluate,
        sheet: () =>
            evaluate<Json>(
                `import("/store.js").then(({ store }) => store.state.sheet && { type: store.state.sheet.type, mode: store.state.sheet.mode })`,
            ),
        close: () => connection.send("Target.disposeBrowserContext", context),
    };
}

before(async () => {
    if (executable === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await Chromium.launch(
        executable,
        profileFolder(executable, mkdtempSync(join(root, "desktop-ui-"))),
        [],
    );
});

after(async () => {
    browser?.kill();
    await browser?.exited;
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the page names the host events it handles, and newSession opens the New session sheet",
    real,
    async () => {
        const page = await openPage(["newSession", "open"]);

        try {
            const events = await page.evaluate<string[]>("window.hostEvents");

            assert.ok(Array.isArray(events), "the page names its events");
            assert.ok(events.includes("newSession"));
            assert.ok(events.includes("open"));
            assert.equal(await page.sheet(), null);

            await page.evaluate(`window.hostListener({ type: "newSession" })`);
            await until(async () => (await page.sheet()) !== null, "the New session sheet");
            assert.deepEqual(await page.sheet(), { type: "cwd", mode: "new" });
            assert.equal(
                await page.evaluate<boolean>(`Boolean(document.querySelector(".sheet"))`),
                true,
                "the sheet shows",
            );
        } finally {
            await page.close();
        }
    },
);

test("without the newSession capability, the event opens nothing", real, async () => {
    const page = await openPage(["open"]);

    try {
        await page.evaluate(`window.hostListener({ type: "newSession" })`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(await page.sheet(), null);
    } finally {
        await page.close();
    }
});
