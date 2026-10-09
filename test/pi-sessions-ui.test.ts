// Continuing a Pi session from the terminal, in a real browser at phone size where this machine has Chromium: the owner
// finds it from the New session sheet, looks at it, and continues it; a guest has no way in.
import { type App, cleanUp, openApp, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
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

/** Run a script in a page and read back the JSON it returns. */
async function inPage<T>(script: string, on = page): Promise<T> {
    return JSON.parse(await on.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const see = (script: string, what: string, on = page) =>
    until(async () => (await inPage<boolean>(script, on)) === true, what);

/** Wait until the page shows `text`. */
const shows = (text: string, on = page) =>
    see(
        `return JSON.stringify(document.body.innerText.includes(${JSON.stringify(text)}))`,
        text,
        on,
    );

/**
 * Past a sheet's rise, as a person's next tap is: a tap right after something slid in under the finger is let go
 * (`back.js`), and its rows are still moving.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 450));

/** The New session sheet, at phone size, on the session list. */
async function newSessionSheet(on = page): Promise<void> {
    await on.setViewport(VIEWPORTS.mobile);
    await on.navigate(`${base}/`);
    await see(
        `return JSON.stringify(document.querySelector(".composer, .home-list, .splash") !== null)`,
        "the app",
        on,
    );
    await on.evaluate(`(await import("/store.js")).openSheet({ type: "cwd", mode: "new" })`);
    await shows("New session", on);
    await settled();
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const manager = SessionManager.inMemory(work);

    manager.appendSessionInfo("Fix the checkout total");
    manager.appendMessage({ role: "user", content: "The total is off by a cent.", timestamp: 1 });
    manager.appendMessage(
        fauxAssistantMessage([fauxText("Floats drift; I will use integer cents.")]),
    );
    const folder = join(process.env.PI_CODING_AGENT_DIR!, "sessions", "--work--");

    mkdirSync(folder, { recursive: true });

    // Long titles, one without a space to break at, so the list's rows must cut them short.
    for (const [file, title] of [
        ["long.jsonl", "Why does the payments gateway retry three times when the bank answers 409"],
        ["word.jsonl", "averyveryveryverylongwordwithoutanyspacesthatshouldnotbreakthesheetlayout"],
    ] as const) {
        const other = SessionManager.inMemory(work);

        other.appendMessage({ role: "user", content: title, timestamp: 1 });
        writeFileSync(
            join(folder, file),
            [other.getHeader(), ...other.getEntries()]
                .map((entry) => JSON.stringify(entry))
                .join("\n") + "\n",
        );
    }

    writeFileSync(
        join(folder, "checkout.jsonl"),
        [manager.getHeader(), ...manager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
    );
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "pi-sessions-ui-")),
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

test(
    "the owner finds a Pi session from New session, looks at it, and continues it here",
    real,
    async () => {
        await newSessionSheet();
        await page.click({ label: "Continue a Pi session" });
        await shows("Fix the checkout total");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
            ),
            true,
            "the list fits the phone's width",
        );
        assert.deepEqual(
            await inPage<string[]>(`
                const sheet = document.querySelector(".sheet-body");
                const wide = [...document.querySelectorAll(".pi-session, .pi-session-title, .pi-folder-head")]
                    .filter((element) => element.getBoundingClientRect().right > sheet.getBoundingClientRect().right + 1)
                    .map((element) => element.textContent.trim().slice(0, 30));

                return JSON.stringify(sheet.scrollWidth > sheet.clientWidth + 1 ? ["the sheet", ...wide] : wide);
            `),
            [],
            "no row runs past the sheet",
        );
        await settled();
        await page.click({ label: "Fix the checkout total" });
        await shows("Floats drift; I will use integer cents.");
        await settled();
        await page.click({ label: "Continue in Pocket" });
        await see(
            `return JSON.stringify(/^\\/s\\/\\d+$/.test(location.pathname))`,
            "the new session",
        );
        await shows("Continued from Pi in the terminal");
        await shows("The total is off by a cent.");
        assert.equal(
            await inPage<string | null>(
                `return JSON.stringify((await import("/store.js")).store.state.view.conversation?.title ?? null)`,
            ),
            "Fix the checkout total",
        );
        assert.deepEqual(
            await inPage<unknown>(
                `return JSON.stringify((await import("/store.js")).store.state.sheet)`,
            ),
            null,
        );
    },
);

test("a guest has no way to Pi's sessions", real, async () => {
    const { user, token } = app.config.addUser("Gus", "guest");
    const guest = await browsers.open(2);

    try {
        await guest.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await see(
            `return JSON.stringify((await import("/store.js")).store.state.me?.role === "guest")`,
            "the guest signed in",
            guest,
        );
        await newSessionSheet(guest);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.body.innerText.includes("Continue a Pi session"))`,
                guest,
            ),
            false,
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify((await import("/sheets/pi-sessions.js")).piSessionsAvailable())`,
                guest,
            ),
            false,
        );
    } finally {
        await browsers.close(2);
        app.config.removeUser(user.id);
    }
});
