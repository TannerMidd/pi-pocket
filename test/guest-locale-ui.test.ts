// Guest-visible fixed UI uses the real external Chinese pack, including built-in browser modules.
import {
    type App,
    cleanUp,
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
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { Auth } from "../src/server/auth.ts";
import { EN } from "../web/locales/en.js";
import {
    chineseModule,
    chinesePackOptions,
    chinesePackPath,
    enableExternalChinese,
    externalChinesePack,
} from "./external-chinese-pack.ts";
import type { UiLocalePack } from "../src/server/ui-locales.ts";

let chinese: UiLocalePack;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;
let guest = "";
const evidence = process.env.PI_POCKET_LOCALE_EVIDENCE_DIR;
const records: {
    name: string;
    text: string;
    controls: string[];
    lang: string;
    role?: string;
    screenshot?: string;
}[] = [];

before(async () => {
    if (chinesePackPath === undefined) {
        return;
    }

    chinese = await externalChinesePack();
    assert.ok(findBrowser(), "Chromium is required for guest locale acceptance");
    const model = scriptedModel();

    Object.assign(
        model.models.find((each) => each.id === "faux-1")!,
        { reasoning: true },
    );
    app = await openApp(model, join(root, "guest-locales"));
    await enableExternalChinese(app);
    session = await newSession(app);
    await say(
        app,
        session,
        "Keep user content in English: Guest example <img src=x>\n\n```js\nconst original = 'English code stays literal';\n```",
    );
    guest = app.config.addUser("Guest example", "guest").token;
    await app.setExtensionEnabled(owner(app), "ask-someone.ts", true);
    await app.setExtensionEnabled(owner(app), "session-tags.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
    base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "guest-locale-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(guest)}`);
    await see(
        `(await import('/store.js')).store.state.me?.role === 'guest'`,
        "the real guest is signed in",
    );
    await page.evaluate(`(await import('/ui-locale.js')).setLocale('zh-CN')`);
    await see(`document.documentElement.lang === 'zh-CN'`, "the external Chinese pack is active");
});

after(async () => {
    if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, "guest-ui-results.json"), JSON.stringify(records, null, 2));
    }

    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function value<T>(script: string): Promise<T> {
    return JSON.parse(
        await page.evaluate(`return JSON.stringify(await (async () => { ${script} })())`),
    ) as T;
}

async function see(expression: string, name: string) {
    await until(() => value<boolean>(`return Boolean(${expression})`), name, 15000);
}

async function sheet(type: string) {
    await page.evaluate(
        `(await import('/store.js')).openSheet({ type: ${JSON.stringify(type)} });`,
    );
    await see(`document.querySelector('[data-sheet=${JSON.stringify(type)}]')`, `${type} sheet`);
}

const menuButton = '.topbar button[aria-label="菜单"]';
const designPlace = '[data-sheet=menu] [data-place="ext:design:design"]';

async function guestMenu() {
    await see(`document.querySelector(${JSON.stringify(menuButton)})`, "the guest menu button");
    await page.evaluate(`document.querySelector(${JSON.stringify(menuButton)}).click()`);
    await see(`document.querySelector('[data-sheet=menu]')`, "menu");
}

async function openGuestDesign() {
    await guestMenu();
    await see(
        `document.querySelector(${JSON.stringify(designPlace)})?.getAttribute('aria-label') === '设计'`,
        "the real Design menu tile is Chinese",
    );
    await page.evaluate(`document.querySelector(${JSON.stringify(designPlace)}).click()`);
}

async function record(name: string, selector = "body") {
    const result = await value<{ text: string; controls: string[]; lang: string; role?: string }>(`
        const node=document.querySelector(${JSON.stringify(selector)});
        return { text:node?.textContent?.replace(/\\s+/g,' ').trim() ?? '',
          controls:[...node.querySelectorAll('button,input,select,[aria-label]')].map(e=>e.getAttribute('aria-label')||e.getAttribute('title')||e.getAttribute('placeholder')||e.textContent.trim()),
          lang:document.documentElement.lang, role:document.querySelector('script[type="importmap"]') ? (await import('/store.js')).store.state.me?.role : undefined };`);
    let screenshot: string | undefined;

    if (evidence) {
        await page.evaluate(
            `await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        mkdirSync(evidence, { recursive: true });
        screenshot = `${name}.jpg`;
        const image = (await page.screenshot()).data;

        writeFileSync(
            join(evidence, screenshot),
            Buffer.isBuffer(image) ? image : Buffer.from(image as string, "base64"),
        );
    }

    records.push({ name, ...result, ...(screenshot ? { screenshot } : {}) });

    return result;
}

test(
    "guest phone home, menu and settings use Chinese and keep it after refresh",
    chinesePackOptions,
    async () => {
        await page.navigate(`${base}/`);
        await see(
            `document.documentElement.lang === 'zh-CN' && document.querySelector('.session-row')`,
            "Chinese home after refresh",
        );
        const home = await record("home");

        assert.equal(home.role, "guest");
        const list = await value<{ text: string; title: string; branch: string }>(
            `const store=(await import('/store.js')).store; const query=document.querySelector('[data-part=session-search] input'); if(query){query.value='Keep user';query.dispatchEvent(new Event('input',{bubbles:true}));} return {text:document.body.textContent,title:[...document.querySelectorAll('.rail [title]')].map(e=>e.title).join(' '),branch:(await import('/commands.js')).parseCommand('/copy').command.name};`,
        );

        await see(
            `document.body.textContent.includes('匹配结果')`,
            "search result group label is Chinese",
        );
        assert.ok(list.title.includes("游客"));
        assert.equal(list.branch, "copy", "command identifiers stay unchanged");
        await page.navigate(`${base}/`);
        await see(`document.querySelector('.session-row')`, "home restored before language switch");
        await page.evaluate(`document.querySelector('[data-tab=recent]').click()`);
        const dayHeader = '[data-part="session-group-name"]';

        assert.ok(home.controls.includes("设计"), "the built-in Design rail label is translated");
        await page.evaluate(`(await import('/ui-locale.js')).setLocale('en')`);
        await see(
            `[...document.querySelectorAll('.rail-ext')].some(e=>e.getAttribute('title')==='Design')`,
            "built-in label returns to English in place",
        );
        await see(
            `document.querySelector(${JSON.stringify(dayHeader)})?.textContent.trim() === 'Today'`,
            "the English day header",
        );
        await page.evaluate(`(await import('/ui-locale.js')).setLocale('zh-CN')`);
        await see(
            `[...document.querySelectorAll('.rail-ext')].some(e=>e.getAttribute('title')==='设计')`,
            "built-in label returns to Chinese in place",
        );
        await see(
            `document.querySelector(${JSON.stringify(dayHeader)})?.textContent.trim() === '今天' && !document.body.textContent.includes('Today')`,
            "Today changes immediately without refresh",
        );
        await page.navigate(`${base}/s/${session}`);
        await see(`document.querySelector('.composer textarea')`, "conversation");
        await see(
            `document.querySelector('.code [data-copy]')`,
            "a real code block in the model reply",
        );
        assert.equal(
            await value<string>("return document.querySelector('.code [data-copy]').textContent"),
            "复制",
        );
        assert.ok(
            (
                await value<string>("return document.querySelector('.code pre').textContent")
            ).includes("English code stays literal"),
        );
        await guestMenu();
        const menu = await record("menu", "[data-sheet=menu]");

        assert.ok(!menu.text.includes("(desktop)"));

        for (const text of [
            "外观",
            "记忆",
            "定时消息",
            "问题",
            "设计",
            "导出为 Markdown",
            "完整历史",
            "应用",
            "退出登录",
        ]) {
            assert.ok(menu.text.includes(text), text);
        }

        const artifactsTile = "[data-sheet=menu] [data-place=artifacts] .place-label";
        const placesLabel =
            "document.querySelector('[data-sheet=menu] .places')?.getAttribute('aria-label')";

        await see(`${placesLabel} === '位置'`, "the menu names Places in Chinese");
        await see(
            `document.querySelector(${JSON.stringify(artifactsTile)})?.textContent === '产物'`,
            "the menu's Artifacts tile is Chinese on first open",
        );
        await page.evaluate(`(await import('/ui-locale.js')).setLocale('en')`);
        await see(`${placesLabel} === 'Places'`, "the open menu names Places in English");
        await see(
            `document.querySelector(${JSON.stringify(artifactsTile)})?.textContent === 'Artifacts'`,
            "the open menu's Artifacts tile changes to English",
        );
        await page.evaluate(`(await import('/ui-locale.js')).setLocale('zh-CN')`);
        await see(
            `document.querySelector(${JSON.stringify(artifactsTile)})?.textContent === '产物'`,
            "the open menu's Artifacts tile changes back to Chinese",
        );
        await sheet("appearance");
        const appearance = await record("appearance", "[data-sheet=appearance]");

        for (const text of [
            "平铺窗口",
            "侧栏",
            "动态效果",
            "文字大小",
            "显示思考",
            "保持活动区折叠",
            "回复速度",
        ]) {
            assert.ok(appearance.text.includes(text), text);
        }

        for (const text of [
            "Tiled windows",
            "Show thinking",
            "Keep activity folded",
            "Reply speed",
            "Always shown",
            "Move ",
        ]) {
            assert.ok(
                !appearance.text.includes(text) &&
                    !appearance.controls.some((c) => c.includes(text)),
                text,
            );
        }

        const cookie = await value<string>("return document.cookie");

        assert.match(cookie, /(?:^|;\s*)pocket_locale=zh-CN(?:;|$)/);
        assert.doesNotMatch(cookie, /(?:^|;\s*)pi_locale=/);
        await page.navigate(`${base}/s/${session}`);
        await see(
            `document.documentElement.lang === 'zh-CN' && document.querySelector('.composer textarea')`,
            "Chinese persists after refresh",
        );
        await sheet("appearance");
        assert.ok(
            (await record("appearance-refreshed", "[data-sheet=appearance]")).text.includes(
                "平铺窗口",
            ),
        );
    },
);

test(
    "guest built-in Design and question empty states use default pack, without translating prompts",
    chinesePackOptions,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await see(`document.querySelector('.composer textarea')`, "the guest session");
        await openGuestDesign();
        await see(`document.querySelector('.dsn-empty-state')`, "the real Design panel");
        const empty = await record("design-empty", ".ext-panel");
        const emptyLabel =
            chinese.messages[
                "server.extensions.design.workspace.create-workspace.empty.h3.no-designs-yet"
            ];

        assert.ok(emptyLabel, "the external pack contains the Design empty-state label");
        assert.ok(empty.text.includes(emptyLabel));
        assert.ok(!empty.text.includes("No designs yet"));
        assert.ok(!empty.text.includes("Ask Pi to design something"));
        const label = await value<string>(
            "return document.querySelector('.dsn-idea')?.textContent",
        );

        assert.ok(/[\u3400-\u9fff]/.test(label));
        await page.evaluate(`document.querySelector('.dsn-idea').click()`);
        await see(
            `document.querySelector('.composer textarea')?.value.startsWith('Design a landing page for a small coffee roaster.')`,
            "the model instruction remains English",
        );
        // Use the real menu registration instead of a synthetic component or translation pack.
        await page.evaluate(
            `(await import('/extension-ui.js')).closeExtPanel(); (await import('/store.js')).openSheet({type:'menu'});`,
        );
        await see(`document.querySelector('[data-sheet=menu]')`, "menu");
        await value(
            `const button=[...document.querySelectorAll('[data-sheet=menu] button')].find(e=>e.textContent.includes('问题')); button.click(); return true;`,
        );
        await see(`document.querySelector('.ask-sheet')`, "the real Questions sheet");
        const questions = await record("questions-empty", ".sheet:last-of-type");

        assert.ok(!questions.text.includes("No questions yet"));
        assert.ok(/[\u3400-\u9fff]/.test(questions.text));
    },
);

test(
    "guest extension metadata, command help and Design menus use the real Chinese catalog",
    chinesePackOptions,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await see(`document.querySelector('.composer textarea')`, "the guest session");
        await sheet("extensions");
        await see(`document.querySelector('.ext-row')`, "the real built-in module rows");
        const modules = await record("extensions", "[data-sheet=extensions]");
        const actualMetadata = await value<{ file: string; title: string; summary: string }[]>(
            `const api=await import('/store.js'); const locale=await import('/builtin-locales.js'); const data=await api.api('extensions'); return data.modules.filter(m=>m.source==='built-in').map(m=>({file:m.file,title:locale.moduleTitle(m),summary:locale.moduleSummary(m)}));`,
        );

        assert.ok(actualMetadata.length >= 20);
        const metadata = await value<{ title: string; summary: string }>(
            `const locale=await import('/builtin-locales.js'); const module={file:'custom.ts',source:'drop-in',title:'My Design',summary:'Keep custom content'}; return {title:locale.moduleTitle(module),summary:locale.moduleSummary(module)};`,
        );

        assert.deepEqual(metadata, { title: "My Design", summary: "Keep custom content" });

        for (const text of ["设计", "系统提示", "触发器"]) {
            assert.ok(modules.text.includes(text), text);
        }

        for (const text of ["System prompt", "A canvas beside the chat", "Who the agent is"]) {
            assert.ok(!modules.text.includes(text), text);
        }

        // The language pack is now an external module, not a built-in with localized metadata.
        const packModule = (await app.extensions(owner(app))).modules.find(
            (module) => module.file === chineseModule,
        );

        assert.ok(packModule);
        assert.equal(packModule.source, "drop-in");
        assert.ok(packModule.summary.includes("Simplified Chinese UI text"));
        const packRow = await value<{ title: string; summary: string }>(`
            const file = ${JSON.stringify(chineseModule)};
            const by = [...document.querySelectorAll('[data-sheet=extensions] .ext-row-by')]
                .find(e => e.textContent === file);
            const row = by.closest('.ext-row');
            return {title: row.querySelector('.ext-row-title').textContent,
                summary: row.querySelector('.ext-row-desc').textContent};
        `);

        assert.deepEqual(packRow, { title: packModule.title, summary: packModule.summary });
        await sheet("appearance");
        await see(
            `document.querySelector('[data-sheet=appearance] select option[value=zh-CN]')?.textContent === '简体中文'`,
            "the language chooser shows the external pack's Chinese label",
        );
        await sheet("extensions");
        await see(`document.querySelector('.ext-row')`, "extension modules after appearance");
        await value(
            `const button=[...document.querySelectorAll('.ext-row-open')].find(e=>e.textContent.includes('设计')); button.click(); return true;`,
        );
        await record("design-extension-detail", "[data-sheet=extensions]");
        await value(
            `document.querySelector('[data-sheet=extensions] .ext-row-title')?.scrollIntoView({block:'center'}); return true;`,
        );
        const commands = await value<{ name: string; args?: string; description?: string }[]>(
            `return (await import('/commands.js')).suggestCommands('/')`,
        );

        assert.ok(
            commands.some(
                (command) => command.name === "compact" && command.description?.includes("总结"),
            ),
        );
        assert.ok(
            commands.some(
                (command) =>
                    command.name === "design-open" && command.description?.includes("设计"),
            ),
        );
        assert.ok(commands.find((command) => command.name === "compact")?.args?.includes("保留"));
        assert.ok(
            commands.every(
                (command) => !command.description || /[\u3400-\u9fff]/.test(command.description),
            ),
            "all built-in command descriptions are Chinese",
        );
        await page.evaluate(
            `(await import('/store.js')).closeSheet(); const area=document.querySelector('.composer textarea'); area.value='/'; area.dispatchEvent(new Event('input',{bubbles:true}));`,
        );
        await see(
            `document.body.textContent.includes('总结较早的消息')`,
            "translated live command help",
        );
        await record("command-help");
        await page.evaluate(
            `const area=document.querySelector('.composer textarea'); area.value=''; area.dispatchEvent(new Event('input',{bubbles:true})); (await import('/store.js')).openSheet({type:'shortcuts'});`,
        );
        await see(`document.querySelector('[data-sheet=shortcuts]')`, "keyboard shortcut labels");
        const shortcuts = await record("shortcuts", "[data-sheet=shortcuts]");

        assert.ok(!shortcuts.text.includes("Click"));
        assert.ok(!shortcuts.text.includes(" or "));
        await page.evaluate(`(await import('/store.js')).closeSheet()`);
        await openGuestDesign();
        await see(
            `document.querySelector('.dsy-empty-system')`,
            "the built-in Design system entry",
        );
        await page.evaluate(`document.querySelector('.dsy-empty-system').click()`);
        await see(`document.querySelector('.dsy-blank')`, "the real design-system empty state");
        const system = await record("design-system-empty", ".ext-panel");

        for (const text of [
            "No design system yet",
            "A design system is the colors",
            "Ask Pi to scan",
        ]) {
            assert.ok(!system.text.includes(text), text);
        }

        await value(
            `const button=document.querySelector('.dsy-bar button[aria-haspopup=dialog]:last-child') || [...document.querySelectorAll('.ext-panel button')].find(e=>e.getAttribute('aria-label')==='更多'); button.click(); return true;`,
        );
        await record("design-system-menu", ".ext-panel");
        assert.ok(
            !(
                await value<string>("return document.querySelector('.ext-panel').textContent")
            ).includes("Read it again"),
        );
        const untranslated = actualMetadata.filter(
            (module) => !/[\u3400-\u9fff]/.test(module.summary ?? ""),
        );

        assert.deepEqual(untranslated, [], "every built-in module has a Chinese summary");
    },
);

test(
    "guest tag filters use Chinese with the real built-in module",
    chinesePackOptions,
    async () => {
        await page.navigate(`${base}/`);
        await see(`document.querySelector('[data-part=session-filter]')`, "the real tag filter");
        await value(
            `const button=[...document.querySelectorAll('button')].find(e=>e.getAttribute('title')==='按标签筛选' || e.getAttribute('aria-label')==='按标签筛选'); button.click(); return true;`,
        );
        await see(`document.querySelector('.tags-sheet')`, "the tag filter sheet");
        const tags = await record("tags-empty", ".sheet:last-of-type");

        assert.ok(!tags.text.includes("No tags yet"));
        assert.ok(tags.text.includes("标签"));
    },
);

test(
    "guest desktop navigation and Design titles keep Chinese on switch and refresh",
    chinesePackOptions,
    async () => {
        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/`);
        await see(
            `document.querySelector('.rail-ext[title="设计"]')`,
            "desktop Design is Chinese on first display",
        );
        await record("desktop-home");
        await page.navigate(`${base}/s/${session}`);
        await see(`document.querySelector('.composer textarea')`, "desktop real session");
        await page.evaluate(`(await import('/extension-ui.js')).openExtPanel('design','design')`);
        await see(`document.querySelector('.dsn-empty-state')`, "desktop Design");
        await record("desktop-design", ".ext-panel");
        await page.evaluate(`(await import('/ui-locale.js')).setLocale('en')`);
        await see(
            `document.querySelector('.ext-panel h2')?.textContent === 'Design'`,
            "desktop English fallback",
        );
        await page.evaluate(`(await import('/ui-locale.js')).setLocale('zh-CN')`);
        await see(
            `document.querySelector('.ext-panel h2')?.textContent === '设计'`,
            "desktop language switch",
        );
        await page.navigate(`${base}/`);
        await see(
            `document.querySelector('.rail-ext[title="设计"]')`,
            "desktop refresh keeps Chinese",
        );
        await page.setViewport(VIEWPORTS.mobile);
    },
);

test(
    "guest role labels, empty copy notice, context and thinking UI preserve identifiers",
    chinesePackOptions,
    async () => {
        const { id } = await app.commands.createSession(owner(app), {});

        await page.navigate(`${base}/s/${id}`);
        await see(`document.querySelector('.composer textarea')`, "an empty real guest session");
        await page.evaluate(
            `const command=(await import('/commands.js')).parseCommand('/copy'); command.command.run(command.arg);`,
        );
        await see(
            `document.body.textContent.includes('Pi 尚未回复')`,
            "the translated empty reply notice",
        );
        await record("copy-no-reply");
        await page.navigate(`${base}/s/${session}`);
        await app.commands.configure(session, owner(app), { thinkingLevel: "high" });
        await see(
            `document.querySelector('.model-chip')?.textContent.includes('高')`,
            "the visible thinking level is translated",
        );
        await page.evaluate(
            `const command=(await import('/commands.js')).parseCommand('/session'); command.command.run(command.arg);`,
        );
        await see(`document.body.textContent.includes('上下文')`, "context notice is translated");
        await record("context-thinking");
        await page.navigate(`${base}/`);
        await see(`document.querySelector('.rail')`, "the guest navigation");
        assert.ok(
            (
                await value<string>(
                    "return document.querySelector('.rail').textContent + [...document.querySelectorAll('.rail [title]')].map(e=>e.title).join(' ')",
                )
            ).includes("游客"),
        );
        const viewer = app.config.addUser("Viewer example", "viewer");

        await page.navigate(`${base}/login?token=${encodeURIComponent(viewer.token)}`);
        await page.evaluate(`document.querySelector('main.plain form button')?.click()`);
        await see(
            `(await import('/store.js')).store.state.me?.role === 'viewer'`,
            "the real viewer",
        );
        await record("viewer-home");
        assert.ok(
            (
                await value<string>(
                    "return [...document.querySelectorAll('.rail [title]')].map(e=>e.title).join(' ')",
                )
            ).includes("仅查看"),
        );
        await page.navigate(`${base}/login?token=${encodeURIComponent(guest)}`);

        if (
            await value<boolean>("return Boolean(document.querySelector('main.plain form button'))")
        ) {
            await page.evaluate(`document.querySelector('main.plain form button').click()`);
        }

        await see(
            `(await import('/store.js')).store.state.me?.role === 'guest'`,
            "guest identity restored",
        );
    },
);

test(
    "guest real join and login pages use Chinese, while static shell remains a browser-rendered app",
    chinesePackOptions,
    async () => {
        const auth = new Auth(app.config);
        const invite = auth.createInvite(owner(app), { role: "guest" });

        await page.navigate(`${base}/join/${invite.code}`);
        await see(`document.querySelector('main.plain')`, "join page");
        const joined = await record("join");

        assert.equal(joined.lang, "zh-CN");
        assert.ok(!joined.text.includes("Join Pi Pocket"));
        await page.navigate(`${base}/login?token=expired`);
        const login = await record("login-expired");

        assert.equal(login.lang, "zh-CN");
        assert.ok(!login.text.includes("Link expired"));
        const shell = await fetch(`${base}/`, { headers: { cookie: "pocket_locale=zh-CN" } });
        const html = await shell.text();

        assert.match(html, /<html lang="en"/);
        assert.ok(
            html.includes("starting"),
            "the static boot shell is unchanged, not converted to SSR",
        );
        assert.equal(
            Object.keys(EN).filter((key) => !Object.hasOwn(chinese.messages, key)).length,
            0,
        );
    },
);
