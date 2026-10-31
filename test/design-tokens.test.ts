import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawSystem } from "../src/server/design/tokens-base.ts";
import { scaleOf } from "../src/server/design/tokens-compile.ts";
import { buildSystem } from "../src/server/design/tokens-model.ts";
import type { DesignSystem, ResolvedToken } from "../src/server/design/system-types.ts";

function build(
    tokens: unknown,
    options: { modes?: Record<string, unknown>; components?: Record<string, string> } = {},
): DesignSystem {
    const raw: RawSystem = {
        folder: "project",
        tokens,
        modes: new Map(Object.entries(options.modes ?? {})),
        components: new Map(Object.entries(options.components ?? {})),
        guidelines: "",
        problems: [],
    };

    return buildSystem(raw);
}

const token = (system: DesignSystem, name: string): ResolvedToken => {
    const found = system.tokens.find((each) => each.name === name);

    assert.ok(
        found,
        `token ${name} exists (have ${system.tokens.map((each) => each.name).join(", ")})`,
    );

    return found;
};

const errors = (system: DesignSystem) =>
    system.problems
        .filter((problem) => problem.level === "error")
        .map((problem) => problem.message);
const warnings = (system: DesignSystem) =>
    system.problems
        .filter((problem) => problem.level === "warning")
        .map((problem) => problem.message);
const css = (system: DesignSystem, name: string, mode = system.modes[0]!) =>
    token(system, name).modes[mode]!.css;

test("both value forms of every type become CSS", () => {
    const system = build({
        color: {
            $type: "color",
            hex: { $value: "#7AA2F7" },
            fn: { $value: "oklch(0.72 0.12 264)" },
            name: { $value: "RebeccaPurple" },
            obj: { $value: { colorSpace: "srgb", components: [0.5, 0.2, 1] } },
            alpha: { $value: { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5 } },
            p3: { $value: { colorSpace: "display-p3", components: [1, 0, 0] } },
        },
        size: {
            $type: "dimension",
            str: { $value: "1.5rem" },
            obj: { $value: { value: 16, unit: "px" } },
            zero: { $value: 0 },
            calc: { $value: "calc(100% - 2rem)" },
            clamp: { $value: "clamp(1rem, 2vw + 0.5rem, 1.5rem)" },
        },
        time: {
            $type: "duration",
            str: { $value: "0.2s" },
            obj: { $value: { value: 200, unit: "ms" } },
        },
        ease: {
            $type: "cubicBezier",
            arr: { $value: [0.4, 0, 0.2, 1] },
            kw: { $value: "ease-out" },
            fn: { $value: "cubic-bezier(0.4, 0, 0.2, 1)" },
        },
        weight: {
            $type: "fontWeight",
            num: { $value: 700 },
            word: { $value: "semi-bold" },
            digits: { $value: "500" },
        },
        font: {
            $type: "fontFamily",
            arr: { $value: ["Geist", "Segoe UI", "ui-sans-serif", "sans-serif"] },
            str: { $value: "'JetBrains Mono', ui-monospace, monospace" },
        },
        n: { $type: "number", one: { $value: 1.5 }, text: { $value: "2" } },
    });

    assert.deepEqual(errors(system), []);
    assert.equal(css(system, "color.hex"), "#7aa2f7");
    assert.equal(css(system, "color.fn"), "oklch(0.72 0.12 264)");
    assert.equal(css(system, "color.name"), "rebeccapurple");
    assert.equal(css(system, "color.obj"), "#8033ff");
    assert.equal(css(system, "color.alpha"), "rgb(0 0 0 / 0.5)");
    assert.equal(css(system, "color.p3"), "color(display-p3 1 0 0)");
    assert.equal(token(system, "color.hex").modes.light!.hex, "#7aa2f7");
    assert.equal(token(system, "color.obj").modes.light!.hex, "#8033ff");
    assert.equal(css(system, "size.str"), "1.5rem");
    assert.equal(css(system, "size.obj"), "16px");
    assert.equal(css(system, "size.zero"), "0");
    assert.equal(css(system, "size.calc"), "calc(100% - 2rem)");
    assert.equal(css(system, "size.clamp"), "clamp(1rem, 2vw + 0.5rem, 1.5rem)");
    assert.equal(css(system, "time.str"), "0.2s");
    assert.equal(css(system, "time.obj"), "200ms");
    assert.equal(css(system, "ease.arr"), "cubic-bezier(0.4, 0, 0.2, 1)");
    assert.equal(css(system, "ease.kw"), "ease-out");
    assert.equal(css(system, "ease.fn"), "cubic-bezier(0.4, 0, 0.2, 1)");
    assert.equal(css(system, "weight.num"), "700");
    assert.equal(css(system, "weight.word"), "600");
    assert.equal(css(system, "weight.digits"), "500");
    assert.equal(css(system, "font.arr"), 'Geist, "Segoe UI", ui-sans-serif, sans-serif');
    assert.equal(css(system, "font.str"), "'JetBrains Mono', ui-monospace, monospace");
    assert.equal(css(system, "n.one"), "1.5");
    assert.equal(css(system, "n.text"), "2");
    assert.deepEqual(token(system, "color.obj").modes.light!.value, {
        colorSpace: "srgb",
        components: [0.5, 0.2, 1],
    });
});

test("composite types: shadow, typography, border, transition, gradient, strokeStyle", () => {
    const system = build({
        color: { $type: "color", ink: { $value: "#101820" }, line: { $value: "{color.ink}" } },
        t: {
            shadow: {
                $type: "shadow",
                one: {
                    $value: { color: "#00000033", offsetX: "0px", offsetY: "1px", blur: "2px" },
                },
                two: {
                    $value: [
                        {
                            color: "{color.ink}",
                            offsetX: "0",
                            offsetY: "4px",
                            blur: "8px",
                            spread: "-2px",
                        },
                        {
                            color: "#fff",
                            offsetX: "0",
                            offsetY: "0",
                            blur: "0",
                            spread: "1px",
                            inset: true,
                        },
                    ],
                },
                css: { $value: "0 1px 2px rgb(0 0 0 / 0.2)" },
            },
            border: {
                $type: "border",
                hair: { $value: { color: "{color.line}", width: "1px", style: "dashed" } },
            },
            move: {
                $type: "transition",
                std: {
                    $value: { duration: "200ms", timingFunction: [0.4, 0, 0.2, 1], delay: "50ms" },
                },
            },
            fade: {
                $type: "gradient",
                a: {
                    $value: [
                        { color: "#000", position: 0 },
                        { color: "{color.ink}", position: 1 },
                    ],
                },
                s: { $value: "linear-gradient(90deg, red, blue)" },
            },
            line: {
                $type: "strokeStyle",
                dash: { $value: { dashArray: ["2px"], lineCap: "round" } },
            },
            type: {
                $type: "typography",
                body: {
                    $value: {
                        fontFamily: ["Inter", "sans-serif"],
                        fontSize: "1rem",
                        fontWeight: 400,
                        lineHeight: 1.5,
                        letterSpacing: "0.01em",
                    },
                },
            },
        },
    });

    assert.deepEqual(errors(system), []);
    assert.equal(css(system, "t.shadow.one"), "0px 1px 2px #00000033");
    assert.equal(
        css(system, "t.shadow.two"),
        "0 4px 8px -2px var(--color-ink), inset 0 0 0 1px #fff",
    );
    assert.equal(
        token(system, "t.shadow.two").modes.light!.literal,
        "0 4px 8px -2px #101820, inset 0 0 0 1px #fff",
    );
    assert.equal(css(system, "t.shadow.css"), "0 1px 2px rgb(0 0 0 / 0.2)");
    assert.equal(css(system, "t.border.hair"), "1px dashed var(--color-line)");
    assert.equal(css(system, "t.move.std"), "200ms cubic-bezier(0.4, 0, 0.2, 1) 50ms");
    assert.equal(
        css(system, "t.fade.a"),
        "linear-gradient(to right, #000 0%, var(--color-ink) 100%)",
    );
    assert.equal(css(system, "t.fade.s"), "linear-gradient(90deg, red, blue)");
    assert.equal(css(system, "t.line.dash"), "dashed");

    const type = token(system, "t.type.body").modes.light!;

    assert.equal(type.css, "400 1rem/1.5 Inter, sans-serif");
    assert.deepEqual(type.parts, {
        "font-family": "Inter, sans-serif",
        "font-size": "1rem",
        "font-weight": "400",
        "line-height": "1.5",
        "letter-spacing": "0.01em",
    });
});

test("a type comes from the token, its group, a reference, or its value (with a warning)", () => {
    const system = build({
        group: {
            $type: "dimension",
            own: { $value: "4px" },
            nested: { deeper: { $value: "8px" }, wide: { $type: "color", $value: "#fff" } },
        },
        alias: { $value: "{group.own}" },
        guess: { $value: "#112233" },
        guessLen: { $value: "12px" },
        guessMs: { $value: "120ms" },
        guessNum: { $value: 3 },
    });

    assert.equal(token(system, "group.own").type, "dimension");
    assert.equal(token(system, "group.nested.deeper").type, "dimension");
    assert.equal(token(system, "group.nested.wide").type, "color");
    assert.equal(token(system, "alias").type, "dimension", "a reference takes its target's type");
    assert.equal(token(system, "guess").type, "color");
    assert.equal(token(system, "guessLen").type, "dimension");
    assert.equal(token(system, "guessMs").type, "duration");
    assert.equal(token(system, "guessNum").type, "number");
    assert.ok(
        warnings(system).some((text) => /"guess" has no \$type; it is read as color/.test(text)),
    );
    assert.deepEqual(errors(system), []);
});

test("a token with no type and no clue is an error that lists the types", () => {
    const system = build({ mystery: { $value: { a: 1 } } });

    assert.equal(system.tokens.length, 0);
    assert.match(errors(system)[0]!, /no \$type.*one of color, dimension/);
});

test("references: chains, composite members, embedded in a calc, and $root", () => {
    const system = build({
        space: {
            $type: "dimension",
            base: { $value: "4px" },
            wide: { $value: "calc({space.base} * 4)" },
        },
        color: {
            $type: "color",
            blue: { $root: { $value: "#0000ff" }, light: { $value: "#8888ff" } },
            link: { $value: "{color.blue}" },
            hover: { $value: "{color.link}" },
        },
    });

    assert.deepEqual(errors(system), []);
    assert.equal(css(system, "space.wide"), "calc(var(--space-base) * 4)");
    assert.equal(token(system, "space.wide").modes.light!.literal, "calc(4px * 4)");
    assert.equal(css(system, "color.hover"), "var(--color-link)");
    assert.equal(token(system, "color.hover").modes.light!.alias, "color.link");
    assert.equal(token(system, "color.hover").modes.light!.hex, "#0000ff");
    assert.equal(
        token(system, "color.blue").cssVar,
        "--color-blue",
        "$root is the group's own token",
    );
    assert.equal(token(system, "color.blue.light").cssVar, "--color-blue-light");
});

test("a missing reference names the nearest token; a cycle names its path; a type mismatch says both types", () => {
    const system = build({
        color: {
            $type: "color",
            accent: { $value: "{color.acent}" },
            bg: { $value: "#fff" },
            a: { $value: "{color.b}" },
            b: { $value: "{color.c}" },
            c: { $value: "{color.a}" },
            self: { $value: "{color.self}" },
        },
        space: { $type: "dimension", s: { $value: "4px" } },
        bad: { $type: "color", $value: "{space.s}" },
    });
    const list = errors(system);

    assert.ok(
        list.some((text) =>
            /\{color\.acent\} does not exist\. Did you mean \{color\.accent\}\?/.test(text),
        ),
    );
    assert.ok(
        list.some((text) =>
            /Reference cycle: color\.a → color\.b → color\.c → color\.a/.test(text),
        ),
        list.join("\n"),
    );
    assert.ok(list.some((text) => /Reference cycle: color\.self → color\.self/.test(text)));
    assert.ok(
        list.some((text) => /\{space\.s\} is a dimension, but a color is needed here/.test(text)),
    );
    assert.ok(system.tokens.some((each) => each.name === "color.bg"));
    assert.ok(!system.tokens.some((each) => each.name === "color.accent"));
    assert.equal(list.filter((text) => /Reference cycle: color\.a/.test(text)).length, 1);
});

test("a typeless alias of a missing token is still reported", () => {
    const system = build({ ghost: { $value: "{nowhere.here}" } });

    assert.ok(errors(system).some((text) => /\{nowhere\.here\} does not exist/.test(text)));
});

test("shape errors say how to write it", () => {
    const system = build({
        "bad name": { $value: "#fff", $type: "color" },
        plain: "#fff",
        old: { value: "#fff", type: "color" },
        hasKids: { $type: "color", $value: "#fff", child: { $value: "#000" } },
        __proto__: { x: { $value: "1", $type: "number" } },
        group: { ok: { $type: "number", $value: 1 } },
    });
    const list = errors(system);

    assert.ok(list.some((text) => /The name "bad name".*letters, digits/.test(text)));
    assert.ok(list.some((text) => /"plain" is a plain string.*\{ "\$value"/.test(text)));
    assert.ok(list.some((text) => /uses "value" and "type".*"\$value" and "\$type"/.test(text)));
    assert.ok(
        list.some((text) =>
            /"hasKids" has a \$value, so it is a token and cannot hold "child"/.test(text),
        ),
    );
    assert.ok(system.tokens.some((each) => each.name === "group.ok"));
});

test("bad values are errors with a fix", () => {
    const system = build({
        c: {
            $type: "color",
            a: { $value: "#12" },
            b: { $value: 5 },
            c: { $value: { colorSpace: "cmyk", components: [0, 0, 0] } },
        },
        d: {
            $type: "dimension",
            a: { $value: "big" },
            b: { $value: { value: "x", unit: "px" } },
            c: { $value: "16" },
        },
        t: { $type: "duration", a: { $value: "soon" } },
        e: { $type: "cubicBezier", a: { $value: [2, 0, 0.2, 1] }, b: { $value: "wobble" } },
        w: { $type: "fontWeight", a: { $value: 2000 }, b: { $value: "chonky" } },
        f: { $type: "fontFamily", a: { $value: [] }, b: { $value: "a; b" } },
        s: { $type: "shadow", a: { $value: { color: "#000" } }, b: { $value: [] } },
        n: { $type: "number", a: { $value: "abc" } },
        g: { $type: "gradient", a: { $value: [{ color: "#000", position: 0 }] } },
        ty: { $type: "typography", a: { $value: { fontSize: "1rem" } } },
        u: { $type: "weird", a: { $value: 1 } },
    });
    const list = errors(system).join("\n");

    assert.match(list, /"#12" is not a color/);
    assert.match(
        list,
        /A color is a string such as "#7aa2f7" or a \{ colorSpace, components \} object, not 5/,
    );
    assert.match(list, /colorSpace must be one of srgb/);
    assert.match(list, /"big" is not a dimension/);
    assert.match(list, /A dimension object is \{ "value": 16, "unit": "px" \}/);
    assert.match(list, /"soon" is not a duration/);
    assert.match(list, /A cubicBezier array is four numbers/);
    assert.match(list, /"wobble" is not an easing/);
    assert.match(list, /is not a font weight/);
    assert.match(list, /A fontFamily is a string/);
    assert.match(list, /not allowed in a token value/);
    assert.match(list, /offsetX is missing/);
    assert.match(list, /A shadow is one layer or an array of 1 to 8 layers/);
    assert.match(list, /A number token is a number such as 1.5, not "abc"/);
    assert.match(list, /A gradient is an array of 2 to 12 stops/);
    assert.match(list, /fontFamily is missing/);
    assert.match(list, /Unknown \$type "weird"/);
    assert.equal(css(system, "d.c"), "16px");
    assert.ok(warnings(system).some((text) => /"16" has no unit; it is read as 16px/.test(text)));
});

test("value text cannot end a rule, open markup, hide a comment, or load a URL", () => {
    for (const evil of [
        "Inter; } body { background: red",
        "Inter</style><script>x</script>",
        "a /* b",
        "url(https://evil.example/x.png)",
        'image-set("https://evil.example/x.png" 1x)',
        "x\\ny",
        "((x)",
        `"unclosed`,
        "x".repeat(500),
        "expression(alert(1))",
        "@import 'x'",
    ]) {
        const system = build({ font: { $type: "fontFamily", f: { $value: evil } } });

        assert.equal(system.tokens.length, 0, `refused: ${evil.slice(0, 30)}`);
        assert.equal(errors(system).length, 1);
    }

    assert.equal(
        errors(build({ s: { $type: "dimension", a: { $value: "calc(1px; color: red)" } } })).length,
        1,
    );
});

test("css variable names join the path with dashes, and two tokens may not share one", () => {
    const system = build({
        a: { "b-c": { $type: "number", $value: 1 } },
        "a-b": { c: { $type: "number", $value: 2 } },
    });

    assert.ok(
        errors(system).some((text) => /"a-b\.c" and "a\.b-c" both become --a-b-c/.test(text)),
    );
});

test("tiers: by group name, by extension, by reference, by role words, by component", () => {
    const system = build(
        {
            primitive: { gray: { $type: "color", 900: { $value: "#111" } } },
            color: {
                $type: "color",
                blue: { 500: { $value: "#37f" } },
                bg: { page: { $value: "{primitive.gray.900}" } },
                raw: { $value: "#222", $extensions: { "com.pi-pocket": { tier: "component" } } },
            },
            space: { $type: "dimension", 4: { $value: "16px" } },
            button: { primary: { bg: { $type: "color", $value: "{color.bg.page}" } } },
        },
        {
            components: {
                button: '<script type="application/json" id="pocket-component">{"name":"Button"}</script><template data-state="default"><button class="b"></button></template>',
            },
        },
    );
    const tier = (name: string) => token(system, name).tier;

    assert.equal(tier("primitive.gray.900"), "primitive");
    assert.equal(tier("color.blue.500"), "primitive");
    assert.equal(tier("color.bg.page"), "semantic");
    assert.equal(tier("color.raw"), "component");
    assert.equal(tier("space.4"), "primitive");
    assert.equal(tier("button.primary.bg"), "component");
});

test("modes: an override flows through the references that point at it", () => {
    const system = build(
        {
            color: {
                $type: "color",
                gray: { 50: { $value: "#fafafa" }, 900: { $value: "#111111" } },
                bg: { page: { $value: "{color.gray.50}" } },
                text: { primary: { $value: "{color.gray.900}" } },
                card: { $value: "{color.bg.page}" },
            },
        },
        {
            modes: {
                dark: {
                    color: {
                        gray: { 50: { $value: "#101010" } },
                        text: { primary: { $value: "{color.gray.50}" } },
                    },
                },
            },
        },
    );

    assert.deepEqual(errors(system), []);
    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(
        token(system, "color.bg.page").modes.dark!.hex,
        "#101010",
        "a primitive override flows to its alias",
    );
    assert.equal(token(system, "color.card").modes.dark!.hex, "#101010", "and through a chain");
    assert.equal(token(system, "color.text.primary").modes.dark!.hex, "#101010");
    assert.equal(token(system, "color.text.primary").modes.light!.hex, "#111111");
    assert.equal(token(system, "color.text.primary").modes.dark!.alias, "color.gray.50");
    assert.equal(system.schemes.light, "light");
    assert.equal(system.schemes.dark, "dark");
});

test("modes: a token only in a mode file, a type change, a bad name, and the default's name are errors", () => {
    const system = build(
        { color: { $type: "color", accent: { $value: "#37f" }, ink: { $value: "#000" } } },
        {
            modes: {
                dark: {
                    color: {
                        acent: { $value: "#fff" },
                        ink: { $type: "dimension", $value: "1px" },
                    },
                },
                "Bad Name": {},
                light: {},
            },
        },
    );
    const list = errors(system).join("\n");

    assert.match(list, /"color\.acent" is not in tokens\.json.*Did you mean "color\.accent"\?/);
    assert.match(list, /"color\.ink" is color in tokens\.json but dimension in tokens\.dark\.json/);
    assert.match(list, /The mode name "Bad Name" must be lowercase/);
    assert.match(list, /tokens\.light\.json has the name of the default mode/);
});

test("modes: the default mode can be named, the order puts dark first, and a scheme comes from the file, the name, or the page color", () => {
    const system = build(
        {
            $extensions: { "com.pi-pocket": { name: "Brand", mode: "day" } },
            color: { $type: "color", bg: { $value: "#ffffff" } },
        },
        {
            modes: {
                zebra: { color: { bg: { $value: "#ff0000" } } },
                night: {
                    $extensions: { "com.pi-pocket": { colorScheme: "dark" } },
                    color: { bg: { $value: "#808080" } },
                },
                dark: { color: { bg: { $value: "#000000" } } },
                "high-contrast": { color: { bg: { $value: "#000" } } },
                "light-soft": { color: { bg: { $value: "#eee" } } },
            },
        },
    );

    assert.equal(system.name, "Brand");
    assert.deepEqual(system.modes, [
        "day",
        "dark",
        "high-contrast",
        "light-soft",
        "night",
        "zebra",
    ]);
    assert.deepEqual(system.schemes, {
        day: "light",
        dark: "dark",
        "high-contrast": "dark",
        "light-soft": "light",
        night: "dark",
        zebra: "light",
    });
});

test("contrast pairs are checked in every mode, with the ratio kept", () => {
    const system = build(
        {
            color: {
                $type: "color",
                bg: { $value: "#ffffff" },
                text: {
                    ok: {
                        $value: "#111111",
                        $extensions: {
                            "com.pi-pocket": { contrast: { on: "{color.bg}", min: 4.5 } },
                        },
                    },
                    weak: {
                        $value: "#999999",
                        $extensions: { "com.pi-pocket": { contrast: { on: "color.bg" } } },
                    },
                    many: {
                        $value: "#111111",
                        $extensions: {
                            "com.pi-pocket": {
                                contrast: [
                                    { on: "{color.bg}", min: 7 },
                                    { on: "{color.panel}", min: 4.5 },
                                ],
                            },
                        },
                    },
                },
                panel: { $value: "#222222" },
            },
        },
        { modes: { dark: { color: { bg: { $value: "#000000" }, panel: { $value: "#eeeeee" } } } } },
    );

    const ok = token(system, "color.text.ok");

    assert.deepEqual(ok.contrast, { on: "color.bg", min: 4.5 });
    assert.equal(ok.modes.light!.contrast!.pass, true);
    assert.ok(ok.modes.light!.contrast!.ratio > 17);
    assert.equal(ok.modes.dark!.contrast!.pass, false, "#111 on black fails in dark");
    assert.ok(ok.modes.dark!.contrast!.ratio < 1.2);

    const weak = token(system, "color.text.weak");

    assert.equal(weak.modes.light!.contrast!.pass, false, "#999 on white is 2.848:1");
    assert.equal(
        weak.modes.light!.contrast!.ratio,
        2.84,
        "the ratio is cut, not rounded up, so a pass is honest",
    );

    const messages = warnings(system).filter((text) => /Contrast of/.test(text));

    assert.equal(messages.length, 3, "one warning for each failing token, not one for each mode");
    assert.match(
        messages.find((text) => /color\.text\.ok/.test(text))!,
        /dark 1\.\d\d:1 on color\.bg \(needs 4\.5\)/,
    );
    assert.match(
        messages.find((text) => /color\.text\.many/.test(text))!,
        /on color\.panel \(needs 4\.5\)/,
    );
    assert.deepEqual(errors(system), []);
});

test("a bad contrast declaration is an error that shows the shape", () => {
    const system = build({
        color: {
            $type: "color",
            bg: { $value: "#fff" },
            a: {
                $value: "#000",
                $extensions: { "com.pi-pocket": { contrast: { on: "{color.nope}" } } },
            },
            b: {
                $value: "#000",
                $extensions: { "com.pi-pocket": { contrast: { on: "{color.bg}", min: 40 } } },
            },
        },
        space: {
            $type: "dimension",
            s: {
                $value: "1px",
                $extensions: { "com.pi-pocket": { contrast: { on: "{color.bg}" } } },
            },
        },
    });

    assert.equal(errors(system).length, 3);
    assert.ok(errors(system).every((text) => /contrast pair/.test(text)));
});

test("deprecated tokens still in use are reported", () => {
    const system = build({
        color: {
            $type: "color",
            old: { $value: "#111", $deprecated: "use color.new" },
            new: { $value: "#222" },
            link: { $value: "{color.old}" },
        },
    });

    assert.equal(token(system, "color.old").deprecated, "use color.new");
    assert.ok(
        warnings(system).some((text) =>
            /"color\.old" is deprecated \(use color\.new\) but color\.link still uses it/.test(
                text,
            ),
        ),
    );
});

test("semantic colors that hold raw values next to a palette get one aggregated warning", () => {
    const system = build({
        color: {
            $type: "color",
            blue: { 500: { $value: "#37f" } },
            bg: { page: { $value: "#fff" }, surface: { $value: "#eee" } },
        },
    });
    const notes = warnings(system).filter((text) => /raw value/.test(text));

    assert.equal(notes.length, 1);
    assert.match(
        notes[0]!,
        /2 semantic colors hold raw values.*color\.bg\.page, color\.bg\.surface/,
    );
});

test("a missing tokens.json is a warning, not a crash", () => {
    const system = build(undefined);

    assert.equal(system.tokens.length, 0);
    assert.deepEqual(errors(system), []);
    assert.match(warnings(system)[0]!, /no tokens\.json/);
    assert.equal(system.name, "project");
    assert.match(system.compiled.css, /:root/);
});

test("limits: too many tokens, and groups nested too deep", () => {
    const many: Record<string, unknown> = { n: { $type: "number" } };

    for (let i = 0; i < 5100; i++) {
        (many.n as Record<string, unknown>)[`t${i}`] = { $value: i };
    }

    const big = build(many);

    assert.equal(big.tokens.length, 5000);
    assert.ok(errors(big).some((text) => /more than 5000 tokens/.test(text)));

    let deep: Record<string, unknown> = { $type: "number", $value: 1 };

    for (let i = 0; i < 20; i++) {
        deep = { g: deep };
    }

    assert.ok(errors(build(deep)).some((text) => /nest more than 12 levels/.test(text)));
});

test("more problems than the limit are cut with a note", () => {
    const bad: Record<string, unknown> = { c: { $type: "color" } };

    for (let i = 0; i < 300; i++) {
        (bad.c as Record<string, unknown>)[`t${i}`] = { $value: "nope" };
    }

    const system = build(bad);

    assert.equal(system.problems.length, 201);
    assert.match(system.problems.at(-1)!.message, /100 more problems are not shown/);
});

test("the semantic tier pairs aliases with the role words, and a system of palettes only still builds", () => {
    const system = build({
        color: {
            $type: "color",
            red: { 500: { $value: "#f00" } },
            green: { 500: { $value: "#0f0" } },
        },
    });

    assert.deepEqual(errors(system), []);
    assert.ok(system.tokens.every((each) => each.tier === "primitive"));
    assert.equal(system.tokens[0]!.cssVar, "--color-red-500");
});

test("composite values come back fully resolved in every mode: no reference is left in a value", () => {
    const system = build(
        {
            $extensions: { "com.pi-pocket": { mode: "day" } },
            color: {
                $type: "color",
                ink: { $value: "#101820" },
                line: { $value: "{color.ink}" },
                shadowtone: { $value: "#00000033" },
            },
            font: {
                family: { $type: "fontFamily", sans: { $value: ["Inter", "sans-serif"] } },
                size: { $type: "dimension", md: { $value: "1rem" } },
                weight: { $type: "fontWeight", bold: { $value: 700 } },
            },
            motion: {
                $type: "cubicBezier",
                out: { $value: [0.2, 0, 0, 1] },
            },
            time: { $type: "duration", fast: { $value: "120ms" } },
            space: {
                $type: "dimension",
                2: { $value: "8px" },
                wide: { $value: "calc({space.2} * 3)" },
            },
            shadow: {
                $type: "shadow",
                card: {
                    $value: [
                        {
                            color: "{color.shadowtone}",
                            offsetX: "0",
                            offsetY: "{space.2}",
                            blur: "16px",
                        },
                        {
                            color: "{color.line}",
                            offsetX: "0",
                            offsetY: "0",
                            blur: "0",
                            spread: "1px",
                        },
                    ],
                },
                text: { $value: "0 1px {space.2} {color.shadowtone}" },
                again: { $value: "{shadow.card}" },
            },
            type: {
                body: {
                    $type: "typography",
                    $value: {
                        fontFamily: "{font.family.sans}",
                        fontSize: "{font.size.md}",
                        fontWeight: "{font.weight.bold}",
                        lineHeight: 1.5,
                    },
                },
            },
            edge: {
                $type: "border",
                hair: { $value: { color: "{color.line}", width: "1px", style: "solid" } },
            },
            move: {
                $type: "transition",
                std: { $value: { duration: "{time.fast}", timingFunction: "{motion.out}" } },
            },
            fade: {
                $type: "gradient",
                a: {
                    $value: [
                        { color: "{color.ink}", position: 0 },
                        { color: "{color.line}", position: 1 },
                    ],
                },
            },
        },
        {
            modes: {
                night: {
                    color: { ink: { $value: "#f0f4f8" }, shadowtone: { $value: "#000000cc" } },
                },
            },
        },
    );

    assert.deepEqual(errors(system), []);
    assert.deepEqual(system.modes, ["day", "night"]);

    for (const each of system.tokens) {
        for (const [mode, value] of Object.entries(each.modes)) {
            const json = JSON.stringify(value.value);

            assert.ok(!/\{[a-z]/i.test(json), `${each.name} in ${mode} holds a reference: ${json}`);
            assert.ok(!/var\(/.test(json), `${each.name} in ${mode} holds a var(): ${json}`);
        }
    }

    const shadow = token(system, "shadow.card");

    assert.deepEqual(shadow.modes.day!.value, [
        { color: "#00000033", offsetX: "0", offsetY: "8px", blur: "16px" },
        { color: "#101820", offsetX: "0", offsetY: "0", blur: "0", spread: "1px" },
    ]);
    assert.equal((shadow.modes.night!.value as { color: string }[])[1]!.color, "#f0f4f8");
    assert.equal((shadow.modes.night!.value as { color: string }[])[0]!.color, "#000000cc");
    assert.equal(
        token(system, "shadow.text").modes.day!.value,
        "0 1px 8px #00000033",
        "a string form is resolved too",
    );
    assert.equal(token(system, "space.wide").modes.day!.value, "calc(8px * 3)");
    assert.deepEqual(
        token(system, "shadow.again").modes.day!.value,
        shadow.modes.day!.value,
        "an alias holds the target's value",
    );
    assert.deepEqual(token(system, "type.body").modes.day!.value, {
        fontFamily: ["Inter", "sans-serif"],
        fontSize: "1rem",
        fontWeight: 700,
        lineHeight: 1.5,
    });
    assert.deepEqual(token(system, "edge.hair").modes.night!.value, {
        color: "#f0f4f8",
        width: "1px",
        style: "solid",
    });
    assert.deepEqual(token(system, "move.std").modes.day!.value, {
        duration: "120ms",
        timingFunction: [0.2, 0, 0, 1],
    });
    assert.deepEqual(token(system, "fade.a").modes.night!.value, [
        { color: "#f0f4f8", position: 0 },
        { color: "#f0f4f8", position: 1 },
    ]);
    assert.equal(token(system, "font.size.md").type, "dimension");
    assert.equal(token(system, "font.weight.bold").type, "fontWeight");
    assert.equal(token(system, "color.line").tier, "semantic");
});

test("scaleOf says which dimension tokens are the type, spacing, and radius scales", () => {
    const system = build({
        font: {
            size: { $type: "dimension", md: { $value: "1rem" } },
            weight: { $type: "fontWeight", bold: { $value: 700 } },
        },
        text: { $type: "dimension", sm: { $value: "0.875rem" } },
        space: { $type: "dimension", 4: { $value: "16px" }, gap: { in: { $value: "8px" } } },
        spacing: { $type: "dimension", 2: { $value: "8px" } },
        radius: { $type: "dimension", card: { $value: "12px" } },
        radii: { $type: "dimension", sm: { $value: "4px" } },
        breakpoint: { $type: "dimension", md: { $value: "768px" } },
        size: { $type: "dimension", control: { md: { $value: "36px" } } },
        dim: { $type: "dimension", 4: { $value: "16px" } },
        border: { width: { $type: "dimension", hairline: { $value: "1px" } } },
        ease: { $type: "cubicBezier", out: { $value: [0, 0, 0.2, 1] } },
    });
    const scales = Object.fromEntries(system.tokens.map((each) => [each.name, scaleOf(each)]));

    assert.deepEqual(scales, {
        "font.size.md": "text",
        "font.weight.bold": undefined,
        "text.sm": "text",
        "space.4": "space",
        "space.gap.in": "space",
        "spacing.2": "space",
        "radius.card": "radius",
        "radii.sm": "radius",
        "breakpoint.md": "breakpoint",
        "size.control.md": undefined,
        "dim.4": undefined,
        "border.width.hairline": undefined,
        "ease.out": undefined,
    });
});

test("many missing references have a budget for typo suggestions, so a load stays fast", () => {
    const shade: Record<string, unknown> = {};
    const typo: Record<string, unknown> = {};

    for (let i = 0; i < 600; i++) {
        shade[`shade-${i}-of-the-long-ramp`] = { $value: 1 };
        typo[`shade-${i}-of-the-long-ramp`] = { $value: `{a.shade-${i}-of-the-long-ramps}` };
    }

    const missing = errors(build({ a: { $type: "number", ...shade }, b: { ...typo } }));

    assert.equal(missing.length, 200);
    assert.ok(missing.some((message) => message.includes("Did you mean")));
    assert.ok(missing.some((message) => !message.includes("Did you mean")));
});

test("a very long chain of references is a problem, not a stack overflow", () => {
    const chain: Record<string, unknown> = { t4999: { $value: 1 } };

    for (let i = 0; i < 4999; i++) {
        chain[`t${i}`] = { $value: `{n.t${i + 1}}` };
    }

    assert.match(
        errors(build({ n: { $type: "number", ...chain } }))[0]!,
        /more than 200 references/,
    );
});

test("a reference chain that doubles at each step stops past 10,000 characters", () => {
    const font: Record<string, unknown> = { c0: { $value: "ab" } };

    for (let i = 1; i <= 30; i++) {
        font[`c${i}`] = { $value: `{f.c${i - 1}}{f.c${i - 1}}` };
    }

    const started = Date.now();
    const system = build({ f: { $type: "fontFamily", ...font } });

    assert.ok(Date.now() - started < 2000);
    assert.ok(errors(system).some((message) => /expands past 10,000 characters/.test(message)));
    assert.ok(
        system.tokens.every((each) => (each.modes[system.modes[0]!]?.css.length ?? 0) < 20_000),
    );
});

test("a token key with a very long run of dashes is refused quickly", () => {
    const started = Date.now();
    const system = build({ n: { $type: "number", [`a${"-".repeat(100_000)}b`]: { $value: 1 } } });

    assert.ok(Date.now() - started < 1000);
    assert.ok(errors(system).some((message) => /must use letters, digits/.test(message)));
});
