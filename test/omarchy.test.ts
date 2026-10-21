import assert from "node:assert/strict";
import { test } from "node:test";
import { parseColors } from "../src/server/omarchy.ts";

test("colors.toml lines become colors; odd values are skipped", () => {
    const colors = parseColors(
        [
            'accent = "#7aa2f7"',
            'bad = "url(javascript:alert(1)); color: red"',
            'sneaky = "url(x)"',
        ].join("\n"),
    );

    assert.deepEqual(colors, { accent: "#7aa2f7" });
});
