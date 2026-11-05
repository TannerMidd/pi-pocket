// WP2 through the real app and Chromium, with only the model boundary scripted.
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
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { WP2_KEYS } from "./wp2-locale-keys.ts";

// Every payload equals the English value of an actual catalog key, whose hostile translation is installed below.
const USER = "Close";
const ANSWER = "Close";
const TOOL = "Close";
const CHAT = "Close";
const DRAFT = "Close";
const PERSON = "Close";
const COMMAND = "printf 'Close {name}'";
const TOOL_COMMAND = `printf '%s' '${TOOL}'`;
const READ_ONE = "Read one line";
const READ_TWO = "Read two lines";
const ONE_FILE = join(work, "wp2-one.txt");
const TWO_FILE = join(work, "wp2-two.txt");

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    // The app adds this speaker marker once a guest exists; it is not part of the message typed by a person.
    const written = text.replace(/^\[from: [^\]\n]+\] /, "");

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(ANSWER)]);
    }

    if (written === READ_ONE || written === READ_TWO) {
        return fauxAssistantMessage(
            [fauxToolCall("read", { path: written === READ_ONE ? ONE_FILE : TWO_FILE })],
            {
                stopReason: "toolUse",
            },
        );
    }

    return fauxAssistantMessage([fauxToolCall("bash", { command: TOOL_COMMAND })], {
        stopReason: "toolUse",
    });
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let session: ConversationId;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (expression: string, what: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(Boolean(${expression}))`), what, 20_000);

const switchTo = async (locale: "en" | "zh-CN") => {
    await page.evaluate(`(await import('/ui-locale.js')).setLocale(${JSON.stringify(locale)})`);
    await see(`document.documentElement.lang === ${JSON.stringify(locale)}`, `${locale} selected`);
};

before(async () => {
    assert.ok(findBrowser(), "Chromium is required for WP2 UI acceptance");
    const dropIns = join(root, "data", "extensions");
    const overlay = Object.fromEntries(WP2_KEYS.map(({ key, zh }) => [key, zh]));

    overlay["ui.close"] = "MUTATED-BY-TRANSLATOR";

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(dropIns, "zz-wp2-adversarial.ts"),
        `/** Adversarial same-text catalog for an isolated test. */\nimport { EN } from ${JSON.stringify(new URL("../web/locales/en.js", import.meta.url).href)};\nexport default (_host, web) => web.uiLocales([{ id: "zh-CN", label: "简体中文", messages: { ...Object.fromEntries(Object.entries(EN).filter(([, value]) => value === "Close").map(([key]) => [key, "MUTATED-BY-TRANSLATOR"])), ...${JSON.stringify(overlay)} } }]);\n`,
    );
    writeFileSync(ONE_FILE, "one\n");
    writeFileSync(TWO_FILE, "one\ntwo\n");
    app = await openApp(scriptedModel(route));
    const module = (await app.extensions(owner(app))).modules.find(
        (entry) => entry.file === "zh-cn.ts",
    );

    if (module?.enabled) {
        await app.setExtensionEnabled(owner(app), "zh-cn.ts", false);
    }

    await app.setExtensionEnabled(owner(app), "zz-wp2-adversarial.ts", true);
    session = await newSession(app);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    // The work package does not own EN. Add its proposed keys to this disposable catalog response only.
    server = createServer((request, response) => {
        if (request.method === "GET" && request.url === "/ui-locales.json") {
            const snapshot = app.webs.locales.snapshot();
            const locales = snapshot.locales.map((pack) =>
                pack.id === "zh-CN"
                    ? { ...pack, messages: { ...pack.messages, ...overlay } }
                    : pack,
            );

            response.writeHead(200, {
                "content-type": "application/json",
                "cache-control": "no-store",
            });
            response.end(JSON.stringify({ ...snapshot, locales }));

            return;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "wp2-chromium-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await see(
        `(await import('/store.js')).store.state.connection === 'open' &&
            (await import('/store.js')).store.state.view.conversation?.id === ${Number(session)} &&
            document.querySelector('.composer textarea')`,
        "the isolated session",
    );
    await see(
        `(await import('/ui-locale.js')).languages().some((each) => each.id === 'zh-CN')`,
        "the real Chinese catalog",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("WP2 real UI: language switching preserves sent text, tool output, chat and draft", async () => {
    await switchTo("en");
    await switchTo("zh-CN");
    await page.type({ selector: ".composer textarea" }, USER);
    await page.press("Enter");
    await until(
        async () => {
            const entries = await app.transcripts.allEntries(session, true);

            return (
                !app.isBusy(session) &&
                entries.some((entry) => entry.kind === "toolResult") &&
                entries.some(
                    (entry) =>
                        entry.kind === "assistant" &&
                        entry.blocks.some(
                            (block) => block.type === "text" && block.text === ANSWER,
                        ),
                )
            );
        },
        "the actual model and bash tool finish",
        20_000,
    );
    await see(
        `document.querySelector('[data-part="prompt-text"] .user-text')?.textContent === ${JSON.stringify(USER)} &&
            [...document.querySelectorAll('[data-part="reply"] .md')].some((node) => node.textContent.trim() === ${JSON.stringify(ANSWER)}) &&
            document.querySelector('[data-part="activity"]')`,
        "the user, answer and activity reach the browser",
    );
    await page.evaluate(`
        document.querySelector('[data-part="activity"]:not(.open) .activity-head')?.click();
    `);
    await see(
        `document.querySelector('[data-part="tool-call"][data-status="done"] .step-head')`,
        "the completed bash call",
    );
    await page.evaluate(`document.querySelector('[data-part="tool-call"] .step-head').click()`);
    await see(
        `document.querySelector('[data-part="tool-call"] .step-body .output')`,
        "the tool output is open",
    );
    const stored = await app.transcripts.allEntries(session, true);
    const result = stored.find((entry) => entry.kind === "toolResult");

    assert.equal(result?.text, TOOL, "the real tool result is not translated before rendering");
    assert.equal(
        await inPage(
            `return JSON.stringify((await import('/ui-locale.js')).t('ui.close', 'Close'))`,
        ),
        "MUTATED-BY-TRANSLATOR",
        "the actual Chinese catalog adversarially translates the same English bytes",
    );
    await inPage(
        `await (await import('/store.js')).actions.chat(${JSON.stringify(CHAT)}); return 'null'`,
    );
    await page.evaluate(`(await import('/store.js')).openSheet({ type: 'chat' })`);
    await see(
        `[...document.querySelectorAll('.chat-text')].some((node) => node.textContent === ${JSON.stringify(CHAT)})`,
        "the real side chat message",
    );
    await switchTo("en");
    await see(
        `document.querySelector('.composer .send-button')?.getAttribute('aria-label') === 'Send'`,
        "the English composer redraws",
    );
    await page.type({ selector: ".composer textarea" }, DRAFT);
    await page.evaluate(`
        window.wp2Document = document;
        window.wp2TextArea = document.querySelector('.composer textarea');
        window.wp2TextArea.focus();
        window.wp2TextArea.setSelectionRange(1, 4);
    `);
    const snapshot = () =>
        inPage<{
            lang: string;
            send: string;
            promptTitle: string;
            user: string;
            answer: string;
            tool: string;
            chat: string;
            draft: string;
            sameDocument: boolean;
            sameBox: boolean;
            focused: boolean;
            selection: number[];
        }>(`
        const box = document.querySelector('.composer textarea');
        return JSON.stringify({
            lang: document.documentElement.lang,
            send: document.querySelector('.composer .send-button').getAttribute('aria-label'),
            promptTitle: document.querySelector('[data-part="prompt"]').title,
            user: document.querySelector('[data-part="prompt-text"] .user-text').textContent,
            answer: [...document.querySelectorAll('[data-part="reply"] .md')]
                .find((node) => node.textContent.trim() === ${JSON.stringify(ANSWER)})?.textContent.trim() ?? '',
            tool: document.querySelector('[data-part="tool-call"] .step-body .output')?.textContent ?? '',
            chat: [...document.querySelectorAll('.chat-text')]
                .find((node) => node.textContent === ${JSON.stringify(CHAT)})?.textContent ?? '',
            draft: box.value,
            sameDocument: window.wp2Document === document,
            sameBox: window.wp2TextArea === box,
            focused: document.activeElement === box,
            selection: [box.selectionStart, box.selectionEnd],
        });
    `);

    const checkContents = (shown: Awaited<ReturnType<typeof snapshot>>) => {
        assert.equal(shown.user, USER, "the user's sent text stays literal");
        assert.equal(shown.answer, ANSWER, "the model's answer stays literal");
        assert.equal(shown.tool, TOOL, "the real bash output stays literal");
        assert.equal(shown.chat, CHAT, "the side chat stays literal");
        assert.equal(shown.draft, DRAFT, "the draft stays literal");
        assert.equal(shown.sameDocument, true, "switching does not reload the document");
        assert.equal(shown.sameBox, true, "switching does not replace the message box");
        assert.equal(shown.focused, true, "switching keeps focus");
        assert.deepEqual(shown.selection, [1, 4], "switching keeps the selection");
    };

    const english = await snapshot();

    assert.equal(english.send, "Send");
    assert.equal(english.promptTitle, "Edit, send again, or copy");
    checkContents(english);
    await switchTo("zh-CN");
    await see(
        `document.querySelector('.composer .send-button')?.getAttribute('aria-label') === '发送'`,
        "the Chinese send label",
    );
    const chinese = await snapshot();

    assert.equal(chinese.lang, "zh-CN");
    assert.equal(chinese.send, "发送");
    assert.equal(chinese.promptTitle, "编辑、重新发送或复制");
    checkContents(chinese);
    await switchTo("en");
    await see(
        `document.querySelector('.composer .send-button')?.getAttribute('aria-label') === 'Send'`,
        "the English send label",
    );
    const restored = await snapshot();

    assert.equal(restored.promptTitle, english.promptTitle);
    checkContents(restored);
});

test("WP2 real UI: person names and counts fill translated placeholders literally", async () => {
    await page.evaluate(`(await import('/store.js')).closeSheet()`);
    await switchTo("en");
    const guest = app.config.addUser(PERSON, "guest");
    const guestPage = await browsers.open(2);

    try {
        await guestPage.setViewport(VIEWPORTS.desktop);
        await guestPage.navigate(`${base}/login?token=${encodeURIComponent(guest.token)}`);
        await guestPage.navigate(`${base}/s/${session}`);
        await see(
            `(await import('/store.js')).store.state.presence.some((person) => person.name === ${JSON.stringify(PERSON)})`,
            "the actual guest presence",
        );
        await page.evaluate(`
            window.wp2PeopleDocument = document;
            window.wp2Avatar = document.querySelector('.people-button .avatar');
        `);
        const people = () =>
            inPage<{ label: string; title: string; avatar: boolean; sameDocument: boolean }>(`
            const button = document.querySelector('.people-button');
            return JSON.stringify({ label: button.getAttribute('aria-label'), title: button.title,
                avatar: button.contains(window.wp2Avatar) && window.wp2Avatar !== null,
                sameDocument: document === window.wp2PeopleDocument });
        `);
        const english = await people();

        assert.ok(
            english.label.includes(PERSON),
            "the whole guest name appears in the English label",
        );
        assert.equal(english.title, english.label);
        assert.equal(english.avatar, true, "the avatar VNode produced a real child");
        await switchTo("zh-CN");
        await see(
            `document.querySelector('.people-button')?.getAttribute('aria-label') !== ${JSON.stringify(english.label)}`,
            "the people label changes to Chinese",
        );
        const chinese = await people();

        assert.match(chinese.label, /[\u3400-\u9fff]/u);
        assert.ok(chinese.label.includes(PERSON), "the translated label preserves the entire name");
        assert.equal(chinese.title, chinese.label);
        assert.equal(chinese.avatar, true, "the real avatar child survives the locale redraw");
        assert.equal(chinese.sameDocument, true);
        assert.doesNotMatch(chinese.label, /\{(?:names|who|first|second)\}/);
        await guestPage.type({ selector: ".composer textarea" }, "typing");
        await see(
            `document.querySelector('.typing-line')?.textContent.includes(${JSON.stringify(PERSON)})`,
            "the actual guest is typing",
        );
        const typing = await inPage<string>(
            `return JSON.stringify(document.querySelector('.typing-line').textContent)`,
        );

        assert.match(typing, /[\u3400-\u9fff]/u);
        assert.ok(typing.includes(PERSON));
        assert.doesNotMatch(typing, /\{(?:names|who|first|second)\}/);
        await switchTo("en");
        await see(
            `document.querySelector('.people-button')?.getAttribute('aria-label') === ${JSON.stringify(english.label)}`,
            "the original people label returns",
        );
    } finally {
        await guestPage.close();
    }
});

test("WP2 real UI: goal command VNode and numeric checks survive translation", async () => {
    await switchTo("en");
    await app.commands.setGoal(session, owner(app), COMMAND);
    await app.harness.commit(async (tx) => {
        const { GoalDoc } = await import("../src/server/docs.ts");
        const doc = await tx.doc(GoalDoc, session);

        assert.ok(doc.goal);
        doc.goal.status = "met";
        doc.goal.tries = 2;
    }, context);
    await page.navigate(`${base}/s/${session}`);
    await see(`document.querySelector('.goal-bar .mono')`, "the actual goal VNode");
    const goal = () =>
        inPage<{ text: string; command: string; elements: number; strong: boolean }>(`
        const bar = document.querySelector('.goal-bar');
        const node = bar.querySelector('.mono');
        return JSON.stringify({ text: bar.textContent, command: node?.textContent ?? '',
            elements: bar.querySelectorAll('.mono').length, strong: Boolean(bar.querySelector('strong')) });
    `);
    const english = await goal();

    assert.equal(english.command, COMMAND);
    assert.equal(english.elements, 1);
    assert.equal(english.strong, true);
    assert.ok(english.text.includes("2"));
    assert.ok(english.text.includes("5"));
    assert.ok(english.text.includes("passes (check 2 of 5)."));
    await switchTo("zh-CN");
    await see(
        `document.querySelector('.goal-bar strong')?.textContent.includes('完成')`,
        "the goal label changes to Chinese",
    );
    const chinese = await goal();

    assert.equal(chinese.command, COMMAND, "the user command remains literal");
    assert.equal(chinese.elements, 1, "the htm span is not stringified or lost");
    assert.equal(chinese.strong, true, "the htm strong element remains a node");
    assert.match(chinese.text, /[\u3400-\u9fff]/u);
    assert.ok(chinese.text.includes("2"));
    assert.ok(chinese.text.includes("5"));
    assert.ok(chinese.text.includes("通过（第 2/5 次检查）。"));
    assert.doesNotMatch(chinese.text, /\[object Object\]|\{(?:command|tries|max)\}/);
    await switchTo("en");
    await see(
        `document.querySelector('.goal-bar strong')?.textContent === 'Done:'`,
        "the goal returns to English",
    );
    assert.deepEqual(await goal(), english);
});

test("WP2 real UI: singular and plural read counts redraw with the language", async () => {
    const id = await newSession(app);

    await say(app, id, READ_ONE);
    await page.navigate(`${base}/s/${id}`);
    await see(`document.querySelector('[data-part="activity"]')`, "the one-line read activity");
    await page.evaluate(
        `document.querySelector('[data-part="activity"]:not(.open) .activity-head')?.click()`,
    );
    await see(
        `document.querySelector('[data-part="tool-call"] .step-meta')`,
        "the one-line read outcome",
    );
    const count = () =>
        inPage<string>(
            `return JSON.stringify([...document.querySelectorAll('[data-part="tool-call"] .step-meta')].at(-1)?.textContent.trim())`,
        );

    await switchTo("en");
    await see(
        `document.querySelector('[data-part="tool-call"] .step-meta')?.textContent.trim() === '1 line'`,
        "the English singular",
    );
    assert.equal(await count(), "1 line");
    await switchTo("zh-CN");
    await see(
        `document.querySelector('[data-part="tool-call"] .step-meta')?.textContent.trim() === '1 行'`,
        "the Chinese singular",
    );
    assert.equal(await count(), "1 行");
    const second = await newSession(app);

    await say(app, second, READ_TWO);
    const recorded = await app.transcripts.allEntries(second, true);
    const readCall = recorded
        .flatMap((entry) => (entry.kind === "assistant" ? entry.blocks : []))
        .find((block) => block.type === "toolCall" && block.name === "read");
    const readResult = recorded.find(
        (entry) => entry.kind === "toolResult" && entry.name === "read",
    );

    assert.ok(readCall?.type === "toolCall");
    assert.ok(readResult?.kind === "toolResult");
    assert.equal(readCall?.args?.path, TWO_FILE, "the model requested the real two-line file");
    assert.equal(readResult?.text, "one\ntwo\n", "the real read result has two lines");
    await page.navigate(`${base}/s/${second}`);
    await see(
        `(await import('/store.js')).store.state.view.conversation?.id === ${Number(second)}`,
        "the second session is open",
    );
    await see(`document.querySelector('[data-part="activity"]')`, "the two-line read activity");
    await page.evaluate(
        `document.querySelector('[data-part="activity"]:not(.open) .activity-head')?.click()`,
    );
    await see(
        `document.querySelector('[data-part="tool-call"] .step-meta')`,
        "the two-line read outcome",
    );
    assert.equal(await count(), "2 行");
    await switchTo("en");
    await see(
        `document.querySelector('[data-part="tool-call"] .step-meta')?.textContent.trim() === '2 lines'`,
        "the English plural",
    );
    assert.equal(await count(), "2 lines");
});

test("WP2 real UI: retry countdown keeps spacing and the external error literal", async () => {
    await switchTo("en");
    await page.evaluate(`
        const { store, serverClockOffset } = await import('/store.js');
        store.set({ view: { ...store.state.view, live: {
            ...store.state.view.live, busy: true,
            generation: { attempt: 0, retry: { at: Date.now() + serverClockOffset() + 120000, error: 'Close' } },
        } } });
    `);
    await see(
        `document.querySelector('.live-state span') && document.querySelector('.live-why')`,
        "the retry countdown",
    );
    const live = () =>
        inPage<{ state: string; error: string }>(`
        return JSON.stringify({ state: document.querySelector('.live-state').textContent.trim(),
            error: document.querySelector('.live-why').textContent.trim() });
    `);
    const english = await live();

    assert.match(english.state, /^Retrying in \d+s$/);
    assert.equal(english.error, "Close");
    await switchTo("zh-CN");
    await see(
        `document.querySelector('.live-state')?.textContent.includes('正在重试')`,
        "the translated retry countdown",
    );
    const chinese = await live();

    assert.match(chinese.state, /^正在重试 \d+ 秒后$/);
    assert.equal(chinese.error, "Close");
    await page.evaluate(`
        const { store } = await import('/store.js');
        store.set({ view: { ...store.state.view, live: { busy: false } } });
    `);
});
