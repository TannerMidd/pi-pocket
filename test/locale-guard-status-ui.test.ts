// Verify the original Guard status-line button through a real temporary app and the installed guard, not a settings row.
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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const evidence = process.env.PI_POCKET_LOCALE_RESIDUAL_EVIDENCE_DIR;
const installed = process.env.PI_POCKET_LOCALE_TEST_LANCET_DIR;
const previous = Object.fromEntries(
    ["HOME", "USERPROFILE", "PI_POCKET_GUARD", "PI_POCKET_LANCET_DIR"].map((name) => [
        name,
        process.env[name],
    ]),
);
const records: unknown[] = [];
const completed = new Set<"mobile" | "desktop">();
let app: App;
let server: Server;
let browsers: Browsers;
let base = "";
let token = "";
let session = 0;
let unavailable: string | undefined;

before(async () => {
    if (!installed || !existsSync(join(installed, "src/gate.ts"))) {
        unavailable =
            "The installed Lancet Guard path was not supplied; the original status-line path is unverified.";

        return;
    }

    assert.ok(findBrowser(), "Chromium is required for the Guard status-line verification");
    // These settings belong only to this test process's temporary home, never the user's global guard settings.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PI_POCKET_LANCET_DIR = installed;
    delete process.env.PI_POCKET_GUARD;
    mkdirSync(join(home, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi/lancet-guard.json"), '{"enabled":false}\n');
    app = await openApp(scriptedModel(), join(root, "guard-status-locale"));
    const status = await app.guard.status();

    if (!status.available) {
        unavailable = `The real installed Guard cannot provide an available state: ${status.detail}`;

        return;
    }

    assert.equal(app.guard.settingsFile, join(home, ".pi/lancet-guard.json"));
    // Only the app's isolated configuration has this switch off. No risky tool is executed here.
    await app.setExtensionEnabled(owner(app), "guard.ts", false);
    session = Number(await newSession(app));
    token = app.config.addUser("Guard guest", "guest").token;
    const actual = await app.guardStatus();

    assert.equal(actual.available, true);
    assert.equal(actual.enabled, false);
    assert.equal(
        actual.detail,
        "Lancet Guard is off in Pi Pocket: bash, background, write, and edit calls run unchecked here.",
    );
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
    base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "guard-status-browser-")),
        load: async () => undefined,
        save: () => {},
    });
});

after(async () => {
    if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(
            join(evidence, "guard-status-results.json"),
            JSON.stringify(
                {
                    status: unavailable
                        ? "未验证"
                        : completed.size === 2 && records.length === 2
                          ? "通过"
                          : "失败",
                    reason: unavailable,
                    records,
                },
                null,
                2,
            ),
        );
    }

    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.close();

    for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }

    cleanUp();
});

for (const viewport of ["mobile", "desktop"] as const) {
    test(`guard ${viewport}: the actual status-line title uses the built-in Chinese pack`, async (t) => {
        if (unavailable) {
            t.skip(unavailable);

            return;
        }

        const page = await browsers.open(viewport === "mobile" ? 1 : 2);
        const value = async <T>(expression: string) =>
            JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;
        const see = (expression: string, name: string) =>
            until(() => value<boolean>(`Boolean(${expression})`), name, 15000);

        await page.setViewport(VIEWPORTS[viewport]);
        await page.navigate(`${base}/login?token=${encodeURIComponent(token)}&next=/s/${session}`);
        await see(
            `(await import('/store.js')).store.state.me?.role==='guest' && document.querySelector('.status-line .guard')`,
            "the original Guard status-line control",
        );
        await page.evaluate(`(await import('/ui-locale.js')).setLocale('zh-CN')`);
        await see(
            `document.querySelector('.status-line .guard')?.title.includes('已关闭')`,
            "Chinese Guard tooltip",
        );
        const title = await value<string>("document.querySelector('.status-line .guard').title");
        const aria = await value<string>(
            "document.querySelector('.status-line .guard').getAttribute('aria-label')",
        );

        assert.ok(title.includes("Pi Pocket 中的 Lancet Guard 已关闭"), title);
        assert.ok(!title.includes("Lancet Guard is off"), title);
        assert.equal(aria, "Lancet Guard 关");
        let screenshot: string | undefined;

        if (evidence) {
            await page.evaluate(
                `document.querySelector('.status-line .guard').scrollIntoView({block:'center'})`,
            );
            await new Promise((resolve) => setTimeout(resolve, 400));
            mkdirSync(evidence, { recursive: true });
            screenshot = `${viewport}-guard-status.jpg`;
            const image = (await page.screenshot()).data;

            writeFileSync(
                join(evidence, screenshot),
                Buffer.isBuffer(image) ? image : Buffer.from(image as string, "base64"),
            );
        }

        records.push({
            viewport,
            selector: ".status-line .guard",
            title,
            aria,
            role: "guest",
            language: "zh-CN",
            source: "real installed guard status -> PocketApp.guardStatus -> hello -> original status-line button",
            screenshot,
        });
        await page.evaluate(`(await import('/ui-locale.js')).setLocale('en')`);
        await see(
            `document.querySelector('.status-line .guard')?.title === 'Lancet Guard is off in Pi Pocket: bash, background, write, and edit calls run unchecked here.'`,
            "English Guard title fallback",
        );
        page.close();
        completed.add(viewport);
    });
}
