// A bash call that is running shows that it runs with a still mark, and nothing in its step moves: no spinner, no
// sweep along its edge, no pulse, in Pocket's look or in a theme that builds on the app's own stylesheet. Real
// Chromium; no provider is called.
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
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** The first message runs a bash call that ends when `after` makes a file; the call's result gets a plain answer. */
const route: FauxResponseStep = (request) => {
    const { role } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("done")]);
    }

    return fauxAssistantMessage(
        [
            fauxText("Running it."),
            fauxToolCall("bash", {
                command: "while [ ! -f release-bash ]; do sleep 0.1; done",
                timeout: 120,
            }),
        ],
        { stopReason: "toolUse" },
    );
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

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
        dataDir: mkdtempSync(join(root, "running-step-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    session = await newSession(app);
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
            )) === true,
        "signed in",
    );
    // The command runs until `after` releases it, so the step is running in every test.
    await app.commands.submit(session, owner(app), {
        text: "run it",
        requestId: crypto.randomUUID(),
    });
});

after(async () => {
    writeFileSync(join(work, "release-bash"), "");
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

type Seen = { state: string; mark: string; spinners: number; moving: string[]; pseudo: string[] };

const STEP = `document.querySelector('[data-part~="tool-call"][data-state="running"]')`;

/** Open the session in a look, wait for the running bash step, and read what animates in it. */
async function whileRunning(kept: Record<string, unknown>): Promise<Seen> {
    await page.navigate(`${base}/`);
    await page.evaluate(`
        localStorage.clear();
        for (const [key, value] of Object.entries(${JSON.stringify(kept)})) {
            localStorage.setItem(key, JSON.stringify(value));
        }
    `);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            (await inPage<boolean>(
                `const { store } = await import("/store.js");

                return JSON.stringify(${STEP} !== null && Array.isArray(store.state.themeList))`,
            )) === true,
        "a running bash step",
        20_000,
    );
    // Past any delay that an animation could start after.
    await inPage(`await new Promise((done) => setTimeout(done, 400)); return "null"`);

    return inPage<Seen>(`
        const step = ${STEP};
        const moving = document
            .getAnimations()
            .filter((each) => each.effect?.target && step.contains(each.effect.target))
            .map((each) => (each.animationName ?? "transition " + each.transitionProperty) + " on " + each.effect.target.className);
        const pseudo = ["::before", "::after"].flatMap((part) =>
            [step, ...step.querySelectorAll("*")]
                .filter((each) => getComputedStyle(each, part).animationName !== "none")
                .map((each) => part + " of " + each.className),
        );

        return JSON.stringify({
            state: step.dataset.state,
            mark: step.querySelector('[data-part~="step-mark"]')?.textContent.trim() ?? "",
            spinners: step.querySelectorAll(".spinner").length,
            moving,
            pseudo,
        });
    `);
}

test("a running bash step is still in Pocket's look", real, async () => {
    const seen = await whileRunning({});

    assert.equal(seen.state, "running");
    assert.notEqual(seen.mark, "", "the step still says that it runs");
    assert.equal(seen.spinners, 0, "no spinner in the step");
    assert.deepEqual(seen.moving, [], "nothing in the step animates");
    assert.deepEqual(seen.pseudo, [], "no pseudo-element in the step animates");
});

test(
    "a running bash step is still in a theme that builds on the app's stylesheet",
    real,
    async () => {
        const seen = await whileRunning({
            "pocket.themeChosen": { theme: true, look: true },
            "pocket.appearance": { look: "lantern", theme: "lantern" },
        });

        assert.equal(seen.state, "running");
        assert.notEqual(seen.mark, "", "the step still says that it runs");
        assert.equal(seen.spinners, 0, "no spinner in the step");
        assert.deepEqual(seen.moving, [], "nothing in the step animates");
        assert.deepEqual(seen.pseudo, [], "no pseudo-element in the step animates");
    },
);
