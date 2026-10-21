// Real isolated app routes and assets; no live data or model calls.
import {
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
const ids: ConversationId[] = [];
let list = ".sidebar";
const row = (id: ConversationId) => `${list} .session-row[data-id="${id}"]`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 400));

async function value<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function fresh(width = 1280): Promise<void> {
    list = width < 700 ? ".home-list" : ".sidebar";
    await page.setViewport({ width, height: 844, scale: 1, mobile: width < 700 });
    await page.navigate(`${base}/`);
    await until(
        () =>
            value<boolean>(
                `return JSON.stringify(!!document.querySelector(${JSON.stringify(row(ids[0]!))}))`,
            ),
        "session row ready",
        15000,
    );
    await pause();
}

async function blank(id: ConversationId): Promise<{ x: number; y: number }> {
    return value(`
        const tags = document.querySelector(${JSON.stringify(`${row(id)} .session-tags`)});
        const box = tags.getBoundingClientRect();
        const x = box.right - 15, y = box.y + box.height / 2;
        if (document.elementFromPoint(x, y) !== tags) throw Error('Not blank tag-row space');
        return JSON.stringify({ x, y });
    `);
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());

    for (const title of ["Polish Alpha", "Polish Beta"]) {
        const id = await newSession(app);

        ids.push(id);
        await app.commands.updateSession(id, owner(app), { title });
        await app.commands.updateSessionTags(owner(app), { ids: [Number(id)], add: ["polish"] });
    }

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "tags-polish-ui-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.close();
    cleanUp();
});

test(
    "polish: blank tag-row space opens the real conversation on desktop and phone",
    real,
    async () => {
        for (const width of [1280, 390, 320]) {
            await fresh(width);

            if (process.env.POLISH_EVIDENCE_DIR) {
                const shot = await page.screenshot();

                writeFileSync(
                    join(process.env.POLISH_EVIDENCE_DIR, `tag-row-${width}.jpg`),
                    Buffer.from(shot.data, "base64"),
                );
            }

            const point = await blank(ids[0]!);

            assert.equal(
                await value(
                    `return JSON.stringify(getComputedStyle(document.elementFromPoint(${point.x}, ${point.y})).cursor)`,
                ),
                "pointer",
                `clickable blank tag-row space uses a pointer cursor at ${width}px`,
            );
            await page.click(point);
            await pause();
            assert.equal(
                await value(
                    `return JSON.stringify((await import('/store.js')).store.state.conversationId)`,
                ),
                Number(ids[0]!),
                `blank space opens at ${width}px`,
            );
        }
    },
);

test(
    "polish: filter option hover reaches the right inner edge without an idle scrollbar gutter",
    real,
    async () => {
        await fresh();
        await page.click({ selector: `${list} .search-filters` });
        await pause();
        const geometry = await value<{ gap: number; hit: boolean }>(`
        const list = document.querySelector('.sheet-host:not(.leaving) .tag-filter-results');
        const option = list.querySelector('label');
        const outer = list.getBoundingClientRect(), box = option.getBoundingClientRect();
        const edge = outer.right - parseFloat(getComputedStyle(list).borderRightWidth);
        return JSON.stringify({ gap: edge - box.right, hit: document.elementFromPoint(edge - 2, box.y + box.height / 2)?.closest('label') === option });
    `);

        assert.ok(geometry.gap < 1, `right edge gap is ${geometry.gap}px`);
        assert.equal(geometry.hit, true, "right edge belongs to the hoverable option");
        await page.hover({ selector: ".sheet-host:not(.leaving) .tag-filter-results label" });
        await pause();
        assert.equal(
            await value(
                `return JSON.stringify(!!document.querySelector('.tag-filter-results label:hover'))`,
            ),
            true,
            "real pointer hovers the filter option",
        );

        if (process.env.POLISH_EVIDENCE_DIR) {
            const shot = await page.screenshot();

            writeFileSync(
                join(process.env.POLISH_EVIDENCE_DIR, "filter-hover.jpg"),
                Buffer.from(shot.data, "base64"),
            );
        }
    },
);

test(
    "polish: batch-removal hover and click reach the right edge on desktop and phone",
    real,
    async () => {
        await app.commands.updateSessionTags(owner(app), {
            ids: [Number(ids[1]!)],
            add: ["review"],
            remove: ["polish"],
        });

        try {
            for (const width of [1280, 390, 320]) {
                await fresh(width);
                const point = await blank(ids[0]!);

                await page.evaluate(`
                    const target = document.elementFromPoint(${point.x}, ${point.y});
                    target.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, detail: 1 }));
                `);
                await page.click({ selector: `${row(ids[1]!)} .chip` });
                const edit = await value<{ x: number; y: number }>(`
                    const button = [...document.querySelectorAll(${JSON.stringify(`${list} .select-bar button`)})]
                        .find(each => each.textContent.trim() === 'Edit tags');
                    const box = button.getBoundingClientRect();
                    return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
                `);

                await page.click(edit);
                await pause();
                const geometry = await value<{ gap: number; x: number; y: number }>(`
                    const list = document.querySelector('.sheet-host:not(.leaving) .tag-remove-options');
                    const option = list.querySelector('label');
                    const outer = list.getBoundingClientRect(), box = option.getBoundingClientRect();
                    const edge = outer.right - parseFloat(getComputedStyle(list).borderRightWidth);
                    return JSON.stringify({ gap: edge - box.right, x: edge - 2, y: box.y + box.height / 2 });
                `);

                await page.hover({
                    selector: ".sheet-host:not(.leaving) .tag-remove-options label",
                });
                await pause();

                if (process.env.POLISH_EVIDENCE_DIR) {
                    const shot = await page.screenshot();

                    writeFileSync(
                        join(process.env.POLISH_EVIDENCE_DIR, `batch-removal-hover-${width}.jpg`),
                        Buffer.from(shot.data, "base64"),
                    );
                }

                assert.ok(geometry.gap < 1, `${width}px right edge gap is ${geometry.gap}px`);
                await page.click({ x: geometry.x, y: geometry.y });
                assert.equal(
                    await value(
                        `return JSON.stringify(!!document.querySelector('.tag-remove-options label.marked input:checked'))`,
                    ),
                    true,
                    "right-edge click queues a removal through the native label",
                );
                await page.press("Escape");
                await pause();
            }
        } finally {
            await app.commands.updateSessionTags(owner(app), {
                ids: [Number(ids[1]!)],
                add: ["polish"],
                remove: ["review"],
            });
        }
    },
);

test(
    "polish: tag-row blank space preserves modifiers while tag controls remain independent",
    real,
    async () => {
        await fresh();
        const point = await blank(ids[0]!);

        await page.evaluate(`
        const target = document.elementFromPoint(${point.x}, ${point.y});
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, ctrlKey: true }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, detail: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
    `);
        await pause();
        assert.equal(
            await value(
                `return JSON.stringify(!!document.querySelector(${JSON.stringify(`${row(ids[0]!)}.selected`)}))`,
            ),
            true,
            "Ctrl selects the blank tag-row area",
        );
        await page.click({ selector: `${row(ids[1]!)} .chip` });
        await pause();
        assert.equal(
            await value(
                `return JSON.stringify(!!document.querySelector(${JSON.stringify(`${row(ids[1]!)}.selected`)}))`,
            ),
            true,
            "tag chip selects in batch mode",
        );
        assert.equal(
            await value(
                `return JSON.stringify((await import('/store.js')).store.state.conversationId)`,
            ),
            null,
            "selection does not navigate",
        );
        await fresh();
        await page.click({ selector: `${row(ids[0]!)} .chip` });
        await pause();
        assert.deepEqual(
            await value(
                `return JSON.stringify((await import('/store.js')).store.state.sessionTagFilters.tags)`,
            ),
            ["polish"],
            "tag chip still filters",
        );
    },
);

test(
    "polish: blank-space touch hold keeps native actions, click suppression and row focus return",
    real,
    async () => {
        await fresh(390);
        const point = await blank(ids[0]!);

        await page.evaluate(`
        const target = document.elementFromPoint(${point.x}, ${point.y});
        const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: ${point.x}, clientY: ${point.y} };
        target.dispatchEvent(new PointerEvent('pointerdown', init));
        await new Promise(resolve => setTimeout(resolve, 1000));
        target.dispatchEvent(new PointerEvent('pointerup', init));
        document.elementFromPoint(init.clientX, init.clientY)?.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
    `);
        assert.equal(
            await value(
                `return JSON.stringify((await import('/store.js')).store.state.sheet?.type)`,
            ),
            "session",
        );
        assert.equal(
            await value(
                `return JSON.stringify((await import('/store.js')).store.state.conversationId)`,
            ),
            null,
            "hold lift must not open the conversation",
        );
        await pause();
        await page.press("Escape");
        await pause();
        assert.equal(
            await value(
                `return JSON.stringify(document.activeElement === document.querySelector(${JSON.stringify(`${row(ids[0]!)} > .session`)}))`,
            ),
            true,
            "close returns focus to the existing keyboard-accessible row button",
        );
        await page.press("Shift+F10");
        await pause();
        assert.equal(
            await value(
                `return JSON.stringify((await import('/store.js')).store.state.sheet?.type)`,
            ),
            "session",
            "keyboard actions remain available",
        );
        assert.deepEqual(
            page.logs().filter((entry) => entry.level === "error"),
            [],
            "no browser errors",
        );
    },
);
