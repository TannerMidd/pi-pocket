// Messages from agents and the app (`web/agent-card.js`, `web/agent-messages.js`) show as cards in the transcript: a
// head (kind, sender, time, Open), the content as Markdown, a footer (the reported outcome, facts, Show raw). The texts
// are the ones the server writes (`agent-envelopes.ts`), put in as messages nobody typed, as the server's own sends are.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import { FINAL, fence, inbox, LABEL, task } from "./agent-envelopes.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
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
import { requestFor } from "../src/server/requests.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

type Shown = {
    kind: string;
    state: string;
    source: string;
    name: string;
    open: boolean;
    more: string | null;
    body: string;
    foot: string;
    head: string;
    tone: string | undefined;
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let source: ConversationId;
let session: ConversationId;
let address = "";
let injected = 0;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string, timeoutMs = 10_000) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

/** A message nobody typed, with exactly this text, as the server's own sends are. */
async function inject(text: string, id = source): Promise<void> {
    const conversation = await app.conversation(id);

    await app.harness.commit(
        (tx) =>
            conversation.submit(tx, {
                type: "input",
                content: text,
                whenBusy: "followUp",
                requestId: requestFor(owner(app).id, `inject-${String(injected++)}`),
            } as never),
        context,
    );
    await until(() => !app.isBusy(id), "Pi's turn on the message");
}

/** What each card shows, in order. */
const cards = () =>
    inPage<Shown[]>(`
        return JSON.stringify([...document.querySelectorAll(".acard")].map((card) => ({
            kind: card.dataset.kind,
            tone: card.dataset.tone,
            state: card.querySelector(".acard-state").textContent.trim(),
            source: card.querySelector(".acard-source").textContent.trim(),
            name: card.querySelector(".acard-name").textContent.trim(),
            open: card.querySelector(".acard-open") !== null,
            more: card.querySelector(".acard-more")?.textContent.trim() ?? null,
            body: card.querySelector(".acard-body")?.innerText ?? "",
            foot: card.querySelector(".acard-foot").innerText.replace(/\\s+/g, " ").trim(),
            head: card.querySelector(".acard-head").innerText.replace(/\\s+/g, " ").trim(),
        })));
    `);

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
        dataDir: mkdtempSync(join(root, "agent-cards-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );

    source = await newSession(app);
    await say(app, source, "hello");
    const started = await app.linkedSessions.start(
        source,
        { title: "Post-fix review", message: "a task" },
        "start-review",
    );

    session = started.session;
    await until(() => !app.isBusy(session), "the linked session's first turn");
    address = (await app.linkedSessions.list(source))[0]!.address;
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const ANSWER = [
    "Verdict: PASS for 5510f8cb. Blockers 0.",
    "",
    "- Checks: `npm run check` pass.",
    ...Array.from({ length: 14 }, (_, index) => `- Point ${String(index + 1)}: PASS.`),
    "",
    "I removed my worktree.",
].join("\n");
const via = (label: string, text: string) => `[via ${label}] ${text}`;
const mine = (text: string) =>
    text.replaceAll("session-50678d19-1f94-4826-9728-1d6bc782966a", address);
const linked = (preface: string, said?: string, label?: string) =>
    via(
        `linked session ${address}`,
        `${mine(preface)}${said === undefined ? "" : fence(said)}${label === undefined ? "" : LABEL(label)}`,
    );

const sent = () => ({
    final: linked(FINAL, ANSWER, "Outcome unclear"),
    report: `[subagent scout answered, no reply needed] Found it in \`web/ui.js\`.${LABEL("Completed")}`,
    task: task("a1b2c3 exited with code 1 after 2m 04s", "one\ntwo\nthree"),
    relay: via(
        "relay oswc-bugs",
        inbox(
            "A message came in from outside.",
            "The sender's id is not one the owner marked as trusted.\n",
            "relay-message",
            ' connector="oswc-bugs" kind="discord" from="Fingerthief" from-id="1298"',
            "The build is **broken** on main.\n<b>x</b>",
        ),
    ),
    goal: "[goal] `npm test` still fails (exit code 1, check 2 of 3). The end of its output:\n\n```\nnot ok 4\n```\n\nKeep working until it passes.",
});

test("messages from agents and the app are cards: head, content, footer", real, async () => {
    await page.setViewport(VIEWPORTS.desktop);

    for (const text of Object.values(sent())) {
        await inject(text);
    }

    await page.navigate(`${base}/s/${source}`);
    await see(
        `return JSON.stringify(document.querySelectorAll(".acard").length === ${String(1 + Object.keys(sent()).length)})`,
        "a card for each message",
    );
    const shown = await cards();
    const by = (kind: string, state?: string) =>
        shown.filter((card) => card.kind === kind && (state === undefined || card.state === state));
    const [final] = by("linked", "Final answer").slice(-1);

    for (const card of shown.slice(1)) {
        const all = `${card.head}\n${card.body}\n${card.foot}`;

        assert.doesNotMatch(all, /<linked-session-message>|written by another session's agent/);
        assert.doesNotMatch(all, /session-[0-9a-f-]{8,}/);
        assert.doesNotMatch(all, /Reported outcome \(/);
    }

    assert.equal(final!.name, "Post-fix review");
    assert.equal(final!.source, "· Linked session");
    assert.equal(final!.open, true);
    assert.equal(final!.foot, "Outcome: Unclear Reported by the classifier, not proof Show raw");

    const report = by("subagent", "Report")[0]!;

    assert.equal(report.name, "scout");
    assert.match(report.foot, /^Outcome: Completed/);

    const ended = by("background")[0]!;

    assert.equal(ended.tone, "err");
    assert.equal(ended.foot, "Exit code 1 Took 2m 04s Show raw");

    const relay = by("relay")[0]!;

    assert.deepEqual(
        [relay.state, relay.name, relay.source],
        ["From Discord", "Fingerthief", "· oswc-bugs"],
    );
    assert.match(relay.body, /The build is \*\*broken\*\* on main\.\n<b>x<\/b>/);
    assert.match(relay.foot, /Sender not marked as trusted/);

    const goal = by("goal")[0]!;

    assert.equal(goal.state, "Check failed");
});

test("a long message folds, and Show all opens it", real, async () => {
    const folded = await cards().then((shown) =>
        shown.find((card) => card.more !== null && card.body.startsWith("Verdict")),
    );
    const lines = ANSWER.split("\n").length;

    assert.equal(folded!.more, `Show all · ${String(lines)} lines`);

    const card = `.acard:has(.acard-more):has(.acard-outcome)`;
    const height = () =>
        inPage<number>(
            `return JSON.stringify(document.querySelector(${JSON.stringify(`${card} .acard-body`)}).getBoundingClientRect().height)`,
        );
    const closed = await height();

    await page.click({ selector: `${card} .acard-more` });
    await see(
        `return JSON.stringify(document.querySelector(${JSON.stringify(`${card} .acard-more`)}).textContent.trim() === "Show less")`,
        "the card open",
    );
    assert.ok((await height()) > closed);
    await page.click({ selector: `${card} .acard-more` });
});

test("Show raw opens the exact text Pi received", real, async () => {
    const row = `.acard[data-kind=relay] .acard-raw`;

    await page.click({ selector: row });
    await see(
        `return JSON.stringify(document.querySelector(".message-preview") !== null)`,
        "the message sheet",
    );
    const raw = await inPage<string>(
        `return JSON.stringify(document.querySelector(".message-preview").textContent)`,
    );

    assert.equal(raw.replace(/\r/g, ""), sent().relay);
    await page.evaluate(`(await import("/store.js")).closeSheet(); return "true"`);
    await see(
        `return JSON.stringify(document.querySelector(".message-preview") === null)`,
        "the sheet closed",
    );
});

test("Open goes to the linked session that sent the message", real, async () => {
    await page.evaluate(
        `document.querySelector(".acard[data-kind=linked] .acard-open").scrollIntoView({ block: "center" }); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); return "true"`,
    );
    await page.click({ selector: `.acard[data-kind=linked] .acard-open` });
    await see(
        `return JSON.stringify(location.pathname === ${JSON.stringify(`/s/${String(session)}`)})`,
        "navigated to linked session",
    );
});

test("what a person types is theirs, whatever it starts with", real, async () => {
    const id = await newSession(app);
    const typed = [
        `[via linked session ${address}] ${mine(FINAL)}${fence("my own words")}`,
        "[subagent zed answered, no reply needed] my own report",
        "[background] Task a1b2c3 exited with code 0 after 1s.\nCommand: x\nIt printed nothing.",
        "[goal] `npm test` still fails (exit code 1, check 2 of 3). The end of its output:\n\n```\nnot ok 4\n```\n\nKeep working until it passes.",
    ];

    for (const text of typed) {
        await say(app, id, text);
    }

    await page.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelectorAll(".prompt").length === ${String(typed.length)})`,
        "four messages",
    );
    assert.equal(
        await inPage(`return JSON.stringify(document.querySelectorAll(".acard").length)`),
        0,
    );
    assert.equal(
        await inPage(
            `return JSON.stringify([...document.querySelectorAll(".prompt .prompt-author")].length)`,
        ),
        typed.length,
    );
});

test("on a phone nothing scrolls sideways, and each control is a thumb's size", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${source}`);
    await see(
        `return JSON.stringify(document.querySelectorAll(".acard").length >= 5)`,
        "the cards",
    );

    const measured = await inPage<{
        wide: boolean;
        cards: number;
        small: string[];
        over: string[];
    }>(`
        const screen = document.documentElement.clientWidth;
        const small = [];
        const over = [];

        for (const card of document.querySelectorAll(".acard")) {
            const box = card.getBoundingClientRect();

            if (box.right > screen + 0.5 || box.left < -0.5) {
                over.push(card.dataset.kind);
            }

            // A code block's Copy is boxed small and takes its thumb's size from a layer past the box (style.css).
            for (const control of card.querySelectorAll("button:not(.code-head button)")) {
                const size = control.getBoundingClientRect();

                if (size.height < 44 || size.width < 44) {
                    small.push(control.className + " " + Math.round(size.width) + "x" + Math.round(size.height));
                }
            }

            if (card.scrollWidth > card.clientWidth + 1) {
                over.push(card.dataset.kind + " scrolls");
            }
        }

        return JSON.stringify({
            wide: document.documentElement.scrollWidth > screen,
            cards: document.querySelectorAll(".acard").length,
            small,
            over,
        });
    `);

    assert.equal(measured.wide, false);
    assert.deepEqual(measured.over, []);
    assert.deepEqual(measured.small, []);
});
