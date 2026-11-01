// The static scan wins where it is sure; the rendered values fill what it could not find.
import { parseColor, toHex } from "./color.ts";
import type { PocketHost } from "../host.ts";
import type { DesignBundle } from "./bundle.ts";
import { VIEWPORTS, withRender, type DesignPage } from "./render.ts";
import { type Decl, type Scope } from "./scan-parse.ts";
import type { Facts } from "./scan-facts.ts";
import { type DarkToggle, planRender, type RenderPlan } from "./scan-render-pages.ts";
import { PROBE_SOURCE, type ProbeInput, type Reading, type Weights } from "./scan-render-probe.ts";

interface PageEvidence {
    page: string;
    light: Reading;
    dark?: Reading;
    how?: string;
}

export interface RenderedEvidence {
    pages: PageEvidence[];
    notes: string[];
}

const BUDGET_MS = 40_000;

const OFFLINE = {
    fetchPublic: async () => {
        throw new Error("The scan shows pages offline.");
    },
} as unknown as PocketHost;

// The sandbox denies storage, and a page that reads its theme from it must not fail on that.
const STORAGE_SHIM = `(() => {
    const make = () => {
        const data = new Map();
        return {
            getItem: (key) => (data.has(String(key)) ? data.get(String(key)) : null),
            setItem: (key, value) => { data.set(String(key), String(value)); },
            removeItem: (key) => { data.delete(String(key)); },
            clear: () => data.clear(),
            key: (index) => [...data.keys()][index] ?? null,
            get length() { return data.size; },
        };
    };
    for (const name of ['localStorage', 'sessionStorage']) {
        try { Object.defineProperty(window, name, { value: make(), configurable: true }); } catch {}
    }
})();`;

const SETTLE_STYLE = `(() => {
    const style = document.createElement('style');
    style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:auto!important}';
    document.head.append(style);
})()`;

function differs(a: Reading, b: Reading): boolean {
    if (a.page.bg !== b.page.bg || a.page.text !== b.page.text) {
        return true;
    }

    const changed = Object.entries(a.vars).filter(
        ([name, value]) => b.vars[name] !== undefined && b.vars[name] !== value,
    );

    return changed.length >= 2;
}

async function apply(page: DesignPage, toggle: DarkToggle): Promise<() => Promise<void>> {
    const spec = JSON.stringify(toggle);

    await page.evaluate(`((toggle) => {
        for (const el of [document.documentElement, document.body]) {
            if ('class' in toggle) { if (!el.classList.contains(toggle.class)) { el.classList.add(toggle.class); el.setAttribute('data-pi-scan-' + toggle.class, ''); } }
            else if (!el.hasAttribute(toggle.attr)) { el.setAttribute(toggle.attr, toggle.value); el.setAttribute('data-pi-scan-' + toggle.attr, ''); }
        }
    })(${spec})`);

    return async () => {
        await page.evaluate(`((toggle) => {
            for (const el of [document.documentElement, document.body]) {
                const mark = 'data-pi-scan-' + ('class' in toggle ? toggle.class : toggle.attr);
                if (el.hasAttribute(mark)) {
                    el.removeAttribute(mark);
                    if ('class' in toggle) el.classList.remove(toggle.class); else el.removeAttribute(toggle.attr);
                }
            }
        })(${spec})`);
    };
}

async function read(page: DesignPage, input: ProbeInput): Promise<Reading> {
    return (await page.evaluateIsolated(
        `(${PROBE_SOURCE})(${JSON.stringify(input)})`,
    )) as unknown as Reading;
}

async function renderEvidence(plan: RenderPlan, signal?: AbortSignal): Promise<RenderedEvidence> {
    signal?.throwIfAborted();

    const bundle = {
        meta: {},
        version: 1,
        content: "<!doctype html><title>scan</title>",
        assets: plan.assets,
    } as unknown as DesignBundle;
    const stop = new AbortController();
    const timer = setTimeout(
        () => stop.abort(new Error("The rendered scan took too long.")),
        BUDGET_MS,
    );

    signal?.addEventListener("abort", () => stop.abort(signal.reason), { once: true });

    try {
        return await withRender(bundle, OFFLINE, stop.signal, async (page) => {
            const out: RenderedEvidence = { pages: [], notes: [] };

            await page.send("Page.addScriptToEvaluateOnNewDocument", { source: STORAGE_SHIM });

            for (const rel of plan.pages) {
                try {
                    out.pages.push(await readPage(page, rel, plan));
                } catch (error) {
                    out.notes.push(
                        `${rel}: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`,
                    );

                    if (stop.signal.aborted) {
                        break;
                    }
                }
            }

            return out;
        });
    } finally {
        clearTimeout(timer);
    }
}

async function readPage(page: DesignPage, rel: string, plan: RenderPlan): Promise<PageEvidence> {
    const input: ProbeInput = { vars: plan.vars, bare: true };

    const loadAs = async (colorScheme: "light" | "dark") => {
        await page.applyView({ colorScheme });
        await page.load(VIEWPORTS.desktop, { page: rel });
        await page.evaluate(SETTLE_STYLE);

        return read(page, input);
    };

    const light = await loadAs("light");
    const evidence: PageEvidence = { page: rel, light };

    if (light.count < 3) {
        return evidence;
    }

    // A new load, so that a script that reads the preference at start sees it.
    const media = await loadAs("dark");

    if (differs(light, media)) {
        return { ...evidence, dark: media, how: "prefers-color-scheme" };
    }

    await page.applyView({ colorScheme: "light" });

    for (const toggle of plan.toggles) {
        const undo = await apply(page, toggle);

        await page.settle();

        const reading = await read(page, input);

        await undo();

        if (differs(light, reading)) {
            return {
                ...evidence,
                dark: reading,
                how: "class" in toggle ? `.${toggle.class}` : `[${toggle.attr}=${toggle.value}]`,
            };
        }
    }

    return evidence;
}

const decl = (selector: string, prop: string, value: string, scope: Scope): Decl => ({
    prop,
    value,
    selector,
    at: [],
    scope,
    theme: false,
    inline: false,
});

function hexOf(css: string): string | undefined {
    const color = parseColor(css);

    return color === undefined ? undefined : toHex(color);
}

const copies = (weight: number, scale: number) =>
    Math.max(1, Math.min(8, 1 + Math.floor(Math.log2(1 + weight / scale))));

const BG_SELECTOR: Record<string, string> = {
    card: ".card",
    button: ".btn",
    input: ".input",
    alert: ".alert",
    badge: ".badge",
    nav: ".navbar",
    footer: "footer",
    table: "table",
    code: "pre",
    block: ".section",
};

const TEXT_SELECTOR: Record<string, string> = {
    body: "p",
    heading: "h2",
    muted: ".text-muted",
    link: "a",
    button: ".btn",
    code: "code",
};

interface Known {
    colors: string[];
    vars: Set<string>;
    fonts: boolean;
    sizes: boolean;
    space: boolean;
    radii: boolean;
    shadows: boolean;
}

function isKnown(hex: string, known: Known): boolean {
    const channels = (text: string) =>
        [1, 3, 5].map((at) => Number.parseInt(text.slice(at, at + 2), 16));
    const mine = channels(hex);

    return known.colors.some((other) => {
        const theirs = channels(other);

        return mine.every((value, at) => Math.abs(value - theirs[at]!) <= 3);
    });
}

const STATUS_PART = {
    bg: { selector: ".alert-", prop: "background-color", scale: 60 },
    text: { selector: ".text-", prop: "color", scale: 3 },
    border: { selector: ".border-", prop: "border-color", scale: 3 },
};

// Only values that differ from `against` are written for dark.
function declsOf(reading: Reading, scope: Scope, known: Known, against?: Reading): Decl[] {
    const out: Decl[] = [];
    const dark = scope === "dark";

    const fresh = (css: string) => {
        const hex = hexOf(css);

        return hex !== undefined && !isKnown(hex, known) ? hex : undefined;
    };

    const repeat = (
        weights: Weights,
        selector: string,
        prop: string,
        scale: number,
        valueOf: (key: string) => string | undefined,
    ) => {
        for (const [key, weight] of Object.entries(weights)) {
            const value = valueOf(key);

            if (value === undefined) {
                continue;
            }

            for (let at = 0; at < copies(weight, scale); at++) {
                out.push(decl(selector, prop, value, scope));
            }
        }
    };

    // A color the files hold is already counted by them; a new one is the page's own.
    const colors = (
        weights: Weights,
        before: Weights | undefined,
        selector: string,
        prop: string,
        scale: number,
    ) =>
        repeat(weights, selector, prop, scale, (css) =>
            dark && before !== undefined && css in before ? undefined : fresh(css),
        );

    for (const [name, value] of Object.entries(reading.vars)) {
        if (
            !/^--tw-/.test(name) &&
            !known.vars.has(name) &&
            (!dark || against?.vars[name] !== value)
        ) {
            out.push(decl(":root", name, value, scope));
        }
    }

    // The page's own colors are always said: they tell the page and the text from the rest.
    for (const [key, prop, authored] of [
        ["bg", "background-color", reading.page.bgAuthored],
        ["text", "color", reading.page.textAuthored],
    ] as const) {
        const hex = hexOf(reading.page[key]);
        const said = dark ? against === undefined || hexOf(against.page[key]) !== hex : authored;

        if (hex !== undefined && said) {
            out.push(decl("body", prop, hex, scope));
        }
    }

    for (const [kind, weights] of Object.entries(reading.bg)) {
        if (kind !== "page") {
            const selector = BG_SELECTOR[kind] ?? ".element";

            colors(weights, against?.bg[kind], selector, "background-color", 40);
        }
    }

    for (const [kind, weights] of Object.entries(reading.text)) {
        colors(weights, against?.text[kind], TEXT_SELECTOR[kind] ?? "p", "color", 30);
    }

    colors(reading.border, against?.border, ".card", "border-color", 2);

    for (const [status, groups] of Object.entries(reading.status)) {
        for (const [part, weights] of Object.entries(groups)) {
            const { selector, prop, scale } = STATUS_PART[part as keyof typeof STATUS_PART];
            const before = against?.status[status]?.[part as "bg"];

            colors(weights, before, selector + status, prop, scale);
        }
    }

    const primary =
        reading.buttons.find((button) => button.primary && hexOf(button.bg) !== undefined) ??
        reading.buttons[0];

    for (const button of reading.buttons) {
        const bg = fresh(button.bg);
        const color = fresh(button.color);
        const selector = button === primary ? ".btn-primary" : ".btn";

        if (bg !== undefined) {
            out.push(decl(selector, "background-color", bg, scope));

            if (color !== undefined) {
                out.push(decl(selector, "color", color, scope));
            }
        }
    }

    if (dark) {
        return out;
    }

    if (!known.fonts) {
        for (const [kind, weights] of Object.entries(reading.font)) {
            const selector = kind === "heading" ? "h1" : kind === "code" ? "code" : "body";

            repeat(weights, selector, "font-family", 40, String);
        }
    }

    if (!known.sizes) {
        for (const [kind, weights] of Object.entries(reading.size)) {
            repeat(weights, kind === "heading" ? "h2" : "p", "font-size", 40, String);
        }
    }

    if (!known.radii) {
        repeat(reading.radius, ".card", "border-radius", 2, String);
    }

    if (!known.shadows) {
        repeat(reading.shadow, ".card", "box-shadow", 2, String);
    }

    if (!known.space) {
        repeat(reading.space, ".element", "padding", 2, (size) => `${size}px`);
    }

    return out;
}

export function renderedDecls(
    evidence: RenderedEvidence,
    known: Known,
): { file: string; decls: Decl[] }[] {
    return evidence.pages.map((each) => ({
        file: `[rendered] ${each.page}`,
        decls: [
            ...declsOf(each.light, "default", known),
            ...(each.dark === undefined ? [] : declsOf(each.dark, "dark", known, each.light)),
        ],
    }));
}

export async function renderProject(
    root: string,
    signal?: AbortSignal,
): Promise<RenderedEvidence | undefined> {
    const plan = planRender(root);

    if (plan === undefined) {
        return undefined;
    }

    try {
        const evidence = await renderEvidence(plan, signal);

        return evidence.pages.length === 0 ? undefined : evidence;
    } catch {
        // No browser, a render that stopped, a page that crashed it: the static scan stands alone.
        return undefined;
    }
}

export type Have = Pick<Known, "fonts" | "sizes" | "space" | "radii" | "shadows">;

export function knownOf(facts: Facts, have: Have): Known {
    const hexes = [...facts.colors.keys(), ...facts.darkColors.keys()];
    const colors = new Set(hexes.map((hex) => hex.slice(0, 7)));

    for (const variable of facts.vars) {
        const color = parseColor(variable.value);

        if (color !== undefined) {
            colors.add(toHex({ ...color, a: 1 }));
        }
    }

    return {
        colors: [...colors],
        vars: new Set(facts.vars.map((variable) => `--${variable.name}`)),
        ...have,
    };
}
