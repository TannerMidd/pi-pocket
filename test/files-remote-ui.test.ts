import { cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let id: number;
let removeProvider: (() => void) | undefined;

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    removeProvider = app.registerWorkspaceProvider("ssh", {
        env: () => new NodeExecutionEnv({ cwd: "ssh://host/work" }),
        resolveCwd: async (cwd) => cwd,
    });
    const session = await app.commands.createSession(owner(app), { cwd: "ssh://host/work" });

    id = Number(session.id);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "files-remote-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            await inPage<boolean>(`
                return JSON.stringify((await import("/store.js")).store.state.view.conversation?.cwd ===
                    "ssh://host/work")
            `),
        "the SSH workspace",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    removeProvider?.();
    await app?.close();
    cleanUp();
});

test("SSH workspaces do not expose local Files or Changes controls", real, async () => {
    const state = await inPage<{
        available: boolean;
        controls: number;
        rejected: boolean;
        tile: boolean;
        customSchemeUnavailable: boolean;
        windowsPathAvailable: boolean;
    }>(`
        const { store } = await import("/store.js");
        const { filesAvailable, setFilesOpen, toggleFiles } = await import("/files-panel.js");

        setFilesOpen(true, "files");
        toggleFiles("changes");
        const rejected = !store.state.filesOpen;
        const available = filesAvailable();
        store.set({ filesOpen: true });
        await new Promise((resolve) => requestAnimationFrame(resolve));

        const customConversation = { ...store.state.view.conversation, cwd: "custom+ssh://host/work" };
        store.set((state) => ({
            view: { ...state.view, agent: undefined, conversation: customConversation },
        }));
        const customSchemeUnavailable = !filesAvailable();
        const windowsConversation = { ...customConversation, cwd: "C:\\\\work" };
        store.set((state) => ({
            view: { ...state.view, conversation: windowsConversation },
        }));

        return JSON.stringify({
            available,
            controls: document.querySelectorAll(".files-tabs, .topbar [aria-label='Files'], .changes-button").length,
            rejected,
            tile: document.querySelector(".files-tile") !== null,
            customSchemeUnavailable,
            windowsPathAvailable: filesAvailable(),
        });
    `);

    assert.deepEqual(state, {
        available: false,
        controls: 0,
        rejected: true,
        tile: false,
        customSchemeUnavailable: true,
        windowsPathAvailable: true,
    });
});
