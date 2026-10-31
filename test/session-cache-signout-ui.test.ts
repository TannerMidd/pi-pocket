// Signing out leaves none of the person's sessions on the device (`web/store.js`, `web/session-cache.js`).
import { cleanUp, newSession, openApp, root, say, scriptedModel, until } from "./helpers.ts";
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

test("a session left just before signing out is not saved on the device after", real, async () => {
    const app = await openApp(scriptedModel());
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "signout-ui-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        const [first, second] = [await newSession(app), await newSession(app)];

        await say(app, first, "private words");
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const inPage = async <T>(script: string) => JSON.parse(await page.evaluate(script)) as T;

        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${first}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.body.textContent.includes("private words"))`,
                ),
            "the session",
        );
        // Leave it, and sign out before its save, while the server takes its time to answer the sign-out.
        await inPage(`
            const store = await import("/store.js");
            const fetched = fetch;

            globalThis.fetch = async (url, options) => {
                if (String(url).endsWith("/logout")) {
                    await new Promise((resolve) => setTimeout(resolve, 1300));
                }

                return fetched(url, options);
            };
            store.navigate(${Number(second)});
            void store.signOut();

            return "null";
        `);
        await until(
            async () => await inPage<boolean>(`return JSON.stringify(location.pathname === "/")`),
            "signed out",
        );

        const kept = await inPage<unknown[]>(
            `return JSON.stringify(await (await import("/session-cache.js")).list())`,
        );

        assert.deepEqual(kept, []);
    } finally {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});

test("files attached to a draft are this person's, and go with their sign-out", real, async () => {
    const app = await openApp(scriptedModel());
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "signout-ui-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        const id = await newSession(app);

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const inPage = async <T>(script: string) => JSON.parse(await page.evaluate(script)) as T;
        const kept = () =>
            inPage<string[]>(
                `return JSON.stringify(Object.keys(localStorage).filter((key) => key.startsWith("pocket.attached.")))`,
            );

        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".composer input[type=file]") !== null)`,
                ),
            "the message box",
        );
        await inPage(`
            const data = new DataTransfer();

            data.items.add(new File(["private notes"], "notes.txt", { type: "text/plain" }));
            const picker = document.querySelector(".composer input[type=file]");

            picker.files = data.files;
            picker.dispatchEvent(new Event("change", { bubbles: true }));

            return "null";
        `);
        await until(async () => (await kept()).length === 1, "the file kept with the draft");
        // Under the person's own id, so another one signed in on this browser does not get it.
        assert.deepEqual(await kept(), [`pocket.attached.${app.config.users[0]!.id}.${id}`]);

        await inPage(`void (await import("/store.js")).signOut(); return "null"`);
        await until(
            async () => await inPage<boolean>(`return JSON.stringify(location.pathname === "/")`),
            "signed out",
        );
        assert.deepEqual(await kept(), []);
    } finally {
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});
