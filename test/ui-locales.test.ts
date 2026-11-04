// The data-only locale boundary, tested through the real staged Web rather than a stand-in validator.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkUiLocales, UiLocales } from "../src/server/ui-locales.ts";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import { translate } from "../web/locale.js";
import { EN } from "../web/locales/en.js";

const pack = (
    messages: unknown = { "future.message": "Hello" },
    id = "fr",
    label = "Français",
) => ({
    id,
    label,
    messages,
});

function register(value: unknown): void {
    checkUiLocales("locale-validation.ts", value);
}

function reject(value: unknown, what: string): void {
    assert.throws(() => register(value), what);
}

test("R01: malformed declarations and messages are rejected without executing functions", () => {
    let called = false;

    const executable = () => {
        called = true;

        return "not data";
    };

    const invalid: [string, unknown][] = [
        ["missing declaration", undefined],
        ["non-array declaration", pack()],
        ["null pack", [null]],
        ["array pack", [[]]],
        ["class instance pack", [Object.assign(new (class {})(), pack())]],
        ["missing messages", [{ id: "fr", label: "Français" }]],
        ["null messages", [pack(null)]],
        ["array messages", [pack(["Hello"])]],
        ["function messages", [pack(executable)]],
        ["number messages", [pack(1)]],
        ["empty messages", [pack({})]],
        ["number value", [pack({ "future.message": 7 })]],
        ["function value", [pack({ "future.message": executable })]],
        ["object value", [pack({ "future.message": {} })]],
        ["array value", [pack({ "future.message": [] })]],
        ["null value", [pack({ "future.message": null })]],
        ["extra priority", [{ ...pack(), priority: 1 }]],
    ];

    for (const [what, value] of invalid) {
        reject(value, what);
    }

    assert.equal(called, false, "translation functions are never executed");
    assert.doesNotThrow(() => register([pack()]));
});

test("R02: accessors and dangerous keys are rejected without invoking the getters", () => {
    let called = 0;

    const withGetter = (field: string, initial: Record<string, unknown>) => {
        const object = { ...initial };

        Object.defineProperty(object, field, {
            enumerable: true,
            get() {
                called++;

                return "not data";
            },
        });

        return object;
    };

    const withHiddenGetter = Object.defineProperty({ "future.message": "safe" }, "future.hidden", {
        enumerable: false,
        get() {
            called++;

            return "not data";
        },
    });

    for (const field of ["id", "label", "messages"]) {
        reject([withGetter(field, pack() as Record<string, unknown>)], `getter ${field}`);
    }

    reject([pack(withGetter("future.message", {}))], "message getter");
    reject([pack(withHiddenGetter)], "non-enumerable message getter");

    for (const key of ["__proto__", "constructor", "prototype"]) {
        const messages = Object.create(null) as Record<string, string>;

        messages[key] = "bad";
        reject([pack(messages)], `dangerous key ${key}`);
    }

    assert.equal(called, 0, "validation never executes a getter");
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    const clean = Object.assign(Object.create(null), { "future.message": "safe" });

    assert.doesNotThrow(() => register([pack(clean)]), "a null-prototype message object is valid");
});

test("R02: an accessor on a declared pack array is refused without invocation", () => {
    let called = 0;
    const packs: unknown[] = [];

    Object.defineProperty(packs, "0", {
        enumerable: true,
        get() {
            called++;

            return pack();
        },
    });
    reject(packs, "array-element getter");
    assert.equal(called, 0, "an array element accessor must never run");
});

test("R03: package count, id, label, key and value boundaries are enforced", () => {
    const sixteen = Array.from({ length: 16 }, (_, index) =>
        pack({ "future.message": "ok" }, `fr-x-${index + 1}`),
    );
    const id64 = "fr-x-aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee-ffffffff-ggggg";
    const key160 = "a".repeat(160);

    assert.equal(id64.length, 64);
    assert.doesNotThrow(() => register(sixteen), "16 languages fit");
    reject([], "zero languages");
    reject([...sixteen, pack({ "future.message": "ok" }, "de")], "17 languages");
    assert.doesNotThrow(() => register([pack({ "future.message": "ok" }, id64)]), "64-char id");
    reject([pack({ "future.message": "ok" }, `${id64}g`)], "65-char id");
    assert.doesNotThrow(() => register([pack({ "future.message": "ok" }, "fr", "a".repeat(80))]));

    for (const label of ["", " ", "a".repeat(81), "a\nb", "a\rb", "a\0b"]) {
        reject(
            [pack({ "future.message": "ok" }, "fr", label)],
            `invalid label ${JSON.stringify(label)}`,
        );
    }

    assert.doesNotThrow(() => register([pack({ [key160]: "ok" })]), "160-char key");
    reject([pack({ [`${key160}a`]: "ok" })], "161-char key");

    for (const key of ["", "Upper", "_start", "a..b", "a.", "a/b", "a b"]) {
        reject([pack({ [key]: "ok" })], `invalid key ${JSON.stringify(key)}`);
    }

    assert.doesNotThrow(() => register([pack({ "future.message": "x".repeat(8192) })]));
    reject([pack({ "future.message": "x".repeat(8193) })], "8193 ASCII bytes");
    assert.doesNotThrow(() => register([pack({ "future.message": "é".repeat(4096) })]));
    reject([pack({ "future.message": "é".repeat(4097) })], "8194 UTF-8 bytes");
    reject([pack({ "future.message": "a\0b" })], "NUL in message");
});

test("R03: label length is checked on the raw value", () => {
    assert.doesNotThrow(() => register([pack(undefined, "fr", "a".repeat(80))]));
    reject([pack(undefined, "fr", ` ${"a".repeat(80)} `)], "raw label exceeds 80 characters");
});

test("R03: raw JSON counts ignored fields and original whitespace and casing", () => {
    const messages = Object.fromEntries(
        Array.from({ length: 127 }, (_, i) => [`x${i}`, "x".repeat(8192)]),
    );
    const declaration = [{ ...pack(messages, "FR", " French "), note: "y".repeat(8192) }];

    assert.ok(Buffer.byteLength(JSON.stringify(declaration), "utf8") > 1024 * 1024);
    reject(declaration, "the original declaration, not a reduced copy, exceeds 1 MiB");
});

test("R03: the 1 MiB budget counts the raw label before normalization", () => {
    const messages = Object.fromEntries(
        Array.from({ length: 128 }, (_, i) => [`x${i}`, i < 127 ? "x".repeat(8192) : ""]),
    );
    const declaration = [pack(messages, "fr", " French ")];
    const remainder = 1024 * 1024 - Buffer.byteLength(JSON.stringify(declaration), "utf8");

    assert.ok(remainder > 0 && remainder <= 8192);
    messages.x127 = "x".repeat(remainder);
    assert.equal(Buffer.byteLength(JSON.stringify(declaration), "utf8"), 1024 * 1024);
    assert.doesNotThrow(() => register(declaration), "the exact raw boundary is accepted");
    messages.x127 += "x";
    reject(declaration, "raw size exceeds the limit even if label normalization shrinks the copy");
});

test("R03: aggregate limits are rechecked against real intervening commits", () => {
    const keys = Object.keys(EN)
        .filter((key) => !/[{}]/.test(EN[key]!))
        .slice(0, 63);
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "late.ts"];
    const layers = files.map((file, index) =>
        checkUiLocales(
            file,
            Array.from({ length: 2 }, (_, language) =>
                pack(
                    Object.fromEntries(keys.map((key) => [key, "x".repeat(8192)])),
                    `fr-x-${index + 1}-${language + 1}`,
                ),
            ),
        ),
    );
    const webs = new ExtensionWebs();

    webs.locales.orderedBy(() => files);

    for (let i = 0; i < 3; i++) {
        webs.locales.check(files[i]!, layers[i]!);
        webs.locales.set(files[i]!, layers[i]!);
    }

    const late = webs.stage("late.ts", process.cwd(), "Late locale");
    const latePacks = Array.from({ length: 2 }, (_, language) =>
        pack(
            Object.fromEntries(keys.map((key) => [key, "x".repeat(8192)])),
            `fr-x-6-${language + 1}`,
        ),
    );

    late.web.uiLocales(latePacks as Parameters<typeof late.web.uiLocales>[0]);
    webs.check(late.part);
    webs.locales.check("d.ts", layers[3]!);
    webs.locales.set("d.ts", layers[3]!);
    const before = webs.locales.snapshot();

    assert.throws(
        () => webs.check(late.part),
        "a staged module is rechecked after an intervening commit",
    );
    assert.deepEqual(webs.locales.snapshot(), before);
    webs.discard(late.part);
});

test("R03: the 4 MiB committed-catalog boundary includes JSON metadata", () => {
    const keys = Object.keys(EN).filter((key) => !/[{}]/.test(EN[key]!));
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const locales = new UiLocales();
    const catalog = [] as { id: string; label: string; messages: Record<string, string> }[];

    assert.ok(keys.length >= 63);
    locales.orderedBy(() => files);

    for (let i = 0; i < 4; i++) {
        const input = Array.from({ length: 2 }, (_, language) =>
            pack(
                Object.fromEntries(keys.slice(0, 63).map((key) => [key, "x".repeat(8192)])),
                `fr-x-${i + 1}-${language + 1}`,
            ),
        ) as typeof catalog;
        const checked = checkUiLocales(files[i]!, input);

        catalog.push(...input);
        locales.check(files[i]!, checked);
        locales.set(files[i]!, checked);
    }

    const tail = pack(
        Object.fromEntries(keys.slice(0, 9).map((key) => [key, "x"])),
        "fr-x-9",
        "Français",
    ) as (typeof catalog)[number];
    const all = [...catalog, tail];
    let remaining = 4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(all), "utf8");

    assert.ok(remaining > 0 && remaining < 9 * 8192);

    for (const key of keys.slice(0, 9)) {
        const additional = Math.min(remaining, 8191);

        tail.messages[key] += "x".repeat(additional);
        remaining -= additional;
    }

    assert.equal(remaining, 0);
    assert.equal(Buffer.byteLength(JSON.stringify(all), "utf8"), 4 * 1024 * 1024);
    const exact = checkUiLocales("e.ts", [tail]);

    assert.doesNotThrow(() => locales.check("e.ts", exact), "exactly 4 MiB is allowed");
    const before = locales.snapshot();
    const key = keys.slice(0, 9).find((each) => tail.messages[each]!.length < 8192)!;

    tail.messages[key] += "x";
    const over = checkUiLocales("e.ts", [tail]);

    assert.throws(() => locales.check("e.ts", over), "4 MiB plus one byte is rejected");
    assert.deepEqual(locales.snapshot(), before);
});

test("R03: ignored unknown keys count toward the committed 4 MiB budget", () => {
    const locales = new UiLocales();
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const messages = Object.fromEntries(
        Array.from({ length: 127 }, (_, i) => [`unknown${i}`, "x".repeat(8192)]),
    );

    locales.orderedBy(() => files);

    for (const file of files.slice(0, 4)) {
        const checked = checkUiLocales(file, [pack(messages, `fr-x-${file[0]}`)]);

        locales.check(file, checked);
        locales.set(file, checked);
    }

    const before = locales.snapshot();
    const added = checkUiLocales("e.ts", [pack(messages, "fr-x-e")]);

    assert.throws(
        () => locales.check("e.ts", added),
        "unknown messages count before they are ignored",
    );
    assert.deepEqual(locales.snapshot(), before);
});

test("R03: commit rejects a total over 4 MiB atomically", () => {
    const keys = Object.keys(EN).filter((key) => !/[{}]/.test(EN[key]!));

    assert.ok(keys.length >= 63, "the fixture needs 63 ordinary known keys");
    const locales = new UiLocales();
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];

    locales.orderedBy(() => files);

    for (let i = 0; i < 4; i++) {
        const packs = checkUiLocales(
            files[i]!,
            Array.from({ length: 2 }, (_, language) =>
                pack(
                    Object.fromEntries(keys.slice(0, 63).map((key) => [key, "x".repeat(8192)])),
                    `fr-x-${i + 1}-${language + 1}`,
                ),
            ),
        );

        locales.check(files[i]!, packs);
        locales.set(files[i]!, packs);
    }

    const before = locales.snapshot();
    const next = checkUiLocales("e.ts", [
        pack(Object.fromEntries(keys.slice(0, 9).map((key) => [key, "x".repeat(8192)])), "fr-x-9"),
    ]);

    assert.throws(() => locales.check("e.ts", next), "the next committed layer exceeds 4 MiB");
    assert.deepEqual(
        locales.snapshot(),
        before,
        "a refused commit preserves all old layers and the revision",
    );
});

test("R03: the 10000-message limit includes unknown keys", () => {
    const messages = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`x${i}`, "v"]));

    assert.doesNotThrow(() => register([pack(messages)]), "10000 messages fit");
    reject([pack({ ...messages, x10000: "v" })], "10001 messages");
});

test("R03: the 1 MiB raw JSON limit includes unknown keys", () => {
    const messages = Object.fromEntries(
        Array.from({ length: 128 }, (_, i) => [`x${i}`, i < 127 ? "x".repeat(8192) : ""]),
    );
    const declaration = [pack(messages, "fr", "French")];
    const remainder = 1024 * 1024 - Buffer.byteLength(JSON.stringify(declaration), "utf8");

    assert.ok(remainder > 0 && remainder < 8192, "the fixture isolates the raw JSON limit");
    messages.x127 = "x".repeat(remainder);
    assert.equal(Buffer.byteLength(JSON.stringify(declaration), "utf8"), 1024 * 1024);
    assert.doesNotThrow(() => register(declaration), "exactly 1 MiB fits");
    messages.x127 += "x";
    reject(declaration, "1 MiB plus one byte");
});

test("R04 and R09: ordered overlays reveal the earlier layer and then English", () => {
    const locales = new UiLocales();
    const low = checkUiLocales("low.ts", [
        pack({ "ui.close": "Fermer", "ui.back": "Retour" }, "fr", "Lower"),
    ]);
    const high = checkUiLocales("high.ts", [
        pack({ "ui.close": "Quitter", "ui.back": "  " }, "fr", "Higher"),
    ]);

    locales.orderedBy(() => ["low.ts", "high.ts"]);
    locales.check("high.ts", high);
    locales.set("high.ts", high);
    locales.check("low.ts", low);
    locales.set("low.ts", low);
    let snapshot = locales.snapshot();
    let french = snapshot.locales.find((each) => each.id === "fr")!;

    assert.equal(french.label, "Higher");
    assert.equal(french.messages["ui.close"], "Quitter", "completion order does not set priority");
    assert.equal(
        french.messages["ui.back"],
        "Retour",
        "blank upper messages expose the lower layer",
    );
    assert.equal(translate(french.messages, "ui.cancel", EN["ui.cancel"]!), "Cancel");
    const replacement = checkUiLocales("low.ts", [
        pack({ "ui.close": "Fermer encore" }, "fr", "Lower 2"),
    ]);

    locales.check("low.ts", replacement);
    locales.set("low.ts", replacement);
    french = locales.snapshot().locales.find((each) => each.id === "fr")!;
    assert.equal(
        french.messages["ui.close"],
        "Quitter",
        "reloading the lower layer does not raise it",
    );
    locales.set("high.ts", undefined);
    snapshot = locales.snapshot();
    french = snapshot.locales.find((each) => each.id === "fr")!;
    assert.equal(french.label, "Lower 2");
    assert.equal(french.messages["ui.close"], "Fermer encore");
    locales.set("low.ts", undefined);
    assert.deepEqual(
        locales.snapshot().locales.map((each) => each.id),
        ["en"],
    );
});

test("R05: unknown keys still enforce message types and sizes", () => {
    assert.doesNotThrow(() => register([pack({ "future.unknown": "ignored" })]));
    const disguised = { includes: () => false, trim: () => "pretend", toString: () => "pretend" };

    assert.throws(
        () => register([pack({ "future.unknown": 42 })]),
        "unknown numeric values are rejected",
    );
    assert.throws(
        () => register([pack({ "future.unknown": disguised })]),
        "unknown objects are rejected even if they act like strings",
    );
    reject([pack({ "future.unknown": "x".repeat(8193) })], "unknown oversized value");
});

test("R05: unknown keys are filtered after validation and never reach a snapshot", () => {
    const locales = new UiLocales();
    const checked = checkUiLocales("newer.ts", [
        pack({ "future.unknown": "Not in this version", "ui.close": "Fermer" }),
    ]);

    locales.orderedBy(() => ["newer.ts"]);
    locales.check("newer.ts", checked);
    locales.set("newer.ts", checked);
    const french = locales.snapshot().locales.find((each) => each.id === "fr")!;

    assert.equal(french.messages["future.unknown"], undefined);
    assert.equal(french.messages["ui.close"], "Fermer");
    assert.equal(
        translate(french.messages, "future.unknown", "Call-site English"),
        "Call-site English",
    );
});

test("R06: known translations use the exact set of English placeholders", () => {
    const english = EN["signin.switch-as"]!;

    assert.match(english, /\{name\}/);
    assert.doesNotThrow(() => register([pack({ "signin.switch-as": "Salut {name}, {name}" })]));
    assert.doesNotThrow(() => register([pack({ "signin.switch-as": "   " })]));
    reject([pack({ "signin.switch-as": "Salut" })], "missing placeholder");
    reject([pack({ "signin.switch-as": "Salut {name} {extra}" })], "extra placeholder");
    reject([pack({ "ui.close": "Fermer {extra}" })], "a placeholder absent from English");
});

test("R16: changing the module's original messages leaves the published snapshot unchanged", () => {
    const messages = { "ui.close": "Fermer" };
    const checked = checkUiLocales("mutable.ts", [pack(messages)]);
    const locales = new UiLocales();

    locales.orderedBy(() => ["mutable.ts"]);
    locales.check("mutable.ts", checked);
    locales.set("mutable.ts", checked);
    messages["ui.close"] = "Changed";
    assert.equal(
        locales.snapshot().locales.find((each) => each.id === "fr")?.messages["ui.close"],
        "Fermer",
    );
});

test("R16: checked declaration array is immutable", () => {
    const checked = checkUiLocales("mutable.ts", [pack({ "ui.close": "Fermer" })]);

    assert.throws(() => {
        (checked as unknown as { id: string }[])[0] = { id: "de" };
    }, "the checked declaration array cannot be changed");
});

test("R16: published data has no writable references", () => {
    const input = [pack({ "ui.close": "Fermer" })];
    const checked = checkUiLocales("mutable.ts", input);
    const locales = new UiLocales();

    locales.orderedBy(() => ["mutable.ts"]);
    locales.check("mutable.ts", checked);
    locales.set("mutable.ts", checked);
    const snapshot = locales.snapshot();
    const french = snapshot.locales.find((each) => each.id === "fr")!;

    assert.ok(
        Object.isFrozen(checked) &&
            Object.isFrozen(checked[0]) &&
            Object.isFrozen(checked[0]!.messages),
    );
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.locales));
    assert.ok(Object.isFrozen(french) && Object.isFrozen(french.messages));
    assert.throws(() => {
        (checked as unknown as { id: string }[])[0] = { id: "de" };
    }, "the checked declaration array cannot be changed");
    assert.throws(() => {
        (french.messages as Record<string, string>)["ui.close"] = "Mutated";
    });
    assert.equal(
        locales.snapshot().locales.find((each) => each.id === "fr")!.messages["ui.close"],
        "Fermer",
    );
});

test("R16: checked declarations and snapshots are frozen independent copies", () => {
    const messages = { "ui.close": "Fermer" };
    const input = [pack(messages)];
    const checked = checkUiLocales("mutable.ts", input);
    const locales = new UiLocales();

    locales.orderedBy(() => ["mutable.ts"]);
    locales.check("mutable.ts", checked);
    locales.set("mutable.ts", checked);
    const before = locales.snapshot();
    const french = before.locales.find((each) => each.id === "fr")!;

    messages["ui.close"] = "Altered";
    input[0]!.label = "Altered";
    input.push(pack({ "ui.close": "Z" }, "de"));
    assert.ok(
        Object.isFrozen(checked) &&
            Object.isFrozen(checked[0]) &&
            Object.isFrozen(checked[0]!.messages),
    );
    assert.ok(Object.isFrozen(before) && Object.isFrozen(before.locales));
    assert.ok(Object.isFrozen(french) && Object.isFrozen(french.messages));
    assert.equal(french.label, "Français");
    assert.equal(french.messages["ui.close"], "Fermer");
    assert.equal(
        locales.snapshot().locales.find((each) => each.id === "fr")!.messages["ui.close"],
        "Fermer",
    );
    assert.throws(() => {
        (french.messages as Record<string, string>)["ui.close"] = "Mutated";
    });
});

test("R07: canonical IDs appear exactly, without parent or regional substitution", () => {
    const locales = new UiLocales();
    const checked = checkUiLocales("regional.ts", [pack({ "ui.close": "Quitter" }, "fr-ca")]);

    locales.orderedBy(() => ["regional.ts"]);
    locales.check("regional.ts", checked);
    locales.set("regional.ts", checked);
    const languages = locales.snapshot().locales;

    assert.equal(languages.find((each) => each.id === "fr-CA")?.messages["ui.close"], "Quitter");
    assert.equal(
        languages.find((each) => each.id === "fr"),
        undefined,
    );
    assert.equal(
        languages.find((each) => each.id === "fr-FR"),
        undefined,
    );
});

test("R07: duplicate canonical locale IDs and the reserved English ID are rejected", () => {
    assert.doesNotThrow(() => register([pack({ "future.message": "ok" }, "fr-ca")]));
    reject([pack({}, "fr")], "empty messages remain invalid");
    reject([pack(undefined, "fr-ca"), pack(undefined, "fr-CA")], "canonical duplicate");
    reject([pack(undefined, "en")], "reserved en");
    reject([pack(undefined, "EN")], "reserved en after canonicalization");
    reject([pack(undefined, "invalid_locale")], "invalid locale");
    reject([pack(undefined, "fr\0")], "NUL in locale ID");
});
