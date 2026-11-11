// The built-in Chinese pack, through the real catalog and extension loader.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { createRegistry } from "@earendil-works/pi-durable";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";
import {
    checkUiLocales,
    requestLocale,
    UI_LOCALE_LIMITS,
    type UiLocalePack,
} from "../src/server/ui-locales.ts";
import { placeholders } from "../web/locale.js";
import { EN } from "../web/locales/en.js";

const builtIn = join(import.meta.dirname, "../src/server/extensions");
const moduleUrl = pathToFileURL(join(builtIn, "zh-cn.ts")).href;
const dataUrl = pathToFileURL(join(builtIn, "zh-cn/messages.ts")).href;
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

async function pack(): Promise<UiLocalePack> {
    return (await import(dataUrl)).default;
}

function loaderAt(directory: string) {
    const webs = new ExtensionWebs();
    const loader = new ExtensionLoader(
        createRegistry(),
        { notice: () => {} } as unknown as PocketHost,
        { builtIn: directory },
        undefined,
        { webs },
    );

    return { webs, loader };
}

after(cleanUp);

test("the Chinese data has valid keys, matching placeholders, and fits all locale limits", async () => {
    const chinese = await pack();
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
});

test("the real built-in module registers Chinese and resolves 10 translated messages", async () => {
    const { webs, loader } = loaderAt(builtIn);

    try {
        assert.deepEqual(
            await loader.reload("zh-cn.ts"),
            [],
            "a data-only module needs no synthetic extension",
        );
        const info = loader.list().find((each) => each.file === "zh-cn.ts");
        const snapshot = webs.locales.snapshot();
        const chinese = requestLocale(snapshot, "zh-CN");

        assert.ok(info, "the loader lists the Chinese module");
        assert.equal(info.source, "built-in");
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
        await loader.close();
    }
});

test("invalid Chinese updates are refused and keep the previously registered pack", async () => {
    const directory = mkdtempSync(join(root, "zh-cn-loader-"));
    const file = join(directory, "zh-cn.ts");
    const { webs, loader } = loaderAt(directory);

    writeFileSync(
        file,
        `/** The real Chinese module. */\nexport { default } from ${JSON.stringify(moduleUrl)};\n`,
    );

    try {
        await loader.reload("zh-cn.ts");
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
                `/** Invalid Chinese update. */\nimport pack from ${JSON.stringify(dataUrl)};\nexport default (_host, web) => web.uiLocales([{ ...pack, messages: ${messages} }]);\n`,
            );
            await assert.rejects(loader.reload("zh-cn.ts"), error);
            assert.deepEqual(
                webs.locales.snapshot(),
                prior,
                "an invalid update cannot publish any text",
            );
            assert.ok(loader.list().find((each) => each.file === "zh-cn.ts")?.error);
        }
    } finally {
        await loader.close();
    }
});
