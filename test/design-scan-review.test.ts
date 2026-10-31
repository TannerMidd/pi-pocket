import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanReport, scanTokens } from "../src/server/design/scan.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-review-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
    }

    return dir;
}

const report = (dir: string) => scanReport(scanTokens(dir));

const review = (text: string) => {
    const at = text.indexOf("Review these");

    return at === -1 ? [] : text.slice(at).split("\n\n")[0]!.split("\n");
};

const CLEAN = `:root { --bg: #ffffff; --surface: #f4f5f7; --text: #111827; --text-muted: #6b7280; --border: #e5e7eb; --accent: #2563eb; --danger: #dc2626; --warning: #d97706; --success: #16a34a;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
  --font-size-sm: 13px; --font-size-md: 16px; --font-size-lg: 20px; --font-sans: Inter, sans-serif; --shadow-sm: 0 1px 2px rgba(0,0,0,.2); --shadow-md: 0 4px 12px rgba(0,0,0,.2); --shadow-lg: 0 10px 30px rgba(0,0,0,.25);
  --duration-fast: 120ms; --duration-slow: 300ms }
body { background: var(--bg); color: var(--text) }`;

test("a project that names everything has no review list at the top", () => {
    const text = report(project({ "styles.css": CLEAN }));

    assert.deepEqual(review(text), []);
    assert.doesNotMatch(text, /Review these/);
});

test("the roles chosen on weak evidence and the roles with no color are listed first, with the reason", () => {
    const text = report(
        project({
            "a.css":
                ".a { color: #2a2a2a; background: #ffffff } .b { color: #2a2a2a } .c { color: #c8553d; border: 1px solid #ddd } .d { color: #c8553d }",
        }),
    );
    const lines = review(text);

    assert.match(lines[0]!, /^Review these \(the scan is not sure, or left something out\):$/);
    assert.ok(
        lines.some((line) => /^  - roles: .*\(low confidence: /.test(line)),
        lines.join("\n"),
    );
    assert.ok(
        lines.some((line) => /no color found for .*success/.test(line)),
        lines.join("\n"),
    );
    assert.ok(text.indexOf("Review these") < text.indexOf("Color roles"));
});

test("the scales that are a thin guess are listed by category, and the spacing values that fit no step", () => {
    const text = report(
        project({
            "a.css":
                ":root { --bg: #fff; --text: #111 } body { padding: 10px; margin: 14px 18px; border-radius: 6px; font-size: 15px; box-shadow: 0 1px 2px rgba(0,0,0,.3) }",
        }),
    );
    const scales = review(text).find((line) => /^  - scales: /.test(line))!;

    assert.ok(scales !== undefined, text);
    assert.match(scales, /spacing \(guessed from use: \d+ values?, \d+ uses?\)/);
    assert.match(scales, /radii \(guessed from use: 1 value, 1 use\)/);
    assert.match(scales, /type scale \(guessed from use: 1 value, 1 use\)/);
    assert.match(scales, /shadows \(guessed from use/);
    assert.match(scales, /fit no step of the \d+px grid: /);
    assert.doesNotMatch(review(report(project({ "a.css": CLEAN }))).join("\n"), /scale/);
});

test("what the walk left out is named with its reason: vendored code, build output, minified files, links, and a file cut at its limit", () => {
    const dir = project({
        "node_modules/lib/a.css": ":root { --lib: #123456 }",
        "vendor/b.css": "a { color: #abcdef }",
        "third_party/c.css": "a { color: #fedcba }",
        "dist/app.css": "a { color: #111111 }",
        "src/app.css": `:root { --bg: #fff; --text: #111 }\nbody { background: var(--bg); color: var(--text) }\n${"/* filler to make the file larger than the limit */\n".repeat(5000)}`,
        "src/app.min.css": "a{color:#ff0000}".repeat(300),
        ".git/config": "x",
    });

    symlinkSync(join(dir, "src"), join(dir, "linked"));

    const scan = scanTokens(dir);
    const text = scanReport(scan);
    const left = review(text).find((line) => /^  - left out: /.test(line))!;

    assert.ok(left !== undefined, text);
    assert.match(left, /vendored code: node_modules\/, third_party\/, vendor\//);
    assert.match(left, /build output: dist\//);
    assert.match(left, /minified: src\/app\.min\.css/);
    assert.match(left, /a link, not followed: linked/);
    assert.match(
        left,
        /too large \(cut at the limit\): src\/app\.css \(read the first 200 KB of \d+ KB\)/,
    );
    assert.doesNotMatch(left, /\.git/, "a dot folder is not worth a line");
    assert.deepEqual(scan.files, ["src/app.css"], "none of them was read");
    assert.equal(scan.skipped.length >= 6, true);
});

test("a minified file is read when it is all the project has, and text with no line breaks is not read as styles", () => {
    const only = scanTokens(
        project({
            "app.min.css":
                ":root{--bg:#ffffff;--fg:#111111}body{background:var(--bg);color:var(--fg)}",
        }),
    );

    assert.deepEqual(only.files, ["app.min.css"]);
    assert.equal(only.skipped.length, 0);

    const built = scanTokens(
        project({
            "a.css": ":root { --bg: #fff; --text: #111 }\nbody { background: var(--bg) }",
            "bundle.css": `${"a{color:#ff00ff;margin:3px}".repeat(300)}`,
        }),
    );

    assert.ok(built.skipped.some((item) => item.path === "bundle.css" && item.why === "minified"));
    assert.equal(
        built.colors.some((color) => color.value === "#ff00ff"),
        false,
        "the bundle's colors are not the design's",
    );
});

test("a project with no style files says what was left out, as the place the design may be", () => {
    const text = report(
        project({ "node_modules/ui/a.css": "a { color: #123456 }", "README.md": "# hi" }),
    );

    assert.match(text, /found no style files/);
    assert.match(text, /left out: vendored code: node_modules\//);
    assert.match(text, /scan that folder with path/);
});

test("token files: there are no roles or scales to review, but what was left out is still named", () => {
    const tokens: Record<string, unknown> = {};

    for (let at = 1; at <= 10; at++) {
        tokens[`c${at}`] = { $value: `#${at}${at}${at}${at}${at}${at}`, $type: "color" };
    }

    const text = report(
        project({
            "tokens.json": JSON.stringify({ color: tokens }),
            "node_modules/x/a.css": "a{color:red}",
        }),
    );
    const lines = review(text);

    assert.equal(
        lines.some((line) => /roles:|scales:/.test(line)),
        false,
    );
    assert.ok(
        lines.some((line) => /left out: vendored code: node_modules\//.test(line)),
        text,
    );
});
