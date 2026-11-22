// The external Chinese entry, through the real catalog and an isolated app's drop-in loader.
import { cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";
import {
    chineseModule,
    chinesePackOptions,
    enableExternalChinese,
    externalChinesePack,
} from "./external-chinese-pack.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";
import { createHandler } from "../src/server/http.ts";
import { checkUiLocales, requestLocale, UI_LOCALE_LIMITS } from "../src/server/ui-locales.ts";
import { placeholders } from "../web/locale.js";
import { EN } from "../web/locales/en.js";
const samples = {
    "ui.close": "关闭",
    "app.menu": "菜单",
    "app.files": "文件",
    "menu.appearance": "外观",
    "appearance.title": "外观",
    "appearance.language": "语言",
    "appearance.theme": "主题",
    "appearance.colors": "配色",
    "sessions.new": "新建会话",
    "signin.name-label": "你的名字",
};

after(cleanUp);

test("a fresh app publishes only English and falls back for an unavailable Chinese preference", async () => {
    const app = await openApp(scriptedModel(), join(root, "english-only-app"));
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    try {
        const modules = (await app.extensions(owner(app))).modules;

        assert.ok(
            !modules.some(
                (each) => each.source === "built-in" && /^zh-cn(?:[.-]|$)/i.test(each.file),
            ),
            "the loader has no built-in Chinese module",
        );
        assert.deepEqual(
            app.webs.locales.snapshot().locales.map((each) => each.id),
            ["en"],
        );
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const catalog = await fetch(`${base}/ui-locales.json`);

        assert.equal(catalog.status, 200);
        const body = (await catalog.json()) as { locales: { id: string }[] };

        assert.deepEqual(
            body.locales.map((each) => each.id),
            ["en"],
        );
        const login = await fetch(`${base}/login?token=expired`, {
            headers: { cookie: "pocket_locale=zh-CN" },
        });
        const html = await login.text();

        assert.equal(login.status, 401);
        assert.match(html, /<html lang="en">/);
        assert.match(html, /Link expired/);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) =>
            server.listening ? server.close(() => resolve()) : resolve(),
        );
        await app.close();
    }
});

test(
    "the Chinese data has valid keys, matching placeholders, and fits all locale limits",
    chinesePackOptions,
    async () => {
        const chinese = await externalChinesePack();
        const keys = Object.keys(chinese.messages);
        const checked = checkUiLocales("zh-CN", [chinese]);

        assert.equal(chinese.id, "zh-CN");
        assert.equal(chinese.label, "简体中文");
        assert.ok(keys.length > 0 && keys.length <= UI_LOCALE_LIMITS.messages);
        const englishKeys = Object.keys(EN);

        assert.deepEqual(
            englishKeys.filter((key) => !Object.hasOwn(chinese.messages, key)),
            [],
            "the pack covers every live English key and retains keys for later batches",
        );
        assert.deepEqual(
            Object.keys(checked[0]!.messages).sort(),
            [...englishKeys].sort(),
            "core publishes every live English key without publishing future keys",
        );
        assert.ok(Buffer.byteLength(JSON.stringify([chinese])) <= UI_LOCALE_LIMITS.declaration);
        assert.ok(Buffer.byteLength(JSON.stringify([chinese])) <= UI_LOCALE_LIMITS.total);

        for (const [key, value] of Object.entries(chinese.messages)) {
            assert.match(key, /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
            assert.ok(key.length <= UI_LOCALE_LIMITS.key, key);
            assert.ok(
                !key
                    .split(/[._-]/)
                    .some((part) => ["prototype", "constructor", "__proto__"].includes(part)),
                key,
            );
            assert.equal(typeof value, "string", key);
            assert.ok(value.trim().length > 0 && !value.includes("\0"), key);
            assert.ok(Buffer.byteLength(value) <= UI_LOCALE_LIMITS.value, key);

            if (Object.hasOwn(EN, key)) {
                assert.deepEqual(
                    [...new Set(placeholders(value))].sort(),
                    [...new Set(placeholders(EN[key]!))].sort(),
                    `${key} keeps the English placeholder names`,
                );
            }
        }
    },
);

test(
    "the external drop-in registers Chinese and resolves 10 translated messages",
    chinesePackOptions,
    async () => {
        const app = await openApp(scriptedModel(), join(root, "zh-cn-loader"));

        try {
            await enableExternalChinese(app);
            const info = (await app.extensions(owner(app))).modules.find(
                (each) => each.file === chineseModule,
            );
            const snapshot = app.webs.locales.snapshot();
            const chinese = requestLocale(snapshot, "zh-CN");

            assert.ok(info, "the loader lists the Chinese module");
            assert.equal(info.source, "drop-in");
            assert.equal(info.enabled, true);
            assert.equal(info.error, undefined);
            assert.deepEqual(info.web?.locales, ["zh-CN"]);
            assert.equal(chinese.lang, "zh-CN");
            assert.equal(snapshot.locales.filter((each) => each.id === "zh-CN").length, 1);

            for (const [key, value] of Object.entries(samples)) {
                assert.ok(Object.hasOwn(EN, key), `${key} is an English catalog key`);
                assert.equal(chinese.t(key, EN[key]!), value, key);
                assert.notEqual(value, EN[key], key);
            }
        } finally {
            await app.close();
        }
    },
);

test("invalid locale updates are refused and keep the previously registered pack", async () => {
    const directory = mkdtempSync(join(root, "locale-invalid-"));
    const file = join(directory, "locale-fixture.ts");
    const webs = new ExtensionWebs();
    const loader = new ExtensionLoader(
        createRegistry(),
        { notice: () => {} } as unknown as PocketHost,
        { builtIn: directory },
        undefined,
        { webs },
    );
    const pack = { id: "zh-CN", label: "测试", messages: { "ui.close": "关闭" } };

    writeFileSync(
        file,
        `/** Initial locale fixture. */\nexport default (_host, web) => web.uiLocales([${JSON.stringify(pack)}]);\n`,
    );

    try {
        await loader.reload("locale-fixture.ts");
        const prior = webs.locales.snapshot();

        assert.equal(requestLocale(prior, "zh-CN").t("ui.close", "Close"), "关闭");

        for (const [messages, error] of [
            ['{ ...pack.messages, "ui.close": 42 }', /is text, and not a number/],
            ['{ ...pack.messages, "unsafe.prototype.message": "bad" }', /not a message key/],
            ['{ ...pack.messages, "ui.close": "x".repeat(8193) }', /8192 UTF-8 bytes/],
            ['{ ...pack.messages, "ui.close": "关闭 {unexpected}" }', /placeholders/],
        ] as const) {
            writeFileSync(
                file,
                `/** Invalid locale update. */\nconst pack = ${JSON.stringify(pack)};\nexport default (_host, web) => web.uiLocales([{ ...pack, messages: ${messages} }]);\n`,
            );
            await assert.rejects(loader.reload("locale-fixture.ts"), error);
            assert.deepEqual(
                webs.locales.snapshot(),
                prior,
                "an invalid update cannot publish any text",
            );
            assert.ok(loader.list().find((each) => each.file === "locale-fixture.ts")?.error);
        }
    } finally {
        await loader.close();
    }
});
