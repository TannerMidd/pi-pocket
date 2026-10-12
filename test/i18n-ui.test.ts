// A live locale change reaches already-open guest sessions without a reload, on phone and desktop.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const dataDir = join(root, "i18n-ui-data");
const localeFile = "zh-cn-ui.ts";
const draft = "Draft stays here while the interface changes.";

let app: App | undefined;
let server: Server | undefined;
let browsers: Browsers | undefined;
let mobile: BrowserPage | undefined;
let desktop: BrowserPage | undefined;
let base = "";
let session: ConversationId;
let guestToken = "";

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });
    copyFileSync(
        join(import.meta.dirname, "../docs/examples/zh-cn-ui.ts"),
        join(dropIns, localeFile),
    );
    const active = await openApp(scriptedModel(), dataDir);

    app = active;
    session = await newSession(active);
    await active.commands.updateSession(session, owner(active), { title: "Menu" });
    guestToken = active.config.addUser("I18n guest", "guest", [String(session)]).token;
    server = createServer(
        createHandler({ app: active, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "i18n-ui-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    mobile = await browsers.open(501, { restore: false, viewport: VIEWPORTS.mobile });
    desktop = await browsers.open(502, { restore: false, viewport: VIEWPORTS.desktop });
    await mobile.setViewport(VIEWPORTS.mobile);
    await desktop.setViewport(VIEWPORTS.desktop);

    for (const page of [mobile, desktop]) {
        await page.navigate(`${base}/login?token=${encodeURIComponent(guestToken)}`);
        await page.navigate(`${base}/s/${session}`);
        await until(
            async () =>
                JSON.parse(
                    await page.evaluate(
                        `return JSON.stringify(document.querySelector(".composer textarea") !== null && document.querySelector(".model-chip") !== null)`,
                    ),
                ) === true,
            "the signed-in guest session",
            20_000,
        ).catch((error) => {
            throw new Error(`${String(error)}; browser logs: ${JSON.stringify(page.logs())}`, {
                cause: error,
            });
        });
    }
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

type UiState = {
    lang: string;
    path: string;
    timeOrigin: number;
    title: string | null;
    labels: string[];
    menuButton: string | null;
    model: string | null;
    draft: string | null;
    innerWidth: number;
    pageWidth: number;
};

/** Read the rendered state from a real Chromium page. */
async function ui(page: BrowserPage): Promise<UiState> {
    return JSON.parse(
        await page.evaluate(`
            return JSON.stringify({
                lang: document.documentElement.lang,
                path: location.pathname,
                timeOrigin: performance.timeOrigin,
                title: document.querySelector(".sheet-head h2")?.textContent.trim() ?? null,
                labels: [...document.querySelectorAll(".sheet .group .list-item > span:first-child")]
                    .map((element) => element.textContent.trim()),
                menuButton: document.querySelector('.topbar [aria-label="菜单"], .topbar [aria-label="Menu"]')
                    ?.getAttribute("aria-label") ?? null,
                model: document.querySelector(".model-chip")?.textContent.trim() ?? null,
                draft: document.querySelector(".composer textarea")?.value ?? null,
                innerWidth,
                pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
            });
        `),
    ) as UiState;
}

async function openMenu(page: BrowserPage): Promise<void> {
    await page.evaluate(`document.querySelector('.topbar [aria-label="Menu"]').click()`);
    await until(async () => (await ui(page)).title === "Menu", "the open session menu");
}

async function postExtension(token: string, enabled: boolean): Promise<Response> {
    return fetch(`${base}/api/extensions/${localeFile}`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify({ enabled }),
    });
}

function assertNoReloadAndNoDataChanges(state: UiState, initial: UiState) {
    assert.equal(state.path, initial.path, "the open conversation stays put");
    assert.equal(state.timeOrigin, initial.timeOrigin, "the document was not reloaded");
    assert.equal(state.title, "Menu", "the user's conversation title is not translated");
    assert.equal(state.model, initial.model, "the model identifier is unchanged");
    assert.equal(state.draft, initial.draft, "the unsent draft is preserved");
    assert.ok(
        state.pageWidth <= state.innerWidth,
        `no horizontal overflow: page ${state.pageWidth}px, viewport ${state.innerWidth}px`,
    );
}

test(
    "upstream speed and unread controls retain live translations on phone and desktop",
    real,
    async () => {
        assert.ok(app && mobile && desktop);
        const pages: BrowserPage[] = [mobile, desktop];

        for (const enabled of [true, false]) {
            assert.equal((await postExtension(app.config.ownerToken, enabled)).status, 200);

            for (const page of pages) {
                await until(
                    async () => (await ui(page)).lang === (enabled ? "zh-CN" : "en"),
                    "locale changed",
                );
                await page.evaluate(`(async () => {
                    const { store } = await import('/store.js');
                    const { setPrefs } = await import('/theme.js');
                    setPrefs({ speed: true });
                    store.set({ view: { ...store.state.view, stats: { ...store.state.view.stats,
                        tokensPerSec: 87.4, ttftMs: 1240, cacheRate: 0.83, contextTokens: 98000 } } });
                })()`);
                await until(
                    async () =>
                        (
                            await page.evaluate(`document.querySelector('.speed')?.title ?? ''`)
                        ).includes(enabled ? "每秒 87.4 个 token" : "87.4 tokens a second"),
                    "speed tooltip translated",
                );
                const tooltip = await page.evaluate(`document.querySelector('.speed').title`);

                assert.ok(tooltip.includes(enabled ? "1.24 秒" : "1.24s"));
                await page.evaluate(
                    `(async () => { const { openSheet } = await import('/store.js'); openSheet({ type: 'appearance' }); })()`,
                );
                await until(
                    async () =>
                        (
                            await page.evaluate(
                                `document.querySelector('.sheet')?.textContent ?? ''`,
                            )
                        ).includes(enabled ? "回复速度" : "Reply speed"),
                    "appearance translated",
                );
                await page.evaluate(
                    `(async () => { const { openSheet, store } = await import('/store.js'); openSheet({ type: 'session', id: store.state.conversationId }); })()`,
                );
                await until(
                    async () =>
                        (
                            await page.evaluate(
                                `document.querySelector('.sheet')?.textContent ?? ''`,
                            )
                        ).includes(enabled ? "标记为未读" : "Mark unread"),
                    "session menu translated",
                );
                const result = await page.evaluate(`
                const { t } = await import('/i18n.js');
                return JSON.stringify([t('How fast the last answer came: {{detail}}', { detail: 'Menu {{detail}} <img>' }), t('Unknown fixed key')]);
            `);

                assert.deepEqual(JSON.parse(result), [
                    (enabled ? "上一条回复的生成速度：" : "How fast the last answer came: ") +
                        "Menu {{detail}} <img>",
                    "Unknown fixed key",
                ]);
                assert.ok((await ui(page)).pageWidth <= (await ui(page)).innerWidth);
                await page.evaluate(
                    `(async () => { const { closeSheet } = await import('/store.js'); closeSheet(); })()`,
                );
            }
        }

        for (const page of [mobile, desktop]) {
            await page.evaluate(
                `(async () => { const { setPrefs } = await import('/theme.js'); setPrefs({ speed: false }); })()`,
            );
        }
    },
);

test(
    "live locale hello updates open guest menus on mobile and desktop, then restores English",
    real,
    async () => {
        const active = app;
        const phonePage = mobile;
        const computerPage = desktop;

        assert.ok(active && phonePage && computerPage);

        await phonePage.type({ selector: ".composer textarea" }, draft);
        await openMenu(phonePage);
        await openMenu(computerPage);

        const initialMobile = await ui(phonePage);
        const initialDesktop = await ui(computerPage);

        for (const [label, state] of [
            ["mobile", initialMobile],
            ["desktop", initialDesktop],
        ] as const) {
            assert.equal(state.lang, "en", `${label} starts in English`);
            assert.ok(state.labels.includes("Appearance"), `${label} shows English Appearance`);
            assert.ok(state.labels.includes("Extensions"), `${label} shows English Extensions`);
            assert.equal(state.title, "Menu", `${label} shows the unmodified user title`);
            assert.equal(state.menuButton, "Menu", `${label} has the English Menu control`);
            assert.match(state.model ?? "", /faux-1/, `${label} shows the model ID`);
            assert.ok(
                state.pageWidth <= state.innerWidth,
                `${label} has no horizontal overflow (${state.pageWidth}/${state.innerWidth})`,
            );
        }

        assert.equal(initialMobile.draft, draft);
        assert.equal(initialDesktop.innerWidth, VIEWPORTS.desktop.width);

        const refused = await postExtension(guestToken, true);

        assert.equal(refused.status, 403, "a guest cannot enable a drop-in extension");
        assert.equal(
            active.loader.list().find((module) => module.file === localeFile)?.enabled,
            false,
            "the denied request leaves the fixture disabled",
        );

        const enabled = await postExtension(active.config.ownerToken, true);

        assert.equal(enabled.status, 200, "the owner enables the test locale through the API");
        await until(
            async () => {
                const [phone, computer] = await Promise.all([ui(phonePage), ui(computerPage)]);

                return (
                    phone.lang === "zh-CN" &&
                    phone.labels.includes("扩展") &&
                    phone.labels.includes("外观") &&
                    phone.menuButton === "菜单" &&
                    computer.lang === "zh-CN" &&
                    computer.labels.includes("扩展") &&
                    computer.labels.includes("外观") &&
                    computer.menuButton === "菜单"
                );
            },
            "both open guest menus to update to Chinese",
            20_000,
        );

        const chineseMobile = await ui(phonePage);
        const chineseDesktop = await ui(computerPage);

        for (const [label, state, initial] of [
            ["mobile", chineseMobile, initialMobile],
            ["desktop", chineseDesktop, initialDesktop],
        ] as const) {
            assert.equal(state.lang, "zh-CN", `${label} document language changes`);
            assert.ok(state.labels.includes("扩展"), `${label} translates Extensions`);
            assert.ok(state.labels.includes("外观"), `${label} translates Appearance`);
            assert.equal(state.menuButton, "菜单", `${label} translates the Menu control`);
            assertNoReloadAndNoDataChanges(state, initial);
        }

        const rawError = "EXTERNAL RAW {{name}} <img>";
        const attachment = "Menu {{name}} /some/path";
        const notice = `Could not attach ${attachment}: ${rawError}`;

        active.notice("error", notice, session, {
            key: "Could not attach {{name}}: {{error}}",
            params: { name: attachment, error: rawError },
        });
        active.notice("error", rawError, session);
        await until(async () => {
            const texts = await Promise.all(
                [phonePage, computerPage].map((page) =>
                    page.evaluate(`document.querySelector('.notices')?.textContent ?? ''`),
                ),
            );

            return texts.every((text) => text.includes("无法附加") && text.includes(rawError));
        }, "both pages render structured notices without translating raw errors");

        for (const page of [phonePage, computerPage]) {
            assert.equal(
                await page.evaluate(`document.querySelectorAll('.notices img').length`),
                "0",
            );
        }

        const disabled = await postExtension(active.config.ownerToken, false);

        assert.equal(disabled.status, 200, "the owner disables the test locale through the API");
        await until(
            async () => {
                const [phone, computer] = await Promise.all([ui(phonePage), ui(computerPage)]);

                return (
                    phone.lang === "en" &&
                    phone.labels.includes("Extensions") &&
                    phone.labels.includes("Appearance") &&
                    phone.menuButton === "Menu" &&
                    computer.lang === "en" &&
                    computer.labels.includes("Extensions") &&
                    computer.labels.includes("Appearance") &&
                    computer.menuButton === "Menu"
                );
            },
            "both open guest menus to return to English",
            20_000,
        );

        const englishMobile = await ui(phonePage);
        const englishDesktop = await ui(computerPage);

        for (const [label, state, initial] of [
            ["mobile", englishMobile, initialMobile],
            ["desktop", englishDesktop, initialDesktop],
        ] as const) {
            assert.equal(state.lang, "en", `${label} document language returns to English`);
            assert.ok(state.labels.includes("Extensions"), `${label} restores Extensions`);
            assert.ok(state.labels.includes("Appearance"), `${label} restores Appearance`);
            assert.equal(state.menuButton, "Menu", `${label} restores the English Menu control`);
            assertNoReloadAndNoDataChanges(state, initial);
        }

        for (const page of [phonePage, computerPage]) {
            const noticeText = await page.evaluate(
                `document.querySelector('.notices').textContent`,
            );

            assert.ok(
                noticeText.includes(notice),
                "open structured notice switches back to English",
            );
            assert.ok(noticeText.includes(rawError), "raw external errors stay unchanged");
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
                "no browser console errors",
            );
        }
    },
);
