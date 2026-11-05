// Owner-only appearance hints use the default language pack; all settings and themes are temporary.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
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

const evidence = process.env.PI_POCKET_OWNER_HINTS_EVIDENCE_DIR;
const results: unknown[] = [];
let app: App;
let server: Server;
let browsers: Browsers;
let base = "";
let session: ConversationId;
let nextPage = 0;

before(async () => {
    assert.ok(findBrowser(), "Chromium is required for owner appearance acceptance");
    app = await openApp(scriptedModel(), join(root, "owner-hints"));
    session = await newSession(app);
    const theme = join(app.dataDir, "themes", "owner-example");

    mkdirSync(theme, { recursive: true });
    writeFileSync(
        join(theme, "theme.json"),
        JSON.stringify({
            themeApi: 1,
            name: "Owner example",
            description: "My theme description stays literal",
        }),
    );
    writeFileSync(
        join(theme, "theme.css"),
        ':root { --sans: "Pocket Inter", sans-serif; --mono: "Pocket Fira Code", monospace; }\n',
    );
    await app.themes.load();
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
    base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "owner-hints-browser-")),
        load: async () => undefined,
        save: () => {},
    });
});

after(async () => {
    if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, "results.json"), JSON.stringify(results, null, 2));
    }

    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.close();
    cleanUp();
});

async function value<T>(page: BrowserPage, script: string): Promise<T> {
    return JSON.parse(
        await page.evaluate(`return JSON.stringify(await (async()=>{${script}})())`),
    ) as T;
}

async function see(page: BrowserPage, expression: string, name: string) {
    await until(() => value<boolean>(page, `return Boolean(${expression})`), name, 15000);
}

async function open(viewport: "mobile" | "desktop") {
    const page = await browsers.open(++nextPage);

    await page.setViewport(VIEWPORTS[viewport]);
    await page.navigate(
        `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${session}`,
    );
    await see(
        page,
        `(await import('/store.js')).store.state.me?.role==='owner' && document.querySelector('.composer textarea')`,
        "isolated owner",
    );
    await page.evaluate(
        `(await import('/ui-locale.js')).setLocale('zh-CN');(await import('/store.js')).openSheet({type:'appearance'});`,
    );
    await see(
        page,
        `document.querySelector('.font-tools') && document.documentElement.lang==='zh-CN'`,
        "owner appearance in Chinese",
    );

    return page;
}

async function choose(page: BrowserPage, name: string) {
    await page.evaluate(
        `const card=[...document.querySelectorAll('.look-card')].find(e=>e.querySelector('.look-name')?.textContent.trim().startsWith(${JSON.stringify(name)})); if(!card)throw new Error('No theme'); card.click();`,
    );
    await see(
        page,
        `document.querySelector('.font-title')?.textContent.includes(${JSON.stringify(name)})`,
        `fonts for ${name}`,
    );
}

async function capture(page: BrowserPage, name: string, selector: string) {
    const actual = await value<{ text: string; aria: string[]; role: string }>(
        page,
        `const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center'});return {text:node.textContent.replace(/\\s+/g,' ').trim(),aria:[node,...node.querySelectorAll('[title],[aria-label]')].map(e=>e.getAttribute('aria-label')||e.title).filter(Boolean),role:(await import('/store.js')).store.state.me.role};`,
    );
    let screenshot: string | undefined;

    if (evidence) {
        await new Promise((resolve) => setTimeout(resolve, 450));
        mkdirSync(evidence, { recursive: true });
        screenshot = `${name}.jpg`;
        const image = (await page.screenshot()).data;

        writeFileSync(
            join(evidence, screenshot),
            Buffer.isBuffer(image) ? image : Buffer.from(image as string, "base64"),
        );
    }

    results.push({ name, ...actual, screenshot });

    return actual;
}

for (const viewport of ["mobile", "desktop"] as const) {
    for (const theme of ["Pocket", "Lantern"]) {
        test(`owner ${viewport}: ${theme} built-in font hint uses Chinese and survives switch and refresh`, async () => {
            const page = await open(viewport);

            try {
                await choose(page, theme);
                const actual = await capture(page, `${viewport}-${theme}-fonts`, ".font-tools");

                assert.ok(actual.text.includes(`${theme} 随应用提供，字体保持原样。`), actual.text);
                assert.ok(!actual.text.includes("comes with the app"), actual.text);

                for (const label of ["正文字体", "代码字体", "连字"]) {
                    assert.ok(actual.text.includes(label), label);
                }

                assert.ok(actual.aria.includes(`${theme} 的字体`));
                await page.evaluate(`document.querySelector('.font-duplicate button').click()`);
                await see(
                    page,
                    `document.querySelector('.font-duplicate .look-duplicate input')`,
                    "font-copy naming branch",
                );
                assert.equal(
                    await value<string>(
                        page,
                        "return document.querySelector('.font-duplicate .look-duplicate input').value",
                    ),
                    `我的 ${theme}`,
                );
                await capture(page, `${viewport}-${theme}-font-duplicate`, ".font-duplicate");
                await page.evaluate(
                    `document.querySelector('.font-duplicate .look-duplicate button[type=button]').click()`,
                );
                await see(
                    page,
                    `!document.querySelector('.font-duplicate input')`,
                    "font-copy hint restored",
                );
                await page.evaluate(`(await import('/ui-locale.js')).setLocale('en')`);
                await see(
                    page,
                    `document.querySelector('.font-tools')?.textContent.includes(${JSON.stringify(`${theme} comes with the app: its fonts stay as they are.`)})`,
                    "English hint fallback",
                );
                await page.evaluate(`(await import('/ui-locale.js')).setLocale('zh-CN')`);
                await see(
                    page,
                    `document.querySelector('.font-tools')?.textContent.includes('字体保持原样')`,
                    "live language switch",
                );
                await page.navigate(`${base}/s/${session}`);
                await see(
                    page,
                    `document.documentElement.lang==='zh-CN'&&document.querySelector('.composer textarea')`,
                    "refresh retains language",
                );
                await page.evaluate(`(await import('/store.js')).openSheet({type:'appearance'})`);
                await see(
                    page,
                    `document.querySelector('.font-tools')?.textContent.includes(${JSON.stringify(`${theme} 随应用提供，字体保持原样。`)})`,
                    "same theme branch after refresh",
                );
            } finally {
                page.close();
            }
        });
    }

    test(`owner ${viewport}: custom fonts, copy controls and default hints use Chinese without changing theme data`, async () => {
        const page = await open(viewport);

        try {
            await choose(page, "Owner example");
            const custom = await capture(page, `${viewport}-custom-fonts`, ".font-tools");

            assert.ok(custom.text.includes("正文字体") && custom.text.includes("代码字体"));
            assert.ok(
                !custom.text.includes("随应用提供"),
                "custom themes do not show the built-in-only hint",
            );
            assert.ok(
                (
                    await value<string>(
                        page,
                        "return document.querySelector('[data-sheet=appearance]').textContent",
                    )
                ).includes("My theme description stays literal"),
            );
            await page.evaluate(
                `const select=document.querySelector('.font-tools select');select.value='system-ui';select.dispatchEvent(new Event('change',{bubbles:true}));`,
            );
            await see(
                page,
                `document.querySelector('.font-tools select')?.value==='system-ui'`,
                "the real saved font value",
            );
            assert.ok(
                (
                    await value<string>(
                        page,
                        "return document.querySelector('.font-tools').textContent",
                    )
                ).includes("系统无衬线字体"),
            );
            await page.evaluate(`document.querySelector('.font-ligatures [role=switch]').click()`);
            await page.evaluate(
                `document.querySelector('.font-ligatures button:not([role=switch])').click()`,
            );
            const all = await capture(
                page,
                `${viewport}-custom-appearance`,
                "[data-sheet=appearance]",
            );

            for (const text of [
                "Edit with Pi",
                "Remove",
                "For new browsers:",
                "New browsers start with",
            ]) {
                assert.ok(!all.text.includes(text), text);
            }

            await value(
                page,
                `const button=[...document.querySelectorAll('.look-tools button')].find(e=>e.textContent.includes('用于新浏览器')||e.textContent.includes('供新浏览器')||e.textContent.includes('新浏览器'));button.click();return true;`,
            );
            await see(
                page,
                `document.querySelector('[data-sheet=appearance]')?.textContent.includes('新浏览器使用：')`,
                "explicit default branch",
            );
            await capture(page, `${viewport}-default-current`, "[data-sheet=appearance]");
            await value(
                page,
                `const button=[...document.querySelectorAll('.look-tools button')].find(e=>e.textContent.trim()==='重置');button.click();return true;`,
            );
            await see(
                page,
                `!([...document.querySelectorAll('.look-tools button')].some(e=>e.textContent.trim()==='重置'))`,
                "default reset branch",
            );
            await choose(page, "Pocket");
            await value(
                page,
                `const button=[...document.querySelectorAll('.look-tools button')].find(e=>e.textContent.trim()==='创建副本');button.click();return true;`,
            );
            await see(
                page,
                `document.querySelector('form.look-duplicate')`,
                "theme-copy naming branch",
            );
            await capture(page, `${viewport}-theme-copy`, "form.look-duplicate");
            const madeName = `Copied ${viewport} Pocket`;

            await page.evaluate(
                `const input=document.querySelector('form.look-duplicate input');input.value=${JSON.stringify(madeName)};input.dispatchEvent(new Event('input',{bubbles:true}));`,
            );
            await page.evaluate(
                `document.querySelector('form.look-duplicate button[type=submit], form.look-duplicate button:not([type])').click()`,
            );
            await see(
                page,
                `document.querySelector('.font-title')?.textContent.includes(${JSON.stringify(madeName)})`,
                "a real theme copy is selected",
            );
            await see(
                page,
                `document.querySelector('.notice-text')?.textContent.includes('已创建')`,
                "translated creation notice",
            );
            await capture(page, `${viewport}-copy-created`, "[data-sheet=appearance]");
            await value(
                page,
                `const button=[...document.querySelectorAll('.look-tools button')].find(e=>e.textContent.trim()==='移除');button.click();return true;`,
            );
            await see(
                page,
                `document.querySelector('.font-title')?.textContent.includes('Pocket') && !document.querySelector('.font-title')?.textContent.includes('Copied')`,
                "temporary copied theme removed",
            );
            assert.ok(
                page
                    .logs()
                    .some(
                        (entry) =>
                            entry.level === "dialog" &&
                            entry.text.includes(`移除主题“${madeName}”`),
                    ),
                "the actual removal confirmation is Chinese",
            );
            await value(
                page,
                `const button=[...document.querySelectorAll('.look-tools button')].find(e=>e.textContent.includes('创建配色副本'));button.click();return true;`,
            );
            await see(
                page,
                `document.querySelector('form.look-duplicate')`,
                "color-copy naming branch",
            );
            await capture(page, `${viewport}-colors-copy`, "form.look-duplicate");
        } finally {
            page.close();
        }
    });
}
