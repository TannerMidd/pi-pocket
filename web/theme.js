// Appearance: the theme (a folder of CSS the server lists, `themes.ts`), the colors (Omarchy palettes as CSS variables,
// a theme folder's own, or "Follow desktop": the Omarchy theme this machine runs), tiled windows, motion, text size,
// density, and the sidebar's shape. Saved per browser. index.html applies the last look before the first paint from
// `pocket.themeCache`, the theme's stylesheets included, so a reload never flashes another look.
import { THEMES } from "./themes.js";
import { onSafeModeEnd, safeMode } from "./safe-mode.js";
import { api, store } from "./store.js";

const KEY = "pocket.appearance";
const CACHE = "pocket.themeCache";
const DESKTOP_CACHE = "pocket.desktopTheme";
const PINNED = "pocket.pinned";
const FALLBACK = "tokyo-night";

/** The app's own look, which every theme builds on: it loads no stylesheet. */
export const BASE_LOOK = "pocket";

/** The conversation's text size in pixels: anything from MIN_TEXT to MAX_TEXT, in steps of STEP_TEXT. */
export const MIN_TEXT = 10;
export const MAX_TEXT = 32;
export const STEP_TEXT = 0.5;

/** A text size someone typed or saved, kept in range and on a step; the default for one that is not a number. */
export function textSizeOf(value) {
    const size = Number(value);

    if (value === null || value === "" || !Number.isFinite(size)) {
        return 15;
    }

    return Math.min(MAX_TEXT, Math.max(MIN_TEXT, Math.round(size / STEP_TEXT) * STEP_TEXT));
}

const DEFAULTS = {
    /**
     * The colors: "desktop" follows the Omarchy theme of the machine Pi Pocket runs on; otherwise a key of THEMES, or the
     * id of a theme folder with a colors.toml. (Its name is from before themes were folders.)
     */
    theme: "desktop",
    /** The theme: a theme folder's id, or "pocket", the app's own look. */
    look: BASE_LOOK,
    /** Wide screens: the sidebar and the conversation as Hyprland windows, with gaps and borders. */
    tiling: true,
    /** The desktop's wallpaper in the gaps, when following the desktop. */
    wallpaper: false,
    /**
     * "auto" follows the system's reduced-motion setting; "full" is the app's usual motion, "reduced" none, and "fluid"
     * the most: springs, staggered entrances, and layout changes that morph (`motionLevel`).
     */
    motion: "auto",
    /** The conversation's text in pixels, MIN_TEXT to MAX_TEXT; the rest of the app keeps its own sizes. */
    text: 15,
    /** How much room the spacing takes: "comfortable", "compact", or "tight". Font sizes stay. */
    density: "comfortable",
    /**
     * How wide the conversation and the message box are on a wide screen: "comfortable" (the theme's width, which grows
     * with the pane), "wide" (most of the pane), or "full" (all of it).
     */
    width: "comfortable",
    /** The sidebar on wide screens: "open", or "rail" (icons and numbered sessions only). */
    sidebar: "open",
    /** The open sidebar's width, its borders, the rail, and the list's: a 254px list. */
    sidebarWidth: 312,
    /** How the session list groups: "priority" (by what needs you), "recent" (by day), or "folder". */
    group: "recent",
    /** Other sessions' live work as peek tiles beside the session (a strip on narrow screens). Off until turned on. */
    peeks: false,
    /** How fast the last answer came, in the status line under the message box. Off until turned on. */
    speed: false,
    /** Pi's current thought above the live line, and its finished thoughts open. Off until turned on. */
    showThinking: false,
    /**
     * Pi's thinking and tool calls stay folded into their one line until opened, also while they run and in the newest
     * turn; off, the newest turn's groups open as they come. A group opened or closed by hand keeps that choice, and a
     * thought alone in its group still follows Show thinking. Off until turned on.
     */
    foldActivity: false,
    /** This browser's own layout of each slot (`slots.js`): `{ [slot]: { order: [ids], hidden: { [id]: boolean } } }`. */
    layout: {},
};

function readJson(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key) ?? "null");

        return value ?? fallback;
    } catch {
        return fallback;
    }
}

const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
/** The system's light or dark, which a theme's pair of palettes follows. */
const lightQuery = matchMedia("(prefers-color-scheme: light)");

/** Set once this browser's saved look has the sidebar's width for the rail beside the list. */
const RAIL_KEY = "pocket.railBeside";
/** Set once this browser's saved look has the soft tiles' text size and sidebar. */
const SOFT_KEY = "pocket.softTiles";

/**
 * What this browser saved. The sidebar's usual width was 300 before the rail went beside the list, then 324, and is
 * 312 with soft tiles. The text size was the whole app's, 12 to 16; it is now the conversation's, a step larger.
 */
function savedPrefs() {
    const saved = readJson(KEY, {});

    if (localStorage.getItem(SOFT_KEY) !== null) {
        return saved;
    }

    // Either usual width, the one from before the rail went beside the list too.
    const usual =
        saved.sidebarWidth === 324 ||
        (saved.sidebarWidth === 300 && !localStorage.getItem(RAIL_KEY));
    const next = {
        ...saved,
        ...(usual && { sidebarWidth: DEFAULTS.sidebarWidth }),
        ...(typeof saved.text === "number" && { text: saved.text + 1 }),
    };

    localStorage.setItem(RAIL_KEY, "1");
    localStorage.setItem(SOFT_KEY, "1");
    localStorage.setItem(KEY, JSON.stringify(next));

    return next;
}

/**
 * Appearance's Width, past Comfortable: the column's width and the message box's, set inline so they win over a theme's.
 * Each grows with the pane (a percentage of it) and has a floor of today's column, so phones and narrow windows stay as
 * they are.
 */
const WIDTHS = {
    wide: {
        "--transcript-width": "clamp(720px, 92%, 1600px)",
        "--composer-width": "calc(clamp(720px, 92%, 1600px) + 48px)",
    },
    full: { "--transcript-width": "100%", "--composer-width": "100%" },
};

/** The open sidebar's width as it shows: the rail and its borders, and a list 204–464px wide. */
const sidebarWidth = (p) => `${Math.min(524, Math.max(264, p.sidebarWidth))}px`;

/** This browser's own choices: what it saved, over the defaults. */
let own = { ...DEFAULTS, ...savedPrefs() };

/** Which of the theme (`look`) and the colors (`theme`) this browser's person chose; the rest follow the owner's default. */
const CHOSEN = "pocket.themeChosen";
const chosen = readJson(CHOSEN, null) ?? {
    // From before there were defaults: colors other than the desktop's were someone's choice.
    theme: own.theme !== DEFAULTS.theme,
    look: own.look !== DEFAULTS.look,
};

/** The owner's default as the last `hello` said it: it stands until the next one, so a reload paints it from the start. */
const DEFAULT_CACHE = "pocket.themeDefault";

/** The owner's default theme and colors: the server's, or, before it said, the one it said last time. */
const ownerDefault = (state = store.state) =>
    state.server ? (state.server.themeDefault ?? null) : readJson(DEFAULT_CACHE, null);

/** The look in force: this browser's own, with the owner's default theme and colors where its person chose none. */
function inForce() {
    const fallback = ownerDefault();

    return {
        ...own,
        ...(fallback && !chosen.look ? { look: fallback.look } : {}),
        ...(fallback && !chosen.theme ? { theme: fallback.colors } : {}),
    };
}

store.set({
    appearance: inForce(),
    desktopTheme: readJson(DESKTOP_CACHE, null),
    pinned: readJson(PINNED, []),
});

export const prefs = () => store.state.appearance;

/** The settings that move the windows: with Fluid motion, changing one morphs the layout (`morph`). */
const MORPHS = new Set(["sidebar", "width", "tiling"]);
let morphing = false;
let morphs = 0;

/**
 * Make `change` a view transition in which the windows slide and resize into their new places (style.css,
 * `layout-vt`), and say whether it did: only with Fluid motion, in a browser that has view transitions, on a page in
 * view, with nothing over the windows. The change itself comes a frame later, once the old layout is captured.
 */
function morph(change) {
    if (
        morphing ||
        motionLevel() !== "fluid" ||
        typeof document.startViewTransition !== "function" ||
        document.visibilityState !== "visible" ||
        // The windows would draw over a sheet or the launcher while they move: with one open, change at once.
        document.querySelector(".overlay, .launcher-overlay")
    ) {
        return false;
    }

    const root = document.documentElement;
    // A second change while one runs skips the first; only the newest one takes the class off when it ends.
    const mine = ++morphs;

    root.classList.add("layout-vt");
    const run = document.startViewTransition(async () => {
        morphing = true;

        try {
            change();
        } finally {
            morphing = false;
        }

        // The store renders in a microtask; let it finish before the new layout is captured.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    settleTransition(run, () => mine === morphs && root.classList.remove("layout-vt"));

    return true;
}

export function setPrefs(patch) {
    const moved = Object.keys(patch).some((key) => MORPHS.has(key) && patch[key] !== prefs()[key]);

    if (moved && morph(() => setPrefs(patch))) {
        return;
    }

    own = { ...own, ...patch };

    // Choosing the theme or the colors makes them this browser's own: the owner's default no longer moves them.
    for (const key of ["look", "theme"]) {
        if (key in patch) {
            chosen[key] = true;
            localStorage.setItem(CHOSEN, JSON.stringify(chosen));
        }
    }

    localStorage.setItem(KEY, JSON.stringify(own));
    store.set({ appearance: inForce() });
    apply();
}

/** The owner's default for browsers that have not chosen (`hello`), or null. */
export const themeDefault = () => store.state.server?.themeDefault ?? null;

// ─── Pinned sessions (this browser) ──────────────────────────────────────────────

/** The pinned ids as a set, made again only when the list changes: rows ask for each session as they draw. */
let pinnedSet = { list: null, set: new Set() };

export function isPinned(id) {
    const list = store.state.pinned;

    if (pinnedSet.list !== list) {
        pinnedSet = { list, set: new Set(list) };
    }

    return pinnedSet.set.has(id);
}

export function togglePin(id) {
    const pinned = isPinned(id)
        ? store.state.pinned.filter((each) => each !== id)
        : [...store.state.pinned, id];

    localStorage.setItem(PINNED, JSON.stringify(pinned));
    store.set({ pinned });
}

export function movePin(id, last) {
    if (!isPinned(id)) {
        return;
    }

    const others = store.state.pinned.filter((each) => each !== id);
    const pinned = last ? [...others, id] : [id, ...others];

    localStorage.setItem(PINNED, JSON.stringify(pinned));
    store.set({ pinned });
}

// ─── Palettes ───────────────────────────────────────────────────────────────────

/** The palette a theme id means: a bundled theme, or the desktop's (falling back when there is none). */
export function paletteOf(id = prefs().theme) {
    if (id === "desktop") {
        const desktop = store.state.desktopTheme;

        if (desktop?.colors) {
            return {
                id: "desktop",
                name:
                    (Object.hasOwn(THEMES, desktop.name) && THEMES[desktop.name].name) ||
                    desktop.name,
                colors: desktop.colors,
                desktop: true,
            };
        }

        return { id: FALLBACK, ...THEMES[FALLBACK] };
    }

    // Own ids only: a folder named "constructor" is no palette of the app's.
    if (Object.hasOwn(THEMES, id)) {
        return { id, ...THEMES[id] };
    }

    const folder = folderColors(id);

    return folder ?? { id: FALLBACK, ...THEMES[FALLBACK] };
}

/** A theme folder's palette, when the server lists one by that id that can be used. */
function folderColors(id) {
    const [base, half] = id.split("@");
    const folder = store.state.themeList?.find(
        (each) => each.id === base && each.usable && each.colors,
    );

    if (!folder) {
        return undefined;
    }

    // A pair (colors.toml and colors-light.toml): the half asked for, or the one the system's light or dark asks for.
    const light =
        folder.colorsLight !== undefined &&
        (half === "light" || (half === undefined && lightQuery.matches));

    return {
        id,
        name: folder.colorsLight && half ? `${folder.name} · ${half}` : folder.name,
        colors: light ? folder.colorsLight : folder.colors,
        folder: true,
        pair: folder.colorsLight !== undefined && half === undefined,
    };
}

/**
 * Whether the palette `id` names is known here yet: one that comes with the app, the desktop's, or any once the server
 * listed its theme folders. Until then, the palette index.html put on the page from the cache stays.
 */
const paletteKnown = (id) => id === "desktop" || Object.hasOwn(THEMES, id) || themesListed();

/** The server listed its theme folders (`hello`). */
const themesListed = () => Array.isArray(store.state.themeList);

// ─── Theme folders ──────────────────────────────────────────────────────────────

/** The theme folder this browser uses: the one it chose, if the server offers it; else the app's own look. */
function lookOf(id = prefs().look) {
    if (safeMode() || id === BASE_LOOK) {
        return null;
    }

    return (
        store.state.themeList?.find(
            (each) => each.id === id && each.usable && each.css.length > 0,
        ) ?? null
    );
}

/** The stylesheets of the theme this tab shows, or null while the server has not listed them yet. */
function themeSheets() {
    if (safeMode() || prefs().look === BASE_LOOK) {
        return [];
    }

    return themesListed() ? (lookOf()?.css ?? []) : null;
}

/** Settles once the newest theme's stylesheets loaded (or failed to). */
let sheetsLoaded = Promise.resolve();

/**
 * Put a theme's stylesheets in the theme layer: the new ones load beside the old, which go once they did, so nothing
 * shows the app without a theme between two. The element holding them is `#pocket-theme`, as index.html names the one
 * it writes before the first paint.
 */
function loadSheets(urls) {
    const key = JSON.stringify(urls);
    const current = document.getElementById("pocket-theme");

    if ((current?.dataset.urls ?? "[]") === key) {
        return sheetsLoaded;
    }

    const next = document.createElement("style");

    next.dataset.urls = key;
    next.textContent = urls.map((url) => `@import url("${url}") layer(theme);`).join("\n");
    current?.removeAttribute("id");
    next.id = "pocket-theme";

    const old = () => {
        for (const each of document.querySelectorAll("style[data-urls]")) {
            if (each !== document.getElementById("pocket-theme")) {
                each.remove();
            }
        }
    };

    if (urls.length === 0) {
        document.head.append(next);
        old();
        requestAnimationFrame(() => document.dispatchEvent(new Event("pocket:theme")));
        sheetsLoaded = Promise.resolve();

        return sheetsLoaded;
    }

    sheetsLoaded = new Promise((resolve) => {
        next.addEventListener("load", resolve, { once: true });
        next.addEventListener("error", resolve, { once: true });
        // A server that does not answer: show what there is.
        setTimeout(resolve, 4000);
    }).then(() => {
        old();
        // What reads where things are laid out (`useSide`) looks again.
        document.dispatchEvent(new Event("pocket:theme"));
    });
    document.head.append(next);

    return sheetsLoaded;
}

/** Switch to the theme folder `id` (or "pocket"), with the reveal; a theme with colors of its own brings them too. */
export function chooseLook(id, event) {
    const at =
        event && "clientX" in event && (event.clientX || event.clientY)
            ? { x: event.clientX, y: event.clientY }
            : undefined;

    if (id === prefs().look) {
        return;
    }

    const look = store.state.themeList?.find((each) => each.id === id);

    transition(() => {
        setPrefs({ look: id, ...(look?.colors ? { theme: id } : {}) });

        return sheetsLoaded;
    }, at);
}

/**
 * The look in use, in words: the theme's name, and the colors' when they are not the theme's own ("Lantern", "Pocket ·
 * Gruvbox"). For the menu's Appearance row and the home screen.
 */
export function lookLabel() {
    const look = lookOf();
    const palette = paletteOf();
    const colors = palette.desktop ? `${palette.name} (desktop)` : palette.name;

    return look && prefs().theme.split("@")[0] === look.id
        ? look.name
        : `${look?.name ?? "Pocket"} · ${colors}`;
}

/** Theme folders that change the look, in the order the server lists them: the app's own first. */
export function lookIds() {
    return [
        BASE_LOOK,
        ...(store.state.themeList ?? [])
            .filter(
                (each) =>
                    each.id !== BASE_LOOK &&
                    (each.css.length > 0 || !each.usable) &&
                    !colorsOnly(each),
            )
            .map((each) => each.id),
    ];
}

/** A theme folder with colors and no CSS: it shows under Colors only. */
export const colorsOnly = (each) =>
    each.css.length === 0 && each.colors !== undefined && each.usable;

/** Theme folders' palettes, after the app's own: their ids. */
export function folderPaletteIds() {
    return (store.state.themeList ?? [])
        .filter((each) => each.usable && each.colors && each.id !== BASE_LOOK)
        .flatMap((each) =>
            each.colorsLight ? [each.id, `${each.id}@dark`, `${each.id}@light`] : [each.id],
        );
}

/** CSS variables for a palette. Everything else in style.css mixes from these. */
export function themeVars(palette) {
    const c = palette.colors;
    const pick = (...keys) =>
        keys
            .map((key) => c[key])
            .find((value) => typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value));
    const bg = pick("background") ?? "#1a1b26";
    const fg = pick("foreground") ?? "#a9b1d6";
    const accent = pick("accent", "blue") ?? fg;

    return {
        "--o-bg": bg,
        "--o-bg-dark": pick("dark_background") ?? bg,
        "--o-bg-darker": pick("darker_background", "dark_background") ?? bg,
        "--o-bg-light": pick("lighter_background") ?? bg,
        "--o-fg": fg,
        "--o-fg-dim": pick("dark_foreground", "muted") ?? fg,
        "--o-fg-light": pick("light_foreground") ?? fg,
        "--o-fg-bright": pick("bright_foreground") ?? fg,
        "--o-accent": accent,
        "--o-selection": pick("selection", "lighter_background") ?? accent,
        "--o-red": pick("red") ?? "#f7768e",
        "--o-yellow": pick("yellow", "bright_yellow") ?? "#e0af68",
        "--o-orange": pick("orange", "bright_yellow", "yellow") ?? "#ff9e64",
        "--o-green": pick("green") ?? "#9ece6a",
        "--o-cyan": pick("cyan") ?? "#7dcfff",
        "--o-blue": pick("blue", "accent") ?? accent,
        "--o-magenta": pick("magenta") ?? "#bb9af7",
    };
}

/** Variables as an inline style. */
export const varsStyle = (vars) =>
    Object.entries(vars)
        .map(([name, value]) => `${name}:${value}`)
        .join(";");

/**
 * Put a palette's variables in the palette layer (index.html declares the layers): under the theme, which may set them
 * again, and over the app's defaults. Inline they would beat the theme. Variables an older version of this page left
 * inline go.
 */
function setPalette(vars) {
    const root = document.documentElement;
    let style = document.getElementById("pocket-palette");

    if (style === null) {
        style = document.createElement("style");
        style.id = "pocket-palette";
        document.head.append(style);
    }

    const text = `@layer palette{:root{${varsStyle(vars)}}}`;

    if (style.textContent !== text) {
        style.textContent = text;
    }

    for (const name of Object.keys(vars)) {
        root.style.removeProperty(name);
    }
}

export const modeOf = (palette) => (palette.colors.mode === "light" ? "light" : "dark");

/** The motion on the page, from Appearance's choice: "reduced", "full", or "fluid" (chosen only, never by Auto). */
export function motionLevel() {
    const motion = prefs().motion;

    if (motion === "reduced" || (motion === "auto" && reduceQuery.matches)) {
        return "reduced";
    }

    return motion === "fluid" ? "fluid" : "full";
}

const reducedMotion = () => motionLevel() === "reduced";

/** Put the current look on the page: variables, mode, and the switches style.css reads from data attributes. */
export function apply() {
    const root = document.documentElement;
    const p = prefs();
    const cached = readJson(CACHE, {});
    // Colors of a theme folder before the server listed them: keep what index.html put on the page from the cache.
    const palette = paletteKnown(p.theme) ? paletteOf() : null;
    const vars = palette ? themeVars(palette) : (cached.palette ?? themeVars(paletteOf(FALLBACK)));

    if (palette) {
        setPalette(vars);
    }

    const sheets = themeSheets();

    if (sheets !== null) {
        loadSheets(sheets);
    }

    const desktop = store.state.desktopTheme;
    // The desktop's wallpaper is the person's choice, so it stays inline and wins; without it, the app's default (none)
    // or the theme's own shows.
    const wallpaper =
        p.theme === "desktop" && p.wallpaper && p.tiling && desktop?.wallpaper
            ? `url("/api/theme/wallpaper?v=${encodeURIComponent(desktop.stamp)}")`
            : null;
    // Width other than Comfortable is the person's choice, inline over the theme's; Comfortable leaves it to the theme.
    const width = WIDTHS[p.width];
    const inline = {
        "--text-size": `${textSizeOf(p.text)}px`,
        "--sidebar-w": sidebarWidth(p),
        ...(wallpaper === null ? {} : { "--wallpaper": wallpaper }),
        ...(width ?? {}),
    };

    if (wallpaper === null) {
        root.style.removeProperty("--wallpaper");
    }

    if (!width) {
        root.style.removeProperty("--transcript-width");
        root.style.removeProperty("--composer-width");
    }

    for (const [name, value] of Object.entries(inline)) {
        root.style.setProperty(name, value);
    }

    const attrs = {
        mode: palette ? modeOf(palette) : (cached.attrs?.mode ?? "dark"),
        // Before the list, the theme index.html painted from the cache stays named, as its stylesheets stay.
        theme: sheets === null ? (cached.attrs?.theme ?? BASE_LOOK) : (lookOf()?.id ?? BASE_LOOK),
        colors: palette?.id ?? cached.attrs?.colors ?? p.theme,
        tiling: p.tiling ? "on" : "off",
        motion: motionLevel(),
        rail: p.sidebar === "rail" ? "on" : "off",
        density: p.density,
        width: WIDTHS[p.width] ? p.width : "comfortable",
    };

    Object.assign(root.dataset, attrs);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", vars["--o-bg"]);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", attrs.mode);
    // In safe mode, or before the list, the theme's stylesheets stay as the cache has them, for the next load.
    const css = sheets === null || safeMode() ? (cached.css ?? []) : sheets;
    const fonts = sheets === null || safeMode() ? (cached.fonts ?? []) : (lookOf()?.fonts ?? []);
    // A pair of palettes: both halves, so the first paint takes the one the system's light or dark asks for.
    const pair = palette?.pair
        ? Object.fromEntries(
              ["dark", "light"].map((half) => {
                  const each = themeVars(paletteOf(`${palette.id}@${half}`));

                  return [half, { palette: each, color: each["--o-bg"] }];
              }),
          )
        : palette
          ? undefined
          : cached.pair;

    localStorage.setItem(
        CACHE,
        JSON.stringify({
            palette: vars,
            vars: inline,
            attrs,
            color: vars["--o-bg"],
            css,
            fonts,
            ...(pair ? { pair } : {}),
        }),
    );
}

/**
 * Change the look with a circle that grows from `at` (a click's place) over the old one, as a view transition. Without
 * view transitions, or with reduced motion, it changes at once.
 */
let transitions = 0;

function transition(change, at) {
    const root = document.documentElement;

    if (
        typeof document.startViewTransition !== "function" ||
        reducedMotion() ||
        document.visibilityState !== "visible"
    ) {
        change();

        return;
    }

    const x = at?.x ?? innerWidth / 2;
    const y = at?.y ?? innerHeight / 2;

    root.style.setProperty("--vt-x", `${x}px`);
    root.style.setProperty("--vt-y", `${y}px`);
    root.style.setProperty(
        "--vt-r",
        `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`,
    );
    root.classList.add("theme-vt");
    // A second change while one runs skips the first; only the newest one takes the class off when it ends.
    const mine = ++transitions;
    const run = document.startViewTransition(async () => {
        await change();
        // The store renders in a microtask; let it finish before the new look is captured.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    settleTransition(run, () => mine === transitions && root.classList.remove("theme-vt"));
}

/** A rapid change can skip a transition: handle each promise, and clean up even when it was skipped. */
function settleTransition(run, clean) {
    run.ready.catch(() => {});
    run.updateCallbackDone.catch(() => {});
    run.finished.then(clean, clean);
}

/** Switch theme, with the reveal starting from where the person clicked. */
export function chooseTheme(id, event) {
    const at =
        event && "clientX" in event && (event.clientX || event.clientY)
            ? { x: event.clientX, y: event.clientY }
            : undefined;

    if (id === prefs().theme) {
        return;
    }

    transition(() => setPrefs({ theme: id }), at);
}

/** Look at a theme without choosing it, as the launcher does while arrowing through themes. null goes back. */
let previewing = null;

export function preview(id) {
    if (id === previewing) {
        return;
    }

    previewing = id;
    const palette = id === null ? paletteOf() : paletteOf(id);

    setPalette(themeVars(palette));
    document.documentElement.dataset.mode = modeOf(palette);
}

// ─── Follow desktop ─────────────────────────────────────────────────────────────

let checking = false;
let started = false;

/** Ask the server for the desktop's theme; animate to it when it changed since the last look. */
async function checkDesktop({ animate = true } = {}) {
    if (checking || store.state.me === null) {
        return;
    }

    checking = true;

    try {
        const { theme } = await api("theme");
        const before = store.state.desktopTheme;

        if ((theme?.stamp ?? null) === (before?.stamp ?? null)) {
            return;
        }

        localStorage.setItem(DESKTOP_CACHE, JSON.stringify(theme));

        const change = () => {
            store.set({ desktopTheme: theme });
            apply();
        };

        if (animate && before !== null && prefs().theme === "desktop") {
            transition(change);
        } else {
            change();
        }
    } catch {
        // Signed out, or an older server without the route: keep what we have.
    } finally {
        checking = false;
    }
}

const DESKTOP_EVERY_MS = 6000;

/** Start following the desktop's theme: now, whenever the page comes back, and every few seconds while it shows. */
export function startTheme() {
    apply();

    if (started) {
        return;
    }

    started = true;
    reduceQuery.addEventListener?.("change", apply);
    lightQuery.addEventListener?.("change", apply);
    onSafeModeEnd(apply);
    // The server's list of theme folders came or changed (a theme's new version, or one that went), or the owner's
    // default did.
    let list = store.state.themeList;
    let fallback = JSON.stringify(ownerDefault());

    store.subscribe((state) => {
        const next = JSON.stringify(ownerDefault(state));

        if (state.server && localStorage.getItem(DEFAULT_CACHE) !== next) {
            localStorage.setItem(DEFAULT_CACHE, next);
        }

        if (next !== fallback) {
            fallback = next;
            store.set({ appearance: inForce() });
            apply();
        } else if (state.themeList !== list) {
            list = state.themeList;
            apply();
        }
    });
    const look = () =>
        document.visibilityState === "visible" && prefs().theme === "desktop" && checkDesktop();

    document.addEventListener("visibilitychange", look);
    addEventListener("focus", look);
    // A server without an Omarchy desktop answers null: no need to keep asking every few seconds.
    setInterval(() => store.state.desktopTheme !== null && look(), DESKTOP_EVERY_MS);
    // Once signed in: the route needs a person.
    const stop = store.subscribe((state) => {
        if (!state.me) {
            return;
        }

        stop();
        checkDesktop({ animate: false });
    });
}

/** Theme ids in the order the picker shows them: dark themes, then light ones. */
export function themeIds() {
    const ids = Object.keys(THEMES);

    return [
        ...ids.filter((id) => THEMES[id].colors.mode !== "light"),
        ...ids.filter((id) => THEMES[id].colors.mode === "light"),
    ];
}

export { THEMES };
