// The page that shows a component's states, for a frame with no scripts and no network. The component's markup and CSS come
// from the project's files: untrusted.

export const escapeHtml = (text) =>
    String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The tags that could load, run, or move a page: they are never in a specimen. */
const UNSAFE_TAGS =
    /<\s*\/?\s*(?:meta|base|link|script|iframe|frame|frameset|object|embed|form|template|noscript)\b[^>]*>/gi;

const cleanMarkup = (markup) => String(markup).replace(UNSAFE_TAGS, "").slice(0, 20_000);

/** A component's CSS that cannot end its own `<style>` element. */
const cleanStyles = (css) =>
    String(css)
        .replace(/<\/(style)/gi, "<\\/$1")
        .slice(0, 40_000);

/** What a frame may do: nothing but draw what is in it (a `data:` image or font, inline styles). */
const SPECIMEN_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

/**
 * The document of one component in one mode. `colors` are CSS colors for the page, the stages, and the text (from the
 * system's own roles, or a default); `theme` is the mode's `:root` block (`themeCss`); `scheme` is `light` or `dark`.
 */
export function specimenDocument({ component, theme, mode, scheme, colors }) {
    // The system says whether a mode is light or dark; its name is only a guess when it does not.
    const dark = scheme === undefined ? /dark/i.test(mode) : scheme === "dark";
    const states = component.states.filter((state) => Object.hasOwn(component.markup, state));

    return `<!doctype html>
<html lang="en" data-theme="${escapeHtml(mode)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SPECIMEN_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${theme}</style>
<style>
*{box-sizing:border-box}
html{color-scheme:${dark ? "dark" : "light"}}
body{margin:0;padding:12px;background:${colors.canvas};color:${colors.text};font:14px/1.5 system-ui,sans-serif}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
figure{margin:0;display:flex;flex-direction:column;gap:6px;min-width:0}
figcaption{font:600 10.5px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;opacity:.65}
.stage{display:flex;align-items:center;min-height:60px;padding:14px;border-radius:8px;background:${colors.surface};box-shadow:0 0 0 1px rgb(127 127 127 / .25);overflow:hidden}
</style>
<style>${cleanStyles(component.css)}</style></head>
<body><div class="grid">${states
        .map(
            (state) =>
                `<figure><figcaption>${escapeHtml(state)}</figcaption><div class="stage">${cleanMarkup(component.markup[state])}</div></figure>`,
        )
        .join("")}</div></body></html>`;
}
