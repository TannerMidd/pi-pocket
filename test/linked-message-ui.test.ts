// A linked session's message (`LinkedMessage` in web/transcript.js) shows as a card of its own: its session's name and
// Open, its text as Markdown, and a long one folded. A sender this person cannot open shows without a name.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
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

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string, timeoutMs = 10_000) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "linked-message-ui-")),
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

const REPORT = [
    "Verdict: PASS for 5510f8cb. Blockers 0.",
    "",
    "- Checks: `npm run check` pass.",
    "- Layout: the old and new `web/running-board.js` match.",
    ...Array.from({ length: 12 }, (_, index) => `- Point ${String(index + 1)}: PASS.`),
    "",
    "I removed my worktree.",
].join("\n");

test("a linked session's message is a card that names its session and opens it", real, async () => {
    const source = await newSession(app);

    await say(app, source, "hello");
    const { session } = await app.linkedSessions.start(
        source,
        { title: "Post-fix review", message: "a task" },
        "start-review",
    );

    await until(() => !app.isBusy(session), "the linked session's first turn");
    const [peer] = await app.linkedSessions.list(session);

    assert.ok(peer);
    await app.linkedSessions.send(session, { to: peer.address, message: REPORT }, "report");

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${source}`);
    await see(
        `return JSON.stringify(document.querySelector(".linked-message .linked-name")?.textContent.trim() === "Post-fix review")`,
        "the card with the session's name",
    );

    const card = await inPage<{
        from: string;
        tag: string;
        items: number;
        code: string[];
        lead: string;
        routing: boolean;
        more: string;
    }>(`
        const card = document.querySelector(".linked-message");
        return JSON.stringify({
            from: card.dataset.from,
            tag: card.querySelector(".linked-tag").textContent,
            items: card.querySelectorAll(".linked-body li").length,
            code: [...card.querySelectorAll(".linked-body code")].map((each) => each.textContent),
            lead: card.querySelector(".linked-body .md > p:first-child").textContent,
            routing: card.textContent.includes("written by another session's agent"),
            more: card.querySelector(".linked-more")?.textContent.trim(),
        });
    `);

    assert.equal(card.from, "linked");
    assert.equal(card.tag, "Linked session");
    // Markdown, not the raw text: a list, code, and the main point as its own first paragraph.
    assert.equal(card.items, 14);
    assert.deepEqual(card.code, ["npm run check", "web/running-board.js"]);
    assert.equal(card.lead, "Verdict: PASS for 5510f8cb. Blockers 0.");
    assert.equal(card.routing, false);
    assert.equal(card.more, `Show all · ${String(REPORT.split("\n").length)} lines`);

    // Folded until Show all; then whole.
    const height = () =>
        inPage<number>(
            `return JSON.stringify(document.querySelector(".linked-message .linked-body").getBoundingClientRect().height)`,
        );
    const folded = await height();

    await page.click({ selector: ".linked-message .linked-more" });
    await see(
        `return JSON.stringify(document.querySelector(".linked-message .linked-more").textContent.trim() === "Show less")`,
        "the message open",
    );
    assert.ok((await height()) > folded);

    // Open goes to the session that sent it.
    await page.click({ selector: ".linked-message .linked-open" });
    await see(`return JSON.stringify(location.pathname === "/s/${session}")`, "the linked session");
});

test(
    "a message from a session nobody can open here shows without a name or Open",
    real,
    async () => {
        const source = await newSession(app);

        await say(app, source, "hello");
        await app.commands.submit(
            source,
            owner(app),
            {
                text: "Message from linked session session-gone.\n<linked-session-message>\nDone.\n</linked-session-message>",
                requestId: `gone-${source}`,
            },
            "linked session session-gone",
        );

        await page.navigate(`${base}/s/${source}`);
        await see(
            `return JSON.stringify(document.querySelector(".linked-message .linked-name.unknown")?.textContent.trim() === "A session you cannot open")`,
            "the card without a name",
        );
        assert.deepEqual(
            await inPage(
                `return JSON.stringify([document.querySelector(".linked-message .linked-open"), document.querySelector(".linked-message .linked-more")])`,
            ),
            [null, null],
        );
    },
);
