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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const localeFile = "i18n-ui-fixture.ts";
const draft = "Draft stays here while the interface changes.";

const localeModule = `/** A small test locale for the live UI translation test. */
import { defineExtension } from "@earendil-works/pi-durable";

export default () => ({
    ...defineExtension({ name: "i18n-ui-fixture" }),
    uiLocales: [
        {
            locale: "zh-CN",
            label: "简体中文",
            default: true,
            strings: {
                Menu: "菜单",
                Extensions: "扩展",
                Appearance: "外观",
            },
            templates: {},
        },
    ],
});
`;

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
    writeFileSync(join(dropIns, localeFile), localeModule);
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
        );
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
    },
);
