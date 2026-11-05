// WP3 in a real app and Chromium. The network boundary supplies a temporary catalog only.
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
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const title = "Title <img src=x onerror=window.wp3Injected=1> {count}";
const name = "Name<img>{other}";
const fileName = "wp3 <literal> {count}.html";
const file = join(work, fileName);
const pageText = "USER PAGE <b>kept</b> {count}";
const userText = "USER_MESSAGE <img src=x> {title}";
const submitted: string[] = [];
const gapDiff =
    "diff --git a/wp3-gap.txt b/wp3-gap.txt\n--- a/wp3-gap.txt\n+++ b/wp3-gap.txt\n@@ -3,1 +3,1 @@\n-old first\n+new first\n@@ -10,1 +10,1 @@\n-old second\n+new second\n";
let mockChanges = false;
const messages = {
    "web.peeks.render.title.open": "打开【{title}】",
    "web.pip.pip-unavailable.pi-p-not-available": "PiP 当前不可用",
    "web.pip.ask-pip-from.reason.sending-needs-click-key": "发送前需要点击或按键",
    "web.linked-sessions.linked-sessions.text.started": "起自【{title}】",
    "web.linked-sessions.linked-sessions.text.linked-session": "关联【{title}】",
    "web.linked-sessions.linked-sessions.button.more": "还有{count}项",
    "web.linked-sessions.linked-sessions.link.new-session": "新会话",
    "web.rich.html-preview.text.preview": "预览页",
    "web.run-frame.run-frame.text.preview": "运行预览页",
    "web.rich.rich-block.button.preview": "预览",
    "web.rich.rich-block.button.run": "▶ 运行",
    "web.rich.rich-block.button.stop": "■ 停止",
    "web.pip.welcome.p.hi-i-m-pi-p": "你好{detail}，我是 PiP。",
    "web.pip.suggestions.needs-me": "有什么需要我？",
    "web.pip.suggestions.start-session": "启动一个会话来……",
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let background: ConversationId;
let peekSession: ConversationId;
let pip: ConversationId;
let base = "";

async function value<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (expression: string, what: string, timeout = 20_000) =>
    until(() => value<boolean>(`return JSON.stringify(Boolean(${expression}))`), what, timeout);

async function setLocale(id: "en" | "zh-CN"): Promise<void> {
    await page.evaluate(`(await import('/ui-locale.js')).setLocale(${JSON.stringify(id)})`);
    await see(`document.documentElement.lang === ${JSON.stringify(id)}`, `${id} is selected`);
}

before(async () => {
    assert.ok(findBrowser(), "Chromium is required; WP3 UI tests must not skip");
    mkdirSync(work, { recursive: true });
    writeFileSync(file, `<p>${pageText}</p>`);
    app = await openApp(
        scriptedModel((request) => {
            const text = lastText(request as never).text;

            submitted.push(text);

            return fauxAssistantMessage([fauxText(`MODEL_REPLY ${text}`)]);
        }),
    );
    app.config.updateUser(owner(app).id, { name });

    app.watches.gh = async () => {
        throw new Error("No GitHub in WP3 UI tests");
    };

    background = await newSession(app);
    peekSession = await newSession(app);
    await app.commands.updateSession(peekSession, owner(app), { title });
    pip = await app.pip.ensure(owner(app));
    await app.commands.configure(pip, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (request.url === "/ui-locales.json") {
            response.writeHead(200, {
                "content-type": "application/json",
                "cache-control": "no-store",
            });
            response.end(
                JSON.stringify({
                    revision: 42,
                    locales: [{ id: "zh-CN", label: "测试中文", messages }],
                }),
            );

            return;
        }

        if (mockChanges && request.url?.startsWith(`/api/c/${background}/changes`)) {
            if (request.url.includes("/diff?")) {
                response.writeHead(200, { "content-type": "text/plain" });
                response.end(gapDiff);
            } else {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        repo: { root: work, branch: "test" },
                        files: [{ path: "wp3-gap.txt", kind: "modified", added: 2, removed: 2 }],
                        piOnly: [],
                        more: 0,
                    }),
                );
            }

            return;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "wp3-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${background}`);
    await see(`document.querySelector('.composer textarea')`, "the real session");
    await see(
        `(await import('/ui-locale.js')).languages().some((each) => each.id === 'zh-CN')`,
        "the test catalog",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("linked sessions redraw with named values and preserve titles", async () => {
    await page.evaluate(`
        const { h, render } = await import('/vendor/preact.mjs');
        const { LinkedSessions } = await import('/linked-sessions.js');
        const { store } = await import('/store.js');
        const parent = document.createElement('div');
        parent.id = 'wp3-linked-fixture';
        document.body.append(parent);
        const current = 700001;
        store.set({ conversationId: current, sessionsLoaded: true, sessions: [
            { id: current },
            { id: current + 1, linkedFrom: { id: current }, title: ${JSON.stringify(title)} },
            ...[2, 3, 4, 5].map((n) => ({ id: current + n, linkedFrom: { id: current }, title: 'Child ' + n })),
        ] });
        window.wp3DrawLinks = () => render(h(LinkedSessions), parent);
        window.wp3DrawLinks();
    `);
    await see(`document.querySelector('#wp3-linked-fixture .breadcrumb')`, "linked sessions");
    const first = () =>
        value<string>(
            `return JSON.stringify(document.querySelector('#wp3-linked-fixture .breadcrumb').textContent.trim())`,
        );
    const more = () =>
        value<string>(
            `return JSON.stringify([...document.querySelectorAll('#wp3-linked-fixture .breadcrumb')].at(-1).textContent.trim())`,
        );

    assert.equal(await first(), `Linked session: ${title}`);
    assert.equal(await more(), "+2 more");
    await setLocale("zh-CN");
    await page.evaluate("window.wp3DrawLinks()");
    await see(
        `document.querySelector('#wp3-linked-fixture .breadcrumb')?.textContent.includes('关联【')`,
        "translated link",
    );
    assert.equal(await first(), `关联【${title}】`);
    assert.equal(await more(), "还有2项");
    assert.equal(
        await value<boolean>(
            `return JSON.stringify(window.wp3Injected === undefined && !document.querySelector('#wp3-linked-fixture img'))`,
        ),
        true,
    );
    await setLocale("en");
    await page.evaluate("window.wp3DrawLinks()");
    await see(
        `document.querySelector('#wp3-linked-fixture .breadcrumb')?.textContent.includes('Linked session:')`,
        "English linked session returns",
    );
    assert.equal(await first(), `Linked session: ${title}`);
    await page.evaluate(
        `(await import('/vendor/preact.mjs')).render(null, document.querySelector('#wp3-linked-fixture')); document.querySelector('#wp3-linked-fixture').remove()`,
    );
    await page.navigate(`${base}/s/${background}`);
    await see(`document.querySelector('.composer textarea')`, "the real session restored");
});

test("real rich and file views preserve titles, source, sandbox and bridge origin", async () => {
    await page.evaluate(`
        const { h, render } = await import('/vendor/preact.mjs');
        const { Markdown } = await import('/ui.js');
        await import('/rich.js');
        const parent = document.createElement('div');
        parent.id = 'wp3-rich-fixture';
        document.body.append(parent);
        window.wp3DrawRich = () => render(h(Markdown, { text: ${JSON.stringify("```html\n<p>USER PAGE <b>kept</b> {count}</p>\n```")} }), parent);
        window.wp3DrawRich();
    `);
    await see(
        `document.querySelector('#wp3-rich-fixture iframe.html-preview')`,
        "the real rich preview",
    );
    const previewTitle = () =>
        value<string>(
            `return JSON.stringify(document.querySelector('#wp3-rich-fixture iframe.html-preview').title)`,
        );

    assert.equal(await previewTitle(), "Preview");
    await setLocale("zh-CN");
    await page.evaluate("window.wp3DrawRich()");
    await see(
        `document.querySelector('#wp3-rich-fixture iframe.html-preview')?.title === '预览页'`,
        "translated preview title",
    );
    assert.equal(
        await value<string>(
            `return JSON.stringify(document.querySelector('#wp3-rich-fixture iframe.html-preview').getAttribute('sandbox'))`,
        ),
        "allow-same-origin",
    );
    assert.ok(
        (
            await value<string>(
                `return JSON.stringify(document.querySelector('#wp3-rich-fixture iframe.html-preview').srcdoc)`,
            )
        ).includes(pageText),
    );
    await page.evaluate(`document.querySelector('#wp3-rich-fixture .rich-run').click()`);
    await see(`document.querySelector('#wp3-rich-fixture iframe.run-frame')`, "the real run frame");
    assert.equal(
        await value<string>(
            `return JSON.stringify(document.querySelector('#wp3-rich-fixture iframe.run-frame').title)`,
        ),
        "运行预览页",
    );
    assert.ok(
        (
            await value<string>(
                `return JSON.stringify(document.querySelector('#wp3-rich-fixture iframe.run-frame').getAttribute('sandbox'))`,
            )
        ).includes("allow-scripts"),
    );
    assert.equal(
        await value<string>(
            `return JSON.stringify((await import('/artifact-bridge.js')).followUpText('user {title}', undefined, "the page in Pi's reply"))`,
        ),
        "From the page in Pi's reply:\nuser {title}",
    );
    await setLocale("en");
    await page.evaluate("window.wp3DrawRich()");
    await see(
        `document.querySelector('#wp3-rich-fixture iframe.run-frame')?.title === 'Preview'`,
        "run frame switches back",
    );
    await page.evaluate(
        `(await import('/vendor/preact.mjs')).render(null, document.querySelector('#wp3-rich-fixture')); document.querySelector('#wp3-rich-fixture').remove()`,
    );

    await page.evaluate(
        `(await import('/files-panel.js')).setFilesOpen(true, 'files'); (await import('/ui.js')).openFile(${JSON.stringify(file)});`,
    );
    await see(
        `document.querySelector('.file-viewer .file-path')?.textContent.includes(${JSON.stringify(fileName)})`,
        "the real file viewer",
    );
    await see(
        `[...document.querySelectorAll('.file-viewer button')].some((button) => button.textContent.trim() === 'Preview')`,
        "the file loaded and offers Preview",
    );
    await page.evaluate(
        `[...document.querySelectorAll('.file-viewer button')].find((button) => button.textContent.trim() === 'Preview').click()`,
    );
    await see(`document.querySelector('.file-viewer iframe.html-preview')`, "file preview");
    const fileTitle = () =>
        value<string>(`return JSON.stringify(document.querySelector('.file-viewer iframe').title)`);

    assert.equal(await fileTitle(), fileName);
    await setLocale("zh-CN");
    assert.equal(await fileTitle(), fileName);
    await page.evaluate(
        `[...document.querySelectorAll('.file-viewer button')].find((button) => button.textContent.includes('Run')).click()`,
    );
    await see(`document.querySelector('.file-viewer iframe.run-frame')`, "running file");
    assert.equal(await fileTitle(), fileName);
    assert.equal(
        await value<string>(
            `return JSON.stringify((await import('/artifact-bridge.js')).followUpText('keep', undefined, ${JSON.stringify(`the file “${fileName}”`)}))`,
        ),
        `From the file “${fileName}”:\nkeep`,
    );
});

test("the extension PiP API keeps machine reasons unchanged in Chinese", async () => {
    await setLocale("zh-CN");
    const unavailable = await value<{ reason: string }>(
        `const { store } = await import('/store.js'); const old = store.state.server; store.set({ server: { ...old, pip: false } }); try { return JSON.stringify(await (await import('/pip.js')).askPipFrom('test', 'hello', false)); } finally { store.set({ server: old }); }`,
    );
    const withoutTap = await value<{ reason: string }>(
        `return JSON.stringify(await (await import('/pip.js')).askPipFrom('test', 'hello', true))`,
    );
    const expected = ["PiP is not available", "Sending needs a click or a key press just before"];

    await setLocale("en");
    assert.deepEqual([unavailable.reason, withoutTap.reason], expected);
});

test("the real diff viewer keeps the gap arrow separated from its label", async () => {
    await setLocale("en");
    mockChanges = true;
    await page.evaluate(`(await import('/files-panel.js')).setFilesOpen(true, 'changes')`);
    await see(
        `document.querySelector('.dr-file[data-path="wp3-gap.txt"] .dv-gap button')`,
        "a real diff gap",
    );
    const labels = await value<string[]>(
        `return JSON.stringify([...document.querySelectorAll('.dr-file[data-path="wp3-gap.txt"] .dv-gap button')].map((button) => button.textContent.trim().replace(/\\s+/g, ' ')))`,
    );

    try {
        assert.ok(
            labels.some((label) => /^[↑↓↕] Show \d+ hidden lines$/.test(label)),
            `gap labels: ${labels.join(", ")}`,
        );
    } finally {
        mockChanges = false;
        await page.evaluate(`(await import('/files-panel.js')).setFilesOpen(false)`);
    }
});

test("a peek tile redraws its translated title when its other props are unchanged", async () => {
    await setLocale("en");
    await page.navigate(`${base}/s/${background}`);
    await see(`document.querySelector('.composer textarea')`, "the real background session");
    await see(
        `(await import('/store.js')).store.state.sessions.some((each) => each.id === ${Number(peekSession)})`,
        "the peek session reached the browser",
    );
    await page.evaluate(`
        const { setPrefs } = await import('/theme.js');
        const { store } = await import('/store.js');
        const session = store.state.sessions.find((each) => each.id === ${Number(peekSession)});
        if (!session) throw new Error('peek fixture session missing');
        store.set({ pinned: [...new Set([...store.state.pinned, session.id])] });
        setPrefs({ peeks: true });
    `);
    const selector = `.peek[data-peek="${Number(peekSession)}"] .peek-head`;

    await see(
        `document.querySelector(${JSON.stringify(selector)})?.title === ${JSON.stringify(`Open ${title}`)}`,
        "the pinned real peek tile",
    );
    // Stop fresh network peeks from changing a tile prop during the language switch.
    await page.evaluate(`
        const { store } = await import('/store.js');
        window.wp3Peek = { tile: document.querySelector(${JSON.stringify(selector)}).closest('.peek'), stream: store.state.streamId };
        store.set({ streamId: null });
    `);

    try {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await setLocale("zh-CN");
        await see(
            `document.querySelector(${JSON.stringify(selector)})?.title === ${JSON.stringify(`打开【${title}】`)}`,
            "the existing tile redraws for the new language",
            5000,
        );
        assert.equal(
            await value<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}).title)`,
            ),
            `打开【${title}】`,
        );
        assert.equal(
            await value<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}).closest('.peek') === window.wp3Peek.tile)`,
            ),
            true,
            "the same mounted tile was updated",
        );
    } finally {
        await page.evaluate(
            `(await import('/store.js')).store.set({ streamId: window.wp3Peek.stream })`,
        );
        await setLocale("en");
    }
});

test("PiP keeps suggestion payloads, user content and the first name across languages", async () => {
    await page.evaluate(
        `(await import('/files-panel.js')).setFilesOpen(false); (await import('/pip.js')).openPip()`,
    );
    await see(
        `document.querySelector('.pip-welcome .pip-chip') && (await import('/store.js')).store.state.pipView.conversation?.id === ${Number(pip)}`,
        "PiP welcome",
    );
    await setLocale("en");
    await see(
        `document.querySelector('.pip-hello')?.textContent.includes(${JSON.stringify(name)})`,
        "the owner's first name",
    );
    const chips = () =>
        value<string[]>(
            `return JSON.stringify([...document.querySelectorAll('.pip-chip')].map((button) => button.textContent.trim()))`,
        );
    const english = await chips();
    const draftIndex = english.findIndex((text) => text.endsWith("…"));
    const sendIndex = english.findIndex((text) => !text.endsWith("…"));

    assert.ok(draftIndex >= 0 && sendIndex >= 0);
    await setLocale("zh-CN");
    await see(
        `document.querySelector('.pip-hello')?.textContent.includes('你好')`,
        "PiP welcome translated",
    );
    await see(
        `document.querySelectorAll('.pip-chip')[${draftIndex}]?.textContent.includes('启动一个会话')`,
        "suggestion translated",
    );
    assert.ok(
        (
            await value<string>(
                `return JSON.stringify(document.querySelector('.pip-hello').textContent)`,
            )
        ).includes(name),
    );
    assert.notEqual((await chips())[draftIndex], english[draftIndex]);
    assert.notEqual((await chips())[sendIndex], english[sendIndex]);
    await page.evaluate(`document.querySelectorAll('.pip-chip')[${draftIndex}].click()`);
    await see(
        `document.querySelector('.pip-composer textarea')?.value === ${JSON.stringify(english[draftIndex]!.slice(0, -1))}`,
        "the original suggestion draft",
    );
    await page.evaluate(
        `const box = document.querySelector('.pip-composer textarea'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true }));`,
    );
    await page.evaluate(`document.querySelectorAll('.pip-chip')[${sendIndex}].click()`);
    await until(
        () => submitted.includes(english[sendIndex]!),
        "the original suggestion submission",
        20_000,
    );
    await see(
        `!(await import('/store.js')).store.state.pipView.live.busy`,
        "PiP finished the suggestion",
    );
    await page.evaluate(
        `const box = document.querySelector('.pip-composer textarea'); box.value = ${JSON.stringify(userText)}; box.dispatchEvent(new Event('input', { bubbles: true }));`,
    );
    await see(
        `document.querySelector('.pip-send') && !document.querySelector('.pip-send').disabled`,
        "send the user's text",
    );
    await page.evaluate(`document.querySelector('.pip-send').click()`);
    await until(() => submitted.includes(userText), "the unchanged user message", 20_000);
    await see(
        `document.querySelector('.pip-body')?.textContent.includes(${JSON.stringify(userText)})`,
        "the user message rendered literally",
    );
    assert.equal(
        await value<boolean>(
            `return JSON.stringify(!document.querySelector('.pip-body img[src=x]'))`,
        ),
        true,
    );
});
