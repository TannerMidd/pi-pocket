// The card of an artifact_inline call (#87), in a real Chromium: between the words around it, Preview and Code, Run and
// Stop, the viewer a tap away, the version its call made (an update adds a card and leaves the earlier one), the artifact
// bridge once it runs (a follow-up after a tap; saved state), and the same for a viewer and for someone invited to
// this session alone.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { ArtifactStateDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
/** Where to write screenshots of the card, when asked (for a person to look at). */
const SHOTS = process.env.INLINE_SHOTS;

/** A button that fills the page: a tap anywhere asks for a follow-up. It saves a state of its own when it opens. */
const PAGE = `<!doctype html><html><head><title>Loan</title></head><body style="margin:0">
<button id="go" style="display:block;width:100%;height:120px;font:16px sans-serif">Ask about the loan</button>
<script>
parent.postMessage({ type: "pocket-state-set", requestId: "opened", schema: "v1", state: { opened: true } }, "*");
document.getElementById("go").onclick = () =>
    parent.postMessage({ type: "pocket-follow-up", text: "Explain this loan" }, "*");
</script></body></html>`;

const route: Parameters<typeof scriptedModel>[0] = (context) => {
    const { role, text } = lastText(context as never);

    if (role === "toolResult" && text.includes("no artifact missing")) {
        return fauxAssistantMessage([fauxText("That did not work.")]);
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("Change the rate to see the payment move.")]);
    }

    if (text.includes("show a calculator")) {
        return fauxAssistantMessage(
            [
                fauxText("Here is a loan calculator:"),
                fauxToolCall("artifact_inline", { id: "loan-calc", title: "Loan", content: PAGE }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (text.includes("add a years field")) {
        return fauxAssistantMessage(
            [
                fauxText("Now with years:"),
                fauxToolCall("artifact_inline", {
                    id: "loan-calc",
                    title: "Loan",
                    edits: [
                        { oldText: "Ask about the loan", newText: "Ask about the loan (years)" },
                    ],
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (text.includes("edit a missing page")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("artifact_inline", {
                    id: "missing",
                    title: "Missing",
                    edits: [{ oldText: "a", newText: "b" }],
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
/** The owner's tab: `page` is another person's while they are in. */
let owners: BrowserPage;
let base = "";
let session: ConversationId;
/** What a busy machine (the whole suite at once) may take to draw a card or load a frame. */
const SLOW = 30_000;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const exists = (selector: string) =>
    inPage<boolean>(
        `return JSON.stringify(Boolean(document.querySelector(${JSON.stringify(selector)})))`,
    );

const count = (selector: string) =>
    inPage<number>(
        `return JSON.stringify(document.querySelectorAll(${JSON.stringify(selector)}).length)`,
    );

const waitFor = (selector: string, what = selector) => until(() => exists(selector), what, SLOW);

const boxText = () =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(".composer textarea")?.value ?? "")`,
    );

/** Tap the middle of an element, as a person does: a frame takes the focus, and its page the click. */
async function tap(selector: string) {
    const box = await inPage<{ x: number; y: number }>(`
        const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    `);

    await page.click({ x: Math.round(box.x), y: Math.round(box.y) });
}

/** The text of the buttons in the nth card's bar. */
const bar = (nth: number) =>
    inPage<string[]>(`
        const card = document.querySelectorAll(".inline-artifact")[${nth}];
        return JSON.stringify([...card.querySelectorAll(".code-head button")].map((each) => each.textContent.trim()));
    `);

/** Tap a button in the nth card's bar by its words. */
async function press(nth: number, words: string) {
    await inPage(`
        const card = document.querySelectorAll(".inline-artifact")[${nth}];
        [...card.querySelectorAll(".code-head button")].find((each) => each.textContent.trim() === ${JSON.stringify(words)}).click();
        return "null";
    `);
}

async function shot(name: string) {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    const { data } = await page.screenshot();

    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from(data, "base64"));
}

/** A browser signed in as `token`, on this session, with its card drawn. */
async function signedIn(token: string) {
    const theirs = new Browsers({
        dataDir: mkdtempSync(join(root, "artifact-inline-guest-")),
        load: async () => undefined,
        save: () => {},
    });

    page = await theirs.open(1);
    await page.setViewport({ width: 1100, height: 800, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
    await page.navigate(`${base}/s/${session}`);
    await waitFor(".inline-artifact .html-preview", "their card's preview");

    return theirs;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(route));
    session = await newSession(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "artifact-inline-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = owners = await browsers.open(1);
    await page.setViewport({ width: 1100, height: 800, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await waitFor(".composer textarea", "the message box");
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the card sits between the words around it, previewing the page with nothing running",
    real,
    async () => {
        await say(app, session, "show a calculator");
        await waitFor(".inline-artifact .html-preview", "the card's preview");

        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(/Change the rate/.test(document.querySelector(".inline-row")?.nextElementSibling?.textContent ?? ""))`,
                ),
            "the words after the card",
            SLOW,
        );

        const around = await inPage<{ before: string; after: string }>(`
        const row = document.querySelector(".inline-row");
        return JSON.stringify({
            before: row.previousElementSibling?.textContent ?? "",
            after: row.nextElementSibling?.textContent ?? "",
        });
    `);

        assert.match(around.before, /Here is a loan calculator:/);
        assert.match(around.after, /Change the rate/);
        assert.deepEqual(await bar(0), ["Preview", "Code", "▶ Run", "Open", "Copy"]);
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".inline-artifact .code-lang").textContent.trim())`,
            ),
            /Loan · v1/,
        );
        assert.equal(
            await exists(".inline-artifact iframe.run-frame"),
            false,
            "nothing runs before a tap",
        );
        assert.equal(
            await inPage<boolean>(`
            const frame = document.querySelector(".inline-artifact iframe.html-preview");
            return JSON.stringify(!frame.sandbox.contains("allow-scripts") && !frame.srcdoc.includes("<script"));
        `),
            true,
            "the preview has no scripts",
        );
        await shot("desktop-preview");
    },
);

test(
    "Code shows the page's source; Run runs it in the artifact's sandbox; Stop ends it",
    real,
    async () => {
        await press(0, "Code");
        await waitFor(".inline-artifact pre code", "the source");
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".inline-artifact pre").textContent)`,
            ),
            /Ask about the loan/,
        );
        await press(0, "Preview");
        await press(0, "▶ Run");
        await waitFor(".inline-artifact iframe.run-frame", "the running frame");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".inline-artifact iframe.run-frame").getAttribute("sandbox"))`,
            ),
            "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads",
            "the same sandbox as an artifact's, with no same-origin",
        );
        assert.equal(await exists(".inline-artifact iframe.html-preview"), false);
        await until(
            async () =>
                (await inPage<number>(
                    `return JSON.stringify(document.querySelector(".inline-artifact iframe.run-frame").offsetHeight)`,
                )) <= 140,
            "the frame fitted to its page",
            SLOW,
        );
        await shot("desktop-running");
        assert.ok((await bar(0)).includes("■ Stop"));
        await press(0, "■ Stop");
        await waitFor(".inline-artifact iframe.html-preview", "the preview again");
        assert.equal(await exists(".inline-artifact iframe.run-frame"), false);
    },
);

test(
    "a running card gets the artifact bridge: saved state under its id, and a follow-up after a tap",
    real,
    async () => {
        await press(0, "▶ Run");
        await waitFor(".inline-artifact iframe.run-frame");
        const saved = async () =>
            (await app.harness.snapshot(ArtifactStateDoc, session, context))?.items["loan-calc"]?.[
                owner(app).id
            ]?.value;

        await until(async () => (await saved()) !== undefined, "the page's saved state", SLOW);
        assert.deepEqual(await saved(), { opened: true });
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(await boxText(), "", "nothing before a tap");
        await tap(".inline-artifact iframe.run-frame");
        await until(
            async () => (await boxText()).includes("Explain this loan"),
            "the follow-up",
            SLOW,
        );
        assert.equal(await boxText(), "From the artifact “Loan”:\nExplain this loan");
        assert.equal(
            (await app.transcripts.allEntries(session, false)).filter(
                (entry) => entry.kind === "user",
            ).length,
            1,
            "nothing was sent",
        );
        await press(0, "■ Stop");
    },
);

test("an update adds a card; the earlier card keeps its version", real, async () => {
    await say(app, session, "add a years field");
    await until(async () => (await count(".inline-artifact")) === 2, "the second card", SLOW);
    await until(
        async () => (await count(".inline-artifact .html-preview")) === 2,
        "both previews",
        SLOW,
    );
    const heads = await inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".inline-artifact .code-lang")].map((each) => each.textContent.trim()))`,
    );

    assert.deepEqual(heads, ["Loan · v1", "Loan · v2"]);

    for (const [nth, text] of [
        [0, "Ask about the loan"],
        [1, "Ask about the loan (years)"],
    ] as const) {
        await press(nth, "Code");
        await until(
            async () =>
                await inPage<boolean>(`
                    const code = document.querySelectorAll(".inline-artifact")[${nth}].querySelector("pre");
                    return JSON.stringify(Boolean(code) && code.textContent.includes(${JSON.stringify(text)}) && ${nth === 0 ? "!code.textContent.includes('(years)')" : "true"});
                `),
            `card ${nth + 1}'s own source`,
            SLOW,
        );
        await press(nth, "Preview");
    }

    await shot("desktop-two-cards");
});

test("Open shows the viewer at the card's version", real, async () => {
    await press(0, "Open");
    await waitFor(".viewer iframe", "the viewer");
    assert.match(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".viewer iframe").getAttribute("src"))`,
        ),
        new RegExp(`/a/${session}/loan-calc/1$`),
        "the first card opens version 1",
    );
    assert.match(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".viewer-title").textContent)`,
        ),
        /version 1.*latest is v2/s,
    );
    await inPage(`const { closeSheet } = await import("/store.js"); closeSheet(); return "null";`);
});

test("after a reload the cards come back with their versions", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () => (await count(".inline-artifact .html-preview")) === 2,
        "both cards",
        SLOW,
    );
    assert.deepEqual(
        await inPage<string[]>(
            `return JSON.stringify([...document.querySelectorAll(".inline-artifact .code-lang")].map((each) => each.textContent.trim()))`,
        ),
        ["Loan · v1", "Loan · v2"],
    );
});

test("on a phone the card fits the screen", real, async () => {
    await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () => (await count(".inline-artifact .html-preview")) === 2,
        "both cards",
        SLOW,
    );
    const over = await inPage<number>(`
        const root = document.documentElement;
        const card = document.querySelector(".inline-artifact");
        const head = card.querySelector(".code-head");
        return JSON.stringify(Math.max(root.scrollWidth - root.clientWidth, head.scrollWidth - head.clientWidth, card.scrollWidth - card.clientWidth));
    `);

    assert.ok(over <= 0, `nothing sticks out of the card or the page (${over}px)`);
    await inPage(
        `document.querySelector(".inline-artifact").scrollIntoView({ block: "center" }); return "null";`,
    );
    await shot("mobile-preview");
    await press(0, "▶ Run");
    await waitFor(".inline-artifact iframe.run-frame");
    await shot("mobile-running");
    await press(0, "■ Stop");
});

test("a viewer sees the card and can run it; they get a notice for a follow-up", real, async () => {
    const viewer = app.config.addUser("Vee", "viewer");
    const theirs = await signedIn(viewer.token);

    try {
        await press(0, "▶ Run");
        await waitFor(".inline-artifact iframe.run-frame", "their running frame");
        await new Promise((resolve) => setTimeout(resolve, 800));
        await tap(".inline-artifact iframe.run-frame");
        await until(
            async () =>
                await inPage<boolean>(`
                    const { store } = await import("/store.js");
                    return JSON.stringify(store.state.notices.some((each) => each.message.includes("you can only view here")));
                `),
            "the notice",
            SLOW,
        );
    } finally {
        await theirs.closeAll({ final: true });
        page = owners;
        app.config.removeUser(viewer.user.id);
    }
});

test("someone invited to this session alone sees the card and its source", real, async () => {
    const guest = app.config.addUser("Ivy", "guest", [String(session)]);
    const theirs = await signedIn(guest.token);

    try {
        assert.equal(await count(".inline-artifact .html-preview"), 2);
        await press(1, "Code");
        await waitFor(".inline-artifact pre code", "their source");
        await press(1, "Preview");
        await press(1, "▶ Run");
        await waitFor(".inline-artifact iframe.run-frame", "their running frame");
    } finally {
        await theirs.closeAll({ final: true });
        page = owners;
        app.config.removeUser(guest.user.id);
    }
});

test("a call that failed shows its step and its reason, not a card", real, async () => {
    await page.setViewport({ width: 1100, height: 800, scale: 1, mobile: false });
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () => (await count(".inline-artifact .html-preview")) === 2,
        "both cards",
        SLOW,
    );
    await say(app, session, "edit a missing page");
    await waitFor(`.inline-row .step[data-status="error"]`, "the failed step");
    assert.equal(await count(".inline-artifact"), 2, "no third card");
    await inPage(`document.querySelector(".inline-row .step-head").click(); return "null";`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".inline-row .step-body")?.textContent.includes("no artifact missing") ?? false)`,
            ),
        "the reason",
        SLOW,
    );
});

test(
    "a preview of a page with an inline SVG or image has no scrollbar of its own",
    real,
    async () => {
        await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
        await page.navigate(`${base}/s/${session}`);
        await waitFor(".composer textarea", "the message box");

        const sizes = await inPage<{ page: number; frame: number }>(`
        const { render } = await import("preact");
        const { html } = await import("/ui.js");
        const { HtmlPreview } = await import("/rich.js");
        const host = document.createElement("div");
        document.body.append(host);
        render(
            html\`<\${HtmlPreview}
                source=\${'<!doctype html><body style="margin:8px"><svg width="300" height="200"><rect width="300" height="200"/></svg></body>'}
            />\`,
            host,
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
        const frame = host.querySelector("iframe");
        return JSON.stringify({
            page: frame.contentDocument.documentElement.scrollHeight,
            frame: frame.clientHeight,
        });
    `);

        assert.ok(
            sizes.frame >= sizes.page,
            `the frame (${sizes.frame}) shows all its page (${sizes.page})`,
        );
    },
);
