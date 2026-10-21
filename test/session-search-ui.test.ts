// Real routes and web assets on an isolated app. Touch uses Chromium emulation, not hardware.
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
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function expectPage(script: string, message: string): Promise<void> {
    await until(
        () => inPage<boolean>(`return JSON.stringify(Boolean(${script}))`),
        message,
        15_000,
    );
}

async function click(selector: string): Promise<void> {
    // Pocket ignores taps for 280ms after a layer transition.
    await new Promise((resolve) => setTimeout(resolve, 320));
    await page.click({ selector });
}

async function fresh(width = 1280): Promise<string> {
    await page.setViewport({ width, height: 844, scale: 1, mobile: width < 700 });
    await page.navigate(`${base}/`);
    const list = width < 700 ? ".home-list" : ".sidebar";

    await expectPage(
        `document.querySelector(${JSON.stringify(`${list} input[aria-label="Search sessions"]`)}) !== null`,
        "native search ready",
    );
    await page.evaluate(
        "await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 350))",
    );

    return list;
}

interface Geometry {
    listWidth: number;
    inputWidth: number;
    placeholderWidth: number;
    badgeWidth: number;
    badgeText: string;
    filtersWidth: number;
    iconWidth: number;
    visibleFiltersText: boolean;
    overflow: boolean;
}

async function geometry(list: string): Promise<Geometry> {
    return inPage<Geometry>(`
        const list = document.querySelector(${JSON.stringify(list)});
        const input = list.querySelector('input[aria-label="Search sessions"]');
        const css = getComputedStyle(input);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        const placeholder = getComputedStyle(input, '::placeholder');
        context.font = [placeholder.fontStyle, placeholder.fontWeight, placeholder.fontSize, placeholder.fontFamily].join(' ');
        const text = context.measureText(input.placeholder).width;
        const spacing = parseFloat(placeholder.letterSpacing) || 0;
        const badge = list.querySelector('.search-keys');
        const filters = list.querySelector('.search-filters');
        const range = document.createRange();
        const walker = document.createTreeWalker(filters, NodeFilter.SHOW_TEXT);
        let visibleFiltersText = false;
        while (walker.nextNode()) {
            if (!walker.currentNode.textContent.includes('Filters')) continue;
            range.selectNodeContents(walker.currentNode);
            visibleFiltersText ||= [...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
        }
        return JSON.stringify({
            listWidth: list.querySelector('.sessions').offsetWidth,
            inputWidth: input.getBoundingClientRect().width - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) - parseFloat(css.borderLeftWidth) - parseFloat(css.borderRightWidth),
            placeholderWidth: text + spacing * Math.max(0, input.placeholder.length - 1),
            badgeWidth: badge?.getBoundingClientRect().width ?? 0,
            badgeText: badge?.textContent.trim() ?? '',
            filtersWidth: filters.getBoundingClientRect().width,
            iconWidth: filters.querySelector('svg').getBoundingClientRect().width,
            visibleFiltersText,
            overflow: document.documentElement.scrollWidth > innerWidth,
        });
    `);
}

before(async () => {
    if (!chromium) {
        return;
    }

    app = await openApp(scriptedModel());
    const id = await newSession(app);

    await app.commands.updateSession(id, owner(app), { title: "Search fixture" });
    await app.commands.updateSessionTags(owner(app), {
        ids: [Number(id)],
        add: ["fit-check", ...Array.from({ length: 9 }, (_, index) => `fit-${index}`)],
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "search-ui-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1280, height: 844, scale: 1, mobile: false });
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
    "search fit: fresh default and resized sidebar keep the complete placeholder visible",
    real,
    async () => {
        const list = await fresh();
        const initial = await geometry(list);
        const defaults = await inPage<{ saved: string | null; width: string }>(`
        return JSON.stringify({ saved: localStorage.getItem('pocket.appearance'), width: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim() });
    `);
        const measurements: Geometry[] = [initial];

        for (const width of [204, 228, 254, 280, 300, 320, 324, 325, 400]) {
            await page.evaluate(`
            const sidebar = document.querySelector('.sidebar');
            const rest = sidebar.offsetWidth - sidebar.querySelector('.sessions').offsetWidth;
            // ResizeHandle uses this live variable. Do not change saved preferences.
            document.documentElement.style.setProperty('--sidebar-w', String(${width} + rest) + 'px');
        `);
            await expectPage(
                `document.querySelector('.sidebar .sessions').offsetWidth === ${width}`,
                `${width}px list width`,
            );
            measurements.push(await geometry(list));
        }

        console.log("SEARCH_FIT_GEOMETRY", JSON.stringify({ defaults, measurements }));
        assert.equal(
            initial.listWidth,
            254,
            "a fresh browser retains the default 312px sidebar and 254px session container",
        );

        for (const measured of measurements) {
            assert.ok(
                measured.inputWidth >= measured.placeholderWidth,
                `${measured.listWidth}px: full placeholder needs ${measured.placeholderWidth}px, has ${measured.inputWidth}px`,
            );
            assert.ok(
                measured.iconWidth > 0 && measured.filtersWidth > 0,
                "native Filters icon remains visible",
            );
            assert.equal(measured.overflow, false, "no page overflow");
        }

        assert.equal(
            measurements.find((each) => each.listWidth === 324)?.badgeWidth,
            0,
            "badge is hidden at exactly 300px container content",
        );
        assert.ok(
            (measurements.find((each) => each.listWidth === 325)?.badgeWidth ?? 0) > 0,
            "badge returns at 301px container content",
        );

        const wide = measurements.at(-1);

        assert.ok(wide !== undefined);
        assert.ok(wide.badgeWidth > 0, "wide desktop keeps the decorative shortcut badge");
        assert.equal(wide.badgeText, "Ctrl K", "Linux desktop shows its native shortcut");
        assert.equal(
            await inPage<string | null>(
                "return JSON.stringify(localStorage.getItem('pocket.appearance'))",
            ),
            defaults.saved,
            "live resizing does not change saved sidebar preferences",
        );
    },
);

test(
    "search fit: touch widths, search clear, active filter count and native launcher remain usable",
    real,
    async () => {
        const failures: string[] = [];

        for (const [width, listWidth] of [
            [390, null],
            [320, null],
            [1280, 254],
            [1280, 204],
        ] as const) {
            const list = await fresh(width);

            if (listWidth !== null) {
                await page.evaluate(`
                    const sidebar = document.querySelector('.sidebar');
                    const rest = sidebar.offsetWidth - sidebar.querySelector('.sessions').offsetWidth;
                    document.documentElement.style.setProperty('--sidebar-w', String(${listWidth} + rest) + 'px');
                `);
                await expectPage(
                    `document.querySelector('.sidebar .sessions').offsetWidth === ${listWidth}`,
                    "requested desktop width settled",
                );
                await new Promise((resolve) => setTimeout(resolve, 350));
            }

            const measured = await geometry(list);

            console.log("SEARCH_FIT_NATIVE", JSON.stringify({ width, measured }));

            if (measured.inputWidth < measured.placeholderWidth) {
                failures.push(
                    `${width}px empty: ${measured.inputWidth}px available, ${measured.placeholderWidth}px needed`,
                );
            }

            await click(`${list} .search-filters`);
            await expectPage(
                `(await import('/store.js')).store.state.sheet?.type === 'session-tag-filter'`,
                "Filters opens the native sheet",
            );

            for (let index = 1; index <= 10; index++) {
                await click(
                    `.sheet-host:not(.leaving) .tag-options label:nth-child(${index}) input[type="checkbox"]`,
                );
            }

            await page.press("Escape");
            await expectPage(
                `(await import('/store.js')).store.state.sheet === null`,
                "filter sheet closed",
            );
            const filter = await inPage<{
                label: string;
                title: string;
                text: string;
                icon: boolean;
                countVisible: boolean;
            }>(`
            const button = document.querySelector(${JSON.stringify(`${list} .search-filters`)});
            return JSON.stringify({ label: button.getAttribute('aria-label'), title: button.title, text: button.textContent, icon: button.querySelector('svg').getBoundingClientRect().width > 0, countVisible: button.querySelector('.search-filter-count')?.getBoundingClientRect().width > 0 });
        `);

            assert.equal(
                filter.label,
                "Filters, 10 active tags",
                "Filters keeps its accessible name and active count",
            );

            if (!filter.title.includes("Filters")) {
                failures.push(`${width}px: Filters has no native title`);
            }

            assert.ok(
                filter.text.includes("10") && filter.icon && filter.countVisible,
                "active count and filter icon remain present",
            );
            const activeGeometry = await geometry(list);

            console.log("SEARCH_FIT_ACTIVE", JSON.stringify({ width, measured: activeGeometry }));

            if (activeGeometry.inputWidth < activeGeometry.placeholderWidth) {
                failures.push(
                    `${width}px active count: ${activeGeometry.inputWidth}px available, ${activeGeometry.placeholderWidth}px needed`,
                );
            }

            await new Promise((resolve) => setTimeout(resolve, 320));
            await page.type(
                { selector: `${list} input[aria-label="Search sessions"]` },
                "Search fixture",
            );
            await expectPage(
                `document.querySelector(${JSON.stringify(`${list} .search-clear`)}) !== null`,
                "populated search retains its native Clear action",
            );
            await click(`${list} .search-clear`);
            await expectPage(
                `document.querySelector(${JSON.stringify(`${list} input[aria-label="Search sessions"]`)}).value === ''`,
                "Clear empties the query",
            );

            // Long queries can scroll inside the native input. They do not have to fit at once.
            if (width < 700) {
                await click(`${list} .search-launcher`);
            } else {
                await page.press("Control+k");
            }

            await expectPage(
                `document.querySelector('[role="combobox"]') !== null`,
                "native global launcher remains available",
            );
            await page.press("Escape");
            await click(`${list} .tag-clear`);
        }

        assert.deepEqual(failures, [], "search fit and native titles at all supported widths");
    },
);
