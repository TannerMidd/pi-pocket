# Example design system: Pi Pocket

`pocket/.pi/design/` is Pi Pocket's own design system, written the way Design mode expects it (see the design system in [features.md](../../features.md)). It is the reference for the file format and a ready system to try.

| File                        | What it holds                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.json`               | The default mode (light): primitives (palettes, scales), semantic roles (`color.bg.surface`, `space.4`, `type.body`), and component tokens. |
| `tokens.dark.json`          | Dark mode: Tokyo Night, the app's own palette. Only the roles that change.                                                                  |
| `tokens.high-contrast.json` | High contrast: text at 7:1 or more on every ground.                                                                                         |
| `components/*.html`         | Ten components with their states: button, input, switch, segmented control, badge, card, notice, menu row, tool step, code block.           |
| `guidelines.md`             | Principles, color, type, space, motion, accessibility, and voice.                                                                           |

To try it, copy the `.pi` folder into a project folder, then open Design and ask Pi for a screen. Every color pair in the system passes WCAG AA in every mode.

Where the values come from: the palette is `web/style.css`'s Tokyo Night (`--o-*`); the radii, spacing, shadows, and motion are its `--r-*`, `--gap-*`, `--shadow`, and `--ease-*` and `--t-*` variables; the roles follow its names (`--card` is `color.bg.surface`, `--line` is `color.border.default`). The light mode and the high-contrast mode are new.
