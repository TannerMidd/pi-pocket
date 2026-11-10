// The viewer's Download in a real Chromium: a plain browser download of the session's file, which an app around the
// page (a desktop app) may save itself.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
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
import { Chromium, type Json } from "../src/server/browser/cdp.ts";
import { findBrowser, profileFolder } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const executable = findBrowser();
const real = {
    skip: executable === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/**
 * A desktop app's `window.pocketHost`, as its preload puts it in the page before the page's own scripts run. It keeps
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

    mkdirSync(work, { recursive: true });
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

/** Open a server session and one real file in its viewer. */
async function filePage(capabilities: string[]) {
    const id = await newSession(app);
    const path = join(work, "download-notes.txt");

    writeFileSync(path, "a file to save\n");

    const page = await openPage(capabilities);

    await page.evaluate(`import("/store.js").then(({ navigate }) => navigate(${id}))`);
    await until(
        () =>
            page.evaluate<boolean>(
                `import("/store.js").then(({ store }) => store.state.view.conversation?.id === ${id})`,
            ),
        "the server session",
    );
    await page.evaluate(
        `import("/ui.js").then(({ openFile }) => openFile(${JSON.stringify(path)}))`,
    );
    await until(
        () =>
            page.evaluate<boolean>(
                `Boolean(document.querySelector('.file-viewer [aria-label="Download"]'))`,
            ),
        "the viewer's Download button",
    );

    return { ...page, id, path };
}

test(
    "Download is offered to readers of files on the server and on a linked computer, but not for folders",
    real,
    async () => {
        const page = await filePage([]);
        const downloadShows = () =>
            page.evaluate<boolean>(
                `Boolean(document.querySelector('.file-viewer [aria-label="Download"]'))`,
            );

        try {
            await page.evaluate(
                `import("/store.js").then(({ store }) => store.set({ me: { ...store.state.me, role: "viewer" } }))`,
            );
            assert.equal(await downloadShows(), true, "a reader can download");

            await page.evaluate(
                `import("/store.js").then(({ store }) => store.set({ view: { ...store.state.view, conversation: { ...store.state.view.conversation, runner: "test-runner" } } }))`,
            );
            // A session on a linked computer downloads its files too (the session's folder, through the runner).
            assert.equal(await downloadShows(), true, "Download for a file on a linked computer");

            await page.evaluate(
                `import("/store.js").then(({ store }) => store.set({ view: { ...store.state.view, conversation: { ...store.state.view.conversation, runner: undefined } } }))`,
            );
            await until(downloadShows, "Download for the server file again");
            await page.evaluate(
                `import("/ui.js").then(({ openFile }) => openFile(${JSON.stringify(work)}))`,
            );
            await until(
                () =>
                    page.evaluate<boolean>(
                        `Array.from(document.querySelectorAll(".file-viewer .file-entry")).some((entry) => entry.textContent.includes("download-notes.txt"))`,
                    ),
                "the folder",
            );
            assert.equal(await downloadShows(), false, "a folder has no Download");
        } finally {
            await page.close();
        }
    },
);

test("Download is a plain browser download, also inside an app around the page", real, async () => {
    // Also when an app around the page offers capabilities: the page asks it nothing for a download.
    for (const capabilities of [[], ["newSession"]]) {
        const page = await filePage(capabilities);

        try {
            await page.evaluate(`(() => {
                window.browserDownloads = [];
                HTMLAnchorElement.prototype.click = function () {
                    window.browserDownloads.push({ url: this.getAttribute("href"), name: this.download });
                };
            })()`);
            await page.evaluate(
                `document.querySelector('.file-viewer [aria-label="Download"]').click()`,
            );
            assert.deepEqual(await page.evaluate<Json>("window.browserDownloads"), [
                {
                    url: `/api/c/${page.id}/download?path=${encodeURIComponent(page.path)}`,
                    name: "download-notes.txt",
                },
            ]);
        } finally {
            await page.close();
        }
    }
});
