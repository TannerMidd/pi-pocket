# Design systems in Design mode (hill climb)

Status: in progress, on `feat/design-system` (off 0.27.0-beta.1). This page is the plan, the contracts between the streams, and the rubric that scores each round. Streams write what they built, and what differs from this page, in `docs/design/ds-notes-<stream>.md`.

## Goal

Make Pi Pocket the best place to **build, keep, and use a design system** with an agent, and prove it with a flagship system (Pi Pocket's own) made with the tools. Today the "design system" is one 16 KB Markdown note in the prompt (`.pi/design-system.md`): nothing compiles it, nothing shares it between designs, nothing checks that designs follow it, and people cannot see or edit it. The end result must be **professional to use**: on par with Figma variables + Tokens Studio + Storybook + zeroheight, for the parts that it covers.

## What "done" looks like (the user stories)

1. "Scan my project and make a design system." Pi runs a scan, gets a **structured** draft (palette, semantic roles, type scale, spacing, radii, shadows, motion, light and dark), names the roles, and saves a valid token set in one or two calls.
2. A person opens **Design → System** and sees the system: color roles as swatches with contrast badges, the type scale as specimens, spacing, radii, shadows, motion, in light and dark. They change a token in place (a color picker, a number) and every open design updates live; **Save** writes the file with no Pi run.
3. Pi makes a design that **links the system** (`ds/tokens.css`). The design uses only system values. `design_preview` reports any value that is not a token, with the nearest token to use, and any contrast, tap-size, or overflow problem.
4. A person opens a design and taps **Check**: findings show as pins on the canvas, each with a fix suggestion and a **Send to Pi** button.
5. Components: the system holds component specimens (button, input, card, …) with their states (default, hover, focus, disabled, error). The System view shows them as a state grid; Pi reuses their markup.
6. **Publish** the system as a documentation page (an artifact: shareable with a link, exportable), and **export** it for code: CSS variables, a Tailwind v4 `@theme` file, and resolved JSON.
7. Old projects with only `.pi/design-system.md` keep working.

## Files on disk (in the session's folder)

```
.pi/design/
  tokens.json            DTCG token file: the default mode (light). Primitives, semantic roles, component tokens.
  tokens.<mode>.json     Overrides for one mode (dark, high-contrast, a brand), same paths, only what changes.
  components/<slug>.html One component specimen per file (format below).
  guidelines.md          Prose: voice, layout rules, do and don't. Bounded (16 KB).
  dist/                  Generated. Never edit by hand.
    tokens.css           :root (default) + [data-theme="<mode>"] + @media (prefers-color-scheme: dark) when a dark mode exists.
    tailwind.css         Tailwind v4 @theme block: one variable for each token, in the Tailwind namespace of its kind
                         (--spacing-4, --text-sm, --leading-tight, --tracking-wide); a color role drops the word that the
                         utility repeats (color.bg.surface is --color-surface, so bg-surface), and a role that is only default,
                         primary, or base takes its group's word (color.border.default is --color-border, color.text.primary is --color-text). A token that fits no namespace
                         keeps its own name. A dark: variant for [data-theme] and the system's dark setting.
    tokens.<mode>.resolved.json
                         The main JSON output. DTCG, one file for each mode, with one $value for each token and every
                         reference followed (Style Dictionary reads it). String forms by default; see "format" below.
    tokens.studio.json   For Tokens Studio: one file with a token set for each mode and a $themes array that turns one on.
    names.md             Every token with its variable in tokens.css and in tailwind.css, and its Tailwind utilities; the rules for how
                         the names come out. Generated: look a class up here (bg-surface is color.bg.surface).
    tokens.resolved.json A compact summary for scripts, secondary to the DTCG files: one line for each token.
    components.css       The CSS of every component specimen, scoped by class.
.pi/design-system.md     The 0.26 format. Still read when .pi/design/ is absent.
```

### Token format

- **W3C Design Tokens (DTCG)**: groups are objects, a token has `$value` and `$type` (inherited from a group), optional `$description`, `$deprecated`, `$extensions`. References are `{group.token}`. Accept both the 2025.10 object forms (color `{ colorSpace, components, alpha?, hex? }`, dimension `{ value, unit }`) and the older string forms (`"#7aa2f7"`, `"16px"`).
- Types: color, dimension, fontFamily, fontWeight, duration, cubicBezier, number, shadow, typography, border, transition, gradient, strokeStyle.
- **Tiers**, by top-level group or `$extensions["com.pi-pocket"].tier`: `primitive` (raw palette and scales), `semantic` (roles: `color.bg.surface`, `color.text.primary`, `color.accent.default`, `space.4`, `font.body`…), `component` (`button.primary.bg`). Semantic tokens should reference primitives.
- **Modes**: the default mode is `tokens.json`; `tokens.<mode>.json` holds overrides. Mode names: lowercase slug.
- **Contrast pairs** (optional): `$extensions["com.pi-pocket"].contrast: { on: "{color.bg.surface}", min: 4.5 }` on a text color: the validator checks it in every mode. A list of pairs is allowed. `exempt: "disabled" | "decorative"` leaves a pair out of the warnings (WCAG exempts both): a failing exempt pair is a note (`notes` of the system), not a warning.
- **Names**: a token named for its own value (`space.16` = 16px, `duration.140` = 140ms) gets a warning, with a fix: name it for a role (`space.card`) or a step of a scale (`space.4`).
- **DTCG draft of the output** (optional): `$extensions["com.pi-pocket"].format` on the root of `tokens.json`. `"2021"` (the default) writes the string forms of the 2021 to 2024 drafts in `tokens.<mode>.resolved.json`: `"#7aa2f7"`, `"16px"`, `"150ms"`. `"2025.10"` writes the object forms: a color is `{ colorSpace, components, alpha, hex }` (sRGB, or the space the token was written in), and a dimension or duration is `{ value, unit }` (2025.10 has px and rem for a dimension and ms and s for a duration; another unit stays text). A file has one form throughout, whatever form the tokens were written in. `tokens.studio.json` is always in the string forms.
- **Tailwind names**: `tailwind.css` puts a token in the namespace of its kind: `--color-*`, `--font-*` (families), `--text-*`, `--font-weight-*`, `--tracking-*`, `--leading-*`, `--breakpoint-*`, `--container-*`, `--spacing-*`, `--radius-*`, `--shadow-*`, `--inset-shadow-*`, `--drop-shadow-*`, `--blur-*`, `--perspective-*`, `--aspect-*`, `--ease-*`. A token whose own name would be read as a namespace of another kind (`--font-leading-tight`) gets `--ds-` in front. A color role drops the word that the utility repeats (`color.bg.surface` is `bg-surface`); one that is only `default`, `primary`, `secondary`, `tertiary`, `base`, `main`, `normal`, `regular`, or `standard` takes the word of its group (`color.border.default` is `--color-border`, `color.text.primary` is `--color-text`), and the second of one name keeps its full name (`--color-text-secondary`). `tokens.css` keeps the full names. `dist/names.md` lists them all.
- **Tailwind reset** (optional): `$extensions["com.pi-pocket"].tailwindReset: ["color"]` on the root of `tokens.json` puts `--color-*: initial;` in `tailwind.css`, so Tailwind's default palette does not leak into utilities. `true` is `["color"]`; the other names are `font`, `text`, `font-weight`, `spacing`, `radius`, `shadow`, `ease`, `breakpoint`, and `all`.
- A primitive, or a step of a scale (`space.4`), that refers to another primitive (`{dim.16}`) is written in `tokens.css` as the value (`--space-4: 16px`), so that DevTools shows `16px`. A role or component token keeps `var()`.
- CSS variable name: the path joined by `-`, with `--` in front (`color.bg.surface` → `--color-bg-surface`). A reference compiles to `var(--…)`, so a mode override of a primitive flows through.

### Component specimen format

```html
<script type="application/json" id="pocket-component">
    {
        "name": "Button",
        "description": "…",
        "states": ["default", "hover", "focus", "disabled"],
        "usage": { "do": ["…"], "dont": ["…"] },
        "tokens": ["button.primary.bg", "…"]
    }
</script>
<style>
    /* the component's CSS: uses only var(--…) tokens; scoped to its class */
</style>
<template data-state="default">…markup…</template>
<template data-state="hover">…markup, with a state class such as .is-hover…</template>
```

## Contracts between the streams

All shared types live in **`src/server/design/system-types.ts`** (written in round 0, owned by T; others import it and must not change it without a note). The functions:

- **T** `src/server/design/tokens.ts`
    - `loadDesignSystem(cwd: string): DesignSystem | undefined` (bounded, symlink-safe reads; `undefined` when `.pi/design/` is absent).
    - `compileDesignSystem(system): CompiledFiles` and `writeDesignSystem(cwd, change): DesignSystem` (validate, write atomically, recompile `dist/`).
    - `systemSummary(system, maxBytes): string` (compact text for the prompt: token names by role with values, modes, components, rules).
- **V** `src/server/design/lint.ts`
    - `checkDesign(bundle, system | undefined, options, host, signal): Promise<CheckReport>` (renders in the private Chromium and walks the DOM).
- **G** `src/server/design/docsite.ts`
    - `renderSystemDoc(system): { html: string; assets: { name: string; content: string }[] }` (the documentation page).
- **U** uses all three through routes in `src/server/extensions/design.ts`.

Until a stream's real function lands, the others use a small local stub with the same signature, and say so in their notes.

## Streams

| Stream                        | Branch      | Worktree         | Owns (plus new tests and its notes file)                                                                                                                |
| ----------------------------- | ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T: tokens engine              | `ds/tokens` | `pi-pocket-ds-t` | `system-types.ts`, new `tokens.ts`, `system.ts`, `scan.ts`, the `design_system` tool, and the `ds/` auto-attach in `src/server/extensions/artifacts.ts` |
| V: verify and export          | `ds/verify` | `pi-pocket-ds-v` | new `lint.ts`, `render.ts`, `export.ts`, `pptx.ts`, `index.ts` (`design_preview`, `design_export`, export route)                                        |
| U: System view                | `ds/ui`     | `pi-pocket-ds-u` | `src/server/extensions/design.ts`, everything in `src/server/extensions/design/`                                                                        |
| G: guide, docs page, flagship | `ds/guide`  | `pi-pocket-ds-g` | `guide.ts`, new `docsite.ts`, `docs/examples/design-system/` (the flagship), `test/fixtures/design-system/flagship/`                                    |
| B: bench                      | `ds/bench`  | `pi-pocket-ds-b` | `test/design-system-bench/` (fixtures, expected values, runner), `test/design-system-bench.test.ts`                                                     |

Worktrees are in `/mnt/games/Development/`. Rules: the house rules in `AGENTS.md`; the stream rules of `docs/design/design-mode.md` (own files only, no new npm dependencies, erasable TypeScript, document kinds unchanged except new ones at the end, `npm run format`, `npm run check`, `npm run lint`, `npm test`); **never edit `/mnt/games/Development/pi-pocket`** (the live server); never restart the live server; never push. Commit on your branch. Throwaway copies: `node test/serve.ts <port> 127.0.0.<n>` with T 8911/.11, V 8912/.12, U 8913/.13, G 8914/.14, B 8915/.15. The `browser` tool is one Chromium that people watch and other streams share: navigate, check, leave.

## The scan (T)

Today: hex only, 60 variables in walk order, one flat list, first value of a variable only, `.ts` theme files and dot folders skipped. Needed:

- All color syntaxes (hex 3/4/6/8, rgb/rgba, hsl/hsla, oklch/oklab, lab/lch, named only when used as a value). Normalize for counting.
- Variables grouped by the selector or file that sets them; `.dark`, `[data-theme=…]`, and `@media (prefers-color-scheme: dark)` values become a **dark mode**.
- Tailwind v4 `@theme`, Tailwind v3 `theme.extend` (static parse, no execution), SCSS/Less variables, token files (DTCG, Style Dictionary, and Tokens Studio: every token set, the modes from `$themes`, references across sets, math such as `{spacing.base} * 2`, color modifiers; one file or a folder with `$themes.json` and `$metadata.json`), Style Dictionary sources (token files in several folders, the config's `source` globs in order, classic and DTCG formats, brands and themes as modes, and a config for each mode: `config.dark.json`, a list of configs, a function that returns one for each theme), Material 3 exports (`--md-sys-color-*` in a file or a class for each scheme, and the Theme Builder's JSON: contrast schemes are modes), SCSS palettes made with loops, maps, and color functions (run as Sass runs them, with the module system: `@use … as ns`, `@forward … show/hide/as`, `@use … with`), Panda CSS and Chakra v3 `semanticTokens` with conditions (`base`, `_dark`, `_osDark`), Ant Design `ThemeConfig`, WordPress `theme.json` (palette, gradients, fluid font sizes, font families, spacing sizes and `spacingScale`, shadows, `settings.custom`, and `styles/*.json` variations: a dark one is the dark mode), CSS-in-JS objects in `.ts/.js` theme files (static).
- Figma `.fig` files, decoded offline (no account, token, or network): the variable collections and their modes (the first mode of a collection is the default, a mode named for dark is the dark mode, and each other mode is a mode of its own), the aliases between variables as DTCG references, and the text (typography), effect (shadow), and paint (color) styles. A name nests as a path of safe slugs (`Colors/Brand/Primary` is `color.brand.primary`). The layers, components, and images are not imported, and the report says what it read and what it did not. Bounded: 20 MB a file, 100 MB after decompression, 500 000 nodes, and 20 s for all of its Figma files together; a file that cannot be read is a note in the report, never an error.
- Ranking by use (references count), not by walk order. Values kept to 200 characters.
- Inference of roles (background, surface, text, muted, border, accent, danger, warning, success) from names and use, of the type scale, the spacing scale (a base unit and steps), radii, shadows, durations and easings.
- Output: a **DTCG draft** (`tokens.json` and `tokens.dark.json` contents) plus the human report. Untrusted data stays fenced as today.

## Verification (V)

- `design_preview` gains `checks` (default on), `tweaks` (values to apply), `colorScheme` (`light` | `dark`), `page` (a second HTML page of the bundle), and `actions` (an ordered list of `hover | click | focus` on a selector before the screenshot).
- `CheckReport.findings`: `off-system-color`, `off-system-font`, `off-system-size` (font size, spacing, radius not on a scale), `contrast` (WCAG 2.2 AA: 4.5, 3 for large text and UI parts), `tap-target` (< 24 px; warn < 44 px), `overflow` (horizontal scroll at the viewport), `image-alt`, `heading-order`, `font-fallback` (declared font not loaded), `missing-viewport`, `missing-pid` (warning). Each: level, selector, pid, value, the nearest token (`var(--color-text-muted)`), and a short fix.
- Export fixes from the critique: deck PNG uses the requested slide (or every slide, zipped); export applies tweak values and the custom size; a page's PDF uses the viewport's width; PPTX notes drop `style` and `script` text and images render at 2×.
- Renders queue instead of failing the third.

## The System view (U)

- The design picker gets a pinned **Design system** item. Opening it shows the System view with sections: **Colors** (roles grouped, swatches, hex/oklch, the alias chain, contrast badges against their pair, light/dark side by side), **Type** (specimens of the scale), **Spacing, Radii, Shadows, Motion** (visual specimens), **Components** (state grid, each specimen in the sandboxed frame), **Guidelines** (rendered Markdown).
- **Edit in place** for people who can steer: color picker and text field, number fields with units, an alias picker. Changes preview live on the open design (CSS variables through `pocket-tweak-set`) and on the specimens; **Save** writes through T's `writeDesignSystem` (a route with steer access, validated, atomic) and shows the result; **Discard** reverts. Undo and redo for unsaved changes.
- **Check** on any design: runs V's `checkDesign`, lists findings, shows them as pins (`pocket-highlight`), and **Send to Pi** puts one message with all findings in the message box.
- **Publish docs** makes the documentation artifact (G's `renderSystemDoc`) and **Export for code** downloads `dist/` as a zip.
- Phone first: one column, sticky section tabs, 44 px targets. Viewers see everything read-only.
- Also fix from the critique: open the phone frame on a phone; a focus mode that hides the chat.

## Guide, docs page, flagship (G)

- **Guide** (`guide.ts`): a page skeleton (viewport meta, `<link rel="stylesheet" href="ds/tokens.css">` when a system exists, `data-pid`s, a tweaks manifest bound to tokens, a `pocket:tweak` listener example), craft rules (type scale, 4/8 spacing, contrast, states for every interactive element, focus rings, responsive breakpoints, real copy, no lorem ipsum), how to use the system (only `var(--…)`, components' markup), how to verify (preview with checks, fix every error), and the preview's limits. When a system exists: T's `systemSummary` instead of the whole file. Keep the stable part first for the prompt cache.
- **Docs page** (`docsite.ts`): a self-contained documentation page for a system, at the level of a professional design-system site (zeroheight, Storybook docs, Radix colors pages): navigation, overview, color roles with contrast tables, type specimens, spacing and radii visuals, shadows, motion demos, component state grids with code snippets, light/dark switch, copy-to-clipboard of token names. Phone and desktop.
- **Flagship**: Pi Pocket's own design system (Tokyo Night, Geist + JetBrains Mono, the radii and spacing in `web/style.css` and `web/themes/pocket/theme.css`), complete: primitives, semantic roles, light and dark, a type scale, spacing, radii, shadows, motion, at least 8 component specimens with states, guidelines. It is the reference example (`docs/examples/design-system/pocket/.pi/design/`) and the bench's main fixture.

## Bench (B)

`node test/design-system-bench/run.ts [--out dir]` prints a JSON score and writes screenshots. It needs no model. It measures:

1. **Scan accuracy**: 4 synthetic fixture projects (plain CSS with `:root` + `.dark`; Tailwind v4 `@theme`; SCSS variables + a `.ts` theme object; a messy real-world page with inline styles and many near-duplicate colors), each with a hand-labelled `expected.json` (roles, scales, modes). Precision and recall of colors, roles, type scale, spacing scale, radii, dark mode.
2. **Format**: the flagship and each fixture's saved system load, validate with no error, round-trip (load → write → load is equal), and compile; the CSS parses in Chromium and every variable resolves in every mode.
3. **Lint**: 6 seeded designs with known violations (`expected-findings.json`): precision and recall per rule, and zero findings on 2 clean designs that use the flagship correctly.
4. **Contrast**: the share of declared contrast pairs that pass in every mode of the flagship.
5. **Rendering**: screenshots of the docs page and the System view (mobile 390×844 and desktop 1440×900, light and dark) for the judges.

## Rubric (each round)

A panel of two independent judges (different models) scores 0–10 per line with evidence; a line's score is the lower of the two. Target: **every line ≥ 9**. The bench's numbers feed lines 2, 3, 4.

1. **Token model**: DTCG compliance, tiers, aliases, modes, coverage (color, type, space, radius, shadow, motion, breakpoints, z-index), validation messages.
2. **Import (scan)**: bench precision/recall ≥ 0.9 on colors and roles, ≥ 0.85 on scales; a draft that needs little editing.
3. **Enforcement**: lint precision ≥ 0.95, recall ≥ 0.9, zero false findings on clean designs; fixes name the right token.
4. **Accessibility**: contrast pairs pass in every mode; checks cover contrast, targets, focus, alt, headings.
5. **Agent experience**: tool schemas and messages are clear; the guide makes Pi produce on-system, polished designs in few calls (judged from tool transcripts and outputs).
6. **People experience**: the System view is beautiful, fast, clear, and fully usable on a phone; editing a token is direct and safe; undo works.
7. **Documentation output**: the docs page looks like a professional design-system site, in light and dark, on phone and desktop.
8. **Code handoff**: the CSS, Tailwind, and JSON outputs are correct, readable, and drop-in.
9. **Engineering**: tests, safety (untrusted data, bounds, symlinks), house style, `npm run check`, `npm run lint`, `npm test` green, docs (`docs/features.md`) updated.

## Process

Round 0: this page, `system-types.ts`, worktrees. Round 1: the five streams build in parallel. Then the integrator merges into `feat/design-system`, runs the bench, and asks the judges. Each next round takes the lowest-scoring lines and fixes them, smallest change first, and keeps a change only when the score goes up (or a line rises and none falls). Stop when every line is at 9 or more, or two rounds bring no rise. The integrator records each round's scores in `docs/design/ds-rounds.md`.
