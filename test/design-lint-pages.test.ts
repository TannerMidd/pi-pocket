// `test/fixtures/design-lint-pages/` holds 25 pages, each read by hand: `expected.json` lists what the checks may report,
// and every entry is a true finding. Anything else is a false finding.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { checkDesign } from "../src/server/design/lint.ts";
import { loadDesignSystem } from "../src/server/design/tokens.ts";
import { bundleOf, host } from "./design-lint-fixtures.ts";

const browser = { skip: findBrowser() === undefined, timeout: 300_000 };
const dir = join(import.meta.dirname, "fixtures", "design-lint-pages");
const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Record<
    string,
    Record<string, string[]>
>;

test(
    "25 pages in other styles give only the findings that were checked by hand",
    browser,
    async () => {
        assert.equal(Object.keys(expected).length, 25);

        for (const [name, states] of Object.entries(expected)) {
            const content = readFileSync(join(dir, name), "utf8");

            for (const [state, wanted] of Object.entries(states)) {
                const [viewport, colorScheme] = state.split("-") as [
                    "mobile" | "desktop",
                    "light" | "dark",
                ];
                const report = await checkDesign(
                    bundleOf(content),
                    undefined,
                    { viewport, colorScheme },
                    host,
                );
                const found = report.findings
                    .filter((item) => item.rule !== "missing-pid")
                    .map((item) => `${item.rule}:${item.pid ?? item.selector}`)
                    .sort();

                assert.deepEqual(found, wanted, `${name} (${state})`);
            }
        }
    },
);

test(
    "the flagship's component specimens, composed into one page, are on the system and get no false findings",
    browser,
    async () => {
        const system = loadDesignSystem(
            join(import.meta.dirname, "..", "docs", "examples", "design-system", "pocket"),
        )!;
        const assets = [
            { name: "ds/tokens.css", type: "text/css", bytes: Buffer.from(system.compiled.css) },
            {
                name: "ds/components.css",
                type: "text/css",
                bytes: Buffer.from(system.compiled.components),
            },
        ];
        const sections = system.components
            .map(
                (item) =>
                    `<section data-pid="comp-${item.slug}"><h2 data-pid="h-${item.slug}">${item.name}</h2>${item.states
                        .map(
                            (state) =>
                                `<div data-pid="${item.slug}-${state}">${item.markup[state]}</div>`,
                        )
                        .join("")}</section>`,
            )
            .join("");
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Components</title><link rel="stylesheet" href="ds/tokens.css"><link rel="stylesheet" href="ds/components.css"><style>body{margin:0;padding:var(--space-4);background:var(--color-bg-base);color:var(--color-text-primary)}</style></head><body><h1 data-pid="t">Components</h1>${sections}</body></html>`;

        for (const colorScheme of ["light", "dark"] as const) {
            const report = await checkDesign(
                bundleOf(html, assets),
                system,
                { viewport: "desktop", colorScheme },
                host,
            );
            const rules = new Set(report.findings.map((item) => item.rule));

            // A faint token such as `bg.hover` (#343b5812) is the color that the hover specimen draws, and a specimen of the
            // focus state has its ring at rest: neither is a finding.
            assert.equal(rules.has("off-system-color"), false, colorScheme);
            assert.equal(rules.has("focus-visible"), false, colorScheme);
            assert.equal(rules.has("overflow"), false, colorScheme);
            assert.equal(rules.has("image-alt"), false, colorScheme);
            assert.equal(rules.has("accessible-name"), false, colorScheme);
            assert.equal(rules.has("form-label"), false, colorScheme);
            assert.equal(
                report.findings.some(
                    (item) => item.rule === "off-system-font" && item.value === "monospace",
                ),
                false,
                colorScheme,
            );
            assert.deepEqual(
                report.findings.filter((item) => item.rule === "contrast"),
                [],
                colorScheme,
            );
        }
    },
);
