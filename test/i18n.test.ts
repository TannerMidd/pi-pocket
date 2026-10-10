// The UI translator accepts only explicit data strings and simple placeholders, never extension scripts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { currentLocale, setUiLocales, t } from "../web/i18n.js";

const chinese = {
    locale: "zh-CN",
    label: "简体中文",
    default: true,
    strings: { Extensions: "扩展" },
    templates: {
        "No model matches “{{query}}”.": "没有匹配的模型：“{{query}}”。",
    },
};

test("English is the default when no extension supplies a locale", () => {
    assert.equal(setUiLocales([]), "en");
    assert.equal(currentLocale(), "en");
    assert.equal(t("Extensions"), "Extensions");
});

test("registered locale packs translate explicit strings and retain dynamic content verbatim", () => {
    assert.equal(setUiLocales([chinese]), "zh-CN");
    assert.equal(t("Extensions"), "扩展");
    assert.equal(
        t("No model matches “{{query}}”.", { query: "faux-2" }),
        "没有匹配的模型：“faux-2”。",
    );
    assert.equal(t("No model matches “faux-2”."), "No model matches “faux-2”.");
    assert.equal(t("A user message that says Extensions"), "A user message that says Extensions");
});

test("parameters are substituted once, unknown and prototype keys fall back, order is deterministic", () => {
    setUiLocales([chinese]);
    assert.equal(
        t("No model matches “{{query}}”.", { query: "<img>{{query}}$&" }),
        "没有匹配的模型：“<img>{{query}}$&”。",
    );
    assert.equal(t("constructor"), "constructor");
    assert.equal(t("__proto__"), "__proto__");
    assert.equal(t(null), null);
    assert.equal(t("Missing {{value}}", { value: "Menu" }), "Missing Menu");
    const french = {
        ...chinese,
        locale: "fr",
        label: "French",
        strings: { Extensions: "Extensions FR" },
    };

    setUiLocales([chinese, french]);
    assert.equal(currentLocale(), "fr");
    setUiLocales([french, chinese]);
    assert.equal(currentLocale(), "fr");
});

test("removing all locale packs restores the original English strings", () => {
    setUiLocales([chinese]);
    assert.equal(t("Extensions"), "扩展");

    setUiLocales([]);

    assert.equal(currentLocale(), "en");
    assert.equal(t("Extensions"), "Extensions");
    assert.equal(t("No model matches “faux-2”."), "No model matches “faux-2”.");
});
