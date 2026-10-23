# The theme surface

What a theme may rely on, at theme API version 1: the tokens (CSS variables), the parts (`data-part` names), their states, and the page's own attributes. [../themes.md](../themes.md) is the guide. `web/theme-surface.js` lists the tokens and parts, and `test/theme-surface.test.ts` checks that each one is still there.

This page is the one full list of the CSS names Pi Pocket keeps. Every name on it is there since 0.14.0, the first release with themes; a later one says since when. Everything else in the app's CSS and markup (class names, the order of elements) may change in any release.

## Extensions' CSS names

The CSS names extensions may use are a subset of this page: the tokens `--text`, `--muted`, `--accent`, `--bg`, `--card`, `--line`, `--err`, `--warn`, and `--ok`, and the classes `button` (with `primary`), `error-box`, `muted`, `small`, `mono`, and `setting`. A theme that changes those tokens changes extensions' pages with the app.

## Tokens

Set them on `:root` in a theme. Most are made from others: a theme that sets `--bg`, `--body`, or `--accent` moves the ones made from them too.

### The palette

Set by Colors (`colors.toml`, an Omarchy palette, or the desktop's). A theme reads them, and may set them, though a `colors.toml` is the better place.

| Token                                                                                     | `colors.toml` key                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `--o-bg`, `--o-bg-dark`, `--o-bg-darker`, `--o-bg-light`                                  | `background`, `dark_background`, `darker_background`, `lighter_background`            |
| `--o-fg`, `--o-fg-dim`, `--o-fg-light`, `--o-fg-bright`                                   | `foreground`, `dark_foreground` (or `muted`), `light_foreground`, `bright_foreground` |
| `--o-accent`, `--o-selection`                                                             | `accent`, `selection`                                                                 |
| `--o-red`, `--o-yellow`, `--o-orange`, `--o-green`, `--o-cyan`, `--o-blue`, `--o-magenta` | the same names                                                                        |

### Surfaces, lines, and text

| Token                     | What                                                                   |
| ------------------------- | ---------------------------------------------------------------------- |
| `--desk`                  | Behind the tiled windows (`--o-bg-darker`)                             |
| `--bg`, `--panel`         | The windows' ground, and the sidebar's (`--o-bg`)                      |
| `--card`, `--card-2`      | Cards and fields, a little and a little more raised from `--bg`        |
| `--raised`                | A selected segment in its track                                        |
| `--hover`, `--pressed`    | Laid over a control under the pointer, and while it is pressed         |
| `--scrim`                 | Behind a sheet                                                         |
| `--code-bg`               | Code blocks (`--o-bg-dark`)                                            |
| `--line`, `--line-strong` | Lines between things                                                   |
| `--edge`                  | A see-through line                                                     |
| `--hair`, `--hair-2`      | The 1px hairlines, and the stronger one of fields and a switch's track |
| `--text`                  | Titles and strong text (`--o-fg-bright`)                               |
| `--body`                  | Running text (`--o-fg`); the surfaces and lines mix from it            |
| `--muted`, `--faint`      | Quieter text, and quieter still                                        |

### Accent and status

| Token                                                                            | What                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `--accent`                                                                       | The accent (`--o-accent`)                                                            |
| `--accent-2`                                                                     | A second accent, for what a theme draws in two colors (`--spark`). The app uses none |
| `--accent-fill`, `--accent-ink`                                                  | The accent under text (buttons, badges), and the text on it                          |
| `--accent-soft`, `--accent-line`                                                 | The accent as a soft fill, and as a line                                             |
| `--focus-ring`                                                                   | The keyboard's focus ring (`--accent`). Change its color; keep the ring              |
| `--spark`, `--brand`                                                             | The second color of loaders and thoughts; the π mark                                 |
| `--ok`, `--ok-soft`                                                              | Done, worked                                                                         |
| `--warn`, `--warn-soft`, `--warn-line`                                           | Waits for you, needs a look                                                          |
| `--err`, `--err-soft`, `--err-line`                                              | Failed                                                                               |
| `--hl-kw`, `--hl-str`, `--hl-num`, `--hl-fn`, `--hl-type`, `--hl-op`, `--hl-tag` | Code's colors: keywords, strings, numbers, functions, types, operators, tags         |

### Type, corners, space, shadows, motion

| Token                                                          | Default                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--sans`, `--mono`                                             | Geist for words; JetBrains Mono for code, paths, counts, keys. The app's other fonts a theme can name: [themes.md](../themes.md)                                                                                                                            |
| `--ligatures`                                                  | `none`: no ligatures, as in a terminal. `contextual` turns on a font's `calt`; `normal`, all its usual ones                                                                                                                                                 |
| `--r-mark`, `--r-tag`, `--r-seg`, `--r-row`, `--r-control`     | 2, 4, 5, 6, 7 px: state squares, tags, segments, rows, fields                                                                                                                                                                                               |
| `--r-card`, `--r-window`, `--r-sheet`, `--r-float`, `--r-pill` | 8, 10, 12, 12, 999 px: cards, windows, sheets, PiP, pills                                                                                                                                                                                                   |
| `--radius`                                                     | A control's corner that names none (`--r-control`)                                                                                                                                                                                                          |
| `--gap-out`, `--gap-in`, `--border`                            | 8, 4, 1 px: the tiled windows' gaps and border                                                                                                                                                                                                              |
| `--window-border`, `--window-border-active`                    | A tiled window's border color (`--hair`), and the one in focus (`--accent-line`)                                                                                                                                                                            |
| `--window-ring`                                                | The shadow around the window in focus (`0 0 0 3px var(--accent-soft)`)                                                                                                                                                                                      |
| `--space-x`, `--space-y`, `--leading`                          | Density's scale of room (1, 1) and the conversation's line height (1.65)                                                                                                                                                                                    |
| `--transcript-width`, `--composer-width`                       | The conversation and the message box at their widest: `clamp(720px, 72%, 1200px)` of the pane, and 48 px more. Set them as a share of the pane, with a floor, so phones keep their width; Appearance's Width (Wide, Full) sets them inline over the theme's |
| `--transcript-gutter`                                          | `0px`: room before the conversation's turns, for a column of a theme's own                                                                                                                                                                                  |
| `--timeline-x`, `--step-mark-size`, `--step-gap`               | 22.5, 19, 10 px: where the timeline's rule and its marks' centers are, the marks' size, and the gap to their words                                                                                                                                          |
| `--wallpaper`                                                  | `none`: what shows in the gaps between tiled windows. The desktop's wallpaper wins when Appearance shows it                                                                                                                                                 |
| `--sh`, `--shadow`, `--pop`                                    | The shadow color; a soft lift; what floats (sheets, menus, the launcher)                                                                                                                                                                                    |
| `--ease-out`, `--ease-in-out`, `--ease-almost`                 | Hyprland's curves                                                                                                                                                                                                                                           |
| `--t-in`, `--t-out`, `--t-fade`, `--t-border`, `--t-hover`     | 410, 150, 175, 540, 140 ms                                                                                                                                                                                                                                  |
| `--ease-spring`, `--ease-glide`, `--ease-exit`                 | Fluid motion's curves: a spring that settles with a 2% overshoot (a `linear()` curve), a glide to rest with none, and a quick exit (since 0.20.0)                                                                                                           |
| `--t-spring`, `--t-glide`, `--t-exit`, `--stagger`             | 560, 420, 150 ms, and 24 ms between staggered arrivals: Fluid motion's (since 0.20.0)                                                                                                                                                                       |

Most corners in the app are these tokens, some a pixel or two from one (`calc(var(--r-row) - 1px)`), so they follow when a theme changes the scale. The timeline's rule, marks, and what shows under each step all place themselves from `--timeline-x`, `--step-mark-size`, and `--step-gap`, so a theme that moves the marks moves them all.

### Set by the person

Read them; a theme cannot change them, as they are each person's choice in Appearance.

| Token                                    | What                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `--text-size`                            | The conversation's text size, 10 to 32 px (13 to 17 before 0.20.0)                  |
| `--sidebar-w`                            | The open sidebar's width, as dragged                                                |
| `--transcript-width`, `--composer-width` | Only with Width set to Wide or Full: then they are inline, and win over the theme's |

## Parts

Each is a `data-part` attribute. Some elements have two (`data-part="composer-button stop-button"`), so select with `~=`: `[data-part~="name"]`.

### The frame

| Part                                                                | What                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`                                                               | The whole layout: the sidebar, the conversation, and the panels beside it, in a row                                                                                                            |
| `boot`                                                              | The screen while the app starts                                                                                                                                                                |
| `brand-mark`                                                        | The π: on the rail, and on the boot screen                                                                                                                                                     |
| `sidebar`                                                           | The rail and the session list, on wide screens                                                                                                                                                 |
| `drawer`                                                            | The rail and the session list sliding in, on narrow screens                                                                                                                                    |
| `rail`, `rail-button`                                               | The column of buttons, and each of them (an extension's too)                                                                                                                                   |
| `session-list`, `session-list-title`                                | The session list, and its title ("Sessions")                                                                                                                                                   |
| `session-search`                                                    | The search field                                                                                                                                                                               |
| `session-filter`                                                    | An extension's filter button in the search field (`data-state="on"` while it narrows the list) (since 0.20.0)                                                                                  |
| `session-tabs`                                                      | Recent, Folders, Archived                                                                                                                                                                      |
| `segment-thumb`                                                     | What slides under the chosen segment, in the session tabs and other segmented controls. The app sets its place and width (`transform` and `width`, or `height` in a column); leave those to it |
| `session-group`, `session-group-head`                               | A group of rows (a day, a folder), and its head, which folds it                                                                                                                                |
| `session-group-name`, `session-group-count`                         | The head's name, and its count                                                                                                                                                                 |
| `session-row`                                                       | One session's line                                                                                                                                                                             |
| `session-button`                                                    | The row's button: its square, title, and what is on its right                                                                                                                                  |
| `session-mark`                                                      | A session's square, in its folder's color, in the shape of its state (the home screen's too)                                                                                                   |
| `session-branches`                                                  | The lines to a session that another one started                                                                                                                                                |
| `session-chips`, `session-chip`                                     | The chips that extensions put under a row's title, and each of them (since 0.20.0)                                                                                                             |
| `home`                                                              | The home screen on wide screens                                                                                                                                                                |
| `home-facts`, `home-logo`, `home-title`, `home-fact`, `home-colors` | Its summary: the block, the logo, the first line, each fact, the palette's colors (each a `home-color`)                                                                                        |
| `home-actions`                                                      | Its buttons                                                                                                                                                                                    |
| `home-recent`, `home-heading`, `home-recent-row`, `home-recent-key` | Jump back in: the list, its heading, each session, and the number that opens it                                                                                                                |
| `home-list`                                                         | The session list as a phone's home screen                                                                                                                                                      |
| `pane`                                                              | The conversation's window (or the subagents board, or an extension's page)                                                                                                                     |
| `topbar`, `topbar-title`, `topbar-sub`                              | The conversation's title bar, its title, and the line under it (folder, branch)                                                                                                                |

### The conversation

| Part                                            | What                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `transcript`                                    | The column of turns                                                                     |
| `prompt-row`                                    | The row a person's message stands in                                                    |
| `prompt`                                        | A person's message                                                                      |
| `prompt-head`, `author-mark`, `prompt-author`   | Its head: who sent it and when; their initials; their name                              |
| `prompt-text`                                   | What it says (its skill chip, words, and files)                                         |
| `reply`                                         | Pi's answer                                                                             |
| `reply-actions`                                 | The row under an answer: react, discuss, pin, copy                                      |
| `activity`, `activity-head`, `activity-chevron` | A group of what Pi did, its head (what it did, how long), and the chevron that opens it |
| `timeline`                                      | The open group's steps, on a rule                                                       |
| `timeline-earlier`                              | Above a long group's newest steps: shows the earlier ones                               |
| `thinking`, `tool-call`                         | A step: a thought, a tool call                                                          |
| `step-head`, `step-mark`, `step-label`          | A step's line, its mark on the rule, and its name                                       |
| `step-detail`                                   | What a step shows under its line: what it made, and its input and output                |
| `approval`                                      | A call that waits for someone to allow it                                               |
| `live-line`, `live-mark`                        | The line that says what Pi does now, and its dot                                        |
| `code-block`, `code-head`                       | A code block in a reply, and its bar (language, Copy)                                   |
| `inline-code`                                   | Code in a line of words, in a reply                                                     |

### The composer

| Part                                      | What                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `composer`                                | All of it, under the conversation                                                                                       |
| `dock`                                    | What sits above the message box: the queue and the bars                                                                 |
| `subagents-bar`                           | The subagents' bar                                                                                                      |
| `message-box`                             | The box you type in, with its buttons                                                                                   |
| `composer-tools`                          | The row of buttons in it                                                                                                |
| `composer-button`                         | Each of its own buttons: Places, Attach, Plan, the mic, Steer and Queue, Stop, and an extension's button (since 0.19.0) |
| `plan-chip`, `mode-switch`, `stop-button` | Plan, Steer and Queue, and Stop, each also a `composer-button`                                                          |
| `model-chip`                              | The model's button                                                                                                      |
| `send-button`                             | Send                                                                                                                    |
| `status-line`                             | The line under the box: who is here, context, cost                                                                      |
| `status-item`                             | An extension's item in it, with `data-module` naming its module (since 0.19.0)                                          |

### Layers over the app

| Part                                 | What                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrim`                              | What a sheet, the launcher, or the drawer sits in, over the app. `data-for` says which: `sheet`, `launcher`, `drawer`                             |
| `sheet`                              | A sheet: a bottom sheet on phones, a window on wide screens. `data-sheet` says which (`appearance`, `menu`, `model`, …; `ext` for an extension's) |
| `sheet-head`, `sheet-body`           | Its title bar, and what it holds                                                                                                                  |
| `menu`                               | The menu, on wide screens (it is the sheet `menu` on phones)                                                                                      |
| `launcher`                           | The launcher (Ctrl/⌘+K)                                                                                                                           |
| `launcher-input`, `launcher-filters` | Its search field, and the search types under it                                                                                                   |
| `launcher-group`, `launcher-row`     | A group's heading, and each result                                                                                                                |
| `notices`, `notice`                  | The notices, and each one                                                                                                                         |

### Panels

| Part                 | What                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `people-panel`       | People: who is here, the side chat                                        |
| `peeks`, `peek-tile` | The peek tiles' column or strip, and each tile                            |
| `files-panel`        | The Files tile                                                            |
| `browser-panel`      | The Browser panel                                                         |
| `pip`                | PiP's panel                                                               |
| `subagents-board`    | The subagents board                                                       |
| `extension-page`     | An extension's page, with `data-module` naming its module                 |
| `extension-panel`    | An extension's panel, with `data-module` naming its module (since 0.19.0) |
| `diff`               | A diff, in a tool call, a reply, or the review                            |
| `sign-in`            | The sign-in screen                                                        |

## States

| Where                                              | Attribute                                        | Values                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `rail-button`                                      | `data-state`                                     | `open` while what it opens shows, `busy` while work it counts goes on; both, or none. Select with `~=`                    |
| `session-row`                                      | `data-state`                                     | `working`, `waiting` (for you), `failed`, `done` (since you looked), `idle`                                               |
| `session-button`                                   | `aria-current`                                   | `page` on the open session's                                                                                              |
| `session-group-head`, `activity-head`, `step-head` | `aria-expanded`                                  | `true` while open                                                                                                         |
| `activity`                                         | `data-state`                                     | `open` while open                                                                                                         |
| `tool-call`                                        | `data-state`                                     | `running`, `ok`, `failed`, `waiting` (for approval), `denied`, `stopped`                                                  |
| `prompt`                                           | `data-from`                                      | `me`, `person` (someone else), `linked` (a linked session), `other` (Pi's schedule, the main agent, a watch or a webhook) |
| `send-button`                                      | `data-state`                                     | `ready` when there is something to send                                                                                   |
| `sheet`                                            | `data-sheet`, `data-size`                        | The sheet's type; `wide` for a wide one                                                                                   |
| `sheet`, `launcher`, `drawer`                      | `data-state`                                     | `closing` while it goes                                                                                                   |
| `scrim`                                            | `data-for`                                       | `sheet`, `launcher`, `drawer`                                                                                             |
| `launcher-row`                                     | `aria-selected`                                  | `true` on the one Enter opens                                                                                             |
| Other buttons and tabs                             | `aria-pressed`, `aria-expanded`, `aria-selected` | As accessibility needs them                                                                                               |

## The page

On `<html>`:

| Attribute      | Values                                                                                                                                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-mode`    | `dark` or `light`: the colors' mode                                                                                                                                                                                                                                                                                              |
| `data-theme`   | The theme in use: `pocket`, or a theme folder's id                                                                                                                                                                                                                                                                               |
| `data-colors`  | The colors in use: `desktop`, a palette's id, or a folder's (`id`, `id@dark`, `id@light`)                                                                                                                                                                                                                                        |
| `data-tiling`  | `on` or `off`: tiled windows on wide screens                                                                                                                                                                                                                                                                                     |
| `data-rail`    | `on` when the sidebar is folded to the rail                                                                                                                                                                                                                                                                                      |
| `data-width`   | `comfortable` (the theme's width), `wide`, or `full`: Appearance's Width. With `wide` or `full`, the widths are the person's; a theme that lays things out by the column's width reads this, as `:root[data-width="full"]`                                                                                                       |
| `data-density` | `comfortable`, `compact`, or `tight`                                                                                                                                                                                                                                                                                             |
| `data-motion`  | `full`, `reduced`, or `fluid` (since 0.20.0): Appearance's Motion. Auto gives `full` or `reduced`; `fluid` is chosen only. With `fluid`, `--ease-out` is `--ease-glide`, and a theme that wants motion for both writes `:root:not([data-motion="reduced"])`                                                                      |
| `data-focus`   | The window in focus: `pane` (the conversation's, at first), `sidebar`, `peeks`, `people-panel`, `browser-panel`, `files-panel`, or `extension-panel` (since 0.19.0): the window's part name. The app draws the focus only on wide screens with tiling on: `:root[data-tiling="on"][data-focus="sidebar"] [data-part~="sidebar"]` |

Widths: below 700 px is the phone layout (sheets from the bottom, one screen at a time); the sidebar shows from 960 px; from 1100 px the Files tile and the Browser panel sit beside the conversation.

## Pseudo-elements the app uses

A part's `::before` and `::after` are a theme's to use, except these, which the app draws (some are tap areas, larger than what shows). Use the other one, or a child:

| Part                                           | The app's                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `session-group-head`                           | `::after`: its tap area on touch screens                                    |
| `session-mark`                                 | `::before`: the square that steps while the session works                   |
| `timeline`                                     | `::before`: the rule                                                        |
| `composer-button`, `model-chip`, `send-button` | `::before`: their tap areas on phones; the mic's `::after` while it listens |
| `notice`                                       | `::after`: the bar that counts down                                         |

What is inside a part (its children without a part of their own) may use its pseudo-elements in any release.

## Layers

`@layer pocket, palette, theme;`: the app's CSS and extensions' stylesheets, then the colors, then the theme. Later layers win over earlier ones, whatever the selectors' specificity, and in every condition: a theme's rule for a property replaces the app's on phones, on touch screens, and on hover too. `!important` reverses that: the app's `!important` rules win over a theme's. The ones a theme is likely to meet: reduced motion, `--ligatures` (so each `font` shorthand cannot reset it), and fields' 16px on touch screens (so iOS does not zoom into them); a few more keep app states whole (the resize cursor while a width is dragged, a page leaving on back, the browser's forward button on a phone). Inline values win over all of them: the text size and the widths people drag, unless a theme marks a size `!important`, which a theme must not do.

## Changes

These names change by the deprecation rules of [the API policy](../policies/api-stability.md#deprecation):

- **Additions** (a new token, part, state, or value) come in any minor release, with no change to `themeApi`. A theme that needs one sets `minPocket` to the release that added it.
- **A rename or a removal** first keeps the old name as an alias: `--old: var(--new)` in the app's CSS, or both names in `data-part` (`data-part="new old"`). The alias stays for at least one minor release and at least 90 days, from the first stable release that deprecates it, whichever is later. This page and the release notes mark it deprecated, with its replacement and its earliest removal.
- **The removal** comes only in a minor release after that time, and raises `themeApi` by one. The release notes list it under "Removed", with what to use instead.
- **A part whose region leaves the app** goes with it, in the same release, with a release note ([A20](../policies/api-stability.md#theme-parts)): a theme's rules for it match nothing, and the rest of the theme works as before.
