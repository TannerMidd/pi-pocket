// Pure shared lookup: neither a browser nor an HTTP server is needed for these exact text rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { translate } from "../web/locale.js";
import { EN } from "../web/locales/en.js";
import { checkUiLocales } from "../src/server/ui-locales.ts";

test("R04: missing, empty and whitespace translations use the explicit English", () => {
    assert.equal(translate({}, "ui.close", EN["ui.close"]!), "Close");
    assert.equal(translate({ "ui.close": "" }, "ui.close", "Close"), "Close");
    assert.equal(translate({ "ui.close": " \t\n" }, "ui.close", "Close"), "Close");
    assert.equal(translate({ "ui.close": "Fermer" }, "ui.close", "Close"), "Fermer");
    assert.equal(EN["ui.close"], "Close", "a translation never changes the core catalog");
});

test("R05: an unknown key returns call-site English and never the key", () => {
    assert.equal(translate({}, "future.unknown", "The explicit English"), "The explicit English");
    assert.equal(translate({}, "future.unknown", "Hello {name}", { name: "Sam" }), "Hello Sam");
});

test("R06: known placeholders must match the English placeholder set", () => {
    const make = (message: string) => [
        { id: "fr", label: "French", messages: { "signin.switch-as": message } },
    ];

    assert.doesNotThrow(() => checkUiLocales("fixture.ts", make("Salut {name}, {name}")));
    assert.throws(
        () => checkUiLocales("fixture.ts", make("Salut")),
        "a missing placeholder is rejected",
    );
    assert.throws(
        () => checkUiLocales("fixture.ts", make("Salut {name} {extra}")),
        "an extra placeholder is rejected",
    );
});

test("R06: interpolation is literal, nonrecursive, and leaves missing or invalid markers", () => {
    const messages = { greeting: "Hello {name}; {name}; {other}; {missing}; {bad-name}." };
    const answer = translate(messages, "greeting", "English {name}", {
        name: "$& <img onerror=1> {other}",
        other: "done",
    });

    assert.equal(
        answer,
        "Hello $& <img onerror=1> {other}; $& <img onerror=1> {other}; done; {missing}; {bad-name}.",
    );
    assert.equal(
        translate({ greeting: "[{name}]" }, "greeting", "English", {
            name: "literal {other}",
            other: "ignored",
        }),
        "[literal {other}]",
    );
    const inherited = Object.assign(Object.create({ name: "from prototype" }), { other: 1 });

    assert.equal(translate({}, "unknown", "{name}/{other}", inherited), "{name}/1");
});
