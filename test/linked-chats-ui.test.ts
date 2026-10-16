// Normal peer-chat navigation in the real app, on a throwaway server and data folder.
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
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base: string;
let origin: ConversationId;
let target: ConversationId;

async function evaluate<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, description: string) =>
    until(async () => {
        try {
            return await evaluate<boolean>(script);
        } catch {
            // Full navigation can briefly leave the old document or the login redirect without an import map.
            return false;
        }
    }, description);
const settled = () => new Promise((resolve) => setTimeout(resolve, 450));

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    origin = await newSession(app);
    await say(app, origin, "main chat context");
    await app.commands.updateSession(origin, owner(app), { title: "Main task" });
    target = await app.linkedChats.start(
        origin,
        { title: "Authentication investigation", message: "task" },
        "browser-start",
    );
    await app.linkedChats.send(
        origin,
        Number(target),
        "Investigate authentication and send findings back when ready.",
        false,
        "browser-initial-message",
    );
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "linked-ui-")),
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
    "desktop and mobile have a normal sidebar chat and working links in both directions",
    real,
    async () => {
        for (const viewport of [VIEWPORTS.desktop!, VIEWPORTS.mobile!]) {
            await page.setViewport(viewport);
            await page.navigate(`${base}/s/${origin}`);
            await see(
                `return JSON.stringify(document.querySelector('.linked-chats')?.textContent.includes('Authentication investigation') === true)`,
                "source link",
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify((await import('/store.js')).store.state.sessions.some(s => s.id === ${Number(target)}))`,
                ),
                true,
            );
            await settled();
            await page.click({ selector: ".linked-chats button" });
            await see(
                `return JSON.stringify((await import('/store.js')).store.state.conversationId === ${Number(target)} && (await import('/store.js')).store.state.view.conversation?.id === ${Number(target)})`,
                "normal target chat",
            );
            await see(
                `return JSON.stringify(document.querySelector('.linked-chats')?.textContent.includes('Started from: Main task') === true)`,
                "origin link",
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify((await import('/store.js')).store.state.view.conversation.kind)`,
                ),
                "session",
            );
            await see(
                `return JSON.stringify(document.querySelector('.prompt-body')?.textContent.includes('Investigate authentication') === true)`,
                "peer task body",
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.querySelector('.prompt-body').textContent.includes('<linked-chat-message>'))`,
                ),
                false,
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.querySelector('.prompt-body').textContent.includes('Message from linked peer'))`,
                ),
                false,
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.querySelector('.parent-session') === null)`,
                ),
                true,
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.querySelector('.title-sub')?.textContent.includes('subagent of') === true)`,
                ),
                false,
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
                ),
                true,
            );
            await settled();
            const rect = await evaluate<{ height: number; right: number }>(
                `const r = document.querySelector('.linked-chats button').getBoundingClientRect(); return JSON.stringify({height:r.height,right:r.right})`,
            );

            assert.ok(rect.height >= 40, JSON.stringify(rect));
            assert.ok(rect.right <= viewport.width);
            const shot = await page.screenshot();

            writeFileSync(
                `/tmp/pi-pocket-linked-${viewport.mobile ? "mobile" : "desktop"}.jpg`,
                Buffer.from(shot.data, "base64"),
            );
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
            await settled();
            await page.click({ selector: ".linked-chats button" });
            await see(
                `return JSON.stringify((await import('/store.js')).store.state.view.conversation?.id === ${Number(origin)})`,
                "back to origin",
            );
        }
    },
);

test("renaming, archive and reload retain the current links", real, async () => {
    await app.commands.updateSession(origin, owner(app), {
        title: "Renamed main chat",
        archived: true,
    });
    await page.navigate(`${base}/s/${target}`);
    await see(
        `return JSON.stringify(document.querySelector('.linked-chats')?.textContent.includes('Renamed main chat') === true)`,
        "updated linked title",
    );
    await page.reload();
    await see(
        `return JSON.stringify(document.querySelector('.linked-chats')?.textContent.includes('Renamed main chat') === true)`,
        "link after reload",
    );
    await settled();
    await page.click({ selector: ".linked-chats button" });
    await see(
        `return JSON.stringify((await import('/store.js')).store.state.view.conversation?.id === ${Number(origin)})`,
        "archived origin remains openable",
    );
});

test(
    "someone seeing only the new chat gets no hidden origin title or clickable link",
    real,
    async () => {
        const { token } = app.config.addUser("Only the peer", "viewer", [String(target)]);

        page = await browsers.open(2);
        await page.setViewport(VIEWPORTS.mobile!);
        await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await see(
            `return JSON.stringify((await import('/store.js')).store.state.me?.role === 'viewer')`,
            "viewer signed in",
        );
        await page.navigate(`${base}/s/${target}`);
        await see(
            `return JSON.stringify(document.querySelector('.linked-chats')?.textContent.includes('Started from another chat') === true)`,
            "private origin fallback",
        );
        assert.equal(
            await evaluate(
                `return JSON.stringify(document.querySelectorAll('.linked-chats button').length)`,
            ),
            0,
        );
        assert.equal(
            await evaluate(
                `return JSON.stringify(document.body.textContent.includes('Renamed main chat'))`,
            ),
            false,
        );
        assert.equal(
            await evaluate(
                `return JSON.stringify((await import('/store.js')).store.state.sessions[0].linkedFrom === undefined)`,
            ),
            true,
        );
    },
);
