// The Gondolin sandbox's browser module in a real Chromium, on the app's menu as people see it: the owner reaches Set up
// with no session open (the module's entry in the Extensions sheet, the launcher) and the Sandbox row is in the session
// menu itself, not buried under a submenu.
import {
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

const rows = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".sheet .list-item")].map((each) => each.textContent.trim()))`,
    );

const buttons = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".sheet button")].map((each) => each.textContent.trim()))`,
    );

const entries = () =>
    inPage<string[]>(
        `return JSON.stringify((await import("/extension-ui.js")).extensionEntries("gondolin").map((each) => each.label))`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    await app.setExtensionEnabled(owner(app), "gondolin.ts", true);
    session = await newSession(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "gondolin-setup-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the owner reaches Set up with no session open: the module's entry, and the launcher",
    real,
    async () => {
        await page.navigate(`${base}/`);
        await until(async () => (await entries()).includes("Sandbox set up"), "the module's entry");
        assert.ok(
            await inPage<boolean>(
                `return JSON.stringify((await import("/extension-ui.js")).extensionLauncherItems().some((each) => each.label === "Sandbox set up"))`,
            ),
            "a launcher action",
        );
        await inPage(
            `(await import("/extension-ui.js")).extensionEntries("gondolin")[0].run(); return "null";`,
        );
        await until(
            async () => (await buttons()).includes("Set up"),
            "Set up in the sandbox sheet",
        );
        assert.ok((await buttons()).includes("Set up with a browser"));
    },
);

test("the menu itself has a Sandbox row at home too, and one tap opens Set up", real, async () => {
    await page.navigate(`${base}/`);
    await inPage(`(await import("/store.js")).openSheet({ type: "menu" }); return "null";`);
    await until(
        async () => (await rows()).some((each) => each.startsWith("Sandbox set up")),
        "the Sandbox set up row in the menu",
    );
    await inPage(
        `[...document.querySelectorAll(".sheet .list-item")].find((each) => each.textContent.trim().startsWith("Sandbox set up")).click(); return "null";`,
    );
    await until(async () => (await buttons()).includes("Set up"), "Set up in the sandbox sheet");
});

test("the Sandbox row is in the session menu itself", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".composer") !== null)`,
            ),
        "the session",
    );
    await inPage(`(await import("/store.js")).openSheet({ type: "menu" }); return "null";`);
    await until(
        async () => (await rows()).some((each) => each.startsWith("Sandbox")),
        "the Sandbox row in the session menu",
    );
    await inPage(
        `[...document.querySelectorAll(".sheet .list-item")].find((each) => each.textContent.trim().startsWith("Sandbox")).click(); return "null";`,
    );
    await until(async () => (await buttons()).includes("Set up"), "Set up in the sandbox sheet");
});

/** Whether the button named `label` is on screen now: what shows at its middle is the button, with no scrolling. */
const visible = (label: string) =>
    inPage<boolean>(`
        const button = [...document.querySelectorAll(".sheet button")].find((each) => each.textContent.trim() === ${JSON.stringify(label)});
        if (!button) return JSON.stringify(false);
        const box = button.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return JSON.stringify(box.bottom <= innerHeight && top !== null && button.contains(top));
    `);

for (const [name, viewport] of [
    ["desktop", { width: 1920, height: 1080, scale: 1, mobile: false }],
    ["phone", { width: 390, height: 844, scale: 1, mobile: true }],
] as const) {
    test(
        `before Set up has run, Set up shows at once in the sandbox sheet (${name}, with and without a session)`,
        real,
        async () => {
            await page.setViewport(viewport);

            for (const where of [`${base}/`, `${base}/s/${session}`]) {
                await page.navigate(where);
                await until(
                    async () => (await entries()).includes("Sandbox set up"),
                    "the module's entry",
                );
                await inPage(
                    `(await import("/extension-ui.js")).extensionEntries("gondolin")[0].run(); return "null";`,
                );
                await until(async () => (await buttons()).includes("Set up"), "the sandbox sheet");
                await until(() => visible("Set up"), `Set up on screen at ${where}`);
                assert.ok(await visible("Set up with a browser"), "both buttons show");
            }
        },
    );
}
