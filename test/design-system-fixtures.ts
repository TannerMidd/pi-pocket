// It has a few things on purpose: a text color that fails its contrast pair, a color in the object form with an alpha, aliases two steps deep, a typography token that refers to other tokens, and a token that is only in the default mode.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ext = (extra: Record<string, unknown>) => ({ "com.pi-pocket": extra });
const on = (name: string, min = 4.5) => ({ contrast: { on: `{${name}}`, min } });
const px = (value: number) => ({ value, unit: "px" });
const ms = (value: number) => ({ value, unit: "ms" });
const black = (alpha: number) => ({ colorSpace: "srgb", components: [0, 0, 0], alpha });

const ramp = (steps: Record<string, string>) =>
    Object.fromEntries(Object.entries(steps).map(([step, $value]) => [step, { $value }]));

export const TOKENS = {
    $extensions: ext({
        name: "Harbor",
        description: "The design system of a small harbor-town ferry app.",
    }),
    color: {
        $type: "color",
        white: { $value: "#ffffff" },
        black: { $value: "#0b0d12" },
        gray: ramp({
            "50": "#f6f7fb",
            "100": "#eceef4",
            "200": "#dcdfe9",
            "300": "#c3c8d8",
            "400": "#a1a8bf",
            "500": "#7c849f",
            "600": "#5d647d",
            "700": "#454b60",
            "800": "#2d3244",
            "900": "#1c1e26",
            "950": "#12131a",
        }),
        blue: ramp({
            "100": "#dbe6ff",
            "300": "#9cb7fb",
            "400": "#7aa2f7",
            "500": "#5683f0",
            "600": "#3b6cf6",
            "700": "#2c52c9",
            "900": "#1b2f73",
        }),
        red: ramp({ "100": "#fde2e6", "400": "#f7768e", "600": "#d6334f", "800": "#8c1d33" }),
        green: ramp({ "100": "#dff4d0", "400": "#9ece6a", "600": "#3f8f2c", "800": "#1f5a14" }),
        amber: ramp({ "100": "#fdf0cf", "400": "#e0af68", "600": "#a96b00", "800": "#664000" }),
        scrim: {
            "40": { $value: black(0.4) },
            "60": { $value: black(0.6) },
        },
        bg: {
            canvas: { $value: "{color.gray.50}", $description: "The page behind everything." },
            surface: { $value: "{color.white}", $description: "Cards, sheets, and fields." },
            raised: { $value: "{color.white}" },
            sunken: { $value: "{color.gray.100}" },
            overlay: {
                $value: "{color.scrim.40}",
                $description:
                    "The scrim behind a dialog. It links to a primitive in the object form, with an alpha.",
            },
        },
        text: {
            primary: {
                $value: "{color.gray.900}",
                $description: "Body and headings.",
                $extensions: ext(on("color.bg.surface", 7)),
            },
            secondary: {
                $value: "{color.gray.700}",
                $extensions: ext(on("color.bg.surface")),
            },
            muted: { $value: "{color.gray.600}", $extensions: ext(on("color.bg.canvas")) },
            disabled: {
                $value: "{color.gray.500}",
                $description: "Disabled controls only: a quieter pair, 3:1 and not 4.5:1.",
                $extensions: ext(on("color.bg.surface", 3)),
            },
            inverse: { $value: "{color.white}", $extensions: ext(on("color.accent.default")) },
            link: {
                $value: "{color.blue.700}",
                $extensions: ext({
                    contrast: [
                        { on: "{color.bg.surface}", min: 4.5 },
                        { on: "{color.bg.canvas}", min: 4.5 },
                    ],
                }),
            },
            placeholder: {
                $value: "{color.gray.400}",
                $description: "Hint text in a field: it fades on purpose, and its pair is exempt.",
                $extensions: ext({
                    contrast: { on: "{color.bg.surface}", min: 4.5, exempt: "decorative" },
                }),
            },
        },
        accent: {
            default: { $value: "{color.blue.600}", $description: "Buttons, links, and focus." },
            hover: { $value: "{color.blue.700}" },
            subtle: { $value: "{color.blue.100}" },
        },
        border: {
            default: { $value: "{color.gray.200}" },
            strong: { $value: "{color.gray.400}" },
            focus: { $value: "{color.blue.500}" },
        },
        status: {
            danger: { $value: "{color.red.600}" },
            warning: { $value: "{color.amber.600}" },
            success: { $value: "{color.green.600}" },
            "danger-subtle": { $value: "{color.red.100}" },
            "success-subtle": { $value: "{color.green.100}" },
        },
    },
    font: {
        family: {
            $type: "fontFamily",
            sans: { $value: ["Geist", "system-ui", "sans-serif"] },
            mono: { $value: ["JetBrains Mono", "ui-monospace", "monospace"] },
        },
        size: {
            $type: "dimension",
            xs: { $value: px(12) },
            sm: { $value: px(14) },
            base: { $value: px(16) },
            lg: { $value: px(20) },
            xl: { $value: px(24) },
            "2xl": { $value: px(32) },
            "3xl": { $value: px(44) },
        },
        weight: {
            $type: "fontWeight",
            regular: { $value: 400 },
            medium: { $value: 500 },
            semibold: { $value: 600 },
            bold: { $value: 700 },
        },
        lineHeight: {
            $type: "number",
            tight: { $value: 1.15 },
            normal: { $value: 1.5 },
            relaxed: { $value: 1.7 },
        },
    },
    type: {
        $type: "typography",
        display: {
            $value: {
                fontFamily: "{font.family.sans}",
                fontSize: "{font.size.3xl}",
                fontWeight: "{font.weight.bold}",
                lineHeight: "{font.lineHeight.tight}",
            },
        },
        heading: {
            $value: {
                fontFamily: "{font.family.sans}",
                fontSize: "{font.size.xl}",
                fontWeight: "{font.weight.semibold}",
                lineHeight: "{font.lineHeight.tight}",
            },
        },
        body: {
            $value: {
                fontFamily: "{font.family.sans}",
                fontSize: "{font.size.base}",
                fontWeight: "{font.weight.regular}",
                lineHeight: "{font.lineHeight.normal}",
            },
        },
        caption: {
            $value: {
                fontFamily: "{font.family.sans}",
                fontSize: "{font.size.xs}",
                fontWeight: "{font.weight.medium}",
                lineHeight: "{font.lineHeight.normal}",
            },
        },
        code: {
            $value: {
                fontFamily: "{font.family.mono}",
                fontSize: "{font.size.sm}",
                fontWeight: "{font.weight.regular}",
                lineHeight: "{font.lineHeight.relaxed}",
            },
        },
    },
    space: {
        $type: "dimension",
        "1": { $value: px(4) },
        "2": { $value: px(8) },
        "3": { $value: px(12) },
        "4": { $value: px(16) },
        "6": { $value: px(24) },
        "8": { $value: px(32) },
        "12": { $value: px(48) },
        "16": { $value: px(64) },
    },
    radius: {
        $type: "dimension",
        sm: { $value: px(4) },
        md: { $value: px(8) },
        lg: { $value: px(12) },
        xl: { $value: px(20) },
        pill: { $value: px(999) },
    },
    shadow: {
        $type: "shadow",
        sm: {
            $value: {
                color: black(0.12),
                offsetX: px(0),
                offsetY: px(1),
                blur: px(2),
                spread: px(0),
            },
        },
        md: {
            $value: {
                color: black(0.16),
                offsetX: px(0),
                offsetY: px(6),
                blur: px(16),
                spread: px(-4),
            },
        },
        lg: {
            $value: {
                color: "{color.scrim.40}",
                offsetX: px(0),
                offsetY: "{space.4}",
                blur: "{space.12}",
                spread: px(-12),
            },
        },
    },
    motion: {
        duration: {
            $type: "duration",
            fast: { $value: ms(120) },
            normal: { $value: ms(220) },
            slow: { $value: ms(420) },
        },
        easing: {
            $type: "cubicBezier",
            standard: { $value: [0.2, 0, 0, 1] },
            emphasized: { $value: [0.3, 0, 0.1, 1.2] },
            exit: { $value: [0.4, 0, 1, 1] },
        },
    },
    z: {
        $type: "number",
        dropdown: { $value: 100 },
        modal: { $value: 300 },
        toast: { $value: 500 },
    },
    breakpoint: {
        $type: "dimension",
        md: { $value: px(768) },
        lg: { $value: px(1100) },
    },
};

export const DARK = {
    color: {
        bg: {
            canvas: { $value: "{color.gray.950}" },
            surface: { $value: "{color.gray.900}" },
            raised: { $value: "{color.gray.800}" },
            sunken: { $value: "{color.black}" },
            overlay: { $value: "{color.scrim.60}" },
        },
        text: {
            primary: { $value: "{color.gray.50}" },
            secondary: { $value: "{color.gray.300}" },
            muted: { $value: "{color.gray.400}" },
            disabled: { $value: "{color.gray.500}" },
            inverse: { $value: "{color.gray.950}" },
            link: { $value: "{color.blue.400}" },
        },
        accent: {
            default: { $value: "{color.blue.400}" },
            hover: { $value: "{color.blue.300}" },
            subtle: { $value: "{color.blue.900}" },
        },
        border: {
            default: { $value: "{color.gray.800}" },
            strong: { $value: "{color.gray.600}" },
        },
        status: {
            danger: { $value: "{color.red.400}" },
            warning: { $value: "{color.amber.400}" },
            success: { $value: "{color.green.400}" },
            "danger-subtle": { $value: "{color.red.800}" },
            "success-subtle": { $value: "{color.green.800}" },
        },
    },
    shadow: {
        md: {
            $value: {
                color: black(0.5),
                offsetX: px(0),
                offsetY: px(6),
                blur: px(16),
                spread: px(-4),
            },
        },
    },
};

const component = (
    meta: Record<string, unknown>,
    css: string,
    states: Record<string, string>,
) => `<script type="application/json" id="pocket-component">
${JSON.stringify(meta, null, 4)}
</script>
<style>
${css.trim()}
</style>
${Object.entries(states)
    .map(([state, markup]) => `<template data-state="${state}">${markup}</template>`)
    .join("\n")}
`;

const COMPONENTS: Record<string, string> = {
    button: component(
        {
            name: "Button",
            description: "The main action of a screen. One primary button for each view.",
            states: ["default", "hover", "focus", "disabled"],
            usage: {
                do: ["Use a verb: “Book a ticket”.", "Keep one primary button in view."],
                dont: ["Put two primary buttons side by side."],
            },
            tokens: ["color.accent.default", "color.accent.hover", "radius.md", "space.3"],
        },
        `
.btn { font: 600 14px/1 var(--font-family-sans); padding: var(--space-3) var(--space-4); border: 0; border-radius: var(--radius-md); background: var(--color-accent-default); color: var(--color-text-inverse); }
.btn.is-hover { background: var(--color-accent-hover); }
.btn.is-focus { outline: 2px solid var(--color-border-focus); outline-offset: 2px; }
.btn[disabled] { background: var(--color-bg-sunken); color: var(--color-text-disabled); }
`,
        {
            default: '<button class="btn">Book a ticket</button>',
            hover: '<button class="btn is-hover">Book a ticket</button>',
            focus: '<button class="btn is-focus">Book a ticket</button>',
            disabled: '<button class="btn" disabled>Book a ticket</button>',
        },
    ),
    input: component(
        {
            name: "Input",
            description: "A single-line field with a label.",
            states: ["default", "focus", "error"],
            tokens: ["color.border.default", "color.status.danger", "radius.md"],
        },
        `
.field { display: grid; gap: var(--space-1); font: 14px var(--font-family-sans); color: var(--color-text-secondary); }
.field input { font: inherit; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border-default); border-radius: var(--radius-md); background: var(--color-bg-surface); color: var(--color-text-primary); }
.field.is-focus input { border-color: var(--color-border-focus); box-shadow: 0 0 0 3px var(--color-accent-subtle); }
.field.is-error input { border-color: var(--color-status-danger); }
.field small { color: var(--color-status-danger); }
`,
        {
            default: '<label class="field">Passenger<input value="Ada Lovelace"></label>',
            focus: '<label class="field is-focus">Passenger<input value="Ada Lovelace"></label>',
            error: '<label class="field is-error">Passenger<input value=""><small>Add a name.</small></label>',
        },
    ),
    badge: component(
        {
            name: "Badge",
            description: "A short status label.",
            states: ["success", "danger"],
            tokens: ["color.status.success-subtle", "color.status.danger-subtle"],
        },
        `
.badge { display: inline-block; font: 600 12px/1 var(--font-family-sans); padding: var(--space-1) var(--space-2); border-radius: var(--radius-pill); }
.badge.ok { background: var(--color-status-success-subtle); color: var(--color-status-success); }
.badge.bad { background: var(--color-status-danger-subtle); color: var(--color-status-danger); }
`,
        {
            success: '<span class="badge ok">On time</span>',
            danger: '<span class="badge bad">Cancelled</span>',
        },
    ),
};

export const GUIDELINES = `# Harbor

Calm, clear, and quick to read at a dock in the wind.

## Layout

- Use the spacing scale only. Four points is the smallest step.
- One column on a phone. Cards never nest.

## Color

- Text sits on a surface at 4.5:1 or better.
- The accent is for the one thing to tap.

## Don't

- Don't use raw hex values in a design.
- Don't put the accent on body text.
`;

export function writeSystemFixture(cwd: string, { dark = true } = {}): void {
    const root = join(cwd, ".pi", "design");

    mkdirSync(join(root, "components"), { recursive: true });
    writeFileSync(join(root, "tokens.json"), `${JSON.stringify(TOKENS, null, 4)}\n`);

    if (dark) {
        writeFileSync(join(root, "tokens.dark.json"), `${JSON.stringify(DARK, null, 4)}\n`);
    }

    for (const [slug, source] of Object.entries(COMPONENTS)) {
        writeFileSync(join(root, "components", `${slug}.html`), source);
    }

    writeFileSync(join(root, "guidelines.md"), GUIDELINES);
}

// A page that uses the system, with two things the check finds on purpose: a color that is no token, and an image with no alt text.
export const ferryPage = (tokensCss: string, probe = false) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ferry</title>
<style>${tokensCss}</style>
<style>
* { box-sizing: border-box; }
body { margin: 0; padding: var(--space-6); background: var(--color-bg-canvas); color: var(--color-text-primary); font: var(--font-size-base)/1.5 var(--font-family-sans); }
h1 { margin: 0 0 var(--space-2); font-size: var(--font-size-2xl); line-height: 1.15; }
p { margin: 0 0 var(--space-4); color: var(--color-text-muted); }
.card { max-width: 420px; padding: var(--space-6); border-radius: var(--radius-lg); background: var(--color-bg-surface); box-shadow: var(--shadow-md); }
.row { display: flex; gap: var(--space-2); align-items: center; margin-top: var(--space-4); }
.btn { border: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--color-accent-default); color: var(--color-text-inverse); font: 600 14px var(--font-family-sans); }
.ok { padding: var(--space-1) var(--space-2); border-radius: var(--radius-pill); background: var(--color-status-success-subtle); color: var(--color-status-success); font: 600 12px var(--font-family-sans); }
</style></head><body>
<div class="card" data-pid="card">
<h1 data-pid="title">The 9:15 to Harbor Island</h1>
<p data-pid="sub">Boarding opens at 9:00. Bring a ticket and a coat.</p>
<img data-pid="photo" width="40" height="40" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' rx='8' fill='%233b6cf6'/%3E%3Cpath d='M20 7v16M20 9l9 12h-9zM9 26h22l-4 7H13z' fill='%23fff'/%3E%3C/svg%3E">
<p data-pid="note" style="color:#7ba3f8">Off-system blue on purpose.</p>
<div class="row"><button class="btn" data-pid="book">Book a ticket</button><span class="ok" data-pid="status">On time</span></div>
</div>${
    probe
        ? `
<script>
// For the tests: the page says what its button and its background look like, when it loads and when it is told a tweak.
const report = () => parent.postMessage({ type: "ferry-saw", button: getComputedStyle(document.querySelector(".btn")).backgroundColor, page: getComputedStyle(document.body).backgroundColor }, "*");
addEventListener("load", report);
addEventListener("pocket:tweak", () => setTimeout(report, 30));
</script>`
        : ""
}
</body></html>`;
