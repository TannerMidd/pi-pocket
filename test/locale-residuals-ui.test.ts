// Reproduce the independent review's actual display paths with the built-in pack and isolated desktop data.
import {
    type App,
    cleanUp,
    home,
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

const evidence = process.env.PI_POCKET_LOCALE_RESIDUAL_EVIDENCE_DIR;
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const observations: unknown[] = [];
let app: App;
let server: Server;
let browsers: Browsers;
let session: ConversationId;
let base = "";
let guestToken = "";
let nextPage = 0;

before(async () => {
    assert.ok(findBrowser(), "Chromium is required for the residual display regressions");
    // Only this test process reads the temporary desktop fixture. No actual desktop settings are changed.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const current = join(home, ".local/state/omarchy/current");

    mkdirSync(join(current, "theme"), { recursive: true });
    writeFileSync(join(current, "theme.name"), "nyxuri\n");
    writeFileSync(
        join(current, "theme/colors.toml"),
        'background = "#111111"\nforeground = "#eeeeee"\naccent = "#aabbcc"\n',
    );
    const model = scriptedModel();

    Object.assign(
        model.models.find((each) => each.id === "faux-1")!,
        { reasoning: true },
    );
    app = await openApp(model, join(root, "locale-residuals"));
    session = await newSession(app);
    await app.commands.configure(session, owner(app), { thinkingLevel: "high" });
    guestToken = app.config.addUser("Owner", "guest").token;
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
    base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "residual-browser-")),
        load: async () => undefined,
        save: () => {},
    });
});

after(async () => {
    if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(
            join(evidence, "display-results.json"),
            JSON.stringify(observations, null, 2),
        );
    }

    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.close();

    if (previousHome === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
    } else {
        process.env.USERPROFILE = previousUserProfile;
    }

    cleanUp();
});

async function value<T>(page: BrowserPage, script: string): Promise<T> {
    return JSON.parse(
        await page.evaluate(`return JSON.stringify(await (async () => { ${script} })())`),
    ) as T;
}

async function see(page: BrowserPage, expression: string, name: string) {
    await until(() => value<boolean>(page, `return Boolean(${expression})`), name, 15000);
}

async function language(page: BrowserPage, id: "en" | "zh-CN") {
    await page.evaluate(`(await import('/ui-locale.js')).setLocale(${JSON.stringify(id)})`);
    await see(page, `document.documentElement.lang === ${JSON.stringify(id)}`, `language ${id}`);
}

async function open(viewport: "mobile" | "desktop") {
    const page = await browsers.open(++nextPage);

    await page.setViewport(VIEWPORTS[viewport]);
    await page.navigate(`${base}/login?token=${encodeURIComponent(guestToken)}&next=/s/${session}`);
    await see(
        page,
        `(await import('/store.js')).store.state.me?.role === 'guest' && document.querySelector('.composer textarea')`,
        "the real guest session",
    );
    await see(
        page,
        `(await import('/ui-locale.js')).languages().some(each=>each.id==='zh-CN')`,
        "the default Chinese pack",
    );
    await language(page, "zh-CN");
    assert.equal(
        await value<string>(page, "return (await import('/store.js')).store.state.me.name"),
        "Owner",
        "a user named Owner is not translated",
    );

    return page;
}

async function capture(page: BrowserPage, name: string, actual: string) {
    let screenshot: string | undefined;

    if (evidence) {
        await page.evaluate(
            `await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
        mkdirSync(evidence, { recursive: true });
        screenshot = `${name}.jpg`;
        const image = (await page.screenshot()).data;

        writeFileSync(
            join(evidence, screenshot),
            Buffer.isBuffer(image) ? image : Buffer.from(image as string, "base64"),
        );
    }

    observations.push({
        name,
        actual,
        role: await value<string>(page, "return (await import('/store.js')).store.state.me.role"),
        language: await value<string>(page, "return document.documentElement.lang"),
        ...(screenshot ? { screenshot } : {}),
    });
}

async function desktopItem(page: BrowserPage) {
    await see(
        page,
        `(await import('/store.js')).store.state.desktopTheme?.name === 'nyxuri'`,
        "desktop data from the real theme route",
    );
    await page.press("Control+K");
    await see(page, `document.querySelector('.launcher input')`, "the actual launcher");
    await page.evaluate(
        `const input=document.querySelector('.launcher input'); input.value='#nyxuri'; input.dispatchEvent(new Event('input',{bubbles:true}));`,
    );
    await see(
        page,
        `[...document.querySelectorAll('.launcher-item')].some(e=>e.textContent.includes('nyxuri'))`,
        "desktop palette in launcher results",
    );

    return value<string>(
        page,
        `const item=[...document.querySelectorAll('.launcher-item')].find(e=>e.textContent.includes('nyxuri')); item.scrollIntoView({block:'center'}); return item.textContent.replace(/\\s+/g,' ').trim();`,
    );
}

for (const viewport of ["mobile", "desktop"] as const) {
    test(`residual ${viewport}: launcher translates the desktop category but keeps the theme name`, async () => {
        const page = await open(viewport);

        try {
            const actual = await desktopItem(page);

            await capture(page, `${viewport}-desktop-name`, actual);
            assert.ok(actual.includes("桌面 · nyxuri"), actual);
            assert.ok(!actual.includes("Desktop ·"), actual);
            await language(page, "en");
            await see(
                page,
                `document.querySelector('.launcher')?.textContent.includes('Desktop · nyxuri')`,
                "English launcher fallback",
            );
            await language(page, "zh-CN");
            await see(
                page,
                `document.querySelector('.launcher')?.textContent.includes('桌面 · nyxuri')`,
                "launcher updates without refresh",
            );
            await page.navigate(`${base}/s/${session}`);
            await see(
                page,
                `document.querySelector('.composer textarea') && document.documentElement.lang==='zh-CN'`,
                "Chinese preference survives refresh",
            );
            assert.ok((await desktopItem(page)).includes("桌面 · nyxuri"));
        } finally {
            page.close();
        }
    });

    test(`residual ${viewport}: session notice uses the visible thinking-level label`, async () => {
        const page = await open(viewport);

        try {
            await page.evaluate(
                `const parsed=(await import('/commands.js')).parseCommand('/session'); parsed.command.run(parsed.arg);`,
            );
            await see(
                page,
                `document.querySelector('.notice-text')?.textContent.includes('faux-1')`,
                "the real session notice",
            );
            const actual = await value<string>(
                page,
                "return document.querySelector('.notice-text').textContent",
            );

            await capture(page, `${viewport}-session-level`, actual);
            assert.ok(actual.includes("faux-1 (高)"), actual);
            assert.ok(!actual.includes("(high)"), actual);
            assert.ok(actual.includes("上下文"), actual);
            assert.equal(
                await value<string>(
                    page,
                    "return (await import('/store.js')).store.state.view.agent.thinkingLevel",
                ),
                "high",
                "the saved level identifier does not change",
            );
            await language(page, "en");
            await page.evaluate(
                `const parsed=(await import('/commands.js')).parseCommand('/session'); parsed.command.run(parsed.arg);`,
            );
            await see(
                page,
                `[...document.querySelectorAll('.notice-text')].some(e=>e.textContent.includes('faux-1 (high)'))`,
                "English session fallback",
            );
        } finally {
            page.close();
        }
    });

    for (const [file, title] of [
        ["memory.ts", "记忆"],
        ["updates.ts", "Pi Pocket 更新"],
    ] as const) {
        test(`residual ${viewport}: ${file} summary translates its fixed owner role`, async () => {
            const page = await open(viewport);

            try {
                await page.evaluate(`(await import('/store.js')).openSheet({type:'extensions'})`);
                await see(
                    page,
                    `document.querySelector('.ext-row-title')`,
                    "actual built-in metadata rows",
                );
                const actual = await value<string>(
                    page,
                    `const row=[...document.querySelectorAll('.ext-row')].find(e=>e.querySelector('.ext-row-title')?.textContent.trim()===${JSON.stringify(title)}); if(!row)throw new Error('No module row'); row.scrollIntoView({block:'center'}); return row.querySelector('.ext-row-desc').textContent;`,
                );

                await capture(page, `${viewport}-${file}-summary`, actual);
                assert.ok(actual.includes("所有者"), actual);
                assert.ok(!actual.includes("Owner"), actual);
                assert.equal(
                    await value<string>(
                        page,
                        "return (await import('/store.js')).store.state.me.name",
                    ),
                    "Owner",
                );
                const module = (
                    await app.extensions(app.config.userByToken(guestToken)!)
                ).modules.find((each) => each.file === file)!;

                assert.equal(module.file, file, "module identifiers do not change");
                await language(page, "en");
                await see(
                    page,
                    `[...document.querySelectorAll('.ext-row')].some(e=>e.querySelector('.ext-row-desc')?.textContent===${JSON.stringify(module.summary)})`,
                    "original English module summary",
                );
            } finally {
                page.close();
            }
        });
    }

    test(`residual ${viewport}: PiP uses the same visible thinking-level label`, async () => {
        const pip = await app.pip.ensure(owner(app));

        await app.commands.configure(pip, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "high",
        });
        const page = await browsers.open(++nextPage);

        try {
            await page.setViewport(VIEWPORTS[viewport]);
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${session}`,
            );
            await see(
                page,
                `(await import('/store.js')).store.state.me?.role==='owner' && document.querySelector('.composer textarea')`,
                "the isolated owner session",
            );
            await language(page, "zh-CN");
            await page.evaluate(`(await import('/pip.js')).openPip()`);
            await see(
                page,
                `document.querySelector('.pip-model .model-level')?.textContent === '高'`,
                "PiP translated level",
            );
            const actual = await value<string>(
                page,
                "return document.querySelector('.pip-model').textContent.replace(/\\s+/g,' ').trim()",
            );

            await capture(page, `${viewport}-pip-level`, actual);
            assert.ok(actual.includes("高"), actual);
            assert.equal(
                await value<string>(
                    page,
                    "return (await import('/store.js')).store.state.pipView.agent.thinkingLevel",
                ),
                "high",
            );
            await language(page, "en");
            await see(
                page,
                `document.querySelector('.pip-model .model-level')?.textContent === 'high'`,
                "PiP English fallback",
            );
        } finally {
            page.close();
        }
    });
}
