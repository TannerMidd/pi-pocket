import { type App, cleanUp, home, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

type Interaction = {
    prompt(prompt: Record<string, unknown>): Promise<string>;
};

/** A subscription whose sign-in asks two questions, one after the other. */
const stepped = {
    ...fauxProvider({ provider: "stepped", models: [{ id: "stepped-1" }] }).provider,
    name: "Stepped",
    auth: {
        oauth: {
            name: "Stepped",
            loginLabel: "Sign in with Stepped",
            login: async (interaction: Interaction) => {
                await interaction.prompt({
                    type: "select",
                    message: "How do you sign in?",
                    options: [{ id: "code", label: "With a code" }],
                });
                const code = await interaction.prompt({ type: "text", message: "Paste the code" });

                return {
                    type: "oauth",
                    access: code,
                    refresh: "r",
                    expires: Date.now() + 3_600_000,
                };
            },
            refresh: async (credential: OAuthCredential) => credential,
            toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
        },
    },
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
const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what);

/** Past a sheet's rise, as a person's next tap is (`back.js` lets go of a tap on what just slid in). */
const settled = () => new Promise((resolve) => setTimeout(resolve, 450));

/** The sign-in dialog of a provider, by its name (the Providers sheet's, not its id). */
const dialog = (name: string) => `section[aria-label="Sign in: ${name}"]`;

/** What went wrong in the page: errors thrown, and error notices. */
const problems = () =>
    inPage<string[]>(`
        const { store } = await import("/store.js");

        return JSON.stringify([
            ...window.pageErrors,
            ...store.state.notices.filter((notice) => notice.level === "error").map((notice) => notice.message),
        ]);
    `);

/**
 * Open the app as the owner, at phone size, with the Providers sheet searched down to `provider`. Replies to answers
 * come back late, as on a slow network: only once the server's next word about that sign-in arrived.
 */
async function providers(provider: string): Promise<void> {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
    await page.evaluate(`
        const { openSheet, store } = await import("/store.js");

        window.pageErrors = [];
        addEventListener("error", (event) => window.pageErrors.push(String(event.message)));

        const fetched = window.fetch;

        window.fetch = async (input, init) => {
            const response = await fetched(input, init);
            const answer = /^\\/api\\/auth\\/([^/]+)\\/([^/]+)$/.exec(String(input));

            if (answer !== null && answer[2] !== "cancel") {
                const [, flowId, promptId] = answer;
                const movedOn = () => {
                    const auth = store.state.auth;

                    return auth?.flowId !== flowId || auth.done || auth.prompt?.id !== promptId;
                };
                const started = Date.now();

                while (!movedOn() && Date.now() - started < 5000) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
            }

            return response;
        };

        openSheet({ type: "providers" });

        return "true";
    `);
    await see(
        `return JSON.stringify(document.querySelector('input[placeholder="Search providers"]') !== null && document.querySelectorAll(".provider").length > 1)`,
        "the providers",
    );
    await settled();
    await page.type({ selector: 'input[placeholder="Search providers"]' }, provider);
    await see(
        `return JSON.stringify(document.querySelectorAll(".provider").length === 1)`,
        `${provider} alone`,
    );
}

/** Answer the dialog's question with `value`, by its field and Continue. */
async function answer(name: string, value: string): Promise<void> {
    await see(
        `return JSON.stringify(document.querySelector('${dialog(name)} .field input') !== null)`,
        "the question",
    );
    await page.type({ selector: `${dialog(name)} .field input` }, value);
    await page.click({ label: "Continue" });
}

/** Wait until the page has had every event the server sent so far: a notice sent now comes after them. */
async function caughtUp(): Promise<void> {
    const word = `caught up ${String(Date.now())}`;

    // Past what was sent within the same turn of the server's loop.
    await new Promise((resolve) => setTimeout(resolve, 0));
    app.notice("info", word);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.notices.some((notice) => notice.message === ${JSON.stringify(word)}))`,
        "the page caught up",
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const faux = scriptedModel();

    app = await PocketApp.open({
        dataDir: join(root, "sign-in-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => {
            models.registerNativeProvider(faux.provider);
            models.registerNativeProvider(stepped as never);
        },
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "sign-in-ui-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a sign-in that asks twice shows the second question, though it came before the first answer's reply",
    real,
    async () => {
        await providers("stepped");
        await page.click({ label: "Sign in with Stepped" });
        await see(
            `return JSON.stringify(document.querySelector('${dialog("Stepped")}')?.textContent.includes("With a code") === true)`,
            "the first question",
        );
        await page.click({ label: "With a code" });
        await answer("Stepped", "the-code");
        await see(
            `return JSON.stringify((await import("/store.js")).store.state.models.some((model) => model.provider === "stepped"))`,
            "signed in to Stepped",
        );
        await see(
            `return JSON.stringify((await import("/store.js")).store.state.auth === null && document.querySelector('${dialog("Stepped")}') === null)`,
            "the dialog closed",
        );
        await caughtUp();
        assert.deepEqual(await problems(), []);
    },
);

test(
    "the Providers model selector keeps its layout and selection across viewports",
    real,
    async () => {
        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await see(
            `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
            "signed in",
        );
        await page.evaluate(
            `window.pageErrors = []; addEventListener("error", (event) => window.pageErrors.push(String(event.message))); return "true"`,
        );
        await page.evaluate(`
        const { openSheet, store } = await import("/store.js");
        localStorage.removeItem("pocket.modelFavorites." + store.state.me.id);
        const model = store.state.models.find((each) => each.provider === "faux");

        store.set((state) => ({
            models: [
                ...state.models,
                ...Array.from({ length: 40 }, (_, index) => ({
                    ...model,
                    id: "fixture-" + index,
                    name: "Fixture model " + index,
                })),
            ],
        }));
        openSheet({ type: "providers" });

        return "true";
    `);
        await see(
            `return JSON.stringify(document.querySelector(".subagent-models-list") !== null && document.querySelector(".providers-main") !== null)`,
            "the Providers model selector",
        );
        await settled();

        const desktop = await inPage<{ width: number; height: number; overflow: boolean }>(`
        const list = document.querySelector(".subagent-models-list").getBoundingClientRect();

        return JSON.stringify({
            width: list.width,
            height: list.height,
            overflow: document.documentElement.scrollWidth > innerWidth,
        });
    `);

        assert.ok(desktop.width >= 400, `desktop model list width was ${desktop.width}px`);
        assert.ok(desktop.height >= 280, `desktop model list height was ${desktop.height}px`);
        assert.equal(desktop.overflow, false, "desktop has no horizontal overflow");

        const chosen = await inPage<{ text: string; title: string }>(`
        const chosen = document.querySelector(".subagent-models-chosen");

        return JSON.stringify({ text: chosen.textContent, title: chosen.title });
    `);

        assert.equal(chosen.text.trim(), "0 for subagents");
        assert.match(chosen.title, /None allowed/);

        await page.type({ selector: 'input[placeholder="Find a model"]' }, "Fixture model 17");
        await see(
            `return JSON.stringify(document.querySelectorAll(".subagent-model").length === 1 && document.querySelector(".subagent-model").textContent.includes("Fixture model 17"))`,
            "the searched model",
        );

        await page.setViewport(VIEWPORTS.mobile);
        await page.evaluate(`
        const input = document.querySelector('input[placeholder="Find a model"]');

        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));

        return "true";
    `);
        await see(
            `return JSON.stringify(document.querySelectorAll(".subagent-model").length > 1)`,
            "the model list on mobile",
        );
        const mobile = await inPage<{
            overflow: boolean;
            sideTop: number;
            mainTop: number;
            minRow: number;
        }>(`
        const side = document.querySelector(".providers-side").getBoundingClientRect();
        const main = document.querySelector(".providers-main").getBoundingClientRect();
        const rows = [...document.querySelectorAll(".subagent-model")].map((row) => row.getBoundingClientRect().height);

        return JSON.stringify({
            overflow: document.documentElement.scrollWidth > innerWidth,
            sideTop: side.top,
            mainTop: main.top,
            minRow: Math.min(...rows),
        });
    `);

        assert.equal(mobile.overflow, false, "mobile has no horizontal overflow");
        assert.ok(
            mobile.sideTop < mobile.mainTop,
            "mobile keeps the model selector above providers",
        );
        assert.ok(mobile.minRow >= 44, `mobile model row height was ${mobile.minRow}px`);

        await page.setViewport(VIEWPORTS.desktop);
        await settled();
        await page.click({ selector: '.subagent-model input[value="faux/faux-1"]' });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const toggleState = await inPage<{
            checked: boolean;
            allowed: string[];
            errors: string[];
        }>(`
            const { store } = await import("/store.js");

            return JSON.stringify({
                checked: document.querySelector('.subagent-model input[value="faux/faux-1"]').checked,
                allowed: store.state.server.subagentModels,
                errors: store.state.notices.filter((notice) => notice.level === "error").map((notice) => notice.message),
            });
        `);

        assert.deepEqual(toggleState, { checked: true, allowed: ["faux/faux-1"], errors: [] });
        await page.evaluate(
            `const { closeSheet, openSheet } = await import("/store.js"); closeSheet(); await new Promise((resolve) => setTimeout(resolve, 450)); openSheet({ type: "providers" }); return "true"`,
        );
        await see(
            `return JSON.stringify(document.querySelector('.subagent-model input[value="faux/faux-1"]')?.checked === true)`,
            "the saved selection after reopening",
        );

        const favoriteSelector = '.subagent-model:has(input[value="faux/faux-1"]) .model-favorite';

        await page.click({ selector: favoriteSelector });
        await see(
            `return JSON.stringify(document.querySelector('${favoriteSelector}')?.getAttribute("aria-pressed") === "true")`,
            "the model starred",
        );
        assert.deepEqual(
            await inPage<string[]>(
                `const { store } = await import("/store.js"); return JSON.stringify(JSON.parse(localStorage.getItem("pocket.modelFavorites." + store.state.me.id)))`,
            ),
            ["faux/faux-1"],
            "favorites use the owner's localStorage key",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.subagent-model input[value="faux/faux-1"]').checked)`,
            ),
            true,
            "star does not change the model checkbox",
        );
        await page.click({ label: "Favorites" });
        await see(
            `return JSON.stringify(document.querySelectorAll(".subagent-model").length === 1 && document.querySelector('.subagent-model input[value="faux/faux-1"]') !== null)`,
            "the Providers favorites filter",
        );
        await page.click({ selector: favoriteSelector });
        await see(
            `return JSON.stringify(document.querySelectorAll(".subagent-model").length === 0 && document.activeElement.matches('.model-filters button[aria-pressed="true"]'))`,
            "unstar removes the row and focuses the active Favorites filter",
        );
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify((await import("/store.js")).store.state.server.subagentModels)`,
            ),
            ["faux/faux-1"],
            "favorites do not change subagent permissions",
        );
        await page.click({ label: "All models" });
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.subagent-model input[value="faux/faux-1"]').checked)`,
            ),
            true,
            "unstar does not change the model checkbox",
        );
        await page.click({ selector: favoriteSelector });
        await see(
            `return JSON.stringify(document.querySelector('${favoriteSelector}')?.getAttribute("aria-pressed") === "true")`,
            "the model starred again",
        );
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await see(
            `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
            "signed in after reload",
        );
        await page.evaluate(
            `window.pageErrors = []; addEventListener("error", (event) => window.pageErrors.push(String(event.message))); return "true"`,
        );
        await page.evaluate(
            `const { openSheet } = await import("/store.js"); openSheet({ type: "providers" }); return "true"`,
        );
        await see(
            `return JSON.stringify(document.querySelector('.subagent-model:has(input[value="faux/faux-1"]) .model-favorite[aria-pressed="true"]') !== null)`,
            "the favorite persisted after reload",
        );
        await page.evaluate(
            `const { closeSheet, openSheet } = await import("/store.js"); closeSheet(); await new Promise((resolve) => setTimeout(resolve, 450)); openSheet({ type: "model" }); return "true"`,
        );
        await see(
            `return JSON.stringify(document.querySelector('.model-filters button') !== null)`,
            "the ModelPicker favorites filter",
        );
        await page.click({ label: "Favorites" });
        await see(
            `return JSON.stringify(document.querySelectorAll('.pop-menu-row').length === 1 && document.querySelector('.pop-menu-row').getAttribute("title").startsWith("faux/faux-1"))`,
            "the ModelPicker favorites results",
        );
        assert.deepEqual(await problems(), []);
        await page.evaluate(
            `const { store } = await import("/store.js"); localStorage.setItem("pocket.modelFavorites." + store.state.me.id, "{"); return "true"`,
        );
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await see(
            `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
            "signed in with malformed favorites",
        );
        await page.evaluate(
            `window.pageErrors = []; addEventListener("error", (event) => window.pageErrors.push(String(event.message))); const { openSheet } = await import("/store.js"); openSheet({ type: "providers" }); return "true"`,
        );
        await see(
            `return JSON.stringify(document.querySelector('.subagent-model:has(input[value="faux/faux-1"]) .model-favorite[aria-pressed="false"]') !== null)`,
            "malformed favorites are ignored",
        );
        assert.deepEqual(await problems(), []);
        await app.setSubagentModels(
            app.config.users.find((user) => user.role === "owner")!,
            [],
        );
        assert.deepEqual(await problems(), []);
    },
);
