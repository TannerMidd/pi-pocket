// The colors a browser starts with are Pocket neutral, and the look is Pocket's own stylesheet ("C · Bold"). A choice
// someone made (any colors, the desktop's too) is kept; colors nobody chose follow the owner's default, else the app's.
// Real Chromium; no provider is called.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

type Shown = {
    asked: string;
    colors: string;
    mode: string;
    look: string;
    background: string;
    bold: string;
    label: string;
};

/** Save what a browser kept (nothing, or an object for each key), then open the app afresh, as a reload does. */
async function visit(kept: Record<string, unknown>): Promise<Shown> {
    await page.navigate(`${base}/`);
    await page.evaluate(`
        localStorage.clear();
        for (const [key, value] of Object.entries(${JSON.stringify(kept)})) {
            localStorage.setItem(key, JSON.stringify(value));
        }
    `);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            JSON.parse(
                await page.evaluate(
                    `const { store } = await import("/store.js");

                    return JSON.stringify(document.querySelector(".scroller .transcript") !== null && Array.isArray(store.state.themeList) && store.state.server !== null)`,
                ),
            ) === true,
        "the session",
        20_000,
    );
    // The theme's stylesheet arrives after the list of themes does.
    await until(
        async () =>
            JSON.parse(
                await page.evaluate(
                    `return JSON.stringify(document.documentElement.dataset.theme === "pocket" ? getComputedStyle(document.documentElement).getPropertyValue("--step-rail") !== "" : true)`,
                ),
            ) === true,
        "the theme's stylesheet",
        20_000,
    );

    return JSON.parse(
        await page.evaluate(`
            const { store } = await import("/store.js");
            const { lookLabel } = await import("/theme.js");
            const css = getComputedStyle(document.documentElement);

            return JSON.stringify({
                asked: store.state.appearance.theme,
                colors: document.documentElement.dataset.colors,
                mode: document.documentElement.dataset.mode,
                look: document.documentElement.dataset.theme,
                background: css.getPropertyValue("--o-bg").trim(),
                bold: css.getPropertyValue("--step-rail").trim(),
                label: lookLabel(),
            });
        `),
    ) as Shown;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "default-colors-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    session = await newSession(app);
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            JSON.parse(
                await page.evaluate(
                    `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
                ),
            ) === true,
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a browser that chose nothing starts with Pocket neutral, in Pocket's own look",
    real,
    async () => {
        const shown = await visit({});

        assert.equal(shown.asked, "pocket-neutral");
        assert.equal(shown.colors, "pocket-neutral");
        assert.equal(shown.mode, "dark");
        assert.equal(shown.look, "pocket");
        assert.equal(shown.background, "#1f1c19");
        assert.equal(shown.bold, "70%", "the look's own stylesheet is loaded, for these colors");
        assert.equal(shown.label, "Pocket");
    },
);

test(
    "colors someone chose are kept: another palette, the desktop's, and the light half",
    real,
    async () => {
        const chosen = { "pocket.themeChosen": { theme: true, look: false } };
        const tokyo = await visit({ ...chosen, "pocket.appearance": { theme: "tokyo-night" } });

        assert.equal(tokyo.colors, "tokyo-night");
        assert.equal(tokyo.background, "#1a1b26");
        assert.equal(tokyo.look, "pocket", "the look is still Pocket's, in these colors");

        // "Desktop" is a choice too: with no desktop on this machine it shows Tokyo Night, as it did.
        const desktop = await visit({ ...chosen, "pocket.appearance": { theme: "desktop" } });

        assert.equal(desktop.asked, "desktop");
        assert.equal(desktop.colors, "tokyo-night");

        const light = await visit({
            ...chosen,
            "pocket.appearance": { theme: "pocket-neutral-light" },
        });

        assert.equal(light.colors, "pocket-neutral-light");
        assert.equal(light.mode, "light");
        assert.equal(light.background, "#fbf8f3");
        assert.equal(light.bold, "5.5%");
    },
);

test(
    "colors saved before there were choices: the old default is no choice, any other is",
    real,
    async () => {
        // Saved as the whole of a browser's settings were, with no record of a choice: the desktop's colors were the default.
        const old = await visit({ "pocket.appearance": { theme: "desktop", text: 16 } });

        assert.equal(old.asked, "pocket-neutral");
        assert.equal(old.colors, "pocket-neutral");

        const gruvbox = await visit({ "pocket.appearance": { theme: "gruvbox", text: 16 } });

        assert.equal(gruvbox.asked, "gruvbox");
        assert.equal(gruvbox.colors, "gruvbox");

        // A browser that says it chose none follows the default whatever it saved.
        const unchosen = await visit({
            "pocket.themeChosen": { theme: false, look: false },
            "pocket.appearance": { theme: "desktop" },
        });

        assert.equal(unchosen.colors, "pocket-neutral");
    },
);

test(
    "the owner's default wins over the app's for browsers that chose none, and Reset goes back",
    real,
    async () => {
        await app.setThemeDefault(
            app.config.users.find((user) => user.role === "owner")!,
            {
                look: "pocket",
                colors: "nord",
            },
        );

        try {
            const followed = await visit({});

            assert.equal(followed.colors, "nord");

            const own = await visit({
                "pocket.themeChosen": { theme: true, look: false },
                "pocket.appearance": { theme: "gruvbox" },
            });

            assert.equal(own.colors, "gruvbox");
        } finally {
            await app.setThemeDefault(
                app.config.users.find((user) => user.role === "owner")!,
                null,
            );
        }

        assert.equal((await visit({})).colors, "pocket-neutral");
    },
);

test(
    "another theme keeps its own look: Pocket's stylesheet is not loaded for it",
    real,
    async () => {
        const lantern = await visit({
            "pocket.themeChosen": { theme: true, look: true },
            "pocket.appearance": { look: "lantern", theme: "lantern" },
        });

        assert.equal(lantern.look, "lantern");
        assert.equal(lantern.bold, "", "no plane steps of Pocket's look");
    },
);

test(
    "a chosen theme that is gone falls back to Pocket's own look, not the bare app",
    real,
    async () => {
        const shown = await visit({
            "pocket.themeChosen": { theme: false, look: true },
            "pocket.appearance": { look: "a-theme-that-is-gone" },
        });

        assert.equal(shown.look, "pocket");
        assert.equal(shown.bold, "70%", "Pocket's stylesheet is loaded");
    },
);

test(
    "quiet text in sheets keeps its color with a light palette that is not Pocket's",
    real,
    async () => {
        await visit({
            "pocket.themeChosen": { theme: true, look: false },
            "pocket.appearance": { theme: "catppuccin-latte" },
        });

        // A weight over 100% is invalid in color-mix(), and the text would inherit its parent's color instead. Chromium
        // clamps a calc() weight, so this run cannot see it; the stylesheet check below holds for every engine.
        const colors = JSON.parse(
            await page.evaluate(`
            const sheet = document.createElement("div");
            const quiet = document.createElement("span");

            sheet.className = "sheet";
            sheet.style.color = "rgb(1, 2, 3)";
            quiet.style.color = "var(--muted)";
            quiet.textContent = "quiet";
            sheet.append(quiet);
            document.body.append(sheet);

            const seen = { parent: getComputedStyle(sheet).color, quiet: getComputedStyle(quiet).color };

            sheet.remove();

            return JSON.stringify(seen);
        `),
        ) as { parent: string; quiet: string };

        assert.notEqual(colors.quiet, colors.parent);

        const css = await readFile(
            join(import.meta.dirname, "..", "web", "themes", "pocket", "theme.css"),
            "utf8",
        );
        const uncapped = css
            .split("\n")
            .filter(
                (line) =>
                    /var\(--mute\) \+/.test(line) && !/min\(100%, var\(--mute\) \+/.test(line),
            );

        assert.deepEqual(
            uncapped,
            [],
            "every --mute weight above the base is capped by min(100%, …)",
        );
    },
);

type Accent = {
    hue: string;
    link: string;
    fill: number[];
    ink: number[];
    edge: number[];
    place: number[];
    focus: number[];
    err: number[];
};

/** What the accent paints in Pocket's look, as RGB: New's fill, the active place's edge and label, the focus ring, `--err`. */
async function accent(kept: Record<string, unknown>): Promise<Accent> {
    await visit(kept);

    return JSON.parse(
        await page.evaluate(`
            const canvas = document.createElement("canvas");

            canvas.width = canvas.height = 1;

            const paint = canvas.getContext("2d", { willReadFrequently: true });
            const rgb = (css) => {
                paint.clearRect(0, 0, 1, 1);
                paint.fillStyle = "#000";
                paint.fillStyle = css;
                paint.fillRect(0, 0, 1, 1);

                return [...paint.getImageData(0, 0, 1, 1).data].slice(0, 3);
            };
            const token = (name) => {
                const probe = document.createElement("span");

                probe.style.color = "var(" + name + ")";
                document.body.append(probe);

                const color = getComputedStyle(probe).color;

                probe.remove();

                return rgb(color);
            };
            const root = getComputedStyle(document.documentElement);
            const fill = document.querySelector(".new-button");
            const place = document.querySelector(".places-rail .rail-place.on");

            return JSON.stringify({
                hue: root.getPropertyValue("--hue").trim(),
                link: root.getPropertyValue("--o-accent").trim(),
                fill: rgb(getComputedStyle(fill).backgroundColor),
                ink: rgb(getComputedStyle(fill).color),
                edge: rgb(getComputedStyle(place, "::before").backgroundColor),
                place: rgb(getComputedStyle(place).color),
                focus: token("--focus-ring"),
                err: token("--err"),
            });
        `),
    ) as Accent;
}

const hueOf = ([r = 0, g = 0, b = 0]: number[]) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const turn =
        max === r
            ? (g - b) / (max - min)
            : max === g
              ? 2 + (b - r) / (max - min)
              : 4 + (r - g) / (max - min);

    return (turn * 60 + 360) % 360;
};

const near = (found: number[], want: number[], by: number) =>
    found.every((channel, index) => Math.abs(channel - want[index]!) <= by);

test(
    "Pocket neutral paints the accent coral on New and the active place, in dark and light",
    real,
    async () => {
        const chosen = { "pocket.themeChosen": { theme: true, look: false } };
        const dark = await accent({});
        const light = await accent({
            ...chosen,
            "pocket.appearance": { theme: "pocket-neutral-light" },
        });

        for (const [mode, shown] of [
            ["dark", dark],
            ["light", light],
        ] as const) {
            assert.equal(shown.hue, "#eb927b", `${mode}: the hue is the brand coral`);
            assert.ok(near(shown.fill, [235, 146, 123], 14), `${mode}: New is coral ${shown.fill}`);
            assert.ok(
                shown.ink.every((channel) => channel < 70),
                `${mode}: dark ink on New`,
            );
            assert.ok(hueOf(shown.edge) < 24, `${mode}: the place's edge is coral ${shown.edge}`);
            assert.deepEqual(shown.place, shown.edge, `${mode}: its label has the edge's color`);
            // Links and the focus ring stay the palette's muted blue.
            assert.ok(
                hueOf(shown.focus) > 190 && hueOf(shown.focus) < 250,
                `${mode}: ${shown.focus}`,
            );
            // The failed color is crimson, apart from the coral.
            const err = hueOf(shown.err);

            assert.ok(err > 340 || err < 4, `${mode}: --err ${shown.err} is crimson (${err})`);
        }

        assert.ok(near(dark.edge, [235, 146, 123], 20), `dark edge ${dark.edge}`);
        assert.ok(
            light.edge[0]! < 200 && light.edge[1]! < 100,
            `light edge is deep: ${light.edge}`,
        );
    },
);

test(
    "another palette keeps its own accent for New, the place, links, and its red",
    real,
    async () => {
        const tokyo = await accent({
            "pocket.themeChosen": { theme: true, look: false },
            "pocket.appearance": { theme: "tokyo-night" },
        });

        assert.equal(tokyo.hue, "#7aa2f7", "the hue is the palette's accent, not the coral");
        assert.ok(hueOf(tokyo.fill) > 200 && hueOf(tokyo.fill) < 250, `New: ${tokyo.fill}`);
        assert.ok(hueOf(tokyo.edge) > 200 && hueOf(tokyo.edge) < 250, `edge: ${tokyo.edge}`);
        assert.deepEqual(tokyo.focus.length, 3);
    },
);

test("the folded sidebar holds the whole rail, labels and badges included", real, async () => {
    await visit({});
    await page.evaluate(`(await import("/theme.js")).setPrefs({ sidebar: "rail" }); return "true"`);
    await until(
        async () =>
            JSON.parse(
                await page.evaluate(
                    `return JSON.stringify(document.documentElement.dataset.rail === "on")`,
                ),
            ) === true,
        "the sidebar folded",
    );

    const fit = JSON.parse(
        await page.evaluate(`
            const rail = document.querySelector(".places-rail").getBoundingClientRect();
            const sidebar = document.querySelector(".sidebar").getBoundingClientRect();

            return JSON.stringify({ rail: Math.round(rail.right), sidebar: Math.round(sidebar.right), width: Math.round(rail.width) });
        `),
    ) as { rail: number; sidebar: number; width: number };

    assert.equal(fit.width, 88);
    assert.ok(fit.rail <= fit.sidebar, JSON.stringify(fit));
    await page.evaluate(`(await import("/theme.js")).setPrefs({ sidebar: "open" }); return "true"`);
});
