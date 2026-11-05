// Unsent answers on a Pi asks card stay with the person who may answer (`web/person-storage.js`).
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
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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

const options = [
    { label: "Postgres", description: "One server" },
    { label: "SQLite", description: "A file" },
];
const questions = [
    { header: "Database", question: "Which database?", options, multiSelect: false },
    { header: "Parts", question: "Which parts?", options, multiSelect: true },
];
const executable = findBrowser();
const real = {
    skip: executable === undefined ? "no Chromium-based browser on this machine" : false,
};
const me = `(document.readyState === "complete"
    ? (await import("/store.js")).store.state.me
    : undefined)`;
const card = `document.querySelector("form.approval.ask")`;

const pressed = (question: string, label: string) => {
    const field = `[...${card}.querySelectorAll("fieldset")].find((field) => field.textContent.includes(${JSON.stringify(question)}))`;

    return `${field}?.querySelector("button[aria-pressed=true]")?.textContent.includes(${JSON.stringify(label)})`;
};

let app: App;
let server: Server;
let chromium: Chromium;
let base: string;
let first: ConversationId;
let second: ConversationId;
let guest: ReturnType<App["config"]["addUser"]>;
let tab: Tab;

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

async function login(into: Tab, token: string, person: string, session: ConversationId) {
    await into.page.navigate(`${base}/login?token=${encodeURIComponent(token)}&next=/s/${session}`);

    if (await into.run<boolean>(`return JSON.stringify(location.pathname === "/login")`)) {
        await into.page.click({ selector: 'form button[type="submit"]' });
    }

    await into.sees(`${me}?.id === ${JSON.stringify(person)}`, "signed in");
}

async function ask(session: ConversationId): Promise<void> {
    await app.commands.submit(session, owner(app), {
        text: "please ask me",
        requestId: `ask-${session}`,
    });
    await until(() => app.approvals.forConversation(session).length === 1, "the card");
}

const savedKeys = (into: Tab, person: string) =>
    into.run<string[]>(`return JSON.stringify(Object.keys(localStorage).filter((key) =>
        key.startsWith(${JSON.stringify(`pocket.person.${encodeURIComponent(person)}:ask.`)})))`);

before(async () => {
    if (executable === undefined) {
        return;
    }

    app = await openApp(
        scriptedModel((request) => {
            const { role, text } = lastText(request as never);

            return role === "toolResult" || !text.includes("ask me")
                ? fauxAssistantMessage([fauxText(`ok: ${text}`)])
                : fauxAssistantMessage([fauxToolCall("ask", { questions })], {
                      stopReason: "toolUse",
                  });
        }),
    );
    first = await newSession(app);
    second = await newSession(app);
    guest = app.config.addUser("Ask test guest", "guest", [String(first), String(second)]);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    chromium = await Chromium.launch(executable, mkdtempSync(join(root, "ask-answers-ui-")), [
        "--renderer-process-limit=2",
    ]);
});

beforeEach(async () => {
    if (executable !== undefined) {
        tab = await openTab(1);
    }
});

afterEach(async () => {
    tab?.page.close();

    if (tab !== undefined) {
        await chromium?.connection.send("Target.closeTarget", { targetId: tab.page.targetId });
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

test("typed and picked answers stay across a switch and a reload, then go", real, async () => {
    await ask(first);
    await ask(second);
    await login(tab, app.config.ownerToken, owner(app).id, first);
    await tab.sees(`${card} !== null`, "the first card");
    await tab.run(`
        const fields = [...${card}.querySelectorAll("fieldset")];
        const database = fields.find((field) => field.textContent.includes("Which database?"));
        const parts = fields.find((field) => field.textContent.includes("Which parts?"));
        const own = parts.querySelector("input.ask-other");

        database.querySelectorAll("button.ask-option")[1].click();

        for (let at = 0; at < 20 && !database.querySelector("button[aria-pressed=true]")?.textContent.includes("SQLite"); at++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }

        own.value = "my own part";
        own.dispatchEvent(new Event("input", { bubbles: true }));

        return "null";
    `);
    await tab.sees(
        `${pressed("Which database?", "SQLite")} && [...${card}.querySelectorAll("input.ask-other")].some((field) => field.value === "my own part")`,
        "the answers",
    );
    assert.equal((await savedKeys(tab, owner(app).id)).length, 1);

    await tab.page.navigate(`${base}/s/${second}`);
    await tab.sees(
        `${card} !== null && !${pressed("Which database?", "SQLite")}`,
        "the other card starts empty",
    );
    await tab.sees(
        `[...${card}.querySelectorAll("input.ask-other")].every((field) => field.value === "")`,
        "its typed answers start empty",
    );
    await tab.page.navigate(`${base}/s/${first}`);
    await tab.sees(`${pressed("Which database?", "SQLite")}`, "the answers after switching back");
    await tab.sees(
        `[...${card}.querySelectorAll("input.ask-other")].some((field) => field.value === "my own part")`,
        "the typed answer after switching back",
    );
    await tab.page.reload();
    await tab.sees(`${pressed("Which database?", "SQLite")}`, "the answers after a reload");
    await tab.sees(
        `[...${card}.querySelectorAll("input.ask-other")].some((field) => field.value === "my own part")`,
        "the typed answer after a reload",
    );

    await tab.run(`
        const field = ${card}.querySelectorAll("input.ask-other")[1];
        field.value = "a finished part";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);
    await tab.sees(
        `${card}.querySelector('button[type="submit"]:not(:disabled)')`,
        "ready to send",
    );
    await tab.page.click({ selector: 'form.approval.ask button[type="submit"]' });
    await tab.sees(`${card} === null`, "the card gone");
    assert.deepEqual(await savedKeys(tab, owner(app).id), []);

    await app.commands.submit(first, owner(app), {
        text: "please ask me again",
        requestId: "ask-again",
    });
    await until(() => app.approvals.forConversation(first).length === 1, "another card");
    await tab.sees(
        `${card} !== null && !${pressed("Which database?", "SQLite")}`,
        "a new card starts empty",
    );
    await tab.sees(
        `[...${card}.querySelectorAll("input.ask-other")].every((field) => field.value === "")`,
        "its typed answers start empty",
    );
    await tab.run(`
        const field = ${card}.querySelector("input.ask-other");
        field.value = "still here";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);
    await tab.sees(
        `${card}.querySelector("input.ask-other").value === "still here"`,
        "typed again",
    );
    await tab.run(`void (await import("/store.js")).signOut(); return "null"`);
    await tab.sees(`${me} === null`, "signed out");
    assert.deepEqual(await savedKeys(tab, owner(app).id), []);
});

// A session the tab has shown before comes back from the view it kept, which lists that session's approvals only.
test("answers stay on a switch to a session this tab already has", real, async () => {
    const one = await newSession(app);
    const two = await newSession(app);

    const go = async (id: ConversationId) => {
        await tab.run(`(await import("/store.js")).navigate(${id}); return "null"`);
        await tab.sees(
            `(await import("/store.js")).store.state.view.conversation?.id === ${id} && ${card} !== null`,
            `session ${id} and its card`,
        );
    };

    await ask(one);
    await ask(two);
    await login(tab, app.config.ownerToken, owner(app).id, two);
    await go(one);
    await tab.run(`${card}.querySelectorAll("button.ask-option")[1].click(); return "null"`);
    await tab.sees(pressed("Which database?", "SQLite"), "the answer");
    await go(two);
    await go(one);
    await tab.sees(pressed("Which database?", "SQLite"), "the answer after switching back");
    assert.ok(
        (await savedKeys(tab, owner(app).id)).some((key) =>
            key.endsWith(`ask.${app.approvals.forConversation(one)[0]!.id}`),
        ),
    );
});

test("a send the server turns down keeps the answers", real, async () => {
    const id = await newSession(app);
    const long = "x".repeat(4097);

    await ask(id);
    await login(tab, app.config.ownerToken, owner(app).id, id);
    await tab.sees(`${card} !== null`, "the card");
    await tab.run(`
        const field = ${card}.querySelector("input.ask-other");
        field.value = ${JSON.stringify(long)};
        field.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);
    await tab.sees(
        `${card}.querySelector("input.ask-other").value.length === ${long.length}`,
        "typed",
    );
    await tab.run(
        `${card}.querySelectorAll("fieldset")[1].querySelector("button.ask-option").click(); return "null"`,
    );
    await tab.sees(
        `${card}.querySelector('button[type="submit"]:not(:disabled)')`,
        "ready to send",
    );
    const saved = await savedKeys(tab, owner(app).id);

    await tab.page.click({ selector: 'form.approval.ask button[type="submit"]' });
    await tab.sees(`document.body.textContent.includes("is too long")`, "the server's no");
    await tab.sees(
        `${card}.querySelector('button[type="submit"]:not(:disabled)')`,
        "sendable again",
    );
    assert.deepEqual(await savedKeys(tab, owner(app).id), saved);
    await tab.page.reload();
    await tab.sees(
        `${card}?.querySelector("input.ask-other")?.value.length === ${long.length}`,
        "the typed answer after a reload",
    );
});

test("someone else sees the waiting card, and their browser keeps no answer", real, async () => {
    await ask(first);
    await login(tab, guest.token, guest.user.id, first);
    await tab.sees(
        `document.body.textContent.includes("Waiting for") && ${card}?.querySelector("input, button.ask-option") === null`,
        "waiting, with nothing to answer",
    );
    assert.deepEqual(await savedKeys(tab, guest.user.id), []);
});
