// PiP's own file composer, in an isolated real browser.
// These tests never select a real provider or use the running server's people, data, or browser profile.
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
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const BOX = ".pip-composer textarea";
const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const requests: { text: string; images: { data: string; mimeType: string }[] }[] = [];
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let pip: ConversationId;
let background: ConversationId;
const project = join(work, "project-alpha");

type Call = {
    url: string;
    body?: {
        text?: string;
        attachments?: { path: string; name: string; mime: string; size: number }[];
    };
};
const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (condition: string, what: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(Boolean(${condition}))`), what, 20_000);
const value = () =>
    inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(BOX)}).value)`);
const names = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll('.pip-attachment-name')].map((each) => each.textContent))`,
    );
const calls = () => inPage<Call[]>(`return JSON.stringify(window.pipTestCalls)`);
const submissions = async () => (await calls()).filter((call) => call.url.endsWith("/submit"));
const settle = () =>
    page.evaluate(`
    await Promise.all(document.getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => {})));
    for (let frame = 0; frame < 3; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
    }
`);

async function tap(selector: string): Promise<void> {
    await settle();
    // back.js deliberately ignores a second pointer tap just after a route/layer transition.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await page.click({ selector });
    await settle();
}

async function text(words: string): Promise<void> {
    await page.evaluate(`
        const box = document.querySelector(${JSON.stringify(BOX)});
        box.value = ${JSON.stringify(words)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await until(async () => (await value()) === words, "PiP draft changed");
}

async function open(): Promise<void> {
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await see(
        `document.querySelector('.pip-panel:not(.leaving)') !== null &&
        (await import('/store.js')).store.state.pipView.conversation?.id === ${Number(pip)}`,
        "PiP's own live view",
    );
    await settle();
}

async function close(): Promise<void> {
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await see(`document.querySelector('.pip-panel') === null`, "PiP closed");
}

async function fresh(viewport: Viewport = VIEWPORTS.desktop): Promise<void> {
    if (
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector(${JSON.stringify(BOX)}) !== null)`,
        )
    ) {
        await page.evaluate(
            `document.querySelectorAll('.pip-attachment-remove').forEach((button) => button.click())`,
        );
        await text("");
    }

    await page.evaluate(`
        (await import('/store.js')).closeSheet();
        (await import('/pip.js')).closePip();
        localStorage.removeItem('pocket.pip.draft');
    `);
    await settle();
    await page.setViewport(viewport);
    // Reload after a touch/desktop change so the composer reads the right media queries.
    await page.navigate(`${base}/s/${background}`);
    await see(`document.querySelector('.composer textarea') !== null`, "the background screen");
    await settle();
    await page.evaluate(`
        window.pipTestFetch = window.fetch;
        window.pipTestCalls = [];
        window.pipTestGates = [];
        window.pipTestHold = '';
        window.pipTestFail = '';
        window.fetch = (url, init) => {
            const path = String(url);
            const kind = path.includes('/upload?') ? 'upload' : path.endsWith('/submit') ? 'submit' : '';
            window.pipTestCalls.push({ url: path, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
            const send = () => window.pipTestFetch(url, init);
            if (kind && kind === window.pipTestFail) {
                return Promise.reject(new TypeError('test offline'));
            }
            if (kind && kind === window.pipTestHold) {
                return new Promise((resolve, reject) => window.pipTestGates.push({ resolve: () => resolve(send()), reject }));
            }
            return send();
        };
    `);
    await open();
}

/** File API fixtures travel through the real input/drop handlers, then the real upload route. */
async function attach(
    method: "picker" | "drop",
    files: { name: string; image?: boolean }[],
): Promise<void> {
    await page.evaluate(`
        const data = new DataTransfer();
        for (const fixture of ${JSON.stringify(files)}) {
            const bytes = fixture.image ? Uint8Array.from(atob(${JSON.stringify(PNG)}), (letter) => letter.charCodeAt(0)) : 'fixture document';
            data.items.add(new File([bytes], fixture.name, { type: fixture.image ? 'image/png' : 'text/plain' }));
        }
        if (${JSON.stringify(method)} === 'picker') {
            const picker = document.querySelector('.pip-file-picker');
            picker.files = data.files;
            picker.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            const wrap = document.querySelector('.pip-composer-wrap');
            wrap.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
            wrap.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
        }
    `);
}

async function uploaded(count: number): Promise<void> {
    await see(
        `document.querySelectorAll('.pip-attachment').length === ${count} &&
        document.querySelector('.pip-attachments .spinner') === null`,
        "uploaded PiP files",
    );
    await see(`!document.querySelector('.pip-send').disabled`, "PiP Send enabled");
}

async function enter(): Promise<void> {
    await page.evaluate(`document.querySelector(${JSON.stringify(BOX)}).focus()`);
    await page.press("Enter");
}

async function idle(): Promise<void> {
    await until(
        async () => {
            const entries = await app.transcripts.allEntries(pip, true);
            const user = entries.findLast((entry) => entry.kind === "user");
            const answer = entries.findLast((entry) => entry.kind === "assistant");

            return (
                !app.isBusy(pip) &&
                user !== undefined &&
                answer !== undefined &&
                answer.id > user.id
            );
        },
        "PiP finished the latest answer",
        20_000,
    );
    await see(`!(await import('/store.js')).store.state.pipView.live.busy`, "PiP's idle view");
}

async function release(): Promise<void> {
    await page.evaluate(
        `window.pipTestHold = ''; window.pipTestGates.splice(0).forEach((gate) => gate.resolve())`,
    );
}

before(async () => {
    if (real.skip) {
        return;
    }

    mkdirSync(project);
    app = await openApp(
        scriptedModel(async (request) => {
            const { text } = lastText(request as never);
            const messages = (request as { messages: { role: string; content: unknown }[] })
                .messages;
            const last = messages.findLast((message) => message.role === "user");
            const images = Array.isArray(last?.content)
                ? (last.content.filter((part) => part.type === "image") as {
                      data: string;
                      mimeType: string;
                  }[])
                : [];

            requests.push({ text, images });

            return fauxAssistantMessage([fauxText(`PiP received ${images.length} images.`)]);
        }),
    );

    app.watches.gh = async () => {
        throw new Error("No GitHub in PiP UI tests");
    };

    background = await newSession(app, project);
    pip = await app.pip.ensure(owner(app));
    await app.commands.configure(pip, owner(app), {
        model: { provider: "faux", modelId: "faux-vision" },
        thinkingLevel: "off",
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "pip-chat-browser-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `(await import('/store.js')).store.state.me?.role === 'owner'`,
        "isolated owner signed in",
    );
});

after(async () => {
    try {
        await browsers?.closeAll({ final: true });
    } finally {
        server?.closeAllConnections();
        server?.close();

        try {
            await app?.close();
        } finally {
            cleanUp();
        }
    }
});

test("image-only and file-only messages to PiP, not the background project", real, async () => {
    await fresh(VIEWPORTS.desktop);
    const backgroundBefore = await app.transcripts.allEntries(background, true);

    const image = "picker.png";
    const document = "picker.txt";
    const before = requests.length;

    await attach("picker", [{ name: image, image: true }, { name: document }]);
    await uploaded(2);
    assert.deepEqual(await names(), [image, document]);
    await tap(`[aria-label="Remove ${document}"]`);
    assert.deepEqual(await names(), [image], "remove one leaves the other");
    await tap(".pip-send");
    await until(() => requests.length > before, "the vision model saw the send");
    await idle();
    const sent = (await submissions()).at(-1)!;

    assert.equal(sent.url, `/api/c/${pip}/submit`);
    assert.equal(sent.body?.text, "");
    assert.deepEqual(
        sent.body?.attachments?.map((file) => file.name),
        [image],
    );
    assert.equal(
        requests.at(-1)?.images.length,
        1,
        "the real model request contains the image, not only its path",
    );
    assert.equal(requests.at(-1)?.images[0]?.mimeType, "image/png");
    assert.equal(
        requests.at(-1)?.images[0]?.data,
        PNG,
        "the fixture's actual image bytes reached the model",
    );
    assert.deepEqual(await names(), []);
    await attach("picker", [{ name: document }]);
    await uploaded(1);
    await tap(".pip-send");
    await until(async () => (await names()).length === 0, "file-only message sent");
    await idle();
    const file = (await submissions()).at(-1)?.body?.attachments?.[0];

    assert.equal(file?.name, document);
    assert.equal(file?.mime, "text/plain");
    assert.equal(file?.size, Buffer.byteLength("fixture document"));
    assert.equal(readFileSync(file!.path, "utf8"), "fixture document");

    assert.deepEqual(
        await app.transcripts.allEntries(background, true),
        backgroundBefore,
        "PiP never messages the background conversation",
    );
    assert.ok(
        (await calls())
            .filter((call) => call.url.includes("/upload?"))
            .every((call) => call.url.startsWith(`/api/c/${pip}/upload?`)),
    );
    await close();
});

test(
    "failed POST retains recoverable text and files; a pending send cannot duplicate and preserves newer typing",
    real,
    async () => {
        await fresh();

        try {
            await attach("picker", [{ name: "recover.png", image: true }, { name: "recover.txt" }]);
            await uploaded(2);
            await text("recover these words");
            await page.evaluate(`window.pipTestFail = 'submit'`);
            await enter();
            await see(
                `(await import('/store.js')).store.state.notices.some((notice) => notice.message.includes('test offline'))`,
                "send failure notice",
            );
            await until(
                async () => (await value()) === "recover these words",
                "failed words restored",
            );
            assert.deepEqual(await names(), ["recover.png", "recover.txt"]);
            await close();
            await open();
            assert.equal(await value(), "recover these words");
            assert.deepEqual(await names(), ["recover.png", "recover.txt"]);
            await page.evaluate(
                `window.pipTestFail = ''; window.pipTestHold = 'submit'; window.pipTestCalls = []`,
            );
            await enter();
            await see(`window.pipTestGates.length === 1`, "submission held");
            await text("newer words while sending");
            await attach("drop", [{ name: "added-during-send.txt" }]);
            await see(
                `document.querySelectorAll('.pip-attachment').length === 3 && document.querySelector('.pip-attachments .spinner') === null`,
                "new file added during the pending send",
            );
            await enter();
            assert.equal((await submissions()).length, 1, "double Enter sends only once");
            await close();
            await open();
            assert.equal(await value(), "newer words while sending");
            await release();
            await until(
                async () => (await names()).length === 1,
                "successful retry removes only its own files",
            );
            assert.deepEqual(
                await names(),
                ["added-during-send.txt"],
                "late success keeps a newer attachment",
            );
            await idle();
            assert.equal(
                await value(),
                "newer words while sending",
                "late success never clears newer typing",
            );
            const sent = (await submissions())[0]!;

            assert.equal(sent.body?.text, "recover these words");
            assert.equal(sent.body?.attachments?.length, 2);
        } finally {
            await page.evaluate(`window.pipTestFail = ''`);
            await release();
        }

        await close();
    },
);

test("a typed PiP text draft survives reload while open and while closed", real, async () => {
    await fresh(VIEWPORTS.desktop);
    const draft = "Keep this PiP draft across reload.\nSecond line, not a sent message.";

    await tap(BOX);
    await page.type({ selector: BOX }, draft);
    await until(async () => (await value()) === draft, "native typing saved the text draft");
    await page.navigate(`${base}/s/${background}`);
    await see(
        `(await import('/store.js')).store.state.me?.role === 'owner' && document.querySelector(${JSON.stringify(BOX)}) !== null && (await import('/store.js')).store.state.pipView.conversation?.id === ${Number(pip)}`,
        "PiP restored after reload and sign-in state loaded",
    );
    await settle();
    assert.equal(
        await value(),
        draft,
        "initial unknown authentication cannot erase the saved text draft",
    );
    await close();
    await page.navigate(`${base}/s/${background}`);
    await see(
        `(await import('/store.js')).store.state.me?.role === 'owner' && document.querySelector('.composer textarea') !== null`,
        "background screen reloaded while PiP closed",
    );
    await settle();
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('.pip-panel') === null)`,
        ),
        true,
    );
    await open();
    assert.equal(
        await value(),
        draft,
        "a closed-panel reload keeps the saved text until the owner reopens PiP",
    );
    await close();
});
