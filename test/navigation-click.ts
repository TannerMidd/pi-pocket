// A real click in the navigation sheet, for the browser tests: the sheet's rows and the buttons that open it.
import assert from "node:assert/strict";
import type { BrowserPage } from "../src/server/browser/page.ts";

/** What to click: a control a `selector` or a `label` finds, or the sheet's own row named `row`. */
export type NavigationTarget = { selector: string } | { label: string } | { row: string };

/**
 * A real click in the navigation sheet, as a person makes it: after the sheet's animations, and past the 280 ms in
 * which a tap that lands on something that just moved is let go (`back.js`). `row` finds the sheet's own row by its
 * `.menu-name`: a button behind the sheet may say the same word in a hint. What the click shows is for the test.
 */
export async function clickNavigation(on: BrowserPage, target: NavigationTarget): Promise<void> {
    await on.evaluate(`
        await Promise.allSettled([...document.querySelectorAll(".sheet-host")]
            .flatMap((host) => host.getAnimations({ subtree: true }))
            .filter((each) => Number.isFinite(each.effect.getComputedTiming().endTime))
            .map((each) => each.finished));
        await new Promise((done) => setTimeout(done, 320));
    `);

    if ("row" in target) {
        const point = await rowPoint(on, target.row);

        await on.click(point);

        return;
    }

    const hit = await on.click(target);

    assert.equal(hit.covered, undefined, `a navigation control must not be covered: ${hit.label}`);
}

/** Where the sheet's row `row` is: drawn, scrolled into view, and nothing over it. */
async function rowPoint(on: BrowserPage, row: string): Promise<{ x: number; y: number }> {
    const find = `
        const sheet = [...document.querySelectorAll(".nav-menu")]
            .find((menu) => !menu.closest(".sheet-host.leaving"));
        const found = [...(sheet?.querySelectorAll(".menu-name") ?? [])]
            .find((name) => name.textContent.trim() === ${JSON.stringify(row)})
            ?.closest(".list-item");

        if (!found) return JSON.stringify(null);

        found.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

        const box = found.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const hit = document.elementFromPoint(x, y);

        return JSON.stringify({
            x,
            y,
            covered: hit !== null && !found.contains(hit) ? String(hit.className || hit.tagName) : null,
        });
    `;

    // A sheet that is still arriving has no row yet; the same row, once drawn, is clicked at once.
    for (let tries = 0; tries < 50; tries++) {
        const point = JSON.parse(await on.evaluate(find)) as {
            x: number;
            y: number;
            covered: string | null;
        } | null;

        if (point !== null) {
            assert.equal(point.covered, null, `the row "${row}" must not be covered`);

            return point;
        }

        await new Promise((done) => setTimeout(done, 100));
    }

    throw new Error(`the navigation sheet has no row "${row}"`);
}
