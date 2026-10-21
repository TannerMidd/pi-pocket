# Theming (design for 0.14.0)

Status: built for 0.14.0 (phases 1 and 2, except what is deferred below); the gallery's theme entries (phase 3) are built separately. [extensions/themes.md](../extensions/themes.md) and [extensions/reference/theme-surface.md](../extensions/reference/theme-surface.md) describe what was built. It differs from this design in these ways:

- The in-house theme's findings added about 50 parts, more states, and tokens for windows, the timeline, a gutter, a second accent, and ligatures; and `colors-light.toml` for a pair of palettes.
- Most corners became tokens with their old values kept (a calc offset where a size sat between steps), and the default look did not change, except muted text, raised to WCAG AA.
- Theme files under their current version are cached as immutable, and the page preloads a theme's own fonts.
- Deferred: the type scale (about 300 font sizes), heading tokens, `extends`, contrast warnings in Appearance, and themes in the gallery (separate work).

The goal, from issue #90, point 3: "A theme should be a folder. Copy the main theme into another folder, customise that copy, and select it in settings. This should allow changes to appearance **and layout** without editing the main theme or maintaining a separate fork of the app."

## What exists now

- **Colors.** `web/themes.js` has 22 Omarchy palettes. **Follow desktop** asks `/api/theme` (`omarchy.ts`) for the desktop's palette every 6 s. `theme.js` turns a palette into 17 `--o-*` variables and sets them **inline** on `<html>`. `style.css` mixes about 45 named tokens (`--bg`, `--text`, `--accent`, …) from them.
- **style.css** has 14,700 lines, about 2,300 rules, and 812 class names. Colors are nearly all tokens (16 literals, mostly masks, QR codes, and page backgrounds). Not tokens yet: about 300 font sizes (14 different sizes), about 95 radii, 23 shadows, and 22 durations.
- **Derived tokens mix the palette, not the named tokens.** `--accent-soft` mixes `--o-accent`, so a theme that sets `--accent` still gets blue soft fills and focus rings.
- **No part names.** The markup has only classes, and classes change often.
- **The CSP already blocks remote loads.** The page sends `default-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`, and `connect-src 'self'`. Remote stylesheets, fonts, and images, and `data:` stylesheets, are blocked on the whole page. Extensions' browser modules already run under this policy, so themes need no new CSP, and extensions lose nothing.
- **First paint** comes from `pocket.themeCache`, applied by an inline script in `index.html`. `pocket.style()` adds an unlayered `<link>`.

**An experiment on a copy** (`node test/serve.ts`) found these results:

1. With `style.css` imported into a cascade layer, the computed styles of all 170 elements on a session screen stayed the same.
2. A theme in a later layer, with low-specificity rules, moved the sidebar to the right, made messages into bubbles, and changed the accent.
3. The app's `!important` reduced-motion rules beat a theme's `!important` rules.
4. An unlayered stylesheet beats every layered rule. A stylesheet imported into the app's layer competes as it does now.
5. With the sidebar on the right, its resize handle stayed at the outer edge, because the JavaScript assumes the left side.

## The decisions

1. **A theme is a folder:** `~/.pi-pocket/themes/<id>/`. The built-in **Pocket** theme is `web/themes/pocket/`, in the same format.
2. **Two choices: Theme and Colors.** The theme sets the look and the layout. Colors is a palette: the 22 Omarchy palettes, Desktop, or a folder's `colors.toml`. A layout must stay when the colors change, because Follow desktop and the launcher's previews change colors often. With one list, a layout would need a copy for each palette.
3. **A folder holds colors, CSS, or both.** `colors.toml` is Omarchy's format, unchanged, so any Omarchy theme folder dropped in shows under Colors. When you choose a theme that has its own colors, Colors changes to them too. You can change it after.
4. **Duplicate gives a starter, not a fork.** If Duplicate copied all of `style.css`, you would have a 14,700-line fork that falls behind at each release. So Pocket's folder holds a manifest and a `theme.css` that lists every token, commented out with its default, plus examples for each part.
5. **Cascade layers: `@layer pocket, palette, theme;`.**
    - `style.css` and extensions' stylesheets go in `pocket`, so they win and lose as they do now.
    - Palette variables go in `palette`, in a `<style>`, not inline. Inline values would beat the theme.
    - The theme goes in `theme`. Its rules win over the app's rules without a fight over specificity.
    - The app's `!important` rules still win. The sizes people choose (text size, dragged widths) stay inline, so they win too.
6. **CSS only, no JavaScript.** The existing CSP blocks remote loads, and the server checks each theme's CSS.
7. **The stable surface** is tokens, `data-part` names, and documented states.
8. **The owner adds themes. Each person chooses in each browser**, as for appearance now.
9. **Live reload swaps the stylesheet without a page reload.** A broken theme keeps its last good version.
10. **Edit with Pi.** A theme card can start a session in the theme's folder.

## The format by example

```
~/.pi-pocket/themes/paper/
    theme.json
    theme.css
    layout.css        (theme.css imports it)
    colors.toml       (optional: its own palette)
    fonts/Inter.woff2
    images/grain.webp
```

`theme.json`:

```json
{
    "themeApi": 1,
    "name": "Paper",
    "description": "Flat cards, your messages as bubbles, a wide message box.",
    "author": "tanner",
    "version": "1.0.0",
    "minPocket": "0.14.0"
}
```

| Field                   | Rule                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `themeApi`              | Required. The version of the surface (1). A newer number is not loaded.              |
| `name`                  | Required, up to 60 characters of plain text                                          |
| `description`, `author` | Optional, up to 200 and 60 characters                                                |
| `version`, `minPocket`  | Optional, semver. `minPocket` is for parts and tokens added in a later minor release |
| `extends` (phase 2)     | Another theme's id. Its CSS loads first. Up to 3 levels, no loops                    |

There is no `mode` field. Light or dark comes from the palette (`mode = "light"` in `colors.toml`), and theme CSS adapts with `[data-mode="light"]`. A folder with only a `colors.toml` needs no `theme.json`.

`theme.css`, a change to colors and type:

```css
@import "layout.css";

@font-face {
    font-family: "Paper Sans";
    src: url("fonts/Inter.woff2") format("woff2");
}

:root {
    --sans: "Paper Sans", ui-sans-serif, system-ui, sans-serif;
    --accent: #c2410c;
    --r-card: 4px;
    --shadow: none;
    --wallpaper: url("images/grain.webp");
}

:root[data-mode="light"] {
    --accent: #9a3412;
}
```

`layout.css`, a change to layout:

```css
/* Your messages as bubbles on the right; other people's stay on the left. */
[data-part="prompt"][data-from="me"] {
    margin-inline-start: auto;
    max-width: 70%;
    background: var(--accent-soft);
}

/* A wider conversation, with a flat message box. */
:root {
    --transcript-width: 880px;
    --composer-width: 880px;
}

[data-part="message-box"] {
    border-radius: 0;
}

/* Phones: no status line. */
@media (max-width: 699px) {
    [data-part="status-line"] {
        display: none;
    }
}
```

**Files.** `theme.css` is the entry, and it can `@import` other `.css` files in the folder. `theme.json` (needed when there is CSS) and `colors.toml` are up to 8 KB each. Fonts are `.woff2` only. Images are `.png`, `.jpg`, `.webp`, `.avif`, `.gif`, or `.svg`. Other files (such as an Omarchy folder's `neovim.lua`) are ignored. Hidden files, links, and `node_modules` are never served.

**Limits.** All CSS together: 256 KB. Any other file: 4 MB. A folder: 16 MB, 200 files, 4 levels deep. The id is the folder name: 2 to 48 lowercase letters, digits, and `-`. `pocket`, `desktop`, and the palette names are reserved.

## The stable surface

### Tokens

| Group                         | Tokens                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Palette (set by Colors)       | `--o-bg`, `--o-bg-dark`, `--o-bg-darker`, `--o-bg-light`, `--o-fg`, `--o-fg-dim`, `--o-fg-light`, `--o-fg-bright`, `--o-accent`, `--o-selection`, `--o-red`, `--o-yellow`, `--o-orange`, `--o-green`, `--o-cyan`, `--o-blue`, `--o-magenta` |
| Surfaces                      | `--desk`, `--bg`, `--panel`, `--card`, `--card-2`, `--raised`, `--hover`, `--pressed`, `--scrim`, `--code-bg`                                                                                                                               |
| Lines                         | `--line`, `--line-strong`, `--edge`, `--hair`, `--hair-2`                                                                                                                                                                                   |
| Text                          | `--text`, `--body`, `--muted`, `--faint`                                                                                                                                                                                                    |
| Accent and status             | `--accent`, `--accent-ink`, `--accent-fill`, `--accent-soft`, `--accent-line`, `--spark`, `--brand`, `--ok`, `--ok-soft`, `--warn`, `--warn-soft`, `--warn-line`, `--err`, `--err-soft`, `--err-line`, `--focus-ring` (new)                 |
| Code                          | `--hl-kw`, `--hl-str`, `--hl-num`, `--hl-fn`, `--hl-type`, `--hl-op`, `--hl-tag`                                                                                                                                                            |
| Type                          | `--sans`, `--mono`. Phase 2: 7 size steps, `--fs-micro` to `--fs-display`                                                                                                                                                                   |
| Corners                       | `--r-mark`, `--r-tag`, `--r-seg`, `--r-row`, `--r-control`, `--r-card`, `--r-window`, `--r-sheet`, `--r-float`, `--r-pill`, `--radius`                                                                                                      |
| Space and layout              | `--gap-out`, `--gap-in`, `--border`, `--space-x`, `--space-y`, `--leading`, `--transcript-width` (new), `--composer-width` (new), `--wallpaper`                                                                                             |
| Shadows                       | `--sh`, `--shadow`, `--pop`                                                                                                                                                                                                                 |
| Motion                        | `--ease-out`, `--ease-in-out`, `--ease-almost`, `--t-in`, `--t-out`, `--t-fade`, `--t-border`, `--t-hover`                                                                                                                                  |
| Set by the person (read only) | `--text-size`, `--sidebar-w`                                                                                                                                                                                                                |

The variables and classes that extensions use now are in this surface, so they keep working.

### Parts

Each part is a `data-part` attribute. An element can have more than one part (`[data-part~="…"]`).

| Area             | Parts                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frame            | `app` (the whole layout), `rail`, `rail-button`, `sidebar`, `session-list`, `session-search`, `session-tabs`, `session-group`, `session-row`, `home` (the wide home screen), `pane` (the conversation's window), `topbar` |
| Conversation     | `transcript`, `prompt` (a person's message), `reply` (Pi's answer), `reply-actions`, `thinking`, `activity` (a group of tool calls), `tool-call`, `approval`, `live-line`, `code-block`                                   |
| Composer         | `composer` (all of it), `dock` (the queue and the bars), `subagents-bar`, `message-box`, `composer-tools`, `send-button`, `model-chip`, `status-line`                                                                     |
| Layers           | `sheet` (with `data-sheet="<type>"`), `sheet-head`, `sheet-body`, `menu`, `launcher`, `notices`, `notice`                                                                                                                 |
| Panels (phase 2) | `people-panel`, `peeks`, `peek-tile`, `files-panel`, `browser-panel`, `pip`, `subagents-board`, `extension-page` (with `data-module`), `diff`, `sign-in`, `boot`                                                          |

**States.**

- ARIA, where it exists, because accessibility needs it anyway: `aria-current="page"` (the open session's row), `aria-pressed`, `aria-expanded`, `aria-selected`.
- `data-state` on `session-row` and `peek-tile` (`working`, `waiting`, `done`, `idle`) and on `tool-call` (`running`, `ok`, `failed`, `waiting`).
- `data-from` on `prompt`: `me` or `person`.
- On `<html>`: `data-mode`, `data-tiling`, `data-rail`, `data-density`, `data-motion`, `data-focus`, and the new `data-theme` and `data-colors`.
- Breakpoints: the phone layout is below 700 px, the sidebar shows from 960 px, and the Files tile and Browser panel sit beside the conversation from 1100 px.

## Security

- **Remote loads.** The CSP the app sends now blocks them for the whole page.
- **Same-origin requests.** A CSP cannot tell theme CSS from the app's own CSS, so `url(/login?token=…)` or `url(/api/…)` would get through. So the server tokenizes each CSS file, with escapes resolved, not by regex. `url()`, `image-set()` strings, `src()`, and `@import` may name only an allowed file in the folder by a relative path (no scheme, no leading `/`, no `..`, no `\`), or a `data:image/…`. `-moz-binding`, `behavior`, and `expression(` are refused.
- **Typed text** cannot leak through attribute selectors, because there is nowhere to send it. **Fonts cannot track people**, because none are remote.
- **Serving.** Files are at `/themes/<id>/<rev>/<path>`, for everyone who is signed in. CSS comes from the checked copy in memory, so nothing changes between the check and the serve. Fonts and images come from disk under the rules for browser-module files: no links, a regular file, the same file that was checked. Images are sniffed.
- **What a theme can still do.** It can hide or relabel the UI with `content:`, an overlay, or a font that remaps glyphs, and so make an approval card mislead. CSS cannot be fenced against this. So only the owner installs themes, and gallery review (phase 3) looks for rules that change or cover approvals.

## Who may do what

| Action                                                        | Owner | Guests, viewers |
| ------------------------------------------------------------- | ----- | --------------- |
| Choose the theme and colors for this browser                  | Yes   | Yes             |
| Duplicate, Edit with Pi, Remove, (later) install from gallery | Yes   | No              |

Remove moves the folder to `themes/.removed/`, which is not listed, so a mistaken tap loses nothing. The stored key `appearance.theme` keeps its meaning (the palette), because `pocket.*` keys are contracts. The theme gets a new key.

## Running

- **Loading.** `index.html` gets `<style>@layer pocket, palette, theme; @import url("/style.css") layer(pocket);</style>`. The theme loads as `@import url("/themes/<id>/<rev>/theme.css") layer(theme)`, and `pocket.style()` imports into `pocket`.
- **First paint.** `pocket.themeCache` also keeps the theme's address. The inline script writes the import with `document.write`, which the parser treats as its own: the page waits for it, as for a `<link>`, so nothing flashes. The script accepts only an address of the expected form. If this gives trouble, the fallback is a cookie, so the server writes the import into the page.
- **Live reload.** The server watches `themes/`, as it watches browser-module folders. About 300 ms after a save, it checks the theme again, gives it a new `rev`, and sends a `themes` event. Tabs add the new stylesheet, wait for it to load, then remove the old one. There is no page reload, so drafts and scroll positions stay.
- **A broken theme** keeps its last good version while the server runs, as an extension does. The owner gets a notice with the file and line, and the theme's card shows the problem. With no good version at start, the theme is not offered, and browsers that chose it use Pocket.
- **A theme that hides what you need.** Safe mode (`?noext=1`) also loads no theme in that tab. From there, use Appearance.

## Interplay

- **Extensions.** Their stylesheets go into the `pocket` layer and win or lose as they do now. A drop-in that adds its own `<link>`, without `pocket.style()`, would now beat the app; the docs already say to use `pocket`. Themes can style extension pages (`[data-part="extension-page"][data-module="x"]`).
- **i18n (#64).** Parts are attributes, never text. Themes must not select on `aria-label`, `title`, or words, and built-in themes put no words in `content:`. Both sweeps change the same templates, so add parts one file at a time, before the i18n sweep or in the same change for each screen. The examples use logical properties, in case right-to-left languages come later.
- **Accessibility.** A theme cannot turn reduced motion back on (checked). Focus rings use `--focus-ring`, and the docs require a visible ring. In phase 2, Appearance warns, but does not block, when the contrast of text, muted text, or accent ink is below 4.5:1. `order` and `row-reverse` do not change the focus order, so the docs limit them to whole regions. Text size and density stay each person's choice.

## Stability and versioning

This follows the API stability policy that is being written. In short:

- `themeApi` is 1. New tokens, parts, and states do not change it. `minPocket` says which release a theme needs.
- To rename or remove a name, keep an alias for the deprecation period (`--old: var(--new)`, or `data-part="new old"`), then remove it with `themeApi` 2.
- One list, `web/theme-surface.js`, names every token and part. The docs use it, and one static test checks that each token is defined in `style.css` and each part is in the `web/` source.

## Phases and estimates

Estimates are in agent-days, with checks and review included.

**Phase 1: theme folders. It can ship alone. About 7 days.**

1. Layers: `index.html`, `pocket.style()`, the palette in a layered `<style>`, and previews. (0.5)
2. Tokens: derive soft fills and lines from the named tokens; add `--focus-ring`, `--transcript-width`, and `--composer-width`; change about 95 radii and 23 shadows to tokens. A diff of computed styles on the main screens must show no change. (1.5)
3. Parts: the 37 parts above and their states, in about 12 files. (1)
4. Server: `themes.ts` (list, check, watch, serve, duplicate, remove), its routes, and the `themes` event. (2)
5. Web: the Theme row in Appearance, with Duplicate, Edit with Pi, and Remove; loading; first paint; the live swap; safe mode. (1.5)
6. The Pocket starter folder; the docs (with the docs-site agent), `map.md`, `architecture.md`, and `features.md`; two lean tests, for the surface list and for the CSS checks. (0.5)

**Phase 2: the full surface. About 4 days.** A type scale (about 300 sizes into 7 steps, reviewed screen by screen, because half-pixel changes show); the 11 panel parts; `extends`; contrast warnings; resize handles and swipes that read where the sidebar is; themes in the launcher and `/theme`; and the owner's default theme for new browsers.

**Phase 3: sharing. About 3 days.** A `theme` entry type in the gallery (files pinned by SHA-256, installed into `themes/`, and updates shown with a diff); import from `~/.config/omarchy/themes`; and the built-in palettes as folders.

## Risks

1. **The layers and `pocket.style()` must ship together.** Without both, extension CSS beats the whole app (seen in the experiment).
2. **The JavaScript assumes positions:** the resize handle, swipes, the dock's sizing, and PiP's corner. A theme that moves regions can break them. Phase 1 documents which layout changes are supported, and phase 2 makes the JavaScript read real positions.
3. **The token sweep can change the look.** Check each step with a diff of computed styles, not with screenshots alone.
4. **Every part is a promise.** Keep the list short, and use aliases for a rename.
5. **Merge conflicts with the i18n sweep.** Plan the order.
6. **`document.write` is out of favor.** Use the cookie fallback if it gives trouble.
7. **Misleading themes** cannot be fenced (see Security).
8. **Slow selectors**, such as a heavy `:has()` in the transcript. The limits help little, so the docs give advice.

## Open questions for the owner

1. **Two choices (Theme and Colors), or one list?** Recommendation: two, so a layout stays when the colors change.
2. **The names "Theme" and "Colors" in the app?** `/theme gruvbox` and the launcher's `#` still find palettes. Recommendation: yes.
3. **Duplicate on Pocket makes a starter (tokens and examples), not a copy of all the CSS?** Recommendation: a starter. A full copy is the fork that the goal rules out.
4. **A choice for each browser, or for each person on all devices?** Recommendation: each browser, as now, with an owner default for new browsers in phase 2.
5. **A broken theme: keep its last good version, or fall back to Pocket at once?** Recommendation: keep the last good version, as extensions do.
6. **Safe mode (`?noext=1`) also turns off the theme?** Recommendation: yes, so there is one safe mode to learn.
7. **Edit with Pi in phase 1?** Recommendation: yes. It is small, and it makes themes usable from a phone.
8. **`extends` in phase 2, up to 3 levels?** Recommendation: yes.
9. **Fence the approval UI from themes, for example in a shadow root?** Recommendation: no. A fence does not stop overlays. Rely on owner-only installs and gallery review.
10. **Everyone signed in can read a theme's files. Is that acceptable?** Recommendation: yes, as for browser modules. The docs say to keep nothing private in a theme.
11. **Remove moves the folder to `themes/.removed/`, not deletes it?** Recommendation: yes.
