// The shipped example is exercised by the real loader and Chromium in i18n-ui.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import zhCnUi from "../docs/examples/zh-cn-ui.ts";
import { setUiLocales, t } from "../web/i18n.js";

test("the example pack is data-only and keeps template placeholders intact", () => {
    const extension = zhCnUi();
    const pack = extension.uiLocales[0]!;
    const slots = (text: string) =>
        [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))].sort();

    assert.equal(extension.name, "zh-cn-ui");
    assert.equal(pack.locale, "zh-CN");
    assert.equal(pack.label, "简体中文");
    assert.equal(pack.default, true);
    assert.ok(Object.keys(pack.strings).length >= 40);
    assert.ok(Object.keys(pack.templates).length >= 10);

    for (const [key, value] of Object.entries(pack.templates)) {
        assert.deepEqual(slots(value), slots(key), key);
    }
});

test("the example pack translates registered text and leaves the rest English", () => {
    const extension = zhCnUi();

    try {
        setUiLocales(extension.uiLocales);
        assert.equal(t("Menu"), "菜单");
        assert.equal(t("Unregistered English UI"), "Unregistered English UI");
        const name = "Menu {{name}} <img> /some/path";
        const error = "EXTERNAL RAW {{name}}";
        const translated = t("Could not attach {{name}}: {{error}}", { name, error });

        assert.ok(translated.includes(name));
        assert.ok(translated.includes(error));
        assert.notEqual(translated, `Could not attach ${name}: ${error}`);
        assert.equal(t("Back to {{tab}}", { tab: "Menu {{tab}} <img>" }), "返回Menu {{tab}} <img>");
    } finally {
        setUiLocales([]);
    }

    assert.equal(t("Menu"), "Menu");
});
