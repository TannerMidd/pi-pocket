// The launcher (Mod+K) finds what the menu has: each sheet the menu opens, and each of its rows by name. The two lists
// are written apart, and the launcher fell behind (Webhooks and watches, Memory, Notifications, and others).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../web/${path}`, import.meta.url), "utf8");
const menu = read("sheets/menu.js");
const launcher = read("launcher.js");
const sheets = (source: string) =>
    new Set([...source.matchAll(/openSheet\(\{ type: "([a-z-]+)"/g)].map((match) => match[1]));

test("the launcher opens every sheet the menu opens", () => {
    const missing = [...sheets(menu)].filter((type) => !sheets(launcher).has(type));

    assert.deepEqual(missing, [], `the launcher has no action for: ${missing.join(", ")}`);
});

test("the launcher has every row of the menu, by name", () => {
    // Literal names, call-site English in `t`, and conditional names on the lines after `item(`.
    const names = [
        ...[...menu.matchAll(/item\(\s*"([^"]+)"/g)].map((match) => match[1]),
        ...[...menu.matchAll(/item\(\s*\n\s*[^"\n]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)].flatMap(
            (match) => [match[1], match[2]],
        ),
    ];

    names.push(
        ...[...menu.matchAll(/item\(\s*t\(\s*"[^"]+"\s*,\s*"([^"]+)"/g)].map((match) => match[1]),
    );
    const missing = names.filter((name) => !launcher.includes(`"${name}`));

    assert.ok(names.includes("Webhooks and watches") && names.includes("Take turns"));
    assert.deepEqual(missing, [], `the launcher has no action named: ${missing.join(", ")}`);
});
