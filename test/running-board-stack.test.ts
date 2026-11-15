import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";

const css = readFileSync(join(APP_ROOT, "web", "style.css"), "utf8");

function zIndexOf(selector: string) {
    const rule = css.match(new RegExp(`^\\s*\\${selector}\\s*\\{[^}]*\\}`, "m"));

    assert.ok(rule, `no rule for ${selector}`);

    const value = rule[0].match(/z-index:\s*(\d+)/);

    assert.ok(value, `${selector} has no z-index`);

    return Number(value[1]);
}

test("the schedule a phone picks floats over the session names pinned at the timeline's left", () => {
    assert.ok(zIndexOf(".board-bar") > zIndexOf(".rb-lane-name"));
});

test("a timeline tip floats over the bar a phone picks a schedule with", () => {
    assert.ok(zIndexOf(".rb-tip") > zIndexOf(".board-bar"));
});
