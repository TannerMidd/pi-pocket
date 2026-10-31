// The flagship's generated files are not committed: the app compiles them in memory. This test compiles the example
// and keeps a short hash of each file, so a compiler change shows up as a diff of this file in review.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDesignSystem } from "../src/server/design/tokens.ts";

const FLAGSHIP = fileURLToPath(new URL("../docs/examples/design-system/pocket", import.meta.url));

const EXPECTED: Record<string, string> = {
    "components.css": "1aec96edfeb4",
    "names.md": "f5ee03e212e9",
    "tailwind.css": "a15dabbbf167",
    "tokens.css": "aa3272aea1ad",
    "tokens.dark.resolved.json": "91a1fb8cf843",
    "tokens.high-contrast.resolved.json": "fe19fd48ea32",
    "tokens.light.resolved.json": "9caed47a5633",
    "tokens.resolved.json": "4b1a8630fac9",
    "tokens.studio.json": "4c5ff7fdc191",
};

function compiled(): Map<string, string> {
    const system = loadDesignSystem(FLAGSHIP)!;
    const files = new Map<string, string>([
        ["tokens.css", system.compiled.css],
        ["tailwind.css", system.compiled.tailwind],
        ["tokens.resolved.json", system.compiled.json],
        ["components.css", system.compiled.components],
        ["tokens.studio.json", system.compiled.studio!],
        ["names.md", system.compiled.names!],
    ]);

    for (const [mode, text] of Object.entries(system.compiled.modes!)) {
        files.set(`tokens.${mode}.resolved.json`, text);
    }

    return files;
}

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

test("the compiler makes the same files from the flagship's sources as before", () => {
    const made = compiled();
    const hashes = Object.fromEntries([...made].map(([name, text]) => [name, short(text)]));
    const hint = `If the compiler or the flagship's tokens changed on purpose, put these in EXPECTED in test/design-dist.test.ts:\n${JSON.stringify(hashes, null, 4)}`;

    assert.deepEqual(
        [...made.keys()].sort(),
        Object.keys(EXPECTED).sort(),
        `the file set. ${hint}`,
    );

    for (const [name, hash] of Object.entries(hashes)) {
        assert.equal(hash, EXPECTED[name], `${name} differs. ${hint}`);
    }
});

test("the compiled files are what a person gets: tokens.css has the modes, tailwind.css the namespaces, the JSON parses", () => {
    const made = compiled();
    const read = (name: string) => made.get(name)!;

    assert.match(read("tokens.css"), /:root,\n\[data-theme="light"\] \{/);
    assert.match(read("tokens.css"), /\[data-theme="dark"\] \{/);
    assert.match(read("tailwind.css"), /--leading-tight:/);
    assert.doesNotMatch(
        read("tailwind.css").slice(read("tailwind.css").indexOf("@theme")),
        /--font-leading/,
    );

    for (const name of [...made.keys()].filter((file) => file.endsWith(".json"))) {
        assert.doesNotThrow(() => JSON.parse(read(name)), name);
    }

    const studio = JSON.parse(read("tokens.studio.json"));

    assert.deepEqual(studio.$metadata.tokenSetOrder, ["light", "dark", "high-contrast"]);
});
