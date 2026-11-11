// WP5 panels use the real browser locale, with all app and browser data in temporary folders.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { WP5_WORDS } from "./wp5-catalog.ts";

// Load an isolated English catalog before the real app imports it. No translation function is replaced.
const productionEnglish = new URL("../web/locales/en.js", import.meta.url);
const originalEnglish = await import(productionEnglish.href);
const english = Object.fromEntries(WP5_WORDS.map(([key, text]) => [key, text]));
const chinese = Object.fromEntries(WP5_WORDS.map(([key, , text]) => [key, text]));
const names = (text: string) =>
    [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((each) => each[1]))].sort();

assert.equal(WP5_WORDS.length, 514);
assert.equal(Object.keys(english).length, WP5_WORDS.length);

for (const [key, text, translated] of WP5_WORDS) {
    assert.deepEqual(names(translated), names(text), `placeholder names for ${key}`);

    if (Object.hasOwn(originalEnglish.EN, key)) {
        assert.equal(originalEnglish.EN[key], text, `live English for ${key}`);
    }
}

const mergedEnglish = { ...originalEnglish.EN, ...english };
const englishUrl = `data:text/javascript,${encodeURIComponent(`export const EN_LABEL = ${JSON.stringify(originalEnglish.EN_LABEL)}; export const EN = Object.freeze(${JSON.stringify(mergedEnglish)});`)}`;

registerHooks({
    resolve(specifier, context, next) {
        const resolved = next(specifier, context);

        return resolved.url === productionEnglish.href
            ? { url: englishUrl, shortCircuit: true }
            : resolved;
    },
});

const { cleanUp, newSession, openApp, owner, root, scriptedModel, until, work } =
    await import("./helpers.ts");
const { Browsers } = await import("../src/server/browser.ts");
const { findBrowser } = await import("../src/server/browser/discovery.ts");
const { VIEWPORTS } = await import("../src/server/browser/viewport.ts");
const { createHandler } = await import("../src/server/http.ts");

type App = Awaited<ReturnType<typeof openApp>>;

const data = join(root, "wp5-data");
const path = join(work, "wp5-literal-path.txt");
const fileText = "Close\nnpm test -- --token=wp5-command-token\n";
const title = "Close <img src=x onerror=window.wp5Injected=1>";
const person = "Close";
const extensionLabel = "Close";
const search = "Close wp5 <img src=x onerror=window.wp5Injected=2>";
const provider = "Close wp5 provider";
const verificationUrl = "https://example.test/Close?token=Close";
const providerCode = "Close-7X42";
const scope = "document.querySelector('.sheet-host:not(.leaving)')";

let app: App;
let server: Server;
let browsers: InstanceType<typeof Browsers>;
let page: BrowserPage;
let session: ConversationId;

async function value<T>(expression: string): Promise<T> {
    return JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;
}

async function see(expression: string, what: string, timeout = 15_000): Promise<void> {
    await until(() => value<boolean>(`Boolean(${expression})`), what, timeout);
}

async function language(id: "en" | "zh-CN" | "fr"): Promise<void> {
    await page.evaluate(`(await import('/ui-locale.js')).setLocale(${JSON.stringify(id)})`);
    await see(`document.documentElement.lang === ${JSON.stringify(id)}`, `language ${id}`);
}

async function open(sheet: Record<string, unknown>, selector: string): Promise<void> {
    await page.evaluate(`(await import('/store.js')).openSheet(${JSON.stringify(sheet)})`);
    await see(`${scope}?.querySelector(${JSON.stringify(selector)})`, `sheet ${sheet.type}`);
}

function sheetText(): Promise<string> {
    return value<string>(`${scope}?.textContent ?? ''`);
}

async function contains(expected: string, what: string): Promise<void> {
    await see(`${scope}?.textContent.includes(${JSON.stringify(expected)})`, what);
}

async function setInput(selector: string, input: string): Promise<void> {
    await page.evaluate(`
        const field = ${scope}.querySelector(${JSON.stringify(selector)});
        if (!field) throw new Error('Missing input: ' + ${JSON.stringify(selector)});
        field.value = ${JSON.stringify(input)};
        field.dispatchEvent(new Event('input', { bubbles: true }));
    `);
}

before(async () => {
    assert.ok(findBrowser(), "Chromium is required; WP5 UI tests do not skip");
    mkdirSync(join(data, "extensions"), { recursive: true });
    writeFileSync(path, fileText);
    writeFileSync(
        join(data, "extensions", "wp5-zh.ts"),
        `/** WP5 proposed words; production catalogs remain untouched. */
export default (_host, web) => web.uiLocales([{ id: "zh-CN", label: "简体中文", messages: ${JSON.stringify(chinese)} }]);\n`,
    );
    writeFileSync(
        join(data, "extensions", "wp5-sparse.ts"),
        `/** Sparse language for English fallback tests. */
export default (_host, web) => web.uiLocales([{ id: "fr", label: "Français", messages: {
    "web.sheets.shortcuts.shortcuts-sheet.title.keyboard-shortcuts": "Raccourcis"
} }]);\n`,
    );
    writeFileSync(
        join(data, "extensions", "wp5-keys.ts"),
        `/** An extension-owned shortcut label. */
export default (_host, web) => web.client("wp5-keys.js", { access: "view" });\n`,
    );
    writeFileSync(
        join(data, "extensions", "wp5-keys.js"),
        `export default (pocket) => pocket.composerKey({
    id: "wp5-key", keys: "Ctrl+Shift+Q", label: ${JSON.stringify(extensionLabel)}, run() {}
});\n`,
    );
    const model = scriptedModel();

    Object.assign(
        model.models.find((each) => each.id === "faux-1")!,
        { reasoning: true },
    );
    app = await openApp(model, data);
    session = await newSession(app);
    await app.commands.updateSession(session, owner(app), { title });
    app.config.addUser(person, "viewer");
    await app.spend.setSessionBudget(owner(app), session, 12.34);
    await app.setExtensionEnabled(owner(app), "wp5-zh.ts", true);
    await app.setExtensionEnabled(owner(app), "wp5-sparse.ts", true);
    await app.setExtensionEnabled(owner(app), "wp5-keys.ts", true);
    const installed = (await app.extensions(owner(app))).modules.find(
        (each) => each.file === "wp5-zh.ts",
    );

    assert.ok(installed, "the temporary Chinese overlay is installed");
    assert.equal(installed.enabled, true);
    assert.equal(installed.error, undefined);
    const catalog = app.webs.locales.snapshot().locales.find((each) => each.id === "zh-CN");

    assert.ok(catalog, "the real locale registry publishes the overlay");

    for (const [key, , translated] of WP5_WORDS) {
        assert.equal(catalog.messages[key], translated, `published Chinese for ${key}`);
    }

    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const browserEnglish = `export const EN_LABEL = ${JSON.stringify(originalEnglish.EN_LABEL)}; export const EN = Object.freeze(${JSON.stringify(mergedEnglish)});`;

    server = createServer((request, response) => {
        if (new URL(request.url ?? "/", "http://127.0.0.1").pathname === "/locales/en.js") {
            response.writeHead(200, {
                "content-type": "text/javascript; charset=utf-8",
                "cache-control": "no-store",
            });
            response.end(browserEnglish);

            return;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "wp5-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`(await import('/store.js')).store.state.me?.role === 'owner'`, "the isolated owner");
    await page.navigate(`${base}/s/${session}`);
    await see(
        `(await import('/store.js')).store.state.view.conversation?.id === ${Number(session)}`,
        "the isolated session",
    );
    await see(`(await import('/store.js')).store.state.connection === 'open'`, "the event stream");
    await see(
        `(await import('/ui-locale.js')).languages().some((item) => item.id === 'zh-CN')`,
        "the Chinese catalog",
    );
    await see(
        `(await import('/ui-locale.js')).languages().some((item) => item.id === 'fr')`,
        "the sparse catalog",
    );
    await see(
        `(await import('/box-keys.js')).boxKeyRows().some((row) => row[1] === 'Close (wp5-keys)')`,
        "the extension shortcut",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.close();
    cleanUp();
});

test("shortcuts redraw in place, keep shortcut keys and extension labels, and fall back to English", async () => {
    await language("en");
    await open({ type: "shortcuts" }, '[data-sheet="shortcuts"]');
    await contains("Launcher: sessions, actions, themes", "the English shortcut description");
    await contains("Close (wp5-keys)", "the extension shortcut label");
    await page.evaluate(
        `window.wp5ShortcutSheet = ${scope}.querySelector('[data-sheet="shortcuts"]')`,
    );
    const keycaps = await value<string[]>(
        `[...${scope}.querySelectorAll('dl.shortcuts dt')].map((each) => each.textContent)`,
    );
    const keys = await value<string[][]>(
        `[...${scope}.querySelectorAll('dl.shortcuts dt')].map((each) => [...each.querySelectorAll('kbd')].map((key) => key.textContent))`,
    );

    assert.ok(keycaps.some((text) => text.includes("Ctrl") && text.includes("K")));
    assert.ok(
        keycaps.some(
            (text) => text.includes("Ctrl") && text.includes("Shift") && text.includes("Q"),
        ),
    );
    assert.ok(keycaps.some((text) => text.includes("!")));
    await language("zh-CN");
    await contains("启动器：会话、操作和主题", "the Chinese shortcut description");
    assert.equal(
        await value(
            `${scope}.querySelector('[data-sheet="shortcuts"]') === window.wp5ShortcutSheet`,
        ),
        true,
    );
    assert.deepEqual(
        await value(
            `[...${scope}.querySelectorAll('dl.shortcuts dt')].map((each) => each.textContent)`,
        ),
        keycaps.map((text) => text.replaceAll("or", "或").replaceAll("Click", "点击")),
    );
    assert.deepEqual(
        await value(
            `[...${scope}.querySelectorAll('dl.shortcuts dt')].map((each) => [...each.querySelectorAll('kbd')].map((key) => key.textContent))`,
        ),
        keys.map((chord) => chord.filter((key) => key !== "Click")),
    );
    assert.ok((await sheetText()).includes("Close (wp5-keys)"), "extension text is not translated");

    await language("fr");
    await contains("Raccourcis", "the sparse catalog title");
    await contains(
        "Launcher: sessions, actions, themes",
        "the missing shortcut description falls back to English",
    );
    assert.deepEqual(
        await value(
            `[...${scope}.querySelectorAll('dl.shortcuts dt')].map((each) => each.textContent)`,
        ),
        keycaps,
    );
    assert.deepEqual(
        await value(
            `[...${scope}.querySelectorAll('dl.shortcuts dt')].map((each) => [...each.querySelectorAll('kbd')].map((key) => key.textContent))`,
        ),
        keys,
    );
    assert.ok((await sheetText()).includes("Close (wp5-keys)"));
});

test("model and provider names stay literal; named search values are translated and escaped", async () => {
    await language("en");
    await open({ type: "model" }, ".model-menu");
    await contains("faux-1", "the actual model name");
    await contains("faux", "the actual provider id");
    const modelRow = await value<{ name: string; sub: string; title: string }>(`(() => {
        const rows = [...${scope}.querySelectorAll('.model-menu .pop-menu-row')];
        const row = rows.find((each) => each.querySelector('.pop-menu-row-name')?.textContent.includes('faux-1'));
        return { name: row.querySelector('.pop-menu-row-name').textContent.trim(),
            sub: row.querySelector('.pop-menu-row-sub').textContent.trim(), title: row.title };
    })()`);

    await language("zh-CN");
    await contains("模型提供方", "the model menu translates");
    assert.equal(
        await value(`${scope}.querySelector('.model-menu .pop-menu-row-name').textContent.trim()`),
        modelRow.name,
    );
    assert.ok((await sheetText()).includes("faux"), "the provider id is not translated");
    assert.ok(
        await value<boolean>(
            `${scope}.querySelector('.model-menu .pop-menu-row').title.includes('faux/faux-1')`,
        ),
    );

    await language("en");
    await open({ type: "providers" }, '[data-sheet="providers"]');
    await open({ type: "model", query: search }, ".model-menu input");
    await contains(`No model matches “${search}”.`, "the English named model search");
    await language("zh-CN");
    await contains(`没有匹配的模型：“${search}”。`, "the Chinese named model search");
    assert.equal(await value(`${scope}.querySelector('.model-menu input').value`), search);
    assert.equal(await value(`${scope}.querySelectorAll('.model-menu img').length`), 0);
    assert.equal(await value("window.wp5Injected === undefined"), true);

    await language("en");
    await open({ type: "providers" }, '[data-sheet="providers"] .providers-main input');
    await contains("~/.pi/agent/auth.json", "the provider auth path");
    await setInput('[data-sheet="providers"] .providers-main input', search);
    await contains(`No providers match “${search}”.`, "the English named provider search");
    await language("zh-CN");
    await contains(`没有匹配“${search}”的模型提供方。`, "the Chinese named provider search");
    assert.equal(
        await value(
            `${scope}.querySelector('[data-sheet="providers"] .providers-main input').value`,
        ),
        search,
    );
    assert.ok((await sheetText()).includes("~/.pi/agent/auth.json"));
    assert.equal(
        await value(
            `${scope}.querySelectorAll('[data-sheet="providers"] .launcher-empty img').length`,
        ),
        0,
    );
    assert.equal(await value("window.wp5Injected === undefined"), true);
});

test("thinking choices redraw after a language switch and keep their selection", async () => {
    await language("en");
    await open({ type: "model" }, ".model-menu .model-levels");
    await see(`${scope}.querySelector('.model-levels button')`, "the thinking choices");
    await page.evaluate(`window.wp5ModelMenu = ${scope}.querySelector('.model-menu')`);
    const before = await value<{ labels: string[]; selected: string[] }>(`(() => {
        const buttons = [...${scope}.querySelectorAll('.model-levels button')];
        return { labels: buttons.map((each) => each.textContent.trim()), selected: buttons.map((each) => each.getAttribute('aria-checked')) };
    })()`);

    assert.ok(before.labels.includes("off"));
    await language("zh-CN");
    await see(
        `[...${scope}.querySelectorAll('.model-levels button')].some((each) => each.textContent.trim() === '关')`,
        "the Chinese off choice",
    );
    const after = await value<{ same: boolean; labels: string[]; selected: string[] }>(`(() => {
        const buttons = [...${scope}.querySelectorAll('.model-levels button')];
        return { same: ${scope}.querySelector('.model-menu') === window.wp5ModelMenu,
            labels: buttons.map((each) => each.textContent.trim()), selected: buttons.map((each) => each.getAttribute('aria-checked')) };
    })()`);

    assert.equal(after.same, true);
    assert.ok(after.labels.includes("关"));
    assert.deepEqual(after.selected, before.selected);
});

test("provider authentication leaves its name, code, URL, token, and provider instructions unchanged", async () => {
    await language("en");
    await open({ type: "providers" }, '[data-sheet="providers"]');
    await page.evaluate(`(await import('/store.js')).store.set({ auth: {
        flowId: 'wp5-fixture-flow', providerName: ${JSON.stringify(provider)}, done: null,
        prompt: null, events: [{ type: 'device_code', verificationUri: ${JSON.stringify(verificationUrl)}, userCode: ${JSON.stringify(providerCode)} },
            { type: 'message', message: 'Close' }]
    } })`);

    try {
        await contains(providerCode, "the provider code");
        assert.ok((await sheetText()).includes(`Sign in: ${provider}`));
        await language("zh-CN");
        await contains(`登录：${provider}`, "the translated authentication title");
        assert.equal(
            await value(`${scope}.querySelector('.auth-inline .code-big').textContent`),
            providerCode,
        );
        assert.equal(
            await value(`${scope}.querySelector('.auth-inline a').getAttribute('href')`),
            verificationUrl,
        );
        assert.ok((await sheetText()).includes(verificationUrl));
        assert.ok((await sheetText()).includes("Close"), "provider instructions stay literal");
    } finally {
        await page.evaluate(`(await import('/store.js')).store.set({ auth: null })`);
    }
});

test("people and file content remain literal while labels and named values change language", async () => {
    await language("en");
    await open({ type: "people" }, '[data-sheet="people"]');
    await contains(person, "the isolated person's name");
    await language("zh-CN");
    await contains("成员", "the Chinese people sheet");
    assert.ok((await sheetText()).includes(person), "the person's name is not translated");
    assert.equal(await value(`${scope}.querySelectorAll('[data-sheet="people"] img').length`), 0);

    await language("en");
    await open({ type: "file", id: path }, ".file-view");
    await contains("2 lines", "the English file line count");
    assert.ok((await sheetText()).includes("npm test -- --token=wp5-command-token"));
    assert.equal(await value(`${scope}.querySelector('.file-path').getAttribute('title')`), path);
    await language("zh-CN");
    await contains("2 行", "the Chinese file line count");
    assert.ok((await sheetText()).includes("npm test -- --token=wp5-command-token"));
    assert.ok((await sheetText()).includes("Close"), "file content is not translated");
    assert.equal(await value(`${scope}.querySelector('.file-path').getAttribute('title')`), path);
});

test("find and spend render their named values without changing user text", async () => {
    await language("en");
    await open({ type: "find", query: search }, '[data-sheet="find"] .find-input');
    await contains(`Nothing here says “${search}”.`, "the English find result");
    await language("zh-CN");
    await contains(`这里没有提到“${search}”。`, "the Chinese find result");
    assert.equal(await value(`${scope}.querySelector('.find-input').value`), search);
    assert.equal(await value(`${scope}.querySelectorAll('[data-sheet="find"] img').length`), 0);
    assert.equal(await value("window.wp5Injected === undefined"), true);

    await language("en");
    await open({ type: "spend" }, '[data-sheet="spend"]');
    await contains(title, "the session title in spend");
    await contains("limit $12.34", "the English spend limit");
    await language("zh-CN");
    await contains("限额 $12.34", "the Chinese spend limit");
    assert.ok((await sheetText()).includes(title), "the session title stays literal");
    assert.equal(await value(`${scope}.querySelectorAll('[data-sheet="spend"] img').length`), 0);
    assert.equal(await value("window.wp5Injected === undefined"), true);
});

test("provider wait choices redraw on language switch without changing their values", async () => {
    await language("en");
    await open({ type: "providers" }, '[data-sheet="providers"] .limit-wait');
    await contains("1 hour", "the English provider wait choice");
    await page.evaluate(
        `window.wp5ProviderSheet = ${scope}.querySelector('[data-sheet="providers"]')`,
    );
    const before = await value<{ labels: string[]; pressed: string[] }>(`(() => {
        const buttons = [...${scope}.querySelectorAll('.limit-wait button')];
        return { labels: buttons.map((each) => each.textContent.trim()), pressed: buttons.map((each) => each.getAttribute('aria-pressed')) };
    })()`);

    assert.ok(before.labels.includes("Off"));
    assert.ok(before.labels.includes("1 hour"));
    await language("zh-CN");
    await contains("1 小时", "the Chinese provider wait choice");
    const after = await value<{ same: boolean; labels: string[]; pressed: string[] }>(`(() => {
        const buttons = [...${scope}.querySelectorAll('.limit-wait button')];
        return { same: ${scope}.querySelector('[data-sheet="providers"]') === window.wp5ProviderSheet,
            labels: buttons.map((each) => each.textContent.trim()), pressed: buttons.map((each) => each.getAttribute('aria-pressed')) };
    })()`);

    assert.equal(after.same, true);
    assert.ok(after.labels.includes("关闭"));
    assert.ok(after.labels.includes("1 小时"));
    assert.deepEqual(after.pressed, before.pressed);
});

test("invite role help and durations redraw in place; the session title and token stay literal", async () => {
    await language("en");
    await open({ type: "invite", session: Number(session) }, '[data-sheet="invite"]');
    await contains(
        "Can steer Pi, which can run commands on this machine",
        "the English guest help",
    );
    await contains("15 min", "the English invite duration");
    await contains(title, "the isolated session title");
    await see(`${scope}.querySelector('.invite-code-value')`, "the isolated invite code");
    await page.evaluate(`window.wp5InviteSheet = ${scope}.querySelector('[data-sheet="invite"]')`);
    const code = await value<string>(
        `${scope}.querySelector('.invite-code-value').textContent.replace(/\\s/g, '')`,
    );

    assert.ok(code.length > 0);
    await language("zh-CN");
    await contains("可以操作 Pi，包括在此设备上运行命令", "the Chinese guest help");
    await contains("15 分钟", "the Chinese invite duration");
    assert.equal(
        await value(`${scope}.querySelector('[data-sheet="invite"]') === window.wp5InviteSheet`),
        true,
    );
    assert.ok((await sheetText()).includes(title));
    assert.equal(
        await value(`${scope}.querySelector('.invite-code-value').textContent.replace(/\\s/g, '')`),
        code,
    );
    assert.equal(await value(`${scope}.querySelectorAll('[data-sheet="invite"] img').length`), 0);
    assert.equal(await value("window.wp5Injected === undefined"), true);
});
