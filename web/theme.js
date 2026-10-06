// Appearance: Omarchy palettes as CSS variables, "Follow desktop" (the Omarchy theme this machine runs), tiled windows,
// motion, text size, and the sidebar's shape. Saved per browser. index.html applies the last look before the first
// paint from `pocket.themeCache`, so a reload never flashes another theme.
import { THEMES } from "./themes.js";
import { api, store } from "./store.js";

const KEY = "pocket.appearance";
const CACHE = "pocket.themeCache";
const DESKTOP_CACHE = "pocket.desktopTheme";
const PINNED = "pocket.pinned";
const FALLBACK = "tokyo-night";

export const DEFAULTS = {
    /** "desktop" follows the Omarchy theme of the machine Pi Pocket runs on; otherwise a key of THEMES. */
    theme: "desktop",
    /** Wide screens: the sidebar and the conversation as Hyprland windows, with gaps and borders. */
    tiling: true,
    /** The desktop's wallpaper in the gaps, when following the desktop. */
    wallpaper: false,
    /** "auto" follows the system's reduced-motion setting. */
    motion: "auto",
    text: 14,
    /** The sidebar on wide screens: "open", or "rail" (icons and numbered sessions only). */
    sidebar: "open",
    sidebarWidth: 300,
    /** How the session list groups: "recent" (by day) or "folder". */
    group: "recent",
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

store.set({
    appearance: { ...DEFAULTS, ...readJson(KEY, {}) },
    desktopTheme: readJson(DESKTOP_CACHE, null),
    pinned: readJson(PINNED, []),
});

export const prefs = () => store.state.appearance;

export function setPrefs(patch) {
    const next = { ...prefs(), ...patch };

    localStorage.setItem(KEY, JSON.stringify(next));
    store.set({ appearance: next });
    apply();
}

// ─── Pinned sessions (this browser) ──────────────────────────────────────────────

export const isPinned = (id) => store.state.pinned.includes(id);

export function togglePin(id) {
    const pinned = isPinned(id)
        ? store.state.pinned.filter((each) => each !== id)
        : [...store.state.pinned, id];

    localStorage.setItem(PINNED, JSON.stringify(pinned));
    store.set({ pinned });
}

// ─── Palettes ───────────────────────────────────────────────────────────────────

/** A Hyprland color (`rgba(33ccffee)`, `rgb(1e1e1e)`, `#hex`) as CSS. */
function hyprColor(value) {
    const match = /^rgba?\(\s*([0-9a-f]{6}(?:[0-9a-f]{2})?)\s*\)$/i.exec(value.trim());

    if (match) {
        return `#${match[1]}`;
    }

    return /^#[0-9a-f]{3,8}$/i.test(value.trim()) ? value.trim() : null;
}

/** A Hyprland border (`rgba(…) rgba(…) 45deg`): its color stops and angle, or null for anything else. */
export function hyprBorder(value) {
    if (typeof value !== "string") {
        return null;
    }

    const angle = /(-?\d+)deg\s*$/.exec(value)?.[1] ?? "45";
    const stops = (value.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi) ?? [])
        .map(hyprColor)
        .filter(Boolean);

    return stops.length === 0 ? null : { stops, angle: Number(angle) };
}

/** The palette a theme id means: a bundled theme, or the desktop's (falling back when there is none). */
export function paletteOf(id = prefs().theme) {
    if (id === "desktop") {
        const desktop = store.state.desktopTheme;

        if (desktop?.colors) {
            return {
                id: "desktop",
                name: THEMES[desktop.name]?.name ?? desktop.name,
                colors: desktop.colors,
                desktop: true,
            };
        }

        return { id: FALLBACK, ...THEMES[FALLBACK] };
    }

    return THEMES[id] ? { id, ...THEMES[id] } : { id: FALLBACK, ...THEMES[FALLBACK] };
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
    const border = hyprBorder(c.hyprland_active_border);
    const stops = border?.stops ?? [accent];
    const inactive = hyprBorder(c.hyprland_inactive_border)?.stops[0];

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
        "--o-active-a": stops[0],
        "--o-active-b": stops[stops.length - 1],
        "--o-active":
            stops.length > 1
                ? `linear-gradient(${border.angle}deg, ${stops.join(", ")})`
                : `linear-gradient(${stops[0]}, ${stops[0]})`,
        // Only when the theme names one: otherwise style.css's default for dark or light themes.
        "--o-inactive": inactive ?? null,
    };
}

/** Variables as an inline style, leaving out the ones a theme does not set. */
export const varsStyle = (vars) =>
    Object.entries(vars)
        .filter(([, value]) => value !== null)
        .map(([name, value]) => `${name}:${value}`)
        .join(";");

function setVars(root, vars) {
    for (const [name, value] of Object.entries(vars)) {
        if (value === null) {
            root.style.removeProperty(name);
        } else {
            root.style.setProperty(name, value);
        }
    }
}

export const modeOf = (palette) => (palette.colors.mode === "light" ? "light" : "dark");

const reducedMotion = () => {
    const motion = prefs().motion;

    return motion === "reduced" || (motion === "auto" && reduceQuery.matches);
};

/** Put the current look on the page: variables, mode, and the switches style.css reads from data attributes. */
export function apply() {
    const root = document.documentElement;
    const palette = paletteOf();
    const vars = themeVars(palette);

    setVars(root, vars);
    const p = prefs();
    const desktop = store.state.desktopTheme;
    const wallpaper =
        p.theme === "desktop" && p.wallpaper && p.tiling && desktop?.wallpaper
            ? `url("/api/theme/wallpaper?v=${encodeURIComponent(desktop.stamp)}")`
            : "none";

    root.style.setProperty("--wallpaper", wallpaper);
    root.style.setProperty("--text-size", `${p.text}px`);
    root.style.setProperty("--sidebar-w", `${p.sidebarWidth}px`);
    const attrs = {
        mode: modeOf(palette),
        tiling: p.tiling ? "on" : "off",
        motion: reducedMotion() ? "reduced" : "full",
        rail: p.sidebar === "rail" ? "on" : "off",
    };

    Object.assign(root.dataset, attrs);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", vars["--o-bg"]);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", attrs.mode);
    const cached = Object.fromEntries(Object.entries(vars).filter(([, value]) => value !== null));

    localStorage.setItem(
        CACHE,
        JSON.stringify({
            vars: {
                ...cached,
                "--wallpaper": wallpaper,
                "--text-size": `${p.text}px`,
                "--sidebar-w": `${p.sidebarWidth}px`,
            },
            attrs,
        }),
    );
}

/**
 * Change the look with a circle that grows from `at` (a click's place) over the old one, as a view transition. Without
 * view transitions, or with reduced motion, it changes at once.
 */
let transitions = 0;

export function transition(change, at) {
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
        change();
        // The store renders in a microtask; let it finish before the new look is captured.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    run.finished.finally(() => mine === transitions && root.classList.remove("theme-vt"));
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
    const root = document.documentElement;
    const palette = id === null ? paletteOf() : paletteOf(id);

    setVars(root, themeVars(palette));
    root.dataset.mode = modeOf(palette);
}

// ─── Follow desktop ─────────────────────────────────────────────────────────────

let checking = false;
let started = false;

/** Ask the server for the desktop's theme; animate to it when it changed since the last look. */
export async function checkDesktop({ animate = true } = {}) {
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
