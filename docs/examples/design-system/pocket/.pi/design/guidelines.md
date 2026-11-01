# Pi Pocket design guidelines

Pi Pocket looks like a tiling window manager that learned to be gentle: soft tiles on a dark ground, hairlines instead of heavy borders, one accent, and motion that settles instead of bounces. This system is that look, written down as tokens. Use it for anything that sits beside the app: designs, docs, screenshots, and extensions.

## Principles

1. **Quiet by default.** Text and tiles come first. The accent marks the one thing to do or the one thing that is selected. If two things on a screen are blue, one is wrong.
2. **Hairlines, not boxes.** Separate with a 1 px line or a step of ground (`color.bg.base` to `color.bg.surface`), never with a heavy border or a drop shadow. Shadows are for what floats: menus, sheets, the launcher.
3. **Words in Geist, facts in mono.** Set messages, labels, and headings in Geist. Set code, paths, branch names, numbers, counts, and keys in JetBrains Mono. Ligatures stay off, as in a terminal.
4. **Phone first.** Design the 390 px screen, then widen. Touch targets are 44 px. Fields are 16 px on touch, so iOS does not zoom.
5. **Every state is designed.** A control has default, hover, focus, active, and disabled. A list has empty, loading, and error. Do not ship a screen with one.

## Color

- Use roles, never primitives. Write `var(--color-text-muted)`, not `var(--color-neutral-500)`. The role changes with the mode, and the primitive does not.
- Pick the ground first, then the text that fits it: `color.text.*` is checked at 4.5:1 or more on `color.bg.base`, `surface`, `raised`, and `sunken` in every mode.
- `color.text.disabled` is for disabled controls only. WCAG exempts it from contrast, so it is below 4.5:1 on purpose. A placeholder uses `color.text.muted`.
- Status colors come in three parts: `default` for text and icons, `soft` for the wash behind, and `line` for the border. Never put `default` text on another status wash.
- A fill needs its own text color: `color.accent.fill` goes with `color.accent.on-fill`, and `color.danger.fill` with `color.danger.on-fill`.
- Do not add a color. Ask for a role first. A new role gets a name, a light value, a dark value, and a contrast pair.

## Type

- The scale is 11, 12, 13, 14, 16, 18, 22, 28, and 36 px. Body text is 14 px at 1.55. Reading text in the conversation is 1.65.
- Use a text style (`type.body`, `type.label`, `type.heading`) over a hand-built size. Three weights do the work: regular for text, medium for labels, semibold for headings and buttons.
- Headings are tight (1.2 to 1.4). Never set body text tighter than 1.4.
- Do not use all capitals except `type.overline`, and never for a sentence.

## Space, layout, and corners

- Space moves on a 4 px grid: `space.1` is 4, `space.2` is 8, `space.3` is 12, `space.4` is 16. Tiles are 8 px apart (`layout.gap.out`), and things inside a tile 4 px (`layout.gap.in`).
- Corners follow what they round, and come from one scale of 2, 4, 6, 8, and 12 px and round. Inline code is `radius.tag` (4), a row or a field is `radius.row` or `radius.control` (6), a card or a window is `radius.card` or `radius.window` (8), and a sheet or the message box is `radius.sheet` (12). Avatars and badges are `radius.pill`.
- Below 700 px (`breakpoint.md`) the layout is one column. The app adds side panes at 960 and 1100 px (`breakpoint.lg` and `breakpoint.xl`).
- Keep a line of text under 75 characters. The conversation column is 720 to 1200 px.

## Elevation

- Three steps: flat (a tile on the ground), `shadow.lift` (the message box), and `shadow.float` (menus, sheets, popovers). Nothing else casts a shadow.
- Shadow color follows the mode (`color.shadow.default`). Do not hard-code black.
- Stack with `z.*` only. Do not write a new z-index.

## Motion

- Use `motion.transition.hover` (150 ms) for color changes, `motion.transition.enter` (420 ms) for arrivals, and `motion.transition.exit` (150 ms) for departures. Things leave faster than they arrive.
- Move one property at a time where you can: color, opacity, or transform. Never animate layout.
- Respect `prefers-reduced-motion: reduce`. Replace movement with a fade or with nothing. A spinner may stop and show a static mark.
- The spring in Fluid motion is a `linear()` easing that a token cannot hold. It lives in the app's stylesheet only; designs use `motion.ease.standard`.

## Accessibility

- Contrast: text 4.5:1, large text and UI parts 3:1. Every pair in this system passes in light, dark, and high contrast. The high-contrast mode reaches 7:1 for text.
- Focus: every control shows `shadow.focus-ring` on keyboard focus. A theme may change its color and may not remove it.
- Targets: 44 px on touch, 24 px at the least anywhere.
- State is never color alone. A failed step has a mark and the word "Failed". A selected row has a wash and a check.
- Give every image an `alt`, every field a label, and every icon button an `aria-label`. Keep headings in order.

## Voice

- Plain and short. Say what happened, then what to do. "The render failed. Try again." not "Oops! Something went wrong."
- Use sentence case, even for buttons and headings. Start a button with a verb.
- Do not thank, apologize, or cheer. No emoji, no exclamation marks.
- Name things as the app does: sessions, designs, artifacts, versions, tweaks.

## Using the system

- Link `ds/tokens.css` and use `var(--…)` for every color, size, space, radius, shadow, and duration.
- Reuse a component from `components/` before you write a new one. Copy its markup and its classes. Link `ds/components.css` for the CSS of every component.
- For dark mode, set `data-theme="dark"` on the root. The system also follows `prefers-color-scheme`.
- A design that needs a value the system does not have asks for a new token. It does not invent one in place.

## Do and don't

| Do                                              | Don't                       |
| ----------------------------------------------- | --------------------------- |
| `color: var(--color-text-secondary)`            | `color: #a9b1d6`            |
| `padding: var(--space-3) var(--space-4)`        | `padding: 13px 15px`        |
| `border-radius: var(--radius-card)`             | `border-radius: 9px`        |
| `box-shadow: var(--shadow-float)` on a menu     | A shadow on every card      |
| One primary button, the rest secondary or ghost | Three blue buttons in a row |
| A visible label above the field                 | A placeholder as the label  |
| A mark and a word for a state                   | A color alone               |
