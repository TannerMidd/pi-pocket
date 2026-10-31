import {
    type App,
    cleanUp,
    context,
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
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";
import type { ApprovalAnswer } from "../src/server/host.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** "fail now" ends the run in an error that is not a wait for a limit; the rest is echoed. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    return role === "user" && text.endsWith("fail now")
        ? fauxAssistantMessage([], {
              stopReason: "error",
              errorMessage: "Invalid request: unsupported parameter",
          })
        : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let calls = 0;

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
        dataDir: mkdtempSync(join(root, "priority-ui-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".sidebar .session-tabs") !== null)`,
            ),
        "the session list",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

function ask(id: ConversationId, subject: string, createdAt: number): Promise<ApprovalAnswer> {
    return app.approvals.request(
        {
            id: `priority-ui-${++calls}`,
            conversationId: id,
            taskId: calls as never,
            callId: `call-${calls}`,
            tool: "bash",
            subject,
            reason: "Publishes to a package registry",
            createdAt,
        },
        context,
    );
}

const group = (name: string) => `.sidebar [data-group="${name}"]`;
const rowIn = (name: string, id: ConversationId) => `${group(name)} .session-row[data-id="${id}"]`;

const exists = (selector: string) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
    );

const click = (selector: string) =>
    page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

const text = (selector: string) =>
    inPage<string | null>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null)`,
    );

const present = (selector: string, what: string) => until(() => exists(selector), what);

const gone = (selector: string, what: string) => until(async () => !(await exists(selector)), what);

const idsIn = (name: string) =>
    inPage<number[]>(
        `return JSON.stringify([...document.querySelectorAll(${JSON.stringify(`${group(name)} .session-row`)})].map((row) => Number(row.dataset.id)))`,
    );

test(
    "a browser that kept no choice starts on Recent, with Priority first and Archived an icon",
    real,
    async () => {
        const tabs = await inPage<{ name: string; label: string | null; selected: boolean }[]>(`
        return JSON.stringify([...document.querySelectorAll(".sidebar .session-tabs [role=tab]")].map((tab) => ({
            name: tab.dataset.tab,
            label: tab.getAttribute("aria-label"),
            selected: tab.getAttribute("aria-selected") === "true",
        })));
    `);

        assert.deepEqual(
            tabs.map((tab) => tab.name),
            ["priority", "recent", "folders", "archived"],
        );
        assert.equal(tabs.find((tab) => tab.selected)?.name, "recent");
        assert.equal(tabs.find((tab) => tab.name === "archived")?.label, "Archived");
    },
);

test("calls wait in Needs you, oldest first, and are answered in their rows", real, async () => {
    const short = await newSession(app);
    const long = await newSession(app);
    const quiet = await newSession(app);
    const shortAnswer = ask(short, "npm publish --tag beta", 1_000);
    const longAnswer = ask(long, `echo ${"a very long command ".repeat(10)}`, 2_000);

    await until(async () => (await text(".sidebar .rail-count.attn")) === "2", "the rail's count");
    await click('.sidebar .session-tabs [data-tab="priority"]');
    await present(group("needs"), "Needs you");
    assert.deepEqual(await idsIn("needs"), [Number(short), Number(long)]);
    assert.equal(await text('.sidebar [data-tab="priority"] .tab-count'), "2");
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(${JSON.stringify(group("quiet"))}).classList.contains("closed") ? "folded" : "open")`,
        ),
        "folded",
        "Quiet starts folded",
    );
    assert.ok(await exists(rowIn("quiet", quiet)));

    await click(`${rowIn("needs", short)} [data-review]`);
    await present(`${rowIn("needs", short)} .need-ask`, "the call");
    assert.match(
        (await text(`${rowIn("needs", short)} .need-command`)) ?? "",
        /npm publish --tag beta/,
    );
    assert.ok(await exists(`${rowIn("needs", short)} [data-part="session-allow"]`));
    await click(`${rowIn("needs", short)} [data-part="session-allow"]`);
    assert.deepEqual(await shortAnswer, { allow: true, by: "Owner" });

    await present(`${rowIn("needs", long)} .need-ask`, "the next call");
    assert.equal(await exists(`${rowIn("needs", long)} [data-part="session-allow"]`), false);
    assert.ok(await exists(`${rowIn("needs", long)} [data-part="session-ask-open"]`));
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(document.activeElement?.dataset.review === ${JSON.stringify(String(long))})`,
            ),
        "the focus on its Review",
    );
    await click(`${rowIn("needs", long)} [data-part="session-deny"]`);
    assert.equal((await longAnswer).allow, false);

    await present(".sidebar .priority-clear", "the empty line");
    assert.equal(await text(".sidebar .priority-clear"), "Nothing needs you");
    await gone(".sidebar .rail-count.attn", "the rail's count");
});

test("a failed run is dismissed from its row, and goes quiet", real, async () => {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "fail now", requestId: "priority-fail" });
    await present(
        `${rowIn("needs", id)} [data-part="session-dismiss"]`,
        "the failure in Needs you",
    );
    assert.match(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(${JSON.stringify(`${rowIn("needs", id)} [data-part="session-dismiss"]`)}).title)`,
        ),
        /^Dismiss: Run failed: Invalid request/,
    );
    await click(`${rowIn("needs", id)} [data-part="session-dismiss"]`);
    await gone(rowIn("needs", id), "the row, out of Needs you");
    assert.ok(await exists(rowIn("quiet", id)), "it is quiet");
});

test(
    "the open session stays in its group while it is read, and moves when another opens",
    real,
    async () => {
        const mine = await newSession(app);
        const other = await newSession(app);

        await page.evaluate(`
        const { setUnread } = await import("/store.js");

        setUnread(${Number(mine)}, true);
    `);
        await present(rowIn("ready", mine), "the session to read");
        await click(`${rowIn("ready", mine)} > .session`);
        await until(
            async () =>
                (await inPage<string>(`return JSON.stringify(location.pathname)`)) === `/s/${mine}`,
            "the session open",
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.ok(await exists(rowIn("ready", mine)), "still in Ready to read while open");
        await page.evaluate(`
        const { navigate } = await import("/store.js");

        navigate(${Number(other)});
    `);
        await present(rowIn("quiet", mine), "Quiet, once another is open");
        assert.equal(await exists(rowIn("ready", mine)), false);
    },
);

test("a row answers only the call it shows, not one that took its place", real, async () => {
    const id = await newSession(app);
    const answer = ask(id, "npm publish --tag next", 3_000);
    const allow = `${rowIn("needs", id)} [data-part="session-allow"]`;

    await click('.sidebar .session-tabs [data-tab="priority"]');
    await present(`${rowIn("needs", id)} [data-review]`, "its Review");
    await click(`${rowIn("needs", id)} [data-review]`);
    await present(allow, "its Allow");
    // The list hears of another call in its place before the row draws again: the tap answers neither.
    await page.evaluate(`
        const { store } = await import("/store.js");
        const button = document.querySelector(${JSON.stringify(allow)});

        store.set((state) => ({
            sessions: state.sessions.map((session) =>
                session.id === ${Number(id)}
                    ? { ...session, approval: { ...session.approval, id: "priority-ui-in-its-place" } }
                    : session,
            ),
        }));
        button.click();
    `);
    await until(
        () =>
            inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(store.state.notices.some((each) => /answered elsewhere/.test(each.message)));
            `),
        "the notice that it was not answered",
    );

    const waiting = app.approvals.all().find((each) => each.conversationId === id);

    assert.ok(waiting, "the call it showed still waits");
    app.approvals.answer(waiting.id, { allow: false, by: "test" });
    assert.equal((await answer).allow, false);
});

test("Undo after Mark all read leaves a session read since as it is", real, async () => {
    const first = await newSession(app);
    const second = await newSession(app);

    await click('.sidebar .session-tabs [data-tab="priority"]');
    await page.evaluate(`
        const { setUnread } = await import("/store.js");

        setUnread(${Number(first)}, true);
        setUnread(${Number(second)}, true);
    `);
    await present(rowIn("ready", first), "the first to read");
    await present(rowIn("ready", second), "the second to read");
    await click(`${group("ready")} [data-part="session-group-action"]`);
    await gone(rowIn("ready", first), "the first, read");
    await gone(rowIn("ready", second), "the second, read");
    // The second is looked at again later (in another tab, say): Undo must not make it unread.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await page.evaluate(`
        const { markSeen } = await import("/seen.js");
        const { store } = await import("/store.js");

        markSeen(${Number(second)});
        store.state.notices.findLast((each) => /^Marked \\d+ read/.test(each.message)).action();
    `);
    await present(rowIn("ready", first), "the first, to read again");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await exists(rowIn("ready", second)), false, "the second stays read");
});

test("an open session that gets a call and has it answered leaves Needs you", real, async () => {
    const id = await newSession(app);

    await click('.sidebar .session-tabs [data-tab="priority"]');
    await app.commands.submit(id, owner(app), { text: "fail now", requestId: "priority-held" });
    await present(`${rowIn("needs", id)} [data-part="session-dismiss"]`, "the failure");
    await page.evaluate(`
        const { navigate } = await import("/store.js");

        navigate(${Number(id)});
    `);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(await exists(rowIn("needs", id)), "still in Needs you while open");

    const answer = ask(id, "npm run build", 4_000);

    await present(`${rowIn("needs", id)} [data-review]`, "its Review");

    const waiting = app.approvals.all().find((each) => each.conversationId === id);

    assert.ok(waiting);
    app.approvals.answer(waiting.id, { allow: false, by: "test" });
    await answer;
    await gone(rowIn("needs", id), "the row, out of Needs you");
});
