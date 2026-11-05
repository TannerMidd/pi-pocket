// A Pi asks card keeps its unsent answers per person (`web/person-storage.js`) until it goes.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
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
import type { TaskId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
};
const choices = [{ label: "Postgres" }, { label: "SQLite" }];
const fields = [
    { name: "db", label: "Which database?", choices, other: true },
    { name: "parts", label: "Which parts?", choices, multiple: true },
    { name: "user", label: "User" },
    { name: "password", label: "Password", secret: true },
];
const store = `(await import("/store.js"))`;
const card = `document.querySelector("form.approval.ask")`;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const sees = (expression: string) =>
    until(
        () => inPage<boolean>(`return JSON.stringify(${expression})`).catch(() => false),
        expression,
    );
// The options chosen and the boxes' text, in the card's order.
const SHOWN = `return JSON.stringify([...${card}.querySelectorAll("[aria-pressed=true], input")]
    .map((each) => (each.tagName === "INPUT" ? each.value : each.textContent.trim())))`;
const shown = () => inPage<string[]>(SHOWN);
let key = "";
const saved = () => inPage<string | null>(`return JSON.stringify(localStorage.getItem(${key}))`);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
    base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "ask-answers-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await sees(`document.readyState === "complete" && ${store}.store.state.me?.id !== undefined`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("answers outlive a switch, a reload, and a refused send, but not the card", real, async () => {
    const id = await newSession(app);
    const other = await newSession(app);
    const form = { title: "Set up", fields, submit: "Send" };
    const request = { id: "ask-1", conversationId: id, taskId: 1 as unknown as TaskId };
    const ask = (createdAt: number, callId?: string) =>
        void app.approvals.request(
            { ...request, tool: "ask", subject: "Set up", reason: "", createdAt, form, callId },
            context,
        );
    const first = Date.now();
    // A secret is not kept: it is typed again.
    const answers = ["MySQL", "Postgres", "SQLite", "ann", ""];

    key = `"pocket.person." + encodeURIComponent(${store}.store.state.me.id) + ":ask.${id}"`;
    // A session with a message: the view the tab keeps of it on a switch lists its card.
    await say(app, id, "Hello");
    ask(first);
    await page.navigate(`${base}/s/${id}`);
    await sees(`${card} !== null`);
    await page.type({ selector: ".ask-other" }, "MySQL");
    await page.click({ selector: "fieldset:nth-of-type(2) .ask-option:nth-child(1)" });
    await page.click({ selector: "fieldset:nth-of-type(2) .ask-option:nth-child(2)" });
    await page.type({ selector: "input[name=user]" }, "ann");
    await page.type({ selector: "input[name=password]" }, "hunter2");
    assert.match((await saved())!, /MySQL.*ann/);
    assert.doesNotMatch((await saved())!, /hunter2/);

    await page.evaluate(`${store}.navigate(${other})`);
    await sees(`${card} === null`);
    // Preact runs the card's clean-up after the next paint: the answers outlast it.
    await page.evaluate(`await new Promise((done) => setTimeout(done, 200))`);
    assert.notEqual(await saved(), null);
    await page.evaluate(`${store}.navigate(${id})`);
    await sees(`${card} !== null`);
    assert.deepEqual(await shown(), answers);
    await page.reload();
    await sees(`${card} !== null`);
    assert.deepEqual(await shown(), answers);

    await page.type({ selector: "input[name=password]" }, "hunter2");
    await page.type({ selector: "input[name=user]" }, "x".repeat(4097));
    await page.click({ selector: 'form.ask button[type="submit"]' });
    await sees(`document.body.textContent.includes("User is too long")`);
    assert.match((await saved())!, /x{4097}/);

    // One that no longer fits the form goes, rather than breaking the card.
    await page.evaluate(`localStorage.setItem(${key}, '{"ask-1@${first}": {}}')`);
    await page.reload();
    await sees(`${card} !== null`);
    assert.deepEqual(await shown(), ["", "", ""]);
    assert.equal(await saved(), null);

    await page.type({ selector: "input[name=user]" }, "ann");
    assert.notEqual(await saved(), null);
    app.approvals.answer("ask-1", { allow: false, by: "Someone else" });
    await until(async () => (await saved()) === null, "the answers gone");

    // It ends while another session shows: a later ask with its id does not get its answers, and
    // they go. What another tab typed for the later one stays, though this tab first shows the
    // session as it kept it, with the ask that ended.
    ask(first + 1);
    await sees(`${card} !== null`);
    await page.type({ selector: "input[name=user]" }, "ann");
    await page.evaluate(`${store}.navigate(${other})`);
    await sees(`${card} === null`);
    app.approvals.answer("ask-1", { allow: false, by: "Someone else" });
    ask(first + 2);
    const none = { picked: [], other: "" };
    const theirs = { db: none, parts: none, user: "cy", password: "" };
    const typed = JSON.stringify({ [`ask-1@${first + 2}`]: theirs });

    await page.evaluate(`localStorage.setItem(${key}, ${JSON.stringify(typed)})`);
    await page.evaluate(`${store}.navigate(${id})`);
    await until(
        async () => (await shown().catch(() => [])).join() === ",cy,",
        "the other tab's answers",
    );
    assert.equal(await saved(), typed, "the ended ask's went");

    // The same call asks again, later, as after a restart: what was typed stays.
    ask(first + 3, "call-1");
    await until(async () => (await shown().catch(() => [])).join() === ",,", "another ask, empty");
    // It rises in: typed into once it stands still.
    await sees(`document.getAnimations().every((each) => each.playState !== "running")`);
    await page.type({ selector: "input[name=user]" }, "bob");
    ask(first + 4, "call-1");
    await sees(`${store}.store.state.view.approvals[0]?.createdAt === ${first + 4}`);
    assert.deepEqual(await shown(), ["", "bob", ""]);
    await page.reload();
    await sees(`${card} !== null`);
    assert.deepEqual(await shown(), ["", "bob", ""]);
});
