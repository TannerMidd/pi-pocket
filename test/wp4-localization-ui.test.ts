// Real app, real locale extension and real browser. Only the gallery's external network is replaced.
import { cleanUp, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { EN } from "../web/locales/en.js";

const messages = {
    "menu.extensions": "扩展管理-测试",
    "menu.memory": "记忆菜单-测试",
    "web.sheets.menu.menu-sheet.div.app": "应用-测试",
    "web.sheets.gallery.entry-facts.dt.author": "作者-测试",
    "web.sheets.gallery.entry-row.text.installed": "已安装-测试",
    "web.sheets.memory.lesson.button.approve": "批准-测试",
    "signin.switch-as": "继续使用 {name}",
    "web.sheets.gallery.owner.owner": "OWNER-FR",
    "web.sheets.gallery.steer.people-who-steer": "STEER-FR",
};
const INDEX = "https://raw.githubusercontent.com/TannerMidd/pi-pocket-extensions/HEAD/index.json";
const NAME = "wp4-clock";
const FILE = `${NAME}.ts`;
const commit = "a".repeat(40);
const extension = "/** Memory. */\nexport default () => undefined;\n";
const entry = {
    name: NAME,
    title: "Memory",
    description: "Extensions",
    tags: ["test"],
    author: { name: "Memory" },
    version: "1.0.0",
    source: { repo: "someone/wp4-clock", commit },
    files: [
        {
            name: FILE,
            sha256: createHash("sha256").update(extension).digest("hex"),
            size: Buffer.byteLength(extension),
        },
    ],
    pocketApi: 1,
    minPocket: "0.14.0",
    declares: {
        extensions: [NAME],
        tools: [],
        readOnlyTools: [],
        hooks: [],
        sections: [],
        wraps: [],
        routes: [],
        client: null,
        access: "owner",
    },
};

async function value<T>(page: BrowserPage, expression: string): Promise<T> {
    return JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;
}

async function see(page: BrowserPage, expression: string, description: string) {
    await until(() => value<boolean>(page, `Boolean(${expression})`), description, 15000);
}

after(cleanUp);

test(
    "WP4 real UI: locale switch, author text, fallback and memory approval",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
    },
    async (t) => {
        const data = mkdtempSync(join(root, "wp4-data-"));
        const dropIns = join(data, "extensions");

        mkdirSync(dropIns, { recursive: true });
        writeFileSync(
            join(dropIns, "wp4-locale.ts"),
            `/** Test-only locale. */\nexport default (_host, web) => web.uiLocales([{ id: "fr", label: "Français", messages: ${JSON.stringify(messages)} }]);\n`,
        );
        const app = await openApp(scriptedModel(), data);
        let server: Server | undefined;
        let browsers: Browsers | undefined;

        t.after(async () => {
            await browsers?.closeAll({ final: true });
            server?.closeAllConnections();
            server?.close();
            await app.close();
        });
        await app.setExtensionEnabled(owner(app), "wp4-locale.ts", true);

        app.gallery.fetch = async (url) => {
            if (url === INDEX) {
                return new Response(JSON.stringify({ format: 1, extensions: [entry] }));
            }

            if (url === `https://raw.githubusercontent.com/someone/wp4-clock/${commit}/${FILE}`) {
                return new Response(extension);
            }

            return new Response("", { status: 404 });
        };

        const project = join(root, "project <img src=x>");

        mkdirSync(project);
        const id = await newSession(app, project);
        const lessonText = "Memory <b>Extensions</b> {name}";
        const lesson = await app.memory.add(
            id,
            project,
            { userId: owner(app).id, byPi: true, name: "Pi" },
            { text: lessonText, scope: "project" },
        );

        assert.equal(lesson.pending, true);
        server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "wp4-browser-")),
            load: async () => undefined,
            save: () => {},
        });
        const page = await browsers.open(1);

        await page.setViewport(VIEWPORTS.mobile);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${id}`);
        await see(
            page,
            `(await import('/store.js')).store.state.connection === 'open'`,
            "connected session",
        );
        await see(
            page,
            `(await import('/ui-locale.js')).languages().some((item) => item.id === 'fr')`,
            "registered test locale",
        );
        await page.evaluate(
            `document.querySelector('.topbar [aria-haspopup="dialog"]').focus(); document.querySelector('.topbar [aria-haspopup="dialog"]').click();`,
        );
        await see(
            page,
            `[...document.querySelectorAll('.list-item')].some((item) => item.textContent.includes('Extensions'))`,
            "English menu",
        );
        assert.equal(
            await value(page, `(await import('/sheets/gallery.js')).accessWords('owner')`),
            "the owner",
        );
        await page.evaluate(`(await import('/ui-locale.js')).setLocale('fr');`);
        await see(
            page,
            `document.body.textContent.includes('扩展管理-测试') && document.body.textContent.includes('记忆菜单-测试')`,
            "translated menu without reload",
        );
        // The real registry publishes translations only after the English catalog contains each key.
        assert.equal(
            await value(page, `(await import('/sheets/gallery.js')).accessWords('owner')`),
            Object.hasOwn(EN, "web.sheets.gallery.owner.owner") ? "OWNER-FR" : "the owner",
        );
        assert.equal(
            await value(page, `(await import('/sheets/gallery.js')).accessWords('steer')`),
            Object.hasOwn(EN, "web.sheets.gallery.steer.people-who-steer")
                ? "STEER-FR"
                : "people who can steer",
        );
        assert.equal(
            await value(
                page,
                `(await import('/sheets/gallery.js')).accessWords('external-author-value')`,
            ),
            "external-author-value",
        );
        await page.press("Escape");
        await see(page, `!(await import('/store.js')).store.state.sheet`, "menu closes by Escape");
        await see(
            page,
            `document.activeElement === document.querySelector('.topbar [aria-haspopup="dialog"]')`,
            "focus returns to the menu button after a language change",
        );
        assert.equal(
            await value(
                page,
                `(await import('/ui-locale.js')).t('signin.switch-as', 'Sign in as {name}', {name: '$& <b>Memory</b> {other}'})`,
            ),
            "继续使用 $& <b>Memory</b> {other}",
        );
        assert.equal(
            await value(
                page,
                `(await import('/ui-locale.js')).t('wp4.missing', 'Fallback {name}', {name: '$& {other}'})`,
            ),
            "Fallback $& {other}",
        );
        await page.evaluate(
            `(await import('/store.js')).openSheet({ type: 'extensions', tab: 'discover' });`,
        );
        await see(
            page,
            `[...document.querySelectorAll('.ext-row-title')].some((node) => node.textContent === 'Memory')`,
            "gallery entry with author title",
        );
        assert.equal(
            await value(
                page,
                `[...document.querySelectorAll('.ext-row')].some((node) => node.textContent.includes('Extensions') && node.textContent.includes('Memory'))`,
            ),
            true,
            "author title and description stay literal",
        );
        await page.evaluate(
            `[...document.querySelectorAll('.ext-row')].find((node) => node.querySelector('.ext-row-title')?.textContent === 'Memory').querySelector('.ext-row-open').click();`,
        );
        await see(
            page,
            `document.querySelector('.extension-hub-detail')?.textContent.includes('作者-测试')`,
            "translated gallery author label",
        );
        assert.equal(
            await value(
                page,
                `document.querySelector('.extension-hub-detail')?.textContent.includes('Memory')`,
            ),
            true,
            "gallery author name stays literal",
        );
        await page.evaluate(`(await import('/store.js')).openSheet({ type: 'memory' });`);
        await see(
            page,
            `[...document.querySelectorAll('.lesson-text')].some((node) => node.textContent === ${JSON.stringify(lessonText)})`,
            "pending author lesson",
        );
        assert.equal(
            await value(
                page,
                `document.querySelector('[data-sheet="memory"] .sheet-body p')?.textContent.includes('project <img src=x>')`,
            ),
            true,
            "project name is present in the intro",
        );
        assert.equal(
            await value(
                page,
                `document.querySelector('[data-sheet="memory"] .sheet-body p img') === null`,
            ),
            true,
            "project name is escaped",
        );
        assert.equal(
            await value(
                page,
                `[...document.querySelectorAll('.lesson-text')].some((node) => node.textContent === ${JSON.stringify(lessonText)} && node.querySelector('b') === null)`,
            ),
            true,
            "author text remains literal, not translated or markup",
        );
        await see(
            page,
            `[...document.querySelectorAll('.lesson button')].some((node) => node.textContent.trim() === '批准-测试')`,
            "translated approval",
        );
        await page.evaluate(
            `[...document.querySelectorAll('.lesson button')].find((node) => node.textContent.trim() === '批准-测试').click();`,
        );
        await until(
            async () =>
                (await app.memory.view(id, owner(app))).lessons.find(
                    (item) => item.id === lesson.id,
                )?.pending === false,
            "real memory approval",
        );
        assert.equal(
            (await app.memory.view(id, owner(app))).lessons.find((item) => item.id === lesson.id)
                ?.text,
            lessonText,
        );
        await page.evaluate(`(await import('/ui-locale.js')).setLocale('en');`);
        await see(page, `document.documentElement.lang === 'en'`, "return to English");
        assert.equal(
            await value(page, `(await import('/sheets/gallery.js')).accessWords('owner')`),
            "the owner",
        );
    },
);
