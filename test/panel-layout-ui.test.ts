// Each session shows the panel it showed when it was left (`web/panel-layout.js`, `web/store.js`): in the same tab, after
// a reload, and in another tab of the device; and none after a sign-out.
import { cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

after(cleanUp);

type Shown = { id: number | null; ext: unknown; files: boolean; tab: string; people: boolean };

test("a session shows again the panel it showed when it was left", real, async () => {
    const app = await openApp(scriptedModel());
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "panel-layout-ui-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        const [first, second] = [await newSession(app), await newSession(app)];

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const inPage = async <T>(script: string) => JSON.parse(await page.evaluate(script)) as T;
        const shown = () =>
            inPage<Shown>(`
                const { store } = await import("/store.js");
                const state = store.state;

                return JSON.stringify({
                    id: state.conversationId,
                    ext: state.extPanel,
                    files: state.filesOpen,
                    tab: state.filesTab,
                    people: state.peopleOpen,
                });
            `);
        const go = (id: number | null) =>
            inPage(`(await import("/store.js")).navigate(${JSON.stringify(id)}); return "null";`);
        const ready = async (id: number) =>
            until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(location.pathname === "/s/${id}" && (await import("/store.js")).store.state.view.conversation?.id === ${id})`,
                    ),
                `session ${id}`,
            );

        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${first}`);
        await ready(Number(first));

        // The first session shows an extension's panel (as Design's); the second, Files on its Changes tab.
        await inPage(
            `(await import("/extension-ui.js")).openExtPanel("design", "design"); return "null";`,
        );
        await go(Number(second));
        await ready(Number(second));
        assert.equal((await shown()).ext, null, "the second session shows no panel yet");
        await inPage(
            `(await import("/files-panel.js")).setFilesOpen(true, "changes"); return "null";`,
        );

        await go(Number(first));
        await ready(Number(first));
        assert.deepEqual(await shown(), {
            id: Number(first),
            ext: { module: "design", id: "design" },
            files: false,
            tab: "files",
            people: false,
        });

        await go(Number(second));
        await ready(Number(second));
        assert.deepEqual(await shown(), {
            id: Number(second),
            ext: null,
            files: true,
            tab: "changes",
            people: false,
        });

        // Home shows none; a reload shows the session's again.
        await go(null);
        assert.deepEqual((await shown()).files, false);
        await page.navigate(`${base}/s/${first}`);
        await ready(Number(first));
        assert.deepEqual((await shown()).ext, { module: "design", id: "design" });

        // Another tab of the device has the device's layouts: closed in this tab, the panel stays closed here.
        await inPage(`(await import("/extension-ui.js")).closeExtPanel(); return "null";`);
        await page.navigate(`${base}/s/${second}`);
        await ready(Number(second));
        await inPage(`sessionStorage.clear(); return "null";`);
        await page.navigate(`${base}/s/${second}`);
        await ready(Number(second));
        assert.equal((await shown()).files, true, "a new tab shows the device's layout");
        await page.navigate(`${base}/s/${first}`);
        await ready(Number(first));
        assert.equal((await shown()).ext, null, "a panel closed is forgotten on the device");

        // A sign-out leaves no layouts.
        await inPage(`void (await import("/store.js")).signOut(); return "null";`);
        await until(
            async () => await inPage<boolean>(`return JSON.stringify(location.pathname === "/")`),
            "signed out",
        );
        assert.equal(
            await inPage<string | null>(
                `return JSON.stringify(localStorage.getItem("pocket.layouts"))`,
            ),
            null,
        );
    } finally {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});
