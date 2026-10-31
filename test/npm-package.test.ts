// Pi Pocket installed from npm: it lands in a node_modules folder, where Node strips no types, and an npx or local
// install puts its packages in a node_modules folder above it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { modulesWith } from "../src/server/config.ts";
import { prepareDropInFolder } from "../src/server/reload.ts";

const ROOT = new URL("..", import.meta.url);

test("Pi Pocket's TypeScript runs from a node_modules folder with bin/strip-types.js", (t) => {
    const temp = mkdtempSync(join(tmpdir(), "pocket-npm-"));

    t.after(() => rmSync(temp, { recursive: true, force: true }));

    const app = join(temp, "node_modules", "pi-pocket");

    mkdirSync(join(app, "bin"), { recursive: true });
    mkdirSync(join(app, "src"), { recursive: true });
    copyFileSync(new URL("bin/strip-types.js", ROOT), join(app, "bin", "strip-types.js"));
    writeFileSync(join(app, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(app, "src", "b.ts"), "export const b: string = 'b';\n");
    // reload.ts imports extension modules with a query, so each edit loads anew.
    writeFileSync(
        join(app, "src", "a.ts"),
        "const { b } = await import('./b.ts?v=1');\nconst a: number = 1;\nconsole.log(a, b);\n",
    );

    const main = join(app, "src", "a.ts");
    const without = spawnSync(process.execPath, [main], { encoding: "utf8" });

    assert.match(without.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);

    const hook = pathToFileURL(join(app, "bin", "strip-types.js")).href;
    const run = spawnSync(process.execPath, ["--import", hook, main], { encoding: "utf8" });

    assert.equal(run.stdout, "1 b\n");
    // Node's warning that its stripper is experimental would print above the launcher's panel.
    assert.equal(run.stderr, "");
});

test("modulesWith finds packages that npm put in a node_modules folder above Pi Pocket", (t) => {
    const temp = mkdtempSync(join(tmpdir(), "pocket-npm-"));

    t.after(() => rmSync(temp, { recursive: true, force: true }));

    const hoisted = join(temp, "node_modules");
    const app = join(hoisted, "pi-pocket");
    const own = join(app, "node_modules");

    mkdirSync(join(hoisted, "preact"), { recursive: true });
    writeFileSync(join(hoisted, "preact", "package.json"), "{}");
    mkdirSync(join(own, "htm"), { recursive: true });
    writeFileSync(join(own, "htm", "package.json"), "{}");

    assert.equal(modulesWith("preact", app), hoisted);
    assert.equal(modulesWith("htm", app), own);
    assert.equal(modulesWith("missing", app), own);
});

// `files` in package.json says what npm packs. Read here, not with `npm pack`, which tests in a sandbox may not run.
test("the npm package has what Pi Pocket runs and reads, and not its tests", () => {
    const { files } = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")) as {
        files: string[];
    };
    const packed = (path: string) =>
        files.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));

    for (const needed of [
        "bin/pi-pocket.js",
        "bin/strip-types.js",
        "src/launcher/main.ts",
        "src/server/main.ts",
        "web/index.html",
        "types/pocket.d.ts",
        "docs/index.md",
        "AGENTS.md",
        // The lockfile that prepack copies, so npm installs the very packages the checkout has.
        "npm-shrinkwrap.json",
    ]) {
        assert.ok(packed(needed), `${needed} is missing from the package`);
    }

    for (const left of ["test/app.test.ts", "site/index.html", "docs-site/package.json"]) {
        assert.ok(!packed(left), `${left} is in the package`);
    }
});

test("drop-ins can import dependencies split between nested and hoisted folders", (t) => {
    const temp = mkdtempSync(join(tmpdir(), "pocket-npm-"));

    t.after(() => rmSync(temp, { recursive: true, force: true }));

    const hoisted = join(temp, "project", "node_modules");
    const app = join(hoisted, "pi-pocket");
    const own = join(app, "node_modules");
    const dropIn = join(temp, "data", "extensions");
    const packages = [
        ["@review/nested", own, "nested"],
        ["@review/hoisted", hoisted, "hoisted"],
    ] as const;

    for (const [name, modules, value] of packages) {
        const folder = join(modules, name);

        mkdirSync(folder, { recursive: true });
        writeFileSync(
            join(folder, "package.json"),
            JSON.stringify({ name, type: "module", exports: "./index.js" }),
        );
        writeFileSync(join(folder, "index.js"), `export const value = "${value}";`);
    }

    prepareDropInFolder(
        dropIn,
        own,
        Object.fromEntries(packages.map(([name]) => [name, modulesWith(name, app)])),
    );

    const entry = join(dropIn, "probe.mjs");

    writeFileSync(
        entry,
        'import { value as a } from "@review/nested";\n' +
            'import { value as b } from "@review/hoisted";\nconsole.log(a, b);\n',
    );

    const run = spawnSync(process.execPath, [entry], { encoding: "utf8" });

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "nested hoisted\n");
});
