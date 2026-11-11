// Chinese switching in the real app, on a phone-sized Chromium page with isolated data.
import { type App, cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const selector = "[data-sheet=appearance] select";
const heading = "document.querySelector('[data-sheet=appearance] h2')?.textContent";

async function value<T>(page: BrowserPage, expression: string): Promise<T> {
    return JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;
}

async function see(page: BrowserPage, expression: string, what: string): Promise<void> {
    await until(() => value<boolean>(page, `Boolean(${expression})`), what, 15_000);
}

async function choose(page: BrowserPage, id: string): Promise<void> {
    await page.evaluate(`
        const select = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((each) => [...each.options].some((option) => option.value === 'zh-CN'));
        if (!select) { throw new Error('The built-in Chinese language is not offered'); }
        select.value = ${JSON.stringify(id)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
    `);
}

after(cleanUp);

test("390 x 844: the language control switches to Chinese, survives disable, and restores the preference", async (t) => {
    assert.ok(
        existsSync(join(import.meta.dirname, "../src/server/extensions/zh-cn.ts")),
        "the built-in Chinese module exists",
    );
    assert.ok(findBrowser(), "Chromium is required; this test does not skip");
    let app: App | undefined;
    let server: Server | undefined;
    let browsers: Browsers | undefined;

    try {
        app = await openApp(scriptedModel(), join(root, "zh-cn-ui-data"));
        const installed = (await app.extensions(owner(app))).modules.find(
            (each) => each.file === "zh-cn.ts",
        );

        assert.ok(installed, "the loader lists the Chinese module");
        assert.equal(installed.source, "built-in");
        assert.equal(installed.enabled, true);
        assert.equal(installed.error, undefined);
        server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "zh-cn-chromium-")),
            load: async () => undefined,
            save: () => {},
        });
        const page = await browsers.open(1);

        await page.setViewport(VIEWPORTS.mobile);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await see(
            page,
            `(await import('/store.js')).store.state.me?.role === 'owner'`,
            "the isolated owner signs in",
        );
        await see(
            page,
            `(await import('/store.js')).store.state.connection === 'open'`,
            "the event stream opens",
        );
        await see(
            page,
            `(await import('/ui-locale.js')).languages().some((each) => each.id === 'zh-CN')`,
            "the real Chinese catalog arrives",
        );
        await page.evaluate(
            `window.zhCnPageMarker = 'same-document'; (await import('/store.js')).openSheet({ type: 'appearance' });`,
        );
        await see(page, `${heading} === 'Appearance'`, "the English Appearance sheet opens");
        const metrics = await value<{
            width: number;
            height: number;
            selectHeight: number;
            left: number;
            right: number;
            scrollWidth: number;
            clientWidth: number;
            selected: string;
            label: string;
        }>(
            page,
            `(() => {
            const select = [...document.querySelectorAll(${JSON.stringify(selector)})]
                .find((each) => [...each.options].some((option) => option.value === 'zh-CN'));
            const box = select.getBoundingClientRect();
            return { width: innerWidth, height: innerHeight, selectHeight: box.height, left: box.left, right: box.right,
                scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
                selected: select.value, label: select.querySelector('option[value="zh-CN"]').textContent };
        })()`,
        );

        assert.equal(metrics.width, 390);
        assert.equal(metrics.height, 844);
        assert.ok(metrics.selectHeight >= 40, `language control is ${metrics.selectHeight}px high`);
        assert.ok(metrics.left >= 0 && metrics.right <= 390, "the language control fits the phone");
        assert.ok(
            metrics.scrollWidth <= metrics.clientWidth,
            "the page has no horizontal overflow",
        );
        assert.equal(metrics.selected, "en");
        assert.equal(metrics.label, "简体中文");
        t.diagnostic(`Measured phone/control geometry: ${JSON.stringify(metrics)}`);

        await choose(page, "zh-CN");
        await see(
            page,
            `document.documentElement.lang === 'zh-CN' && ${heading} === '外观'`,
            "the visible title changes to Chinese",
        );
        assert.equal(await value(page, `(await import('/ui-locale.js')).localeId()`), "zh-CN");
        assert.equal(
            await value(page, `document.querySelector(${JSON.stringify(selector)}).value`),
            "zh-CN",
        );
        assert.equal(
            await value(page, "window.zhCnPageMarker"),
            "same-document",
            "switching does not reload the page",
        );
        assert.ok(await value<boolean>(page, "document.cookie.includes('pocket_locale=zh-CN')"));
        await choose(page, "en");
        await see(page, `${heading} === 'Appearance'`, "English can be selected again");
        await choose(page, "zh-CN");
        await see(page, `${heading} === '外观'`, "Chinese can be selected again");

        await app.setExtensionEnabled(owner(app), "zh-cn.ts", false);
        await see(
            page,
            `document.documentElement.lang === 'en' && ${heading} === 'Appearance'`,
            "disabling the actual module restores English",
        );
        assert.equal(await value(page, `(await import('/ui-locale.js')).localeId()`), "en");
        assert.equal(
            await value(page, `(await import('/ui-locale.js')).t('ui.close', 'Close')`),
            "Close",
        );
        assert.ok(
            await value<boolean>(page, "document.cookie.includes('pocket_locale=zh-CN')"),
            "disabling keeps the preference",
        );
        assert.equal(await value(page, "window.zhCnPageMarker"), "same-document");

        await app.setExtensionEnabled(owner(app), "zh-cn.ts", true);
        await see(
            page,
            `document.documentElement.lang === 'zh-CN' && ${heading} === '外观'`,
            "enabling restores the saved Chinese preference",
        );
        assert.equal(
            await value(page, `document.querySelector(${JSON.stringify(selector)}).value`),
            "zh-CN",
        );
        assert.equal(await value(page, "window.zhCnPageMarker"), "same-document");
    } finally {
        await browsers?.closeAll({ final: true });
        server?.closeAllConnections();
        await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
        await app?.close();
    }
});
