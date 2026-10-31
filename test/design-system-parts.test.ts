import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadDesignSystem } from "../src/server/extensions/design/system-api.ts";
import { ferryPage, writeSystemFixture } from "./design-system-fixtures.ts";

const load = (name: string) =>
    import(new URL(`../src/server/extensions/design/${name}.js`, import.meta.url).href);

const color = await load("color");
const sys = await load("system");

const folder = mkdtempSync(join(tmpdir(), "pi-pocket-system-"));

writeSystemFixture(folder);

const system = loadDesignSystem(folder)!;

after(() => rmSync(folder, { recursive: true, force: true }));

test("colors are read in every form a token file has", () => {
    const hex = (value: unknown) => {
        const read = color.parseColor(value);

        return read === undefined ? undefined : color.toHex(read);
    };

    assert.deepEqual(color.parseColor("#3b6cf6"), {
        r: 59 / 255,
        g: 108 / 255,
        b: 246 / 255,
        a: 1,
    });
    assert.equal(hex("#FFF"), "#ffffff");
    assert.equal(hex("#0008"), "#00000088");
    assert.equal(hex("rgb(59, 108, 246)"), "#3b6cf6");
    assert.equal(hex("rgb(59 108 246 / 50%)"), "#3b6cf680");
    assert.equal(hex("rgba(0,0,0,.25)"), "#00000040");
    assert.equal(hex("hsl(0 100% 50%)"), "#ff0000");
    assert.equal(hex("hsl(120deg 100% 25%)"), "#008000");
    assert.equal(hex("oklch(0.628 0.2577 29.23)"), "#ff0000");
    assert.equal(hex("oklch(1 0 0)"), "#ffffff");
    assert.equal(hex("color(srgb 1 0.5 0 / 0.4)"), "#ff800066");
    assert.equal(hex("transparent"), "#00000000");
    assert.equal(hex({ colorSpace: "srgb", components: [0, 0, 0], alpha: 0.4 }), "#00000066");
    assert.equal(hex({ colorSpace: "srgb", components: [1, 0, 0], hex: "#ff0000" }), "#ff0000");
    assert.equal(hex({ colorSpace: "hsl", components: [240, 100, 50] }), "#0000ff");
    assert.equal(hex({ colorSpace: "oklch", components: [1, 0, 0] }), "#ffffff");
    assert.equal(hex({ colorSpace: "lab", components: [1, 2, 3] }), "#0b0200");

    for (const bad of [
        "",
        "blue-ish",
        "#12",
        "rgb(1 2)",
        "oklch(a b c)",
        "x".repeat(300),
        4,
        null,
        [],
        { colorSpace: "cmyk", components: [1, 2, 3] },
        { components: [1] },
    ]) {
        assert.equal(color.parseColor(bad), undefined, String(bad).slice(0, 20));
    }
});

test("a color is written back as hex, in the dialect of the value it replaces", () => {
    assert.equal(color.toHex({ r: 59 / 255, g: 108 / 255, b: 246 / 255, a: 1 }), "#3b6cf6");
    assert.equal(color.toHex({ r: 0, g: 0, b: 0, a: 0.5 }), "#00000080");
    assert.equal(color.toOklchText({ r: 1, g: 1, b: 1, a: 1 }), "oklch(1 0 0)");
    assert.equal(color.writeColor({ r: 1, g: 0, b: 0, a: 1 }, "#000000"), "#ff0000");
    assert.deepEqual(
        color.writeColor(
            { r: 1, g: 0, b: 0, a: 0.5 },
            { colorSpace: "srgb", components: [0, 0, 0] },
        ),
        {
            colorSpace: "srgb",
            components: [1, 0, 0],
            hex: "#ff0000",
            alpha: 0.5,
        },
    );
});

test("contrast follows WCAG 2.2, and a see-through color is laid over its ground first", () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 1, g: 1, b: 1, a: 1 };

    assert.equal(Math.round(color.contrastRatio(black, white) * 10) / 10, 21);
    assert.equal(color.contrastRatio(white, white), 1);
    // #777 on white is 4.48:1, the classic miss of AA.
    const gray = color.contrastRatio(color.parseColor("#777777"), white);

    assert.ok(gray > 4.4 && gray < 4.5);
    assert.equal(color.grade(gray, 4.5).pass, false);
    assert.equal(color.grade(gray, 4.5).level, "AA large");
    assert.equal(color.grade(10).level, "AAA");
    assert.equal(color.ratioText(4.4999), "4.4:1");
    assert.ok(color.contrastRatio({ ...black, a: 0.5 }, white) < 5);
});

test("a token belongs to the section its type, or the words of its name, say", () => {
    const of = (type: string, ...path: string[]) => sys.sectionOf({ type, path });

    assert.equal(of("color", "color", "bg"), "colors");
    assert.equal(of("gradient", "brand"), "colors");
    assert.equal(of("fontFamily", "font", "sans"), "type");
    assert.equal(of("typography", "type", "body"), "type");
    assert.equal(of("dimension", "font", "size", "base"), "type");
    assert.equal(of("dimension", "space", "4"), "spacing");
    assert.equal(of("dimension", "core", "radius", "md"), "radii");
    assert.equal(of("shadow", "shadow", "md"), "shadows");
    assert.equal(of("duration", "motion", "fast"), "motion");
    assert.equal(of("cubicBezier", "ease"), "motion");
    assert.equal(of("number", "z", "modal"), "other");
    assert.equal(of("dimension", "breakpoint", "md"), "other");
    assert.equal(of("number", "motion", "stagger"), "motion");
});

test("the fixture's tokens group into roles first and a palette after, and the rest into sections", () => {
    const groups = sys.groupsOf(system.tokens, "colors");
    const ids = groups.map((each: { id: string }) => each.id);
    const group = (id: string) => groups.find((each: { id: string }) => each.id === id);

    assert.ok(ids.indexOf("colors:semantic:bg") < ids.indexOf("colors:primitive:gray"), ids.join());
    assert.equal(group("colors:primitive:gray").kind, "palette");
    assert.equal(group("colors:semantic:bg").kind, "roles");
    assert.equal(group("colors:primitive:color").title, "Base");
    assert.equal(group("colors:semantic:bg").fold, false);
    assert.equal(group("colors:primitive:gray").fold, true);
    assert.deepEqual(
        sys.groupsOf(system.tokens, "type", "light").map((each: { title: string }) => each.title),
        ["Styles", "Families", "Sizes", "Weights", "Line height"],
    );
    assert.deepEqual(
        sys.groupsOf(system.tokens, "other", "light").map((each: { title: string }) => each.title),
        ["Z", "Breakpoint"],
    );
    assert.deepEqual(
        sys.groupsOf(system.tokens, "motion", "light").map((each: { title: string }) => each.title),
        ["Durations", "Easing"],
    );
    assert.ok(sys.SECTIONS.every((each: { id: string }) => each.id !== "other" || true));
});

test("a tab counts what its section shows open, folded groups carry their own counts, and the parts add up to the system", () => {
    const counts = sys.sectionCounts(system.tokens);
    const total = Object.values<{ open: number; folded: number; total: number }>(counts).reduce(
        (sum, each) => sum + each.total,
        0,
    );

    const colors = system.tokens.filter((each: { type: string }) => each.type === "color");
    const roles = colors.filter((each: { tier: string }) => each.tier === "semantic");

    assert.equal(counts.colors.open, roles.length);
    assert.equal(counts.colors.total, colors.length);
    assert.equal(counts.colors.open + counts.colors.folded, colors.length);
    assert.ok(counts.colors.folded > 0, "the palette is folded");
    assert.equal(total, system.tokens.length);

    for (const id of Object.keys(counts)) {
        const groups = sys.groupsOf(system.tokens, id);
        const sum = (list: { tokens: unknown[] }[]) =>
            list.reduce((all, group) => all + group.tokens.length, 0);

        assert.equal(sum(groups), counts[id].total, id);
        assert.equal(
            sum(groups.filter((group: { headline: boolean }) => group.headline)),
            counts[id].open,
            id,
        );
    }
});

test("tiles tell tokens apart by the shortest tail of the path that does", () => {
    const token = (name: string) => ({ name, path: name.split(".") });
    const names = sys.tails([
        token("shadow.lift"),
        token("card.shadow"),
        token("menu.shadow"),
        token("button.radius"),
    ]);

    assert.equal(names.get("shadow.lift"), "lift");
    assert.equal(names.get("card.shadow"), "card.shadow");
    assert.equal(names.get("menu.shadow"), "menu.shadow");
    assert.equal(names.get("button.radius"), "radius");
});

test("a search finds a token by its name, its description, or a value", () => {
    const token = (name: string) => system.tokens.find((each) => each.name === name);

    assert.ok(sys.matches(token("color.bg.surface"), "surface"));
    assert.ok(sys.matches(token("color.bg.surface"), "cards fields"));
    assert.ok(sys.matches(token("color.bg.surface"), "BG surf"));
    assert.ok(sys.matches(token("color.bg.surface"), "color-white"));
    assert.ok(!sys.matches(token("color.bg.surface"), "danger"));
    assert.ok(sys.matches(token("color.bg.surface"), "   "));
});

test("an edit to a color flows through the aliases that lead to it, and only there", () => {
    const edits = sys.tokenEdits(
        sys.push(
            sys.emptyHistory(),
            sys.tokenEdit("light", "color.blue.600", { value: "#ff0000" }),
        ),
    );
    const model = sys.createModel(system, edits);
    const saved = sys.createModel(system);

    assert.equal(model.value("color.blue.600", "light").value, "#ff0000");
    assert.equal(model.value("color.blue.600", "light").edited, true);
    assert.equal(model.value("color.accent.default", "light").value, "#ff0000");
    assert.equal(model.value("color.accent.default", "light").alias, "color.blue.600");
    assert.equal(model.value("color.accent.default", "light").css, "var(--color-blue-600)");
    assert.equal(
        model.value("color.accent.default", "dark").value,
        saved.value("color.accent.default", "dark").value,
    );
    assert.equal(model.value("color.gray.50", "light"), saved.value("color.gray.50", "light"));
    assert.deepEqual(model.dependents("color.blue.600"), ["color.accent.default"]);
});

test("a token can be pointed at another, and pointing at one that leads back is a loop", () => {
    const edits = sys.tokenEdits(
        sys.push(
            sys.emptyHistory(),
            sys.tokenEdit("light", "color.bg.sunken", { alias: "color.gray.300" }),
        ),
    );
    const model = sys.createModel(system, edits);

    assert.equal(model.value("color.bg.sunken", "light").value, "#c3c8d8");
    assert.equal(model.value("color.bg.sunken", "light").css, "var(--color-gray-300)");
    assert.deepEqual(model.chain("color.bg.sunken", "light"), [
        "color.bg.sunken",
        "color.gray.300",
    ]);

    // `bg.canvas` points at `gray.50`: pointing `gray.50` at `bg.canvas` would loop.
    assert.ok(
        model
            .targets("color.gray.50")
            .every((each: { name: string }) => each.name !== "color.bg.canvas"),
    );
    assert.ok(
        model.targets("color.bg.canvas").every((each: { type: string }) => each.type === "color"),
    );

    const loop = sys.createModel(
        system,
        sys.tokenEdits(
            sys.push(
                sys.emptyHistory(),
                sys.tokenEdit("light", "color.gray.50", { alias: "color.bg.canvas" }),
            ),
        ),
    );

    assert.ok(
        loop.value("color.bg.canvas", "light").error?.includes("loop"),
        "a loop is an error, not a hang",
    );
});

test("a mode that takes the default's value follows an edit of the default", () => {
    const edits = sys.tokenEdits(
        sys.push(
            sys.emptyHistory(),
            sys.tokenEdit("light", "color.border.focus", { alias: "color.red.600" }),
        ),
    );
    const model = sys.createModel(system, edits);

    assert.equal(model.value("color.border.focus", "dark").alias, "color.red.600");
    const own = sys.createModel(
        system,
        sys.tokenEdits(
            sys.push(
                sys.emptyHistory(),
                sys.tokenEdit("light", "color.accent.default", { alias: "color.red.600" }),
            ),
        ),
    );

    assert.equal(own.value("color.accent.default", "dark").alias, "color.blue.400");
});

test("contrast comes from the token's pair, or is worked out for text, and it moves with the edits", () => {
    const model = sys.createModel(system);
    const primary = model.contrastOf("color.text.primary", "light");

    assert.equal(primary.on, "color.bg.surface");
    assert.equal(primary.min, 7);
    assert.equal(primary.auto, false);
    assert.equal(primary.pass, true);
    assert.equal(primary.level, "AAA");
    assert.equal(model.contrastOf("color.text.disabled", "light").min, 3);
    assert.equal(model.contrastOf("color.text.disabled", "light").pass, true);
    assert.equal(model.contrastOf("color.text.disabled", "light").level, "AA large");
    const braced = {
        ...system,
        tokens: system.tokens.map((token) =>
            token.name === "color.text.primary"
                ? { ...token, contrast: { on: "{color.bg.surface}", min: 7 } }
                : token,
        ),
    };

    assert.equal(
        sys.createModel(braced).contrastOf("color.text.primary", "light").on,
        "color.bg.surface",
    );
    assert.equal(model.contrastOf("color.bg.surface", "light"), null);
    assert.equal(model.contrastOf("color.accent.default", "light"), null);
    assert.equal(model.contrastOf("space.4", "light"), null);

    const edited = sys.createModel(
        system,
        sys.tokenEdits(
            sys.push(
                sys.emptyHistory(),
                sys.tokenEdit("light", "color.gray.900", { value: "#e0e0e0" }),
            ),
        ),
    );

    assert.equal(edited.contrastOf("color.text.primary", "light").pass, false);
});

test("the roles of a system are found by their names", () => {
    const found = sys.roles(sys.createModel(system));

    assert.equal(found.canvas, "color.bg.canvas");
    assert.equal(found.surface, "color.bg.surface");
    assert.equal(found.text, "color.text.primary");
    assert.equal(found.muted, "color.text.muted");
    assert.equal(found.accent, "color.accent.default");
    assert.equal(found.border, "color.border.default");
    assert.equal(found.danger, "color.status.danger");
    assert.equal(found.success, "color.status.success");
    assert.equal(found.warning, "color.status.warning");
});

test("what a person types becomes a value of the token's type, in its dialect, or words for the field", () => {
    assert.deepEqual(sys.readInput("color", "#ABCDEF", "#000000"), { value: "#abcdef" });
    assert.deepEqual(sys.readInput("color", "rgb(255 0 0)", "#000000"), { value: "#ff0000" });
    assert.equal(sys.readInput("color", "#12", "#000").error?.startsWith("Not a color"), true);
    assert.deepEqual(sys.readInput("dimension", "1.5rem", { value: 1, unit: "px" }), {
        value: { value: 1.5, unit: "rem" },
    });
    assert.deepEqual(sys.readInput("dimension", "20", { value: 1, unit: "rem" }), {
        value: { value: 20, unit: "rem" },
    });
    assert.deepEqual(sys.readInput("dimension", "20", "8px"), { value: "20px" });
    assert.ok(sys.readInput("dimension", "20furlongs", "8px").error);
    assert.deepEqual(sys.readInput("duration", "0.4s", { value: 200, unit: "ms" }), {
        value: { value: 0.4, unit: "s" },
    });
    assert.ok(sys.readInput("duration", "4px", "8ms").error);
    assert.deepEqual(sys.readInput("number", "1.25"), { value: 1.25 });
    assert.ok(sys.readInput("number", "x").error);
    assert.deepEqual(sys.readInput("fontWeight", "600"), { value: 600 });
    assert.ok(sys.readInput("fontWeight", "5000").error);
    assert.deepEqual(sys.readInput("fontFamily", `"JetBrains Mono", monospace`, ["a"]), {
        value: ["JetBrains Mono", "monospace"],
    });
    assert.ok(sys.readInput("fontFamily", "evil;}", ["a"]).error);
    assert.deepEqual(sys.readInput("cubicBezier", "0.2, 0, 0, 1", [0, 0, 1, 1]), {
        value: [0.2, 0, 0, 1],
    });
    assert.deepEqual(sys.readInput("cubicBezier", "cubic-bezier(0.3 0 0.1 1.2)"), {
        value: [0.3, 0, 0.1, 1.2],
    });
    assert.ok(sys.readInput("cubicBezier", "2 0 0 1").error);
    assert.ok(sys.readInput("shadow", "x").error);
    assert.ok(sys.readInput("color", "  ").error);
});

test("undo and redo walk the edits, a repeat of one edit is one step, and an edit after an undo ends the redo", () => {
    const edit = (value: string) => sys.tokenEdit("light", "color.blue.600", { value });
    let history = sys.emptyHistory();

    history = sys.push(history, edit("#111111"), 1000);
    history = sys.push(history, edit("#222222"), 1300);
    assert.equal(history.past.length, 1);
    assert.equal(history.past[0].raw.value, "#222222");
    history = sys.push(history, edit("#333333"), 5000);
    history = sys.push(
        history,
        sys.tokenEdit("light", "color.blue.700", { value: "#444444" }),
        5100,
    );
    assert.equal(history.past.length, 3);

    history = sys.undo(history);
    assert.equal(history.past.length, 2);
    assert.equal(history.future.length, 1);
    history = sys.redo(history);
    assert.equal(history.past.length, 3);
    assert.equal(history.future.length, 0);
    history = sys.undo(sys.undo(history));
    history = sys.push(history, edit("#555555"), 99_000);
    assert.equal(history.future.length, 0, "a new edit ends the redo");
    const own = sys.push(
        sys.push(sys.emptyHistory(), edit("#111111"), 1000),
        edit("#222222"),
        1100,
        false,
    );

    assert.equal(own.past.length, 2);
    let long = sys.emptyHistory();

    for (let at = 0; at < 600; at += 1) {
        long = sys.push(
            long,
            sys.tokenEdit("light", `a.t${at % 40}`, { value: String(at) }),
            at * 5000,
        );
    }

    assert.equal(long.past.length, 500);
    assert.equal(long.past.at(-1).raw.value, "599");
    assert.equal(sys.editsOf(long).size, 40, "every thing that was edited is still edited");
    assert.equal(sys.undo(sys.emptyHistory()).past.length, 0);
    assert.equal(sys.redo(sys.emptyHistory()).future.length, 0);
    assert.equal(sys.editsOf(history).size, 1);
});

test("a save is what differs from the saved values: a revert changes nothing, and the order is the person's", () => {
    let history = sys.emptyHistory();

    history = sys.push(
        history,
        sys.tokenEdit("light", "color.accent.default", { alias: "color.blue.500" }),
        1,
    );
    history = sys.push(
        history,
        sys.tokenEdit("dark", "color.bg.canvas", { value: "#000000" }),
        10_000,
    );
    history = sys.push(
        history,
        sys.tokenEdit("light", "color.blue.600", { value: "#3b6cf6" }),
        20_000,
    );
    history = sys.push(history, sys.guidelinesEdit("# New\n"), 30_000);

    const change = sys.changeOf(system, history);

    assert.deepEqual(change.set, [
        { mode: "light", token: "color.accent.default", value: "{color.blue.500}" },
        { mode: "dark", token: "color.bg.canvas", value: "#000000" },
    ]);
    assert.equal(change.guidelines, "# New\n");
    assert.equal(change.count, 3);
    assert.equal(sys.changeOf(system, sys.emptyHistory()).count, 0);
    assert.equal(
        sys.changeOf(system, sys.push(sys.emptyHistory(), sys.guidelinesEdit(system.guidelines)))
            .count,
        0,
    );
});

test("the CSS a design is told is the mode in view where the modes differ, and what an edit changes", () => {
    const model = sys.createModel(system);
    const light = sys.previewVars(model, "light");
    const dark = sys.previewVars(model, "dark");

    // A page that follows the system's dark setting by itself still shows the mode in view: the tokens that vary are set.
    assert.equal(light["--color-bg-canvas"], "var(--color-gray-50)");
    assert.equal(dark["--color-bg-canvas"], "var(--color-gray-950)");
    assert.equal(light["--color-gray-50"], undefined);
    assert.equal(dark["--color-gray-50"], undefined);
    assert.ok(Object.keys(dark).length > 5);
    assert.ok(Object.keys(dark).every((name) => /^--[A-Za-z0-9_-]{1,78}$/.test(name)));

    const edited = sys.createModel(
        system,
        sys.tokenEdits(
            sys.push(
                sys.emptyHistory(),
                sys.tokenEdit("light", "color.blue.600", { value: "#ff0000" }),
            ),
        ),
    );

    assert.equal(sys.previewVars(edited, "light")["--color-blue-600"], "#ff0000");
    assert.equal(sys.previewVars(edited, "light")["--color-gray-50"], undefined);

    assert.equal(sys.safeCss("#fff"), "#fff");
    assert.equal(sys.safeCss("0 1px 2px rgb(0 0 0 / 0.2)"), "0 1px 2px rgb(0 0 0 / 0.2)");

    for (const bad of [
        "red;} body{display:none",
        "</style><script>",
        "url(http://x)",
        "a\\b",
        "/* x */",
        "@import 'x'",
        "x".repeat(401),
        "a\nb",
    ]) {
        assert.equal(sys.safeCss(bad), "", bad.slice(0, 20));
    }

    assert.ok(sys.themeCss(model, "dark").startsWith(":root{--color-white:"));
});

test("values of the other kinds read as amounts, pixels, and milliseconds", () => {
    assert.deepEqual(sys.amountOf({ value: 16, unit: "px" }), { n: 16, unit: "px" });
    assert.deepEqual(sys.amountOf("1.5rem"), { n: 1.5, unit: "rem" });
    assert.equal(sys.amountOf("big"), null);
    assert.equal(sys.pixelsOf("2rem"), 32);
    assert.equal(sys.pixelsOf({ value: 4, unit: "px" }), 4);
    assert.equal(sys.pixelsOf("50%"), null);
    assert.equal(sys.millisecondsOf({ value: 0.4, unit: "s" }), 400);
    assert.equal(sys.millisecondsOf("120ms"), 120);
    assert.equal(
        sys.cssOf("fontFamily", ["JetBrains Mono", "monospace"]),
        `"JetBrains Mono", monospace`,
    );
    assert.equal(sys.cssOf("cubicBezier", [0.2, 0, 0, 1]), "cubic-bezier(0.2, 0, 0, 1)");
    assert.equal(sys.cssOf("color", { colorSpace: "srgb", components: [1, 0, 0] }), "#ff0000");
    assert.equal(sys.cssOf("shadow", {}), undefined);
});

test("a component's page is made of its markup and CSS with nothing that loads, runs, or moves a page", async () => {
    const specimen = await load("specimen");
    const hostile = {
        name: "Evil",
        states: ["default", 'x" onload="alert(1)', "missing"],
        markup: {
            default:
                '<button class="b">Go</button><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/x.css"><iframe src="https://evil.example"></iframe><base href="https://evil.example/"><form action="https://evil.example"><input></form><img src="https://evil.example/p.png" alt="">',
            'x" onload="alert(1)': "<b>ok</b>",
        },
        css: ".b{color:red} </style><script>alert(2)</script><style>",
    };
    const page = specimen.specimenDocument({
        component: hostile,
        mode: 'dark" onload="alert(3)',
        theme: ":root{--a:1}",
        colors: { canvas: "rgb(0 0 0)", surface: "rgb(9 9 9)", text: "rgb(255 255 255)" },
    });

    // A policy that lets nothing in, first among what the page says.
    assert.ok(page.indexOf("Content-Security-Policy") < page.indexOf("<style>"));
    assert.match(page, /default-src 'none'/);
    // None of the tags that load, run, or move a page (the CSS is text of its own element): the one tag that is allowed stays.
    const outside = page.replace(/<style>[\s\S]*?<\/style>/g, "");

    for (const tag of [
        "<script",
        '<meta http-equiv="refresh"',
        "<link",
        "<iframe",
        "<base",
        "<form",
    ]) {
        assert.equal(outside.includes(tag), false, tag);
    }

    assert.match(page, /<button class="b">Go<\/button>/);
    // The CSS cannot end its own element; a state's name or a mode's is text, never markup.
    assert.equal((page.match(/<\/style/g) ?? []).length, 3);
    assert.ok(!page.includes('onload="alert'));
    assert.match(page, /&#34; onload=&#34;alert\(1\)/);
    assert.equal((page.match(/<figure>/g) ?? []).length, 2);
    assert.equal(specimen.escapeHtml(`<a href="x">&'`), "&#60;a href=&#34;x&#34;&#62;&#38;&#39;");
});

test("a font family the app has shows in it, and a typography value becomes safe styles", () => {
    assert.equal(sys.fontStack("Geist, system-ui"), '"Pocket Sans", Geist, system-ui');
    assert.equal(
        sys.fontStack('"JetBrains Mono", monospace'),
        '"Pocket Mono", "JetBrains Mono", monospace',
    );
    assert.equal(sys.fontStack("Inter"), "Inter");

    const style = sys.typographyStyle({
        fontFamily: ["Geist", "sans-serif"],
        fontSize: { value: 20, unit: "px" },
        fontWeight: 600,
        lineHeight: 1.15,
        letterSpacing: "red; background: url(x)",
    });

    assert.match(
        style,
        /^font-family:"Pocket Sans", Geist, sans-serif;font-size:20px;font-weight:600;line-height:1.15$/,
    );
    assert.ok(!style.includes("url"), "an unsafe value is dropped, not cleaned");
    assert.equal(sys.typographyStyle("x"), "");
    assert.equal(
        sys.shadowOf({
            color: { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.2 },
            offsetX: "0px",
            offsetY: { value: 6, unit: "px" },
            blur: "16px",
            spread: "-4px",
        }),
        "0px 6px 16px -4px rgb(0 0 0 / 0.2)",
    );
    assert.equal(sys.shadowOf({ color: "nonsense", offsetX: "0px" }), "");
    assert.equal(
        sys.shadowOf([
            {
                inset: true,
                color: "#000",
                offsetX: "0px",
                offsetY: "1px",
                blur: "2px",
                spread: "0px",
            },
        ]),
        "inset 0px 1px 2px 0px rgb(0 0 0)",
    );
});

test("a typography style is drawn from the tokens its parts link to, so an edit to one moves it", () => {
    const body = system.tokens.find((token) => token.name === "type.body")!;

    assert.equal(body.modes.light!.parts!["font-size"], "var(--font-size-base)");

    const saved = sys.createModel(system);
    const edited = sys.createModel(
        system,
        sys.tokenEdits(
            sys.push(
                sys.emptyHistory(),
                sys.tokenEdit("light", "font.size.base", { value: { value: 20, unit: "px" } }),
            ),
        ),
    );
    const now = (model: { value: (name: string, mode: string) => unknown }) =>
        model.value("type.body", "light");

    assert.match(sys.typographyStyleOf(saved, "light", now(saved)), /--font-size-base:16px/);
    assert.match(
        sys.typographyStyleOf(saved, "light", now(saved)),
        /font-size:var\(--font-size-base\)/,
    );
    assert.match(sys.typographyStyleOf(edited, "light", now(edited)), /--font-size-base:20px/);
    assert.match(
        sys.typographyStyleOf(saved, "light", now(saved)),
        /--font-family-sans:"Pocket Sans", Geist/,
    );
    assert.equal(sys.typographyMeta(saved, "light", now(saved)), "16px / 1.5 · 400 · Geist");
    assert.equal(sys.typographyMeta(edited, "light", now(edited)), "20px / 1.5 · 400 · Geist");
    assert.equal(sys.typographyStyleOf(saved, "light", { value: "x" }), "");
    assert.match(
        sys.typographyStyleOf(saved, "light", { value: { fontSize: "12px" } }),
        /font-size:12px/,
    );
    assert.equal(sys.literalOf(edited, "light", "var(--font-size-base)/1"), "20px/1");
    assert.equal(sys.scopeStyle(saved, "light", "var(--nothing)"), "");
});

test("a text color with no pair is checked against the page only when it is plain text, and the engine's declared pairs are the rest", () => {
    const bare = {
        ...system,
        tokens: system.tokens.map((token) => {
            const { contrast: _, contrasts: __, ...rest } = token;

            return rest as typeof token;
        }),
    };
    const model = sys.createModel(bare);
    const plain = model.contrastOf("color.text.secondary", "light");

    assert.equal(plain.auto, true);
    assert.equal(plain.on, "color.bg.canvas");
    assert.equal(plain.min, 4.5);

    // Text on another ground, or that is quiet on purpose, is not worked out against the page: it would only mislead.
    for (const name of [
        "color.text.inverse",
        "color.text.disabled",
        "color.accent.default",
        "color.bg.surface",
    ]) {
        assert.equal(model.contrastOf(name, "light"), null, name);
    }
});

test("a mode's token is its own or the default's: the engine says which, an edit can give it back, and a save removes it", () => {
    const model = sys.createModel(system);

    assert.equal(model.overridden("color.bg.canvas", "light"), true);
    assert.equal(model.overridden("color.bg.canvas", "dark"), true);
    assert.equal(model.overridden("color.border.focus", "dark"), false, "the file does not set it");
    assert.equal(model.savedOverride("color.border.focus", "dark"), false);

    const history = sys.push(
        sys.emptyHistory(),
        sys.tokenEdit("dark", "color.bg.canvas", { inherit: true }),
        1,
        false,
    );
    const after = sys.createModel(system, sys.tokenEdits(history));

    assert.equal(after.overridden("color.bg.canvas", "dark"), false);
    assert.equal(
        after.value("color.bg.canvas", "dark").value,
        after.value("color.bg.canvas", "light").value,
    );
    assert.equal(after.value("color.bg.canvas", "dark").alias, "color.gray.50");
    assert.deepEqual(sys.changeOf(system, history), {
        set: [],
        remove: [{ mode: "dark", token: "color.bg.canvas" }],
        count: 1,
    });

    for (const [mode, token] of [
        ["dark", "color.border.focus"],
        ["light", "color.bg.canvas"],
    ]) {
        assert.equal(
            sys.changeOf(
                system,
                sys.push(
                    sys.emptyHistory(),
                    sys.tokenEdit(mode, token, { inherit: true }),
                    1,
                    false,
                ),
            ).count,
            0,
            `${mode} ${token}`,
        );
    }

    const edited = sys.createModel(
        system,
        sys.tokenEdits(
            sys.push(
                sys.push(
                    sys.emptyHistory(),
                    sys.tokenEdit("light", "color.border.focus", { value: "#ff0000" }),
                    1,
                    false,
                ),
                sys.tokenEdit("light", "color.bg.canvas", { value: "#00ff00" }),
                2,
                false,
            ),
        ),
    );

    assert.equal(edited.value("color.border.focus", "dark").value, "#ff0000");
    assert.notEqual(edited.value("color.bg.canvas", "dark").value, "#00ff00");

    const own = sys.createModel(
        system,
        sys.tokenEdits(
            sys.push(
                sys.emptyHistory(),
                sys.tokenEdit("dark", "color.border.focus", { value: "#123456" }),
                1,
                false,
            ),
        ),
    );

    assert.equal(own.overridden("color.border.focus", "dark"), true);
});

test("a shadow is read as parts that keep their links, and an edit to one part is a value that a save writes as the file has it", () => {
    const model = sys.createModel(system);
    const { layers } = model.shadowRaw("shadow.lg", "light");

    assert.equal(layers.length, 1);
    assert.equal(layers[0].offsetY, "{space.4}");
    assert.equal(layers[0].blur, "{space.12}");
    assert.equal(layers[0].color, "{color.scrim.40}");
    assert.equal(sys.linkOf(layers[0].offsetY), "space.4");
    assert.equal(sys.linkOf(layers[0].offsetX), null);
    assert.equal(sys.amountOf(layers[0].spread)?.n, -12);

    const next = sys.withPart(sys.withPart(layers, 0, "blur", "{space.8}"), 0, "color", "#112233");
    const history = sys.push(
        sys.emptyHistory(),
        sys.tokenEdit("light", "shadow.lg", { value: sys.shadowValue(next) }),
        1,
        false,
    );
    const edited = sys.createModel(system, sys.tokenEdits(history));
    const now = edited.value("shadow.lg", "light");

    assert.equal(now.edited, true);
    assert.equal(now.value[0].blur.value, 32, "space.8 is 32px");
    assert.equal(now.value[0].color, "#112233");
    assert.match(now.css, /^0px var\(--space-4\) var\(--space-8\) -12px /);
    assert.match(sys.shadowOf(now.value), /^0px 16px 32px -12px /);
    assert.equal(edited.shadowRaw("shadow.lg", "light").layers[0].blur, "{space.8}");
    assert.deepEqual(sys.changeOf(system, history).set, [
        {
            mode: "light",
            token: "shadow.lg",
            value: { ...layers[0], blur: "{space.8}", color: "#112233" },
        },
    ]);
    assert.match(edited.value("shadow.lg", "dark").css, /var\(--space-8\)/);

    const two = sys.shadowValue([layers[0], { ...layers[0], inset: true }]);

    assert.equal(Array.isArray(two), true);
    assert.equal(sys.shadowValue([layers[0]]), layers[0]);
    assert.equal(sys.withPart(layers, 0, "inset", true)[0].inset, true);
    assert.equal(
        "inset" in sys.withPart(sys.withPart(layers, 0, "inset", true), 0, "inset", false)[0],
        false,
    );
});

test("a color lists all its contrast pairs, and a pair that is exempt is a note and not a failure", () => {
    const model = sys.createModel(system);
    const link = model.contrastsOf("color.text.link", "light");

    assert.deepEqual(
        link.map((each: { on: string }) => each.on),
        ["color.bg.surface", "color.bg.canvas"],
    );
    assert.ok(link.every((each: { pass: boolean }) => each.pass));
    assert.equal(
        model.contrastOf("color.text.link", "light").on,
        "color.bg.surface",
        "the first pair is the badge",
    );

    const hint = model.contrastsOf("color.text.placeholder", "light");

    assert.equal(hint.length, 1);
    assert.equal(hint[0].pass, false);
    assert.equal(hint[0].exempt, "decorative");
    assert.ok(system.notes?.some((each) => each.token === "color.text.placeholder"));
    assert.equal(
        system.problems.some((each) => each.token === "color.text.placeholder"),
        false,
    );
});

test("the Ferry page's image has a real source (a small picture, not a broken icon) and still has no alt text, which the check needs", () => {
    const html = ferryPage("");
    const image = /<img data-pid="photo"[^>]*>/.exec(html)![0];

    assert.match(image, /src="data:image\/svg\+xml,%3Csvg /);
    assert.doesNotMatch(image, /\salt=/);
    assert.doesNotMatch(
        image,
        /R0lGODlhAQABAAAAACw/,
        "not the one-pixel gif that draws as a broken image",
    );
});

const FLAGSHIP = new URL("../docs/examples/design-system/pocket", import.meta.url).pathname;

test("spacing is grouped as the documentation page groups it: steps, roles, sizes, then a component's own", async () => {
    const flagship = loadDesignSystem(FLAGSHIP)!;
    const { renderSystemDoc } = await import("../src/server/design/docsite.ts");
    const groups = sys.groupsOf(flagship.tokens, "spacing");
    const names = (kind: string) =>
        groups
            .find((group: { kind: string }) => group.kind === kind)
            ?.tokens.map((each: { name: string }) => each.name) ?? [];

    assert.deepEqual(
        groups.map((group: { title: string }) => group.title),
        ["Steps", "Roles", "Sizes", "Component tokens"],
    );
    assert.deepEqual(
        groups.map((group: { fold: boolean }) => group.fold),
        [false, false, false, true],
    );
    assert.ok(
        names("steps").length >= 8 && names("steps").every((each: string) => /^space\./.test(each)),
    );
    assert.deepEqual(names("roles"), ["layout.gap.in", "layout.gap.out"]);
    assert.ok(
        names("sizes").includes("size.control.sm") && names("sizes").includes("size.icon.md"),
    );
    assert.equal(
        groups.reduce((sum: number, group: { tokens: unknown[] }) => sum + group.tokens.length, 0),
        flagship.tokens.filter((each) => sys.sectionOf(each) === "spacing").length,
        "every token of the section is in a group",
    );

    const page = renderSystemDoc(flagship).html;

    const part = (id: string) => {
        const from = page.indexOf(`<h3 id="${id}">`);
        const rest = page.slice(from + 1);
        const to = rest.search(/<h3[ >]|<h2 /);

        return [
            ...rest
                .slice(0, to === -1 ? undefined : to)
                .matchAll(/<button class="tk">([^<]+)<\/button>/g),
        ].map((each) => each[1]!.replace(/&[a-z]+;/g, ""));
    };

    assert.deepEqual(names("steps").slice().sort(), part("spacing-steps").sort());
    assert.deepEqual(names("roles").slice().sort(), part("spacing-roles").sort());
    assert.deepEqual(names("sizes").slice().sort(), part("sizes").sort());
});

test("radii: the scale first, then the roles that point at it, then a component's own", () => {
    const flagship = loadDesignSystem(FLAGSHIP)!;
    const groups = sys.groupsOf(flagship.tokens, "radii");

    assert.deepEqual(
        groups.map((group: { title: string }) => group.title),
        ["Scale", "Roles", "Component tokens"],
    );
    assert.deepEqual(
        groups[0].tokens.map((each: { name: string }) => each.name),
        [
            "radius.scale.xs",
            "radius.scale.sm",
            "radius.scale.md",
            "radius.scale.lg",
            "radius.scale.xl",
            "radius.scale.full",
        ],
    );
    assert.ok(groups[1].tokens.some((each: { name: string }) => each.name === "radius.card"));
    assert.equal(sys.sectionCounts(flagship.tokens).radii.open, groups[1].tokens.length);
});

test("every layer of a shadow is told with its color, and the one-line summary names the layers after the first", () => {
    const lines = sys.shadowLines([
        { color: "#00000024", offsetX: "0px", offsetY: "24px", blur: "60px", spread: "-16px" },
        {
            color: "#ffffff2b",
            offsetX: "0px",
            offsetY: "0px",
            blur: "0px",
            spread: "1px",
            inset: true,
        },
    ]);

    assert.deepEqual(lines, [
        { words: "y 24 · blur 60 · spread -16 · 14%", color: "#00000024" },
        { words: "inset y 0 · blur 0 · spread 1 · 17%", color: "#ffffff2b" },
    ]);
    assert.deepEqual(sys.shadowLines(null), []);
});
