// Drafts are saved per person, and sign-out clears them.
import {
    type App,
    cleanUp,
    modelTexts,
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
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const executable = findBrowser();
const real = {
    skip: executable === undefined ? "no Chromium-based browser on this machine" : false,
};
let app: App;
let server: Server;
let chromium: Chromium;
let page: BrowserPage;
let peer: BrowserPage;
let primarySession: string;
let peerSession: string;
let base: string;
let session: ConversationId;
let guest: ReturnType<App["config"]["addUser"]>;
const paste = "OWNER DRAFT PASTE\n" + "local pasted line\n".repeat(25);
const streams = new Map<string, ServerResponse>();

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (expression: string, label: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(${expression})`).catch(() => false), label);
const boxText = () =>
    inPage<string>(`return JSON.stringify(document.querySelector(".composer textarea")?.value)`);

async function login(token: string, person: string): Promise<void> {
    await chromium.connection.send("Page.bringToFront", {}, primarySession);
    await page.navigate(`${base}/login?token=${encodeURIComponent(token)}&next=/s/${session}`);

    if (await inPage<boolean>(`return JSON.stringify(location.pathname === "/login")`)) {
        await page.click({ selector: 'form button[type="submit"]' });
    }

    await see(
        `(await import("/store.js")).store.state.me?.id === ${JSON.stringify(person)} && document.querySelector(".composer textarea") !== null`,
        "the account's composer",
    );
}

async function type(selector: string, text: string): Promise<void> {
    await inPage(`
        const box = document.querySelector(${JSON.stringify(selector)});
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);
}

async function composerDraft(): Promise<string> {
    await type(".composer textarea", "Owner's unsent draft ");
    await inPage(`
        const box = document.querySelector(".composer textarea");
        box.setSelectionRange(box.value.length, box.value.length);
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", ${JSON.stringify(paste)});
        box.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
        return "null";
    `);
    await see(
        `document.querySelector(".composer textarea").value.includes("Pasted text #1")`,
        "the folded paste",
    );

    return boxText();
}

/** Unlike Browsers.open(), these 2 pages share a browser context, cookies, and local storage. */
async function browserPage(id: number): Promise<BrowserPage> {
    const connection = chromium.connection;
    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await connection.send("Target.attachToTarget", {
        targetId,
        flatten: true,
    });

    if (id === 1) {
        primarySession = sessionId;
    } else {
        peerSession = sessionId;
    }

    const opened = new BrowserPage({
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

    await opened.init();

    return opened;
}

const inPeer = async <T>(script: string): Promise<T> =>
    JSON.parse(await peer.evaluate(script)) as T;
const peerSees = (expression: string, label: string) =>
    until(() => inPeer<boolean>(`return JSON.stringify(${expression})`).catch(() => false), label);

async function openPeer(): Promise<void> {
    await peer.navigate(`${base}/s/${session}`);
    await peerSees(
        `document.querySelector(".composer textarea") !== null`,
        "the second window's composer",
    );
}

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
            response.end("<!doctype html><title>Away</title><p>Another page</p>");
        } else {
            if (request.url?.startsWith("/api/events?")) {
                const tab = new URL(request.url, base).searchParams.get("tab")!;

                streams.set(tab, response);
                response.once("close", () => {
                    if (streams.get(tab) === response) {
                        streams.delete(tab);
                    }
                });
            }

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
    if (executable === undefined) {
        return;
    }

    page = await browserPage(1);
    peer = await browserPage(2);
});

afterEach(async () => {
    // Each test owns its tabs, including cached documents and fetches held by its checks.
    for (const opened of [page, peer]) {
        if (opened !== undefined) {
            opened.close();
            await chromium.connection.send("Target.closeTarget", { targetId: opened.targetId });
        }
    }
});

after(async () => {
    page?.close();
    peer?.close();
    chromium?.kill();
    await chromium?.exited;
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "sign-out erases local composer storage and signs out the other open window",
    real,
    async () => {
        await login(app.config.ownerToken, owner(app).id);
        await composerDraft();
        await inPage(`
        const transfer = new DataTransfer();
        transfer.items.add(new File(["Owner's local file"], "local-owner.txt", { type: "text/plain" }));
        const input = document.querySelector('.composer input[type="file"]');
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return "null";
    `);
        await see(
            `document.querySelector(".composer .chip-name")?.textContent === "local-owner.txt"`,
            "the owner's attached file",
        );
        await inPage(`
        const { drafts } = await import("/store.js");
        const { remember } = await import("/history.js");
        const { personStorage } = await import("/person-storage.js");
        drafts.set(null, "Owner's home draft");
        drafts.set("chat-${session}", "Owner's chat draft");
        remember("Owner's sent secret", { person: ${JSON.stringify(owner(app).id)}, conversation: ${session} });
        personStorage.set("pip.draft", "Owner's local assistant draft");
        personStorage.set("viewed.${session}", JSON.stringify({ "/local/owner.txt": true }));
        // Also remove data left by versions that persisted attachments or unscoped history.
        localStorage.setItem("pocket.attached.${session}", JSON.stringify([{ path: "/local/owner.txt" }]));
        localStorage.setItem("pocket.history", JSON.stringify(["Owner's legacy secret"]));
        localStorage.setItem("drafts-test.preference", "keep");
        return "null";
    `);
        await openPeer();
        await inPage(`void (await import("/store.js")).signOut(); return "null";`);
        await see(
            `(await import("/store.js")).store.state.me === null && document.querySelector(".composer textarea") === null`,
            "signed out",
        );
        const draftKeys = await inPage<string[]>(`
        return JSON.stringify(Object.keys(localStorage).filter((key) =>
            /^(pocket\\.(draft\\.|pastes\\.|attached\\.|person\\.|history(?:$|\\.)|pip\\.draft$))/.test(key)));
    `);

        assert.deepEqual(draftKeys, []);
        await peerSees(
            `(await import("/store.js")).store.state.me === null && document.querySelector(".composer textarea") === null`,
            "the other window signed out",
        );
        await login(guest.token, guest.user.id);
        assert.equal(await boxText(), "");
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll(".composer .chip-name").length)`,
            ),
            0,
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify((await import("/store.js")).drafts.get("chat-${session}"))`,
            ),
            "",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(localStorage.getItem("drafts-test.preference"))`,
            ),
            "keep",
        );
    },
);

test(
    "a same-person Back restore checks the cookie without losing the draft or attached file",
    real,
    async () => {
        // A peer reconnect can post to the frozen page and make Chromium evict it from the Back cache.
        await peer.navigate("about:blank");
        await login(app.config.ownerToken, owner(app).id);
        await type(".composer textarea", "Keep this draft on Back");
        await inPage(`
        const transfer = new DataTransfer();
        transfer.items.add(new File(["Keep this file on Back"], "back.txt", { type: "text/plain" }));
        const input = document.querySelector('.composer input[type="file"]');
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        globalThis.restoreDocument = true;
        addEventListener("pageshow", (event) => { globalThis.restoredPersisted = event.persisted; });
        const fetched = fetch;
        globalThis.fetch = async (url, options) => {
            if (String(url) === "/api/me") {
                globalThis.restoreWaiting = true;
                await new Promise((resolve) => { globalThis.finishRestore = resolve; });
            }
            return fetched(url, options);
        };
        return "null";
    `);
        await see(
            `document.querySelector(".composer .chip-name")?.textContent === "back.txt"`,
            "the file before leaving",
        );
        await page.navigate(`${base}/away`);
        await page.go(-1);
        await see(`globalThis.restoreWaiting === true`, "the restored page checking its cookie");
        assert.deepEqual(
            await inPage(`return JSON.stringify({
            sameDocument: globalThis.restoreDocument,
            persisted: globalThis.restoredPersisted,
            visible: getComputedStyle(document.documentElement).visibility === "visible",
            covered: document.querySelector(".account-cover")?.matches(":modal"),
        });`),
            { sameDocument: true, persisted: true, visible: true, covered: true },
        );
        await inPage(`globalThis.finishRestore(); return "null";`);
        await see(
            `document.querySelector(".account-cover") === null`,
            "the verified page uncovered",
        );
        assert.equal(await inPage(`return JSON.stringify(globalThis.restoreDocument)`), true);
        assert.equal(await boxText(), "Keep this draft on Back");
        assert.equal(
            await inPage(
                `return JSON.stringify(document.querySelector(".composer .chip-name")?.textContent)`,
            ),
            "back.txt",
        );
    },
);

test(
    "the early sign-out signal stops the peer cache without reloading its still-valid cookie",
    real,
    async () => {
        await login(app.config.ownerToken, owner(app).id);
        await openPeer();
        await inPeer(`
        globalThis.signoutDocument = true;
        addEventListener("pocket:signedOut", () => { globalThis.cacheStopped = true; });
        return "null";
    `);
        await inPage(`
        const fetched = fetch;
        globalThis.fetch = async (url, options) => {
            if (String(url) === "/api/logout") {
                globalThis.logoutWaiting = true;
                await new Promise((resolve) => { globalThis.finishLogout = resolve; });
            }
            const response = await fetched(url, options);
            if (String(url) === "/api/me") {
                globalThis.signoutCheckWaiting = true;
                await new Promise((resolve) => { globalThis.finishSignoutCheck = resolve; });
            }
            return response;
        };
        globalThis.pendingAccountCheck = (await import("/store.js")).start();
        return "null";
    `);
        await see(`globalThis.signoutCheckWaiting === true`, "the earlier account answer");
        await inPage(`void (await import("/store.js")).signOut(); return "null";`);
        await see(`globalThis.logoutWaiting === true`, "the held logout request");
        await inPage(`
            globalThis.finishSignoutCheck();
            await globalThis.pendingAccountCheck;
            return "null";
        `);
        assert.equal(await inPage(`return JSON.stringify(globalThis.logoutWaiting)`), true);
        await peerSees(`globalThis.cacheStopped === true`, "the early cache stop in the peer");
        assert.equal(
            await inPeer(`return JSON.stringify(globalThis.signoutDocument === true &&
            (await import("/store.js")).store.state.me?.id === ${JSON.stringify(owner(app).id)})`),
            true,
        );
        await inPage(`globalThis.finishLogout(); return "null";`);
        await see(
            `location.pathname === "/" && (await import("/store.js")).store.state.me === null`,
            "signed out at Home",
        );
        await peerSees(
            `(await import("/store.js")).store.state.me === null && !globalThis.signoutDocument`,
            "the peer reloaded after logout",
        );
    },
);

test(
    "a new tab of the same person does not reload this one when its stream reconnects",
    real,
    async () => {
        await login(app.config.ownerToken, owner(app).id);
        await type(".composer textarea", "Keep this edit through a reconnect");
        const tab = await inPage<string>(`
            const { store } = await import("/store.js");
            globalThis.sameDocument = true;
            globalThis.streamBefore = store.state.streamId;
            globalThis.peerAnnounced = false;
            const channel = new BroadcastChannel("pocket.account");
            channel.addEventListener("message", (event) => {
                if (event.data.person === ${JSON.stringify(owner(app).id)}) {
                    globalThis.peerAnnounced = true;
                    channel.close();
                }
            });
            const transfer = new DataTransfer();
            transfer.items.add(new File(["Keep this file"], "reconnect.txt", { type: "text/plain" }));
            const input = document.querySelector('.composer input[type="file"]');
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return JSON.stringify(sessionStorage.getItem("pocket.tab"));
        `);

        await see(
            `document.querySelector(".composer .chip-name")?.textContent === "reconnect.txt"`,
            "the attached file before reconnecting",
        );
        await openPeer();
        await see(`globalThis.peerAnnounced === true`, "the same person's account signal");
        await peerSees(
            `typeof (await import("/store.js")).store.state.streamId === "string"`,
            "the second tab's stream",
        );
        const peerStream = await inPeer<string>(
            `return JSON.stringify((await import("/store.js")).store.state.streamId)`,
        );

        // End only this tab's response. Its EventSource retries itself, with the original account generation.
        const stream = streams.get(tab);

        assert.ok(stream);
        stream.end();
        await see(
            `((state) => state.connection === "open" && state.streamId !== globalThis.streamBefore)(
                (await import("/store.js")).store.state)`,
            "the reconnect's hello",
        );
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(globalThis.sameDocument === true)`),
            true,
        );
        assert.equal(await boxText(), "Keep this edit through a reconnect");
        assert.equal(
            await inPage(
                `return JSON.stringify(document.querySelector(".composer .chip-name")?.textContent)`,
            ),
            "reconnect.txt",
        );
        assert.equal(
            await inPeer(`return JSON.stringify((await import("/store.js")).store.state.streamId)`),
            peerStream,
        );
    },
);

test("Back keeps a cover with Retry when the account check returns 503", real, async () => {
    await peer.navigate("about:blank");
    await login(app.config.ownerToken, owner(app).id);
    await type(".composer textarea", "Keep this edit while the server is away");
    await inPage(`
        globalThis.restoreDocument = true;
        globalThis.restoreOffline = true;
        globalThis.restoreChecks = 0;
        globalThis.retryTimers = [];
        globalThis.clearedTimers = [];
        globalThis.checkTimeouts = [];
        const schedule = setTimeout;
        const cancel = clearTimeout;
        globalThis.setTimeout = (fn, ms, ...args) => {
            const id = schedule(fn, ms, ...args);
            if (fn.name === "restoreAccount") globalThis.retryTimers.push({ id, ms });
            if (ms === 10000) globalThis.checkTimeouts.push(id);
            return id;
        };
        globalThis.clearTimeout = (id) => {
            globalThis.clearedTimers.push(id);
            cancel(id);
        };
        const fetched = fetch;
        globalThis.fetch = (url, options) => {
            if (String(url) === "/api/me") {
                globalThis.restoreChecks++;
                globalThis.checkHasSignal = options.signal instanceof AbortSignal;
                if (globalThis.restoreOffline) {
                    return Promise.resolve(new Response('{"error":"Server away"}', { status: 503 }));
                }
            }
            return fetched(url, options);
        };
        return "null";
    `);
    await page.navigate(`${base}/away`);
    await page.go(-1);
    await see(
        `document.querySelector(".account-cover p")?.textContent === "Checking who is signed in…"`,
        "the account check cover",
    );
    assert.deepEqual(
        await inPage(`
            const cover = document.querySelector(".account-cover");
            document.querySelector(".composer textarea").focus();
            const cancelled = !cover.dispatchEvent(new Event("cancel", { cancelable: true }));
            return JSON.stringify({
                visible: getComputedStyle(document.documentElement).visibility === "visible",
                covered: cover.matches(":modal"),
                focused: cover.contains(document.activeElement),
                cancelled,
            });
        `),
        { visible: true, covered: true, focused: true, cancelled: true },
    );
    await see(
        `document.querySelector(".account-cover p")?.textContent === "The server cannot be reached. Try again."`,
        "the error after 3 failed checks",
    );
    assert.deepEqual(
        await inPage(`return JSON.stringify({
            retries: globalThis.retryTimers.map(({ ms }) => ms),
            hasSignal: globalThis.checkHasSignal,
            timeouts: globalThis.checkTimeouts.length,
        });`),
        { retries: [1000, 2000, 4000], hasSignal: true, timeouts: 3 },
    );
    await inPage(`globalThis.restoreOffline = false; return "null";`);
    await page.click({ selector: ".account-cover button" });
    await see(`document.querySelector(".account-cover") === null`, "Retry verified the account");
    assert.equal(await boxText(), "Keep this edit while the server is away");
    assert.deepEqual(
        await inPage(`return JSON.stringify({
            sameDocument: globalThis.restoreDocument,
            checks: globalThis.restoreChecks,
            cancelledRetry: globalThis.clearedTimers.includes(globalThis.retryTimers.at(-1).id),
        });`),
        { sameDocument: true, checks: 4, cancelledRetry: true },
    );
});

test(
    "an account signal during startup rejects the old answer and cached session",
    real,
    async () => {
        await peer.navigate("about:blank");
        await login(app.config.ownerToken, owner(app).id);
        await say(app, session, "The cached session for the startup check");
        await type(".composer textarea", "The owner's startup draft");
        await see(
            `(await (await import("/session-cache.js")).read(${session})) !== undefined`,
            "the owner's session on the device",
        );
        const { identifier } = await chromium.connection.send(
            "Page.addScriptToEvaluateOnNewDocument",
            {
                source: `
                const fetched = fetch;
                globalThis.fetch = async (url, options) => {
                    const response = await fetched(url, options);
                    if (String(url) === "/api/me") {
                        await response.clone().text();
                        globalThis.startupWaiting = true;
                        await new Promise((resolve) => { globalThis.finishStartup = resolve; });
                    }
                    return response;
                };
                addEventListener("storage", (event) => {
                    if (event.key === "pocket.person") globalThis.startupPersonSignal = event.newValue;
                });
            `,
            },
            primarySession,
        );

        try {
            await page.navigate(`${base}/s/${session}`);
            await see(`globalThis.startupWaiting === true`, "the held owner's account answer");
            await inPage(`
            const { store } = await import("/store.js");
            sessionStorage.removeItem("startupAdoptedOwner");
            store.subscribe((state) => {
                if (state.me?.id === ${JSON.stringify(owner(app).id)} && state.view.conversation) {
                    sessionStorage.setItem("startupAdoptedOwner", "yes");
                }
            });
            return "null";
        `);
        } finally {
            await chromium.connection.send(
                "Page.removeScriptToEvaluateOnNewDocument",
                { identifier },
                primarySession,
            );
        }

        await chromium.connection.send("Page.bringToFront", {}, peerSession);
        await peer.navigate(
            `${base}/login?token=${encodeURIComponent(guest.token)}&next=/s/${session}`,
        );

        if (await inPeer<boolean>(`return JSON.stringify(location.pathname === "/login")`)) {
            await peer.click({ selector: 'form button[type="submit"]' });
        }

        await peerSees(
            `(await import("/store.js")).store.state.me?.id === ${JSON.stringify(guest.user.id)}`,
            "the guest in the second tab",
        );
        await chromium.connection.send("Page.bringToFront", {}, primarySession);
        await see(
            `globalThis.startupPersonSignal === ${JSON.stringify(guest.user.id)}`,
            "the account signal before releasing the answer",
        );
        assert.equal(
            await inPage(
                `return JSON.stringify((await import("/store.js")).store.state.me === undefined)`,
            ),
            true,
        );
        await inPage(`globalThis.finishStartup(); return "null";`);
        await see(
            `(await import("/store.js")).store.state.me?.id === ${JSON.stringify(guest.user.id)} &&
            document.querySelector(".composer textarea") !== null`,
            "the new document for the guest",
        );
        assert.equal(await boxText(), "");
        assert.equal(
            await inPage(`return JSON.stringify(sessionStorage.getItem("startupAdoptedOwner"))`),
            null,
        );
    },
);

test(
    "a confirmed account switch isolates drafts and pastes, preserves the owner's reload, and resets the other window",
    real,
    async () => {
        await login(app.config.ownerToken, owner(app).id);
        const original = await composerDraft();

        await inPage(`(await import("/pip.js")).openPip(); return "null";`);
        await see(`document.querySelector(".pip-composer textarea") !== null`, "PiP's composer");
        await type(".pip-composer textarea", "Owner's local PiP draft");
        await inPage(`(await import("/pip.js")).closePip(); return "null";`);
        await inPage(`
        const { drafts } = await import("/store.js");
        const { remember } = await import("/history.js");
        drafts.set(null, "Owner's switched home draft");
        drafts.set("chat-${session}", "Owner's switched chat draft");
        remember("Owner's switched history", { person: ${JSON.stringify(owner(app).id)}, conversation: ${session} });
        return "null";
    `);
        await page.navigate(`${base}/s/${session}`);
        await see(
            `document.querySelector(".composer textarea")?.value === ${JSON.stringify(original)}`,
            "the owner's draft after reload",
        );
        await openPeer();
        await login(guest.token, guest.user.id);
        assert.equal(await boxText(), "");
        assert.deepEqual(
            await inPage<string[]>(`
        const { drafts } = await import("/store.js");
        const { sentHistory } = await import("/history.js");
        return JSON.stringify([drafts.get(null), drafts.get("chat-${session}"), ...sentHistory({ person: ${JSON.stringify(guest.user.id)}, conversation: ${session} })]);
    `),
            ["", ""],
        );
        await peerSees(
            `(await import("/store.js")).store.state.me?.id === ${JSON.stringify(guest.user.id)} && document.querySelector(".composer textarea")?.value === ""`,
            "the other window's account switch",
        );
        // A typed placeholder must not expand to the other person's local paste.
        await type(".composer textarea", "Guest's text [Pasted text #1]");
        await page.click({ selector: ".composer .send-button" });
        await until(
            async () =>
                (await modelTexts(app, session)).some((text) => text.includes("Guest's text")),
            "the guest's message",
        );
        assert.equal(
            (await modelTexts(app, session)).some((text) => text.includes(paste)),
            false,
        );
        await login(app.config.ownerToken, owner(app).id);
        assert.equal(await boxText(), original);
        assert.deepEqual(
            await inPage<string[]>(`
        const { drafts } = await import("/store.js");
        return JSON.stringify([drafts.get(null), drafts.get("chat-${session}")]);
    `),
            ["Owner's switched home draft", "Owner's switched chat draft"],
        );
        await inPage(`(await import("/pip.js")).openPip(); return "null";`);
        await see(
            `document.querySelector(".pip-composer textarea")?.value === "Owner's local PiP draft"`,
            "the owner's PiP draft after switching back",
        );
        await inPage(`(await import("/pip.js")).closePip(); return "null";`);
    },
);
