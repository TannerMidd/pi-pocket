import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LIMITS, checkTokensBlock, scanRoot, scanTokens } from "../src/server/design/scan.ts";
import { planRender } from "../src/server/design/scan-render-pages.ts";
import { designSystemTool } from "../src/server/design/system.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-scan-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
    }

    return dir;
}

test("scan counts colors, fonts, radii and reads CSS variables", () => {
    const dir = project({
        "src/app.css": `:root{--brand:#FF5500;--gap: 8px}
a{color:#ff5500;background:#FFF;border-radius:8px;font-family:Inter, sans-serif}
b{color:#f50;border-radius:8px;font-family:Inter,  sans-serif}`,
        "node_modules/x/skip.css": "a{color:#123456}",
    });
    const scan = scanTokens(dir);

    assert.deepEqual(scan.files, ["src/app.css"]);
    assert.deepEqual(scan.variables, { "--brand": "#FF5500", "--gap": "8px" });
    // #FF5500, #ff5500 (case) and #f50 (short form) are one color: count 3 — and the variable's value counts too.
    assert.deepEqual(scan.colors[0], { value: "#ff5500", count: 3 });
    assert.ok(!scan.colors.some((c) => c.value === "#123456"));
    assert.deepEqual(scan.fonts, [{ value: "Inter, sans-serif", count: 2 }]);
    assert.deepEqual(scan.radii, [{ value: "8px", count: 2 }]);
});

test("a 5-digit hex is not a color", () => {
    const dir = project({ "a.css": "a{color:#12345;x:#abcd}" });

    assert.deepEqual(
        scanTokens(dir).colors.map((c) => c.value),
        ["#aabbccdd"],
    );
});

test("entities, links, ids, and selectors are not colors", () => {
    const dir = project({
        "a.html": `<a href="#add">x</a><p>&#123;</p><svg><use href="#fab"/></svg>
<style>#bad { color: #0a0a0a }  .x{fill:url(#cab)}</style>`,
    });

    assert.deepEqual(
        scanTokens(dir).colors.map((c) => c.value),
        ["#0a0a0a"],
    );
});

test("issue numbers in comments and ids in a selector list are not colors", () => {
    const dir = project({
        "a.tsx": `// fixes issue #123 and PR #186\n/* see #abc */\nconst a = <p className="text-[#0a0a0a]" />;\n{/* note #def */}`,
        "b.css": `#add, #bad {\n  color: red;\n}\n#fab,\n#cab .x { color: #fefefe }\n<!-- #bed -->`,
        "c.html": `<a href="https://x.test/#a">x</a><div style="color:#111"></div><style>.y{color:#222}</style>`,
    });

    assert.deepEqual(
        scanTokens(dir)
            .colors.map((c) => c.value)
            .sort(),
        ["#0a0a0a", "#111111", "#222222", "#fefefe", "#ff0000"],
    );
});

test("a glob in a config is not a comment, and an address keeps its colors", () => {
    const dir = project({
        "tailwind.config.js": `export default { content: ["./pages/*.tsx", "src/**/*.{js,tsx}"], theme: { colors: { primary: "#123456" } } };`,
        "a.css": `a { background: url(//cdn.test/x.png); color: #654321 }`,
    });

    assert.deepEqual(
        scanTokens(dir)
            .colors.map((c) => c.value)
            .sort(),
        ["#123456", "#654321"],
    );
});

test("hostile comments and colors scan in linear time", () => {
    for (const body of ["/*".repeat(LIMITS.fileBytes / 2), "#fff ".repeat(LIMITS.fileBytes / 5)]) {
        const dir = project({ "a.css": body });
        const started = Date.now();

        scanTokens(dir);
        assert.ok(Date.now() - started < 2000);
    }
});

test("a hostile file of dashes scans in linear time", () => {
    const dir = project({ "a.css": "-".repeat(LIMITS.fileBytes) });
    const started = Date.now();

    scanTokens(dir);
    // Before the fix, 40 KB of dashes took 9 s; the limit here is generous for a slow machine.
    assert.ok(Date.now() - started < 2000);
});

test("a file past the byte limit is read only to the limit", () => {
    const dir = project({
        "a.css": `a{color:#111}${" ".repeat(LIMITS.fileBytes)}b{color:#222}`,
    });

    assert.deepEqual(
        scanTokens(dir).colors.map((c) => c.value),
        ["#111111"],
    );
});

test("a tree without style files stops at the entry limit", () => {
    const files: Record<string, string> = {};

    for (let i = 0; i < LIMITS.entries + 5; i++) {
        files[`x${i}.bin`] = "";
    }

    const scan = scanTokens(project(files));

    assert.deepEqual(scan.files, []);
    assert.equal(scan.partial, true);
});

test("scanRoot: a missing path, a folder named ..x, and a deep tree", () => {
    const dir = project({ "..x/a.css": "a{color:#111}" });

    assert.throws(() => scanRoot(dir, "nope"), /does not exist/);
    assert.doesNotThrow(() => scanRoot(dir, "..x"));

    const deep = project({ "a/b/c/d/e/f/g/h/i/j/k.css": "a{color:#111}" });

    assert.deepEqual(scanTokens(deep).files, []);
    assert.equal(scanTokens(deep).partial, true);
});

test("scan never follows a symlink out of the folder", () => {
    const outside = project({ "secret.css": "a{color:#abcdef}" });
    const dir = project({ "ok.css": "a{color:#111}" });

    symlinkSync(outside, join(dir, "link"));
    symlinkSync(join(outside, "secret.css"), join(dir, "file.css"));

    assert.deepEqual(scanTokens(dir).files, ["ok.css"]);
    assert.throws(() => scanRoot(dir, "link"), /folder|inside/);
    assert.throws(() => scanRoot(dir, "../x"), /inside/);
    assert.throws(() => scanRoot(dir, "/etc"), /relative/);
});

test("the file limit ends the walk and says so", () => {
    const files: Record<string, string> = {};

    for (let i = 0; i < LIMITS.files + 5; i++) {
        files[`f${i}.css`] = "a{color:#111}";
    }

    const scan = scanTokens(project(files));

    assert.equal(scan.files.length, LIMITS.files);
    assert.equal(scan.partial, true);
});

test("the rendered scan picks its pages in linear time, also from openers with no end", () => {
    const dir = project({
        "index.html": `<!doctype html><body>${"<style ".repeat(30_000)}${"<p ".repeat(30_000)}`,
    });
    const start = performance.now();

    planRender(dir);
    assert.ok(performance.now() - start < 1_000);
});

test("checkTokensBlock: none is false, broken or non-object throws", () => {
    assert.equal(checkTokensBlock("# just words"), false);
    assert.throws(() => checkTokensBlock("```json\n{oops}\n```"), /not valid JSON/);
    assert.throws(() => checkTokensBlock("```json\n[1]\n```"), /JSON object/);
    assert.throws(() => checkTokensBlock("```json\n```"), /not valid JSON/);
    // Backticks inside a JSON string do not end the block; the fence must start a line.
    assert.equal(checkTokensBlock('```json\n{"a": "use ``` here"}\n```'), true);
    assert.equal(checkTokensBlock('# T\r\n\r\n```json\r\n{"a": 1}\r\n```\r\n'), true);
});

test("the tool: scan returns a draft and writes nothing; write refuses broken tokens", async () => {
    const dir = project({ "a.css": "a{color:#abc}" });
    const tool = designSystemTool();
    const run = (args: object) =>
        tool.execute(
            args as never,
            { agent: async () => ({ cwd: dir }) } as never,
            undefined as never,
        );
    const text = async (call: ReturnType<typeof run>) =>
        ((await call).output as { text: string }[])[0]!.text;

    const scanned = await text(run({ action: "scan" }));

    assert.match(scanned, /#aabbcc/);
    assert.match(scanned, /^<scan_data>/);
    assert.match(scanned, /untrusted project data/);
    assert.match(await text(run({ action: "read" })), /no .*design-system\.md/);
    await assert.rejects(run({ action: "write", content: "```json\n{bad\n```" }), /not valid JSON/);
    assert.match(await text(run({ action: "write", content: "# plain" })), /no fenced JSON/);
});
