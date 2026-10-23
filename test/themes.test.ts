// A theme's CSS reaches only its own folder: the page's content security policy keeps every load on this server, and
// these checks keep a theme from any other address on it (`url(/login?token=…)`, an API route), however it is written.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";
import { readTheme, Themes } from "../src/server/themes.ts";
import { cssReferences } from "../src/server/themes/css.ts";
import { ThemeProblem } from "../src/server/themes/format.ts";

after(cleanUp);

test("a theme's CSS may load only files in its own folder", () => {
    const dir = join(root, "themes", "mine");

    mkdirSync(join(dir, "fonts"), { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ themeApi: 1, name: "Mine" }));
    writeFileSync(join(dir, "fonts", "a.woff2"), "wOF2");

    const css = (rule: string) => {
        writeFileSync(join(dir, "theme.css"), `@font-face { src: url(fonts/a.woff2); }\n${rule}\n`);

        return () => readTheme(dir, "mine", false, "0.14.0");
    };

    assert.equal(css(":root { --x: 1px; }")().assets.size, 1);

    for (const rule of [
        "a { background: url(https://elsewhere.example/a.png); }",
        "a { background: url(/login?token=a); }",
        "a { background: \\75 rl(../../a.png); }",
        'a { background: image-set("/api/me" 1x); }',
        'a { background: image-set(var(--n, "/login?token=a") 1x); }',
        ':root { --x: "/login?token=a"; } a { background: image-set(var(--x) 1x); }',
        "a { background: attr(data-x url); }",
        "@font-face { font-family: x; src: src(var(--f)); }",
    ]) {
        assert.throws(css(rule), ThemeProblem, rule);
    }
});

test("the check reads deeply nested CSS in time: its cost does not grow with the square of the nesting", () => {
    const started = Date.now();

    // 256 KB, a theme's limit: about half a minute before the fix, a fraction of a second after.
    cssReferences(`a{b:${"var(".repeat(64_000)}`);
    assert.ok(Date.now() - started < 5_000);
});

test("every built-in theme passes its checks", () => {
    const builtIn = join(APP_ROOT, "web", "themes");

    for (const id of readdirSync(builtIn)) {
        assert.doesNotThrow(() => readTheme(join(builtIn, id), id, true, "0.14.0"), id);
    }
});

test("an owner's theme loads when the data folder is reached through a link", async () => {
    const data = join(root, "real-data");
    const linked = join(root, "linked-data");

    mkdirSync(join(data, "themes", "mine"), { recursive: true });
    writeFileSync(
        join(data, "themes", "mine", "theme.json"),
        JSON.stringify({ themeApi: 1, name: "Mine" }),
    );
    writeFileSync(join(data, "themes", "mine", "theme.css"), ":root { --r-card: 0; }\n");
    symlinkSync(data, linked);

    const themes = new Themes({
        builtIn: join(root, "no-built-in-themes"),
        dataDir: linked,
        notify: () => {},
        changed: () => {},
        log: () => {},
    });

    await themes.load();
    assert.deepEqual(
        themes.list().map((each) => [each.id, each.usable]),
        [["mine", true]],
    );
});

test("a theme that names the app's fonts gets their files preloaded, with its own", async () => {
    const data = join(root, "app-fonts-data");
    const dir = join(data, "themes", "reader");

    mkdirSync(join(dir, "fonts"), { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ themeApi: 1, name: "Reader" }));
    writeFileSync(join(dir, "fonts", "own.woff2"), "wOF2");
    writeFileSync(
        join(dir, "theme.css"),
        [
            `@font-face { font-family: "Own"; src: url(fonts/own.woff2); }`,
            `:root { --sans: "Pocket Inter", sans-serif; --mono: "Pocket Fira Code", monospace; }`,
            // Named in a comment only: not a font it uses.
            `/* "Pocket Iosevka" */`,
        ].join("\n"),
    );

    const themes = new Themes({
        builtIn: join(root, "no-built-in-themes"),
        dataDir: data,
        notify: () => {},
        changed: () => {},
        log: () => {},
    });

    await themes.load();
    const fonts = themes.list().find((each) => each.id === "reader")?.fonts ?? [];

    assert.equal(fonts.length, 3);
    assert.match(fonts[0]!, /^\/themes\/reader\/[A-Za-z0-9_-]{12}\/fonts\/own\.woff2$/);
    assert.deepEqual(fonts.slice(1), ["/fonts/InterVariable.woff2", "/fonts/FiraCode-VF.woff2"]);
});

test("Appearance's fonts are saved into the owner's theme, and only its fonts there", async () => {
    const data = join(root, "set-fonts-data");
    const dir = join(data, "themes", "mine");

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ themeApi: 1, name: "Mine" }));
    writeFileSync(join(dir, "theme.css"), `:root { --accent: #ff0000; }\n`);

    const themes = new Themes({
        builtIn: join(APP_ROOT, "web", "themes"),
        dataDir: data,
        notify: () => {},
        changed: () => {},
        log: () => {},
    });

    await themes.load();
    const mine = () => themes.list().find((each) => each.id === "mine");

    themes.setFonts("mine", { sans: "Pocket Inter", mono: "Pocket Fira Code", ligatures: true });
    assert.deepEqual(mine()?.typography, {
        sans: "Pocket Inter",
        mono: "Pocket Fira Code",
        ligatures: true,
    });
    assert.deepEqual(
        mine()?.fonts,
        ["/fonts/InterVariable.woff2", "/fonts/FiraCode-VF.woff2"],
        "preloaded",
    );

    // Again: the theme's own CSS is kept, and imports the fonts once, first.
    themes.setFonts("mine", { sans: null, mono: "Pocket Iosevka", ligatures: false });
    const css = readFileSync(join(dir, "theme.css"), "utf8");

    assert.equal(css, `@import "fonts.css";\n:root { --accent: #ff0000; }\n`);
    assert.deepEqual(mine()?.typography, { mono: "Pocket Iosevka", ligatures: false });

    // The device's own fonts, named as CSS names them.
    themes.setFonts("mine", { sans: "system-ui", mono: "ui-monospace" });
    assert.deepEqual(mine()?.typography, {
        sans: "system-ui",
        mono: "ui-monospace",
        ligatures: false,
    });
    assert.match(readFileSync(join(dir, "fonts.css"), "utf8"), /--sans: system-ui, ui-sans-serif/);

    assert.throws(
        () => themes.setFonts("mine", { sans: "Comic Sans" }),
        /Not one of the app's fonts/,
    );
    assert.throws(
        () => themes.setFonts("mine", { mono: "Pocket Inter" }),
        /Not one of the app's fonts/,
    );
    assert.throws(
        () => themes.setFonts("pocket", { sans: "Pocket Inter" }),
        /duplicate this one first/,
    );

    // A theme of colors alone gets the stylesheet, and the theme.json that one needs, and stays usable.
    mkdirSync(join(data, "themes", "hues"), { recursive: true });
    writeFileSync(
        join(data, "themes", "hues", "colors.toml"),
        `background = "#101010"\nforeground = "#eeeeee"\naccent = "#00ff00"\n`,
    );
    await themes.load();
    themes.setFonts("hues", { sans: "Pocket Inter" });
    const hues = themes.list().find((each) => each.id === "hues");

    assert.equal(hues?.usable, true, hues?.problem ?? "");
    assert.equal(hues?.typography?.sans, "Pocket Inter");
    assert.equal(hues?.colors?.accent, "#00ff00", "its colors kept");
});

test("a theme's own font stays when Appearance changes another, and its files are never written through a link", async () => {
    const data = join(root, "own-fonts-data");
    const dir = join(data, "themes", "paper");
    const outside = join(root, "outside.css");

    mkdirSync(join(dir, "fonts"), { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ themeApi: 1, name: "Paper" }));
    writeFileSync(join(dir, "fonts", "paper.woff2"), "wOF2");
    writeFileSync(
        join(dir, "theme.css"),
        [
            `@charset "utf-8";`,
            `@font-face { font-family: "Paper Sans"; src: url(fonts/paper.woff2); }`,
            `:root { --sans: "Paper Sans", sans-serif; --mono: var(--sans); --ligatures: normal; }`,
        ].join("\n"),
    );

    const themes = new Themes({
        builtIn: join(root, "no-built-in-themes"),
        dataDir: data,
        notify: () => {},
        changed: () => {},
        log: () => {},
    });

    await themes.load();
    const paper = () => themes.list().find((each) => each.id === "paper");

    // Its own family shows as its own; a value that is not a family (`var(…)`) is not read as one.
    assert.deepEqual(paper()?.typography, {
        sans: "Paper Sans",
        ligatures: true,
        own: { sans: "Paper Sans" },
    });

    // Only what is given changes: the theme's own text font stays.
    themes.setFonts("paper", { ligatures: false });
    themes.setFonts("paper", { mono: "Pocket Iosevka" });
    assert.deepEqual(paper()?.typography, {
        sans: "Paper Sans",
        mono: "Pocket Iosevka",
        ligatures: false,
        own: { sans: "Paper Sans" },
    });
    assert.match(
        readFileSync(join(dir, "theme.css"), "utf8"),
        /^@charset "utf-8";\n@import "fonts.css";\n/,
    );

    // Over it, and back to it with null.
    themes.setFonts("paper", { sans: "Pocket Inter" });
    assert.equal(paper()?.typography?.sans, "Pocket Inter");
    themes.setFonts("paper", { sans: null });
    assert.equal(paper()?.typography?.sans, "Paper Sans");
    assert.equal(paper()?.typography?.mono, "Pocket Iosevka", "the code font kept");
    assert.throws(() => themes.setFonts("paper", { ligatures: "yes" }), /Ligatures/);

    // A fonts.css that is a link out of the folder is refused, and what it points to stays as it was.
    writeFileSync(outside, "/* not the theme's */\n");
    rmSync(join(dir, "fonts.css"));
    symlinkSync(outside, join(dir, "fonts.css"));
    assert.throws(() => themes.setFonts("paper", { sans: "Pocket Inter" }), /not a plain file/);
    assert.equal(readFileSync(outside, "utf8"), "/* not the theme's */\n");
});
