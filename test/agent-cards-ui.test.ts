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
import { FAILED, FINAL, fence, inbox, LABEL, MESSAGE, STOPPED, task } from "./agent-envelopes.ts";
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
    message: linked(MESSAGE, "Can you look at `web/transcript.js`?"),
    stopped: linked(STOPPED, "its run was stopped"),
    failed: linked(FAILED, "Provider error: 529 overloaded"),
    hidden: via(
        "linked session session-gone",
        `${MESSAGE.replaceAll("session-50678d19-1f94-4826-9728-1d6bc782966a", "session-gone")}${fence("Done.")}`,
    ),
    report: `[subagent scout answered, no reply needed] Found it in \`web/ui.js\`.${LABEL("Completed")}`,
    reports:
        "[subagent a failed: Bad request]\n\n[subagent b stalled: no progress for 20m, waiting on bash since 10:02. Its report still comes by itself]",
    task: task("a1b2c3 exited with code 1 after 2m 04s", "one\ntwo\nthree"),
    scheduled: "[scheduled] Check the deploy and tell me if CI is red.",
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
    surface: via(
        "surface s3",
        inbox(
            "A person acted on a card you showed.",
            "",
            "surface-action",
            ' surface="s3" action="delete" from="Tanner"',
            "Selected: 2 rows",
        ),
    ),
    pip: via("PiP", "Please **review** the branch."),
    goal: "[goal] `npm test` still fails (exit code 1, check 2 of 3). The end of its output:\n\n```\nnot ok 4\n```\n\nKeep working until it passes.",
});

test("messages from agents and the app are cards: head, content, footer", real, async () => {
    await page.setViewport(VIEWPORTS.desktop);

    for (const text of Object.values(sent())) {
        await inject(text);
    }

    await page.navigate(`${base}/s/${source}`);
    // The linked session's first run reported by itself (a card), then one card for each of these, two reports in one.
    await see(
        `return JSON.stringify(document.querySelectorAll(".acard").length === ${String(2 + Object.keys(sent()).length)})`,
        "a card for each message",
    );
    const shown = await cards();
    const by = (kind: string, state?: string) =>
        shown.filter((card) => card.kind === kind && (state === undefined || card.state === state));
    const [final] = by("linked", "Final answer").slice(-1);
    const [message] = by("linked", "Message");

    // Nothing the server writes for Pi to read: no preface, no fence, no address, no outcome line.
    // (The first card is the linked session's own first run: the scripted model's answer is an echo of its prompt.)
    for (const card of shown.slice(1)) {
        const all = `${card.head}\n${card.body}\n${card.foot}`;

        assert.doesNotMatch(all, /<linked-session-message>|written by another session's agent/);
        assert.doesNotMatch(all, /session-[0-9a-f-]{8,}/);
        assert.doesNotMatch(all, /Reported outcome \(/);
    }

    // A linked session's final answer: its title, the answer, Open, and the outcome as the footer says it.
    assert.equal(final!.name, "Post-fix review");
    assert.equal(final!.source, "· Linked session");
    assert.equal(final!.open, true);
    assert.match(final!.body, /^Verdict: PASS for 5510f8cb\. Blockers 0\./);
    assert.equal(final!.foot, "Outcome: Unclear Reported by the classifier, not proof Show raw");
    assert.equal(message!.state, "Message");
    assert.match(message!.body, /Can you look at web\/transcript\.js\?/);

    const stopped = by("linked", "Stopped")[0]!;
    const failed = by("linked", "Failed")[0]!;

    assert.equal(stopped.tone, "warn");
    assert.match(stopped.body, /It was stopped before it answered\./);
    assert.equal(failed.tone, "err");
    assert.match(failed.body, /Provider error: 529 overloaded/);

    // A session nobody here can open: no name, no Open.
    const hidden = shown.find((card) => card.name === "A session you cannot open")!;

    assert.equal(hidden.open, false);

    // Subagents: a report with its outcome, and two reports that came together as a card each.
    const report = by("subagent", "Report")[0]!;

    assert.equal(report.name, "scout");
    assert.match(report.body, /Found it in web\/ui\.js\./);
    assert.match(report.foot, /^Outcome: Completed/);
    assert.deepEqual(
        by("subagent").map((card) => [card.name, card.state]),
        [
            ["scout", "Report"],
            ["a", "Failed"],
            ["b", "Stalled"],
        ],
    );

    // A task's end: its code and time in the footer, its command and output in the body.
    const ended = by("background")[0]!;

    assert.equal(ended.name, "Task a1b2c3");
    assert.equal(ended.state, "Task ended");
    assert.equal(ended.tone, "err");
    assert.equal(ended.foot, "Exit code 1 Took 2m 04s Show raw");
    assert.match(ended.body, /seq 1 3[\s\S]*one\ntwo\nthree/);
    assert.doesNotMatch(ended.body, /Read the rest with the background tool/);

    const goal = by("goal")[0]!;

    assert.equal(goal.state, "Check failed");
    assert.match(goal.body, /npm test[\s\S]*not ok 4/);
    assert.doesNotMatch(goal.body, /Keep working/);

    const scheduled = by("scheduled")[0]!;

    assert.deepEqual([scheduled.state, scheduled.name], ["Scheduled", "Pi"]);
    assert.equal(scheduled.body.trim(), "Check the deploy and tell me if CI is red.");

    // From outside: plain text (the Markdown stars stay), the sender by name, whether the owner trusts them.
    const relay = by("relay")[0]!;

    assert.deepEqual(
        [relay.state, relay.name, relay.source],
        ["From Discord", "Fingerthief", "· oswc-bugs"],
    );
    assert.match(relay.body, /The build is \*\*broken\*\* on main\.\n<b>x<\/b>/);
    assert.match(relay.foot, /Sender not marked as trusted/);
    assert.doesNotMatch(relay.body, /A message came in from outside|relay-message/);

    const surface = by("surface")[0]!;

    assert.deepEqual([surface.state, surface.name], ["Card action", "Tanner"]);
    assert.match(surface.foot, /Action: delete/);
    assert.deepEqual(
        [
            by("pip")[0]!.name,
            await inPage(
                `return JSON.stringify(document.querySelectorAll(".acard[data-kind=pip] strong").length)`,
            ),
        ],
        ["PiP", 1],
    );
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
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(
        await inPage<string>(`return JSON.stringify(location.pathname)`),
        `/s/${String(session)}`,
    );
});

test("what a person types is theirs, whatever it starts with", real, async () => {
    const id = await newSession(app);
    const typed = [
        `[via linked session ${address}] ${mine(FINAL)}${fence("my own words")}`,
        "[subagent zed answered, no reply needed] my own report",
        "[via PiP] my own PiP",
        "[background] Task a1b2c3 exited with code 0 after 1s.\nCommand: x\nIt printed nothing.",
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
    // Each is theirs: their name on it, and what they wrote as they wrote it.
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
        `return JSON.stringify(document.querySelectorAll(".acard").length > 10)`,
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
