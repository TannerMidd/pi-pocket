// Themes rely on the tokens and parts that web/theme-surface.js lists: each must stay defined, or a release would break
// every theme that used it without saying so.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";

const web = join(APP_ROOT, "web");
const { PARTS, TOKENS } = (await import(join(web, "theme-surface.js"))) as {
    PARTS: string[];
    TOKENS: string[];
};

test("every documented token is defined in style.css, and every documented part is on an element", () => {
    const css = readFileSync(join(web, "style.css"), "utf8");
    const missingTokens = TOKENS.filter((token) => !new RegExp(`^\\s*${token}:`, "m").test(css));
    const code = readdirSync(web, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".js") && file !== "theme-surface.js")
        .map((file) => readFileSync(join(web, file), "utf8"))
        .join("\n");
    const named = new Set(
        // `data-part="…"` in markup; `part="…"` for a component that passes it on (`Icon`); `dataset.part` in the DOM.
        [...code.matchAll(/\bpart="([a-z -]+)"|dataset\.part = "([a-z-]+)"/g)].flatMap((match) =>
            (match[1] ?? match[2]!).split(" "),
        ),
    );

    assert.deepEqual(missingTokens, []);
    assert.deepEqual(
        PARTS.filter((part) => !named.has(part)),
        [],
    );
});
