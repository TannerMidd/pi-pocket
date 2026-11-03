// Drafts are saved per person (`web/person-storage.js`), and sign-out clears them.
import {
    type App,
    cleanUp,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

type Tab = {
    page: BrowserPage;
    session: string;
    run<T>(script: string): Promise<T>;
    sees(expression: string, label: string): Promise<void>;
};

const executable = findBrowser();
const real = {
    skip: executable === undefined ? "no Chromium-based browser on this machine" : false,
};
// A module imported before the page has its import map fails, and stays failed in that page.
const me = `(document.readyState === "complete"
    ? (await import("/store.js")).store.state.me
    : undefined)`;
const box = `document.querySelector(".composer textarea")`;
let app: App;
let server: Server;
let chromium: Chromium;
let base: string;
let session: ConversationId;
let guest: ReturnType<App["config"]["addUser"]>;
let tab: Tab;
let peer: Tab;

/** Unlike Browsers.open(), these tabs share a browser context: cookies and local storage. */
async function openTab(id: number): Promise<Tab> {
    const connection = chromium.connection;
    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await connection.send("Target.attachToTarget", {
        targetId,
        flatten: true,
    });
    const page = new BrowserPage({
        conversationId: id,
        connection,
        session: sessionId,
        target: targetId,
        context: "",
        userAgent: chromium.userAgent,
        viewport: VIEWPORTS.desktop,
        changed: () => {},
        saved: () => {},
    });

    await page.init();
    const run = async <T>(script: string) => JSON.parse(await page.evaluate(script)) as T;

    return {
        page,
        session: sessionId,
        run,
        sees: (expression, label) =>
            until(
                () => run<boolean>(`return JSON.stringify(${expression})`).catch(() => false),
                label,
            ),
    };
}

const front = (into: Tab) => chromium.connection.send("Page.bringToFront", {}, into.session);

async function login(into: Tab, token: string, person: string): Promise<void> {
    await front(into);
    await into.page.navigate(`${base}/login?token=${encodeURIComponent(token)}&next=/s/${session}`);

    if (await into.run<boolean>(`return JSON.stringify(location.pathname === "/login")`)) {
        await into.page.click({ selector: 'form button[type="submit"]' });
    }

    await into.sees(
        `${me}?.id === ${JSON.stringify(person)} && ${box} !== null`,
        "the message box",
    );
}

const type = (into: Tab, text: string) =>
    into.run(`
        ${box}.value = ${JSON.stringify(text)};
        ${box}.dispatchEvent(new Event("input", { bubbles: true }));
        globalThis.sameDocument = true;
        return "null";
    `);

before(async () => {
    if (executable === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    session = await newSession(app);
    guest = app.config.addUser("Draft test guest", "guest", [String(session)]);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (request.url === "/away") {
            response.writeHead(200, { "content-type": "text/html" });
            response.end("<!doctype html><title>Away</title>");
        } else {
            void handler(request, response);
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    chromium = await Chromium.launch(executable, mkdtempSync(join(root, "composer-drafts-ui-")), [
        "--renderer-process-limit=2",
    ]);
});

beforeEach(async () => {
    if (executable !== undefined) {
        [tab, peer] = [await openTab(1), await openTab(2)];
    }
});

afterEach(async () => {
    for (const each of [tab, peer]) {
        each?.page.close();
        await chromium?.connection.send("Target.closeTarget", { targetId: each?.page.targetId });
    }
});

after(async () => {
    chromium?.kill();
    await chromium?.exited;
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("drafts stay with their person across a switch, and sign-out clears them", real, async () => {
    await login(tab, app.config.ownerToken, owner(app).id);
    await type(tab, "Owner's draft ");
    await tab.run(`
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", "owner's pasted line\\n".repeat(25));
        const paste = { bubbles: true, cancelable: true, clipboardData };
        ${box}.dispatchEvent(new ClipboardEvent("paste", paste));
        localStorage.setItem("drafts-test.preference", "kept");
        return "null";
    `);
    await tab.sees(`${box}.value.includes("[Pasted text #1")`, "the folded paste");
    const draft = await tab.run<string>(`return JSON.stringify(${box}.value)`);

    await login(peer, guest.token, guest.user.id);
    await front(tab);
    await tab.sees(
        `${me}?.id === ${JSON.stringify(guest.user.id)} && ${box}?.value === ""`,
        "the guest",
    );
    // A placeholder the guest types is not the owner's paste.
    await type(tab, "Guest's text [Pasted text #1]");
    await tab.page.click({ selector: ".composer .send-button" });
    await until(
        async () => (await modelTexts(app, session)).some((text) => text.includes("Guest's text")),
        "the guest's message",
    );
    assert.equal((await modelTexts(app, session)).join().includes("owner's pasted line"), false);

    await login(tab, app.config.ownerToken, owner(app).id);
    assert.equal(await tab.run(`return JSON.stringify(${box}.value)`), draft);
    await tab.run(`void (await import("/store.js")).signOut(); return "null"`);
    await peer.sees(`${me} === null`, "the other tab signed out");
    await tab.sees(`${me} === null`, "signed out");
    assert.deepEqual(
        await tab.run(`return JSON.stringify(Object.keys(localStorage).filter((key) =>
            key.startsWith("pocket.person.") || key.startsWith("drafts-test.")))`),
        ["drafts-test.preference"],
    );
    // Back to the page kept from before the sign-out: it loads again, signed out.
    await tab.page.go(-1);
    await tab.sees(
        `${me} === null && document.querySelector(".account-cover") === null`,
        "the page signed out, with no account check left over",
    );
});

test("Back covers the page until an account check passes, and keeps the draft", real, async () => {
    await login(tab, app.config.ownerToken, owner(app).id);
    await type(tab, "Keep this draft on Back");
    await tab.run(`
        const fetched = fetch;
        globalThis.offline = true;
        globalThis.fetch = (url, options) =>
            String(url) === "/api/me" && globalThis.offline
                ? Promise.resolve(new Response("{}", { status: 503 }))
                : fetched(url, options);
        return "null";
    `);
    await tab.page.navigate(`${base}/away`);
    await tab.page.go(-1);
    await tab.sees(`document.querySelector(".account-cover")?.matches(":modal")`, "the cover");
    await tab.run(`globalThis.offline = false; return "null"`);
    await tab.sees(`document.querySelector(".account-cover") === null`, "the checked page");
    assert.deepEqual(
        await tab.run(`return JSON.stringify([globalThis.sameDocument, ${box}.value])`),
        [true, "Keep this draft on Back"],
    );
});

test("a starting tab keeps its answer for the same person only", real, async () => {
    await login(tab, app.config.ownerToken, owner(app).id);
    // Each load counts itself, hears the account signal, and can hold its first answer of /api/me.
    const source = `
        sessionStorage.setItem("loads", String(Number(sessionStorage.getItem("loads")) + 1));
        addEventListener("storage", (event) => {
            if (event.key === "pocket.person") globalThis.signal = event.newValue;
        });
        const fetched = fetch;
        globalThis.fetch = async (url, options) => {
            const response = await fetched(url, options);
            if (String(url) === "/api/me" && sessionStorage.getItem("hold")) {
                sessionStorage.removeItem("hold");
                await response.clone().text();
                await new Promise((resolve) => { globalThis.release = resolve; });
            }
            return response;
        };
    `;

    await chromium.connection.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source },
        tab.session,
    );

    const start = async () => {
        await tab.run(`
            sessionStorage.setItem("hold", "1");
            sessionStorage.setItem("loads", "0");
            return "null";
        `);
        await tab.page.navigate(`${base}/s/${session}`);
        await tab.sees(`typeof globalThis.release === "function"`, "the held answer");
    };

    await start();
    await peer.page.navigate(`${base}/s/${session}`);
    await peer.sees(`${me}?.id === ${JSON.stringify(owner(app).id)}`, "the owner's second tab");
    await tab.run(`globalThis.release(); return "null"`);
    await tab.sees(`${me}?.id === ${JSON.stringify(owner(app).id)}`, "the owner");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await tab.run(`return JSON.stringify(sessionStorage.getItem("loads"))`), "1");

    await start();
    await tab.run(`
        (await import("/store.js")).store.subscribe((state) => {
            if (state.me?.id === ${JSON.stringify(owner(app).id)}) {
                sessionStorage.setItem("shown", "1");
            }
        });
        return "null";
    `);
    await login(peer, guest.token, guest.user.id);
    await front(tab);
    await tab.sees(`globalThis.signal === ${JSON.stringify(guest.user.id)}`, "the guest's signal");
    await tab.run(`globalThis.release(); return "null"`);
    await tab.sees(
        `${me}?.id === ${JSON.stringify(guest.user.id)} && ${box}?.value === ""`,
        "the guest",
    );
    assert.equal(await tab.run(`return JSON.stringify(sessionStorage.getItem("shown"))`), null);
});
