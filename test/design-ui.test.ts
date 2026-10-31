// The Design workspace in a real Chromium: the panel from the rail, the canvas and its sizes, the picker with a group, the
// versions and "go back to this one", compare, variations, shared comments and what "Send to Pi" puts in the box, the
// artifact viewer's "Open in Design" button, a viewer who cannot write, and the phone's layout. What needs the frame's
// inspector (pointing, editing, tweaks, slides) runs when this copy has it (`attachBridge` in `web/artifact-bridge.js`).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type App, cleanUp, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { ArtifactsDoc, DesignCommentsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { publishAll } from "./design-fixtures.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
/** Whether this copy's frame bridge has the inspector's side (`send`, `onMessage`): Design mode's stream B. */
const inspector = readFileSync(
    new URL("../web/artifact-bridge.js", import.meta.url),
    "utf8",
).includes("attachBridge");
const bridged = {
    skip: real.skip || (inspector ? false : "this copy's bridge has no inspector yet"),
} as const;
const SLOW = 30_000;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let viewerPage: BrowserPage;
let base = "";
let session: ConversationId;
let viewerToken = "";

const evaluate = async <T>(target: BrowserPage, script: string) =>
    JSON.parse(await target.evaluate(script)) as T;
const inPage = <T>(script: string) => evaluate<T>(page, script);

/** Run `script` in the page and wait until it gives something other than false or null. */
async function waitFor<T>(what: string, script: string, target = page): Promise<T> {
    let found: T | null = null;

    await until(
        async () => {
            const value = await evaluate<T | null | false>(target, script);

            found = value === false ? null : value;

            return found !== null;
        },
        what,
        SLOW,
    );

    return found as T;
}

/** Click the first element that matches, by a DOM click (the workspace's own buttons: not the frame's page). */
const press = (selector: string, text?: string, target = page) =>
    evaluate(
        target,
        `
        const matches = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(
            (each) => ${text === undefined ? "true" : `each.textContent.includes(${JSON.stringify(text)})`},
        );
        if (matches.length === 0) { return JSON.stringify("none"); }
        matches[0].click();
        return JSON.stringify("ok");
    `,
    );

const pressed = async (selector: string, text?: string, target = page) => {
    assert.equal(await press(selector, text, target), "ok", `a ${selector} ${text ?? ""}`);
};

const boxText = () =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(".composer textarea")?.value ?? "")`,
    );

const setBox = (text: string) =>
    inPage(`
        const box = document.querySelector(".composer textarea");
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);

/** The Design panel, open: the rail's button, once the module has loaded. */
async function openDesign(target = page) {
    await waitFor(
        "the Design rail button",
        `return JSON.stringify(Boolean(document.querySelector('nav[aria-label="Sessions and tools"] button[aria-label="Design"]')))`,
        target,
    );

    if (
        !(await evaluate<boolean>(
            target,
            `return JSON.stringify(Boolean(document.querySelector(".dsn")))`,
        ))
    ) {
        await pressed(
            'nav[aria-label="Sessions and tools"] button[aria-label="Design"]',
            undefined,
            target,
        );
    }

    await waitFor(
        "the workspace",
        `return JSON.stringify(Boolean(document.querySelector(".dsn-bar")))`,
        target,
    );
}

/** Choose a design in the picker, by its title. */
async function choose(title: string, target = page) {
    await pressed(".dsn-picker", undefined, target);
    await waitFor(
        "the picker",
        `return JSON.stringify(Boolean(document.querySelector(".dsn-list")))`,
        target,
    );
    await pressed(".dsn-list-item", title, target);
    await waitFor(
        `${title} open`,
        `return JSON.stringify(document.querySelector(".dsn-picker-title")?.textContent === ${JSON.stringify(title)})`,
        target,
    );
}

const frameSrc = (target = page) =>
    evaluate<string>(
        target,
        `return JSON.stringify(document.querySelector(".dsn-canvas .dsn-frame")?.getAttribute("src") ?? "")`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    ({ id: session } = await app.commands.createSession(owner(app), { cwd: work }));
    await publishAll(app, session);
    viewerToken = app.config.addUser("Vic", "viewer").token;
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "design-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await waitFor(
        "the session",
        `const { store } = await import("/store.js");
        return JSON.stringify(store.state.view.conversation?.id === ${session} && store.state.view.artifacts.length === 5 && Boolean(document.querySelector(".composer textarea")))`,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("the rail opens the panel, with the newest design in a frame that fits", real, async () => {
    await openDesign();

    const title = await waitFor<string>(
        "a design",
        `return JSON.stringify(document.querySelector(".dsn-picker-title")?.textContent || false)`,
    );

    assert.match(title, /^(Hero [ABC]|Coffee landing page|Pitch deck)$/);
    assert.match(await frameSrc(), new RegExp(`^/a/${session}/[a-z-]+/\\d+$`));
    // The sandbox: scripts run, but nothing of the app's origin.
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".dsn-frame").getAttribute("sandbox"))`,
        ),
        "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads",
    );
    // The panel's body is the workspace's: nothing around it scrolls.
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(getComputedStyle(document.querySelector(".ext-panel-body")).overflow)`,
        ),
        "hidden",
    );
});

test("device sizes change the frame, and fit scales it to the room", real, async () => {
    await choose("Coffee landing page");

    for (const [title, size] of [
        ["Phone, 390 × 844", "390×844"],
        ["Tablet, 820 × 1180", "820×1180"],
        ["Desktop, 1280 × 800", "1280×800"],
    ] as const) {
        await pressed(`.dsn-seg button[title="${title}"]`);
        await waitFor(
            size,
            `return JSON.stringify(document.querySelector(".dsn-zoom-size")?.textContent === ${JSON.stringify(size)})`,
        );
    }

    // Fit: the whole frame is inside the canvas.
    const fits = await inPage<boolean>(`
        const stage = document.querySelector(".dsn-stage").getBoundingClientRect();
        const room = document.querySelector(".dsn-canvas").getBoundingClientRect();
        return JSON.stringify(stage.width <= room.width && stage.height <= room.height);
    `);

    assert.ok(fits);

    // Zoom in leaves fit and says the percentage; the width of the stage follows.
    const before = await inPage<number>(
        `return JSON.stringify(document.querySelector(".dsn-stage").getBoundingClientRect().width)`,
    );

    await pressed('.dsn-zoom button[title="Zoom in"]');
    await waitFor(
        "a zoom",
        `return JSON.stringify(!document.querySelector(".dsn-zoom-value").textContent.includes("Fit") || false)`,
    );
    assert.ok(
        (await inPage<number>(
            `return JSON.stringify(document.querySelector(".dsn-stage").getBoundingClientRect().width)`,
        )) > before,
    );
    await pressed(".dsn-zoom-value");
    await waitFor(
        "fit again",
        `return JSON.stringify(document.querySelector(".dsn-zoom-value").textContent.includes("Fit"))`,
    );
    // What a person chose here is kept in this browser.
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(JSON.parse(localStorage.getItem("x.design.prefs")).device)`,
        ),
        "desktop",
    );
});

test("a group shows together in the picker, and as a grid of live thumbnails", real, async () => {
    await pressed(".dsn-picker");
    await waitFor(
        "the picker",
        `return JSON.stringify(Boolean(document.querySelector(".dsn-list")))`,
    );

    const labels = await inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".dsn-list > li")].map((each) => each.textContent.trim().split("\\n")[0].slice(0, 12)))`,
    );

    // The group's name, then its three, one after the other.
    const at = labels.findIndex((each) => /hero/i.test(each) && !/Hero [ABC]/.test(each));

    assert.ok(at >= 0, labels.join("|"));
    assert.deepEqual(
        labels.slice(at + 1, at + 4).map((each) => each.slice(0, 6)),
        ["Hero C", "Hero B", "Hero A"],
    );
    await pressed(".dsn-list-item", "Hero B");
    await waitFor(
        "Hero B",
        `return JSON.stringify(document.querySelector(".dsn-picker-title")?.textContent === "Hero B")`,
    );
    await pressed('.dsn-tabs button[title="Variations (3)"]');
    await waitFor(
        "three thumbnails",
        `return JSON.stringify(document.querySelectorAll(".dsn-thumb iframe").length === 3)`,
    );
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".dsn-thumb.on strong")?.textContent)`,
        ),
        "Hero B",
    );

    // "Use this one" asks Pi, in the box, and sends nothing.
    const entries = (await app.transcripts.allEntries(session, false)).length;

    await setBox("");
    await pressed(".dsn-thumb button.primary", undefined);
    await until(async () => (await boxText()).includes("I choose"), "the message", SLOW);
    assert.match(
        await boxText(),
        /^I choose “Hero [ABC]” \(artifact `hero-[abc]`\) from the variations in group `hero`/,
    );
    assert.equal(
        (await app.transcripts.allEntries(session, false)).length,
        entries,
        "nothing was sent",
    );
    await setBox("");
});

test(
    "versions: go back to this one makes a new version, and compare shows two side by side",
    real,
    async () => {
        await choose("Coffee landing page");
        await pressed(".dsn-tabs button", "Versions");
        await waitFor(
            "the versions",
            `return JSON.stringify(document.querySelectorAll(".dsn-version").length === 3)`,
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".dsn-version.on .dsn-version-no").textContent)`,
            ),
            "v3",
        );
        // Not for the newest.
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll(".dsn-version")[0].querySelectorAll(".dsn-link").length)`,
            ),
            0,
        );

        // Compare v1 with the newest.
        await pressed(".dsn-version:last-child .dsn-link", "Compare");
        await waitFor(
            "two frames",
            `return JSON.stringify(document.querySelectorAll(".dsn-compare iframe").length === 2)`,
        );
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".dsn-compare iframe")].map((each) => each.getAttribute("src").split("/").pop()))`,
            ),
            ["1", "3"],
        );
        await pressed('.dsn-tabs button[title="Compare versions"]');
        await waitFor(
            "the page again",
            `return JSON.stringify(!document.querySelector(".dsn-compare"))`,
        );

        // Go back to v1: asked first, then a version 4 whose page is v1's.
        await pressed(".dsn-version:last-child .dsn-link", "Go back to this one");
        await waitFor(
            "the question",
            `return JSON.stringify(Boolean(document.querySelector(".dsn-confirm")))`,
        );
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".dsn-confirm").textContent)`,
            ),
            /Make version 4 from version 1\? Nothing is lost/,
        );
        await pressed(".dsn-confirm .primary");
        await until(
            async () =>
                (await app.harness.snapshot(ArtifactsDoc, session, BACKGROUND_CONTEXT))?.items
                    .landing?.versions.length === 4,
            "the new version",
            SLOW,
        );
        await waitFor(
            "it on the canvas",
            `return JSON.stringify(document.querySelector(".dsn-picker .dsn-version-tag")?.textContent === "v4")`,
        );
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".dsn-version.on").textContent)`,
            ),
            /from v1/,
        );
        assert.match(await frameSrc(), /\/landing\/4$/);
    },
);

test(
    "comments are shared: what another person wrote shows, and Send to Pi puts them in the box",
    real,
    async () => {
        await choose("Coffee landing page");
        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(DesignCommentsDoc, session);

            doc.items.landing = {
                comments: [
                    {
                        id: "c1",
                        version: 4,
                        target: {
                            selector: "h1",
                            tag: "h1",
                            text: "Fresh coffee",
                            html: "",
                            rect: { x: 0, y: 0, width: 1, height: 1 },
                            styles: {},
                        },
                        text: "Shorter, please",
                        by: "someone",
                        byName: "Gale",
                        at: Date.now(),
                    },
                    {
                        id: "c2",
                        version: 2,
                        target: {
                            selector: "p",
                            tag: "p",
                            text: "Small batches",
                            html: "",
                            rect: { x: 0, y: 0, width: 1, height: 1 },
                            styles: {},
                        },
                        text: "Bigger",
                        by: "someone",
                        byName: "Gale",
                        at: Date.now(),
                        resolved: { by: "someone", at: Date.now() },
                    },
                ],
            };
        }, BACKGROUND_CONTEXT);
        // The tab reads them when the dock opens.
        await pressed(".dsn-tabs button", "Comment");
        await waitFor(
            "the comment",
            `return JSON.stringify(document.querySelectorAll(".dsn-comment").length === 1)`,
        );
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".dsn-comment").textContent)`,
            ),
            /Gale.*Shorter, please/,
        );
        // The tab says how many are open; the one that is done is behind a toggle.
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".dsn-tab.on .dsn-count").textContent)`,
            ),
            "1",
        );
        await pressed(".dsn-done-toggle");
        await waitFor(
            "the done one",
            `return JSON.stringify(document.querySelectorAll(".dsn-comment").length === 2)`,
        );

        await setBox("");
        await pressed(".dsn-dock-foot .primary");
        await until(
            async () => (await boxText()).startsWith("Design feedback on"),
            "the message",
            SLOW,
        );

        const text = await boxText();

        assert.match(text, /“Coffee landing page” \(artifact `landing`\)/);
        assert.match(text, /1\. Shorter, please\n\(on version 4, from Gale\)\n```json/);
        assert.doesNotMatch(text, /Bigger/, "only the open ones");
        // Marking them done after Pi has the new version.
        await pressed(".dsn-dock-foot .dsn-link", "mark them done");
        await until(
            async () =>
                (
                    await app.harness.snapshot(DesignCommentsDoc, session, BACKGROUND_CONTEXT)
                )?.items.landing?.comments.every((each) => each.resolved !== undefined) === true,
            "both done",
            SLOW,
        );
        await setBox("");
    },
);

test(
    "the artifact viewer has an Open in Design button that opens it there, at that version",
    real,
    async () => {
        await inPage(`
        const { openSheet, closeSheet } = await import("/store.js");
        closeSheet();
        openSheet({ type: "viewer", id: "landing", version: 2 });
        return "null";
    `);
        await waitFor(
            "the viewer",
            `return JSON.stringify(Boolean(document.querySelector(".viewer-head")))`,
        );
        await pressed(".viewer-head button", "Open in Design");
        await waitFor(
            "the viewer gone",
            `return JSON.stringify(!document.querySelector(".viewer"))`,
        );
        await waitFor(
            "landing at v2",
            `return JSON.stringify(document.querySelector(".dsn-picker-title")?.textContent === "Coffee landing page" && document.querySelector(".dsn-picker .dsn-version-tag")?.textContent === "v2")`,
        );
        assert.match(await frameSrc(), /\/landing\/2$/);
        // Old: it says so, and the way to the newest.
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".dsn-old")?.textContent ?? "")`,
            ),
            /Version 2 of 4/,
        );
        await pressed(".dsn-old .dsn-link");
        await waitFor("the newest", `return JSON.stringify(!document.querySelector(".dsn-old"))`);
    },
);

test(
    "/design-open opens the panel in the tab of the person who ran it, at the design they name",
    real,
    async () => {
        await inPage(
            `const { closeExtPanel } = await import("/extension-ui.js"); closeExtPanel(); return "null";`,
        );
        await waitFor("the panel closed", `return JSON.stringify(!document.querySelector(".dsn"))`);

        const commandId = app.webs.commands().find((each) => each.name === "design-open")?.id;

        assert.ok(commandId);

        const done = await app.extensionCommands.run(session, owner(app), {
            commandId,
            args: "pitch",
            requestId: crypto.randomUUID(),
        });

        assert.equal(done.status, "done");
        await waitFor(
            "the deck",
            `return JSON.stringify(document.querySelector(".dsn-picker-title")?.textContent === "Pitch deck")`,
        );
        // A name that matches nothing says so, and leaves what is open.
        await app.extensionCommands.run(session, owner(app), {
            commandId,
            args: "no such design",
            requestId: crypto.randomUUID(),
        });
        await waitFor(
            "the notice",
            `const { store } = await import("/store.js"); return JSON.stringify(store.state.notices.some((each) => each.message.includes("No design matches")))`,
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".dsn-picker-title").textContent)`,
            ),
            "Pitch deck",
        );
    },
);

test(
    "Share opens the artifact's share sheet over the canvas, and closing it comes back to the canvas",
    real,
    async () => {
        await openDesign();
        await choose("Coffee landing page");
        await pressed(".dsn-bar .icon-button[title=More]");
        await waitFor(
            "the menu",
            `return JSON.stringify(Boolean(document.querySelector(".dsn-menu")))`,
        );
        await pressed(".dsn-menu-item", "Share a link");
        await waitFor(
            "the share sheet",
            `const { store } = await import("/store.js"); return JSON.stringify(store.state.sheet?.type === "artifact-share" && store.state.sheet.id === "landing")`,
        );
        await inPage(`
        const close = [...document.querySelectorAll(".sheet button")].find((each) => each.getAttribute("aria-label") === "Close");
        close?.click();
        return "null";
    `);
        await waitFor(
            "back on the canvas",
            `const { store } = await import("/store.js"); return JSON.stringify(store.state.sheet === null && Boolean(document.querySelector(".dsn")))`,
        );
    },
);

test(
    "a viewer sees the canvas, the versions, and the comments, and can write none",
    real,
    async () => {
        viewerPage = await browsers.open(2);
        await viewerPage.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
        await viewerPage.navigate(`${base}/login?token=${encodeURIComponent(viewerToken)}`);
        await viewerPage.navigate(`${base}/s/${session}`);
        await openDesign(viewerPage);
        await choose("Coffee landing page", viewerPage);

        // No Edit text, no Tweaks; Comments is a list to read.
        const tabs = await evaluate<string[]>(
            viewerPage,
            `return JSON.stringify([...document.querySelectorAll(".dsn-tab")].map((each) => each.title))`,
        );

        assert.deepEqual(tabs, ["Preview", "Comments", "Versions"]);
        await pressed(".dsn-tabs button", "Comments", viewerPage);
        await waitFor(
            "the note",
            `return JSON.stringify(Boolean(document.querySelector(".dsn-note")))`,
            viewerPage,
        );
        assert.equal(
            await evaluate<number>(
                viewerPage,
                `return JSON.stringify(document.querySelectorAll(".dsn-comment-actions").length)`,
            ),
            0,
        );
        assert.equal(
            await evaluate<number>(
                viewerPage,
                `return JSON.stringify(document.querySelectorAll(".dsn-dock-foot").length)`,
            ),
            0,
        );
        await pressed(".dsn-tabs button", "Versions", viewerPage);
        await waitFor(
            "versions",
            `return JSON.stringify(document.querySelectorAll(".dsn-version").length === 4)`,
            viewerPage,
        );
        assert.equal(
            await evaluate<number>(
                viewerPage,
                `return JSON.stringify([...document.querySelectorAll(".dsn-link")].filter((each) => each.textContent.includes("Go back")).length)`,
            ),
            0,
            "no way to make a version",
        );
        viewerPage.close();
    },
);

test(
    "on a phone the panel covers the chat, and the canvas is as it was when it comes back",
    real,
    async (t) => {
        await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
        // The viewport goes back to a desktop's whatever happens here: the tests after it need it.
        t.after(() => page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false }));
        await waitFor(
            "the narrow workspace",
            `return JSON.stringify(document.querySelector(".dsn")?.dataset.size === "narrow")`,
        );
        // The panel slides in: wait until it has arrived.
        await waitFor(
            "the panel in place",
            `return JSON.stringify(document.querySelector(".ext-panel").getBoundingClientRect().x === 0)`,
        );

        const panel = await inPage<{ x: number; width: number; height: number }>(`
        const box = document.querySelector(".ext-panel").getBoundingClientRect();
        return JSON.stringify({ x: box.x, width: box.width, height: box.height });
    `);

        assert.equal(panel.x, 0);
        assert.equal(panel.width, 390);
        assert.equal(panel.height, 844);
        // Nothing runs past the screen: the bars fit in 390 px.
        assert.ok(
            await inPage<boolean>(`
            return JSON.stringify([...document.querySelectorAll(".dsn-bars *")].every((each) => each.getBoundingClientRect().right <= 391));
        `),
        );

        // A dock opens under the canvas, and the canvas keeps room.
        await pressed(".dsn-tabs button", "Versions");
        await waitFor(
            "the dock",
            `return JSON.stringify(Boolean(document.querySelector(".dsn-dock")))`,
        );
        assert.ok(
            await inPage<boolean>(`
            const dock = document.querySelector(".dsn-dock").getBoundingClientRect();
            const room = document.querySelector(".dsn-canvas").getBoundingClientRect();
            return JSON.stringify(dock.top >= room.bottom - 1 && room.height > 150);
        `),
        );

        // Back to the chat, and again: the same design, the same dock.
        await pressed(".ext-panel-back");
        await waitFor("the chat", `return JSON.stringify(!document.querySelector(".dsn"))`);
        await inPage(
            `const { openExtPanel } = await import("/extension-ui.js"); openExtPanel("design", "design"); return "null";`,
        );
        await waitFor(
            "the workspace again",
            `return JSON.stringify(Boolean(document.querySelector(".dsn .dsn-dock")))`,
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".dsn-picker-title").textContent)`,
            ),
            "Coffee landing page",
        );
        await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    },
);

test("pointing at an element makes a comment that everyone sees, with a pin", bridged, async () => {
    await openDesign();
    await choose("Coffee landing page");
    await pressed(".dsn-tabs button", "Comment");
    await waitFor(
        "the hint",
        `return JSON.stringify(Boolean(document.querySelector(".dsn-hint")))`,
    );

    // Tap the middle of the page, once it is there: the inspector picks whatever is at that place.
    await waitFor(
        "the page",
        `return JSON.stringify(Boolean(document.querySelector(".dsn-frame.loaded")))`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const box = await inPage<{ x: number; y: number }>(`
        const box = document.querySelector(".dsn-frame").getBoundingClientRect();
        return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 3 });
    `);

    await page.click({ x: Math.round(box.x), y: Math.round(box.y) });
    await waitFor(
        "the composer",
        `return JSON.stringify(Boolean(document.querySelector(".dsn-composer textarea")))`,
    );
    await inPage(`
        const box = document.querySelector(".dsn-composer textarea");
        box.value = "Try a bigger button";
        box.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);
    await pressed(".dsn-composer .primary");
    await until(
        async () =>
            (
                await app.harness.snapshot(DesignCommentsDoc, session, BACKGROUND_CONTEXT)
            )?.items.landing?.comments.some((each) => each.text === "Try a bigger button") === true,
        "the comment",
        SLOW,
    );
    await waitFor(
        "it listed, with a pin number",
        `return JSON.stringify(document.querySelector(".dsn-pin")?.textContent === "1")`,
    );
});

test(
    "tweaks from the page's manifest show as controls, and are kept for the person",
    bridged,
    async () => {
        await openDesign();
        await choose("Coffee landing page");
        await pressed(".dsn-tabs button", "Tweaks");
        await waitFor(
            "the knobs",
            `return JSON.stringify(document.querySelectorAll(".dsn-knob").length === 5)`,
        );

        const labels = await inPage<string[]>(
            `return JSON.stringify([...document.querySelectorAll(".dsn-knob-label span:first-child")].map((each) => each.textContent))`,
        );

        assert.deepEqual(labels, ["Accent", "Corners", "Text size", "Shout", "Tone"]);
        await inPage(`
        const range = document.querySelector('.dsn-knob input[type="range"]');
        range.value = "30";
        range.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);
        await until(
            async () =>
                (await app.harness.snapshot(DesignCommentsDoc, session, BACKGROUND_CONTEXT))?.items
                    .landing?.tweaks?.[owner(app).id]?.values["--radius"] === 30,
            "the tweak kept",
            SLOW,
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".dsn-tab.on .dsn-count").textContent)`,
            ),
            "1",
        );

        // Keep these: the values, in the box, as a message.
        await setBox("");
        await pressed(".dsn-dock-foot .primary");
        await until(
            async () => (await boxText()).startsWith("Keep these tweaks in"),
            "the message",
            SLOW,
        );
        assert.match(await boxText(), /Corners \(`--radius`\): 12px → 30px/);
        await setBox("");
    },
);

test(
    "a deck has a slide strip, and present mode fills the screen and steps through",
    bridged,
    async () => {
        await openDesign();
        await choose("Pitch deck");
        await waitFor(
            "four slides",
            `return JSON.stringify(document.querySelectorAll(".dsn-slide").length === 4)`,
        );
        await pressed(".dsn-slide", "3");
        await waitFor(
            "slide 3",
            `return JSON.stringify(document.querySelector(".dsn-slide.on")?.textContent.trim() === "3")`,
        );
        await pressed('.dsn-tabs button[title="Present"]');
        await waitFor(
            "present mode",
            `return JSON.stringify(Boolean(document.querySelector(".dsn-present iframe")))`,
        );
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".dsn-present-bar").textContent)`,
            ),
            /\d \/ 4/,
        );
        await pressed('.dsn-present-bar button[aria-label="Leave present mode"]');
        await waitFor("back", `return JSON.stringify(!document.querySelector(".dsn-present"))`);
    },
);
