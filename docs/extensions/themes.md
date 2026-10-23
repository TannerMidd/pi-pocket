# Themes

A theme changes how Pi Pocket looks and how it is laid out, without a change to the app's code. A theme is a folder of CSS, colors, fonts, and images. It cannot run code. [reference/theme-surface.md](reference/theme-surface.md) lists every token and part a theme can use.

## Theme and colors

Appearance has two choices:

- **Theme**: the look and the layout. **Pocket** is the app's own look. Each theme folder adds one.
- **Colors**: the palette. The Omarchy palettes that come with the app, **Desktop** (the Omarchy theme of the machine Pi Pocket runs on), and each theme folder that has a `colors.toml`.

They are separate, so a theme's layout stays when the colors change, as they do when you follow the desktop. A theme with colors of its own changes Colors to them when you choose it. You can choose other colors after.

A theme can bring a pair of palettes, dark and light. Colors then shows three cards for it: the pair, which follows the system's light or dark setting (the one a theme brings when you choose it), and each half alone.

Each person chooses for each browser, as for the rest of Appearance. Guests choose too. Only the owner adds, changes, and removes themes. The owner can also choose the theme and colors that browsers start with: in Appearance, **Use these for new browsers** makes the ones in use the default for every browser whose person has not chosen their own, guests' included (**Reset** goes back to Pocket and the desktop's colors).

Besides Appearance: the launcher's **Themes** (Ctrl/⌘+K, then `#`) lists the themes before the colors, and `/theme <name>` in the message box chooses a theme by its name (`/theme paper`), or else colors (`/theme gruvbox`, `/theme desktop`).

## Make a theme

1. Open Appearance: the palette button on the rail, Menu → **Appearance**, or **Appearance** in the launcher (Ctrl/⌘+K).
2. Choose the theme to start from, and tap **Duplicate**. Give it a name. Pi Pocket copies it into a folder of its own and chooses it. **Duplicate colors** does the same for the colors in use.
3. Tap **Edit with Pi**. A session starts in the theme's folder, with a message ready that tells Pi where this guide is. Say what you want: "make my messages bubbles on the right", "a warmer accent", "a square message box".

Each save shows at once in every tab that uses the theme. The page does not reload, so nothing you typed is lost.

You can also edit the folder yourself: `~/.pi-pocket/themes/<id>/` (or `themes/` in `PI_POCKET_DIR`). It is the one place in the data folder, with `extensions/`, that you edit by hand. **Remove** moves a theme's folder to `themes/.removed/`, so you can get it back from there. Pi Pocket never deletes what is in `.removed/`, so it grows: delete the folders there you no longer want.

A copy of Pocket starts with a `theme.css` that lists every token with its value, commented out. Take the comment marks off a token and change its value. Leave the others commented out, so they follow the app's updates.

## The folder

```
~/.pi-pocket/themes/paper/
    theme.json
    theme.css
    layout.css        (theme.css imports it)
    colors.toml       (optional: its own colors)
    colors-light.toml (optional: a light half for them)
    fonts/Inter.woff2
    fonts/OFL.txt     (the font's licence: kept, not served)
    images/grain.webp
```

The folder's name is the theme's id: lowercase letters, digits, and `-` ([Limits](reference/limits.md#themes) gives the lengths). A theme cannot take the name of one that comes with Pi Pocket, of a palette, or `desktop`.

`theme.json` is needed when the folder has CSS:

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

| Field                   | What                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `themeApi`              | Required. The version of the theme surface it uses: 1. A newer one is not loaded.           |
| `name`                  | Required. One line.                                                                         |
| `description`, `author` | Optional. One line each.                                                                    |
| `version`               | Optional. The theme's own version, for people.                                              |
| `minPocket`             | Optional. The oldest Pi Pocket it works with, for parts and tokens added in later releases. |

`colors.toml` is Omarchy's format, as it is: `key = "value"` lines, with `background` and `foreground` at least, and `mode = "light"` for a light palette. A folder with only a `colors.toml` needs no `theme.json`, so you can drop in an Omarchy theme folder and it shows under Colors. Its other files are not read. `colors-light.toml` beside it, in the same format, is the light half of a pair; alone, it is the folder's palette.

What a theme serves:

- `theme.css`, and the `.css` files it imports (`@import "layout.css";`).
- The fonts (`.woff2`) and images (`.png`, `.jpg`, `.webp`, `.avif`, `.gif`, `.svg`) its CSS loads.

Nothing else in the folder is served. Hidden files, `node_modules`, and links are never read. Duplicate copies the whole folder, so a font's licence goes with it.

Fonts: many open fonts reserve their name (the SIL Open Font License's Reserved Font Name), so a cut-down copy (a subset) would have to be renamed. Ship the font files whole; a family name of your own in `@font-face` is not a change to the font. Keep the licence file beside the font.

What a theme may hold, in sizes and counts, is in [Limits](reference/limits.md#themes). A theme past one of them is not loaded, and the owner is told which.

## Writing the CSS

A theme changes the app in two ways: by **tokens**, the CSS variables the app's CSS is built from, and by **parts**, the `data-part` names on the app's main regions.

Colors and type, with tokens:

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

Layout, with parts:

```css
/* Your messages as bubbles on the right; other people's stay on the left. */
[data-part="prompt"][data-from="me"] {
    margin-inline-start: auto;
    max-width: 70%;
    background: var(--accent-soft);
}

/* A wider conversation, with a flat message box: a share of the pane, with a floor and a ceiling. */
:root {
    --transcript-width: clamp(720px, 80%, 1400px);
    --composer-width: var(--transcript-width);
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

Use the tokens and parts in [the reference](reference/theme-surface.md). The app's class names change from release to release; tokens and parts stay. Some tips:

- **Set the named tokens.** `--bg`, `--body`, `--text`, and `--accent` move the surfaces, lines, and soft fills made from them. Set the palette's own variables (`--o-*`) only to change the colors themselves; a `colors.toml` is the better place for that.
- **Light and dark.** The colors decide the mode. `<html data-mode="light">` is set for a light palette, so write `:root[data-mode="light"] { … }` for what differs.
- **Phones.** Below 700 px wide is the phone layout. The sidebar shows from 960 px.
- **States.** Session rows and tool calls say their state in `data-state`, and the open session's row has `aria-current="page"` on its button: `[data-part="session-row"]:has([aria-current="page"])`.
- **Text, not words.** Never select on what an element says (`[aria-label="Send"]`, `[title=…]`): the app's words change, and will come in other languages. Put no words in `content:`.
- **Right to left.** Prefer `margin-inline-start` to `margin-left`, and so on.
- **Order.** `order` and `flex-direction: row-reverse` move what shows, not the order keys reach it. Move whole regions, not parts of a reading flow. The app reads where the sidebar and the drawer are: a sidebar a theme puts on the right gets its resize handle on its left edge, and a drawer on the right closes with a swipe to the right. Other panels (Files, Browser, PiP) and phones' bottom sheets keep their place and their gestures: keep them where they are.
- **Width.** Give `--transcript-width` as a share of the pane with a floor (`clamp(720px, 72%, 1200px)`), so a wide screen gets room and a phone keeps its own. It is the theme's while Appearance's Width is Comfortable; Wide and Full are the person's choice, set inline over the theme's (`<html data-width>` says which). Do not mark the widths `!important`. A reply's code blocks and tables may run wider than the column, up to the pane's room: a theme that frames the column should let them.
- **Focus.** Keep a visible focus ring: change `--focus-ring`'s color, never take the ring away.
- **Every condition.** A rule you write for a property replaces the app's rule for it on phones, on touch screens, and on hover too: the app's media queries are in the layer under yours. Write your own `@media` rules where the app has them. Text fields stay 16px on touch screens whatever you set, as iOS zooms into smaller ones.
- **Pseudo-elements.** Most parts' `::before` and `::after` are yours; a few are the app's (tap areas, the timeline's rule): [the reference](reference/theme-surface.md#pseudo-elements-the-app-uses) lists them.
- **The app's fonts.** A theme can name a font that comes with the app instead of shipping its own: `--sans: "Pocket Inter", sans-serif;` or `--mono: "Pocket Fira Code", "Pocket Nerd Symbols", monospace;`. (Write the whole list: `var(--sans)` inside `--sans` refers to itself, and the browser drops it.) The app's fonts are `"Pocket Sans"` (Geist, the words' default), `"Pocket Mono"` (JetBrains Mono, code's default), `"Pocket Inter"`, `"Pocket Fira Code"`, `"Pocket IBM Plex Mono"`, and `"Pocket Iosevka"`. Each has its own italic, except Geist and Fira Code. The page preloads the ones a theme names, and a browser downloads only those. A font from another site (Google Fonts, a CDN) does not load, as for any file: each browser would ask that site for it, and so tell it the person's IP address and when they use the app. Ship the font in the theme's folder, or name one of these. The Nerd Fonts icons (`"Pocket Nerd Symbols"`) are in the default `--mono` after JetBrains Mono; name them after your own mono font, as above, to show the icons that prompts and tools print. The owner can also pick them in Appearance, under **Fonts for** _the theme_: **Text font**, **Code font** (System Sans and System Mono, the device's own, too), and **Ligatures** write the theme's `fonts.css` (which `theme.css` then imports first), whose values win over the theme's own.
- **Ligatures.** The app turns them off, as in a terminal. Set `--ligatures: contextual` (a font's `calt`) or `normal` to turn them on.
- **The timeline.** Move its rule and marks with `--timeline-x`, `--step-mark-size`, and `--step-gap`, not with padding of your own: the app places all of the timeline's pieces from them.

Only the theme's own files load. `url()`, `image-set()`, `src()`, and `@import` may name a file in the theme's folder by a path from the CSS file (`fonts/a.woff2`, `../images/a.png`), an image written into the CSS (`data:image/…`), or something in the page (`url(#shadow)`). Anything else stops the theme from loading: another site, another address on this server (`/api/…`), a path out of the folder. Old ways for CSS to run code (`expression()`, `behavior`, `-moz-binding`) stop it too. The app's content security policy blocks every other site anyway, for the app and for extensions alike.

## How it loads

The app's CSS comes in three cascade layers: the app's own (with extensions' stylesheets), then the colors, then the theme. So:

- A theme's rule wins over the app's, however specific the app's rule is. `[data-part="message-box"] { border-radius: 0; }` is enough.
- The app's `!important` rules still win, such as Appearance's reduced motion. A theme cannot turn motion back on.
- What people set themselves still wins: the text size, and the widths they drag (`--text-size` and `--sidebar-w` are theirs). A theme's `!important` would beat even those: never mark a size `!important`.
- A theme's `@font-face` and `@keyframes` are in its layer too.

Each browser keeps the theme's addresses, and the page loads them before it first draws, so a reload never flashes the app's own look. It preloads the theme's fonts in place of the app's. A theme's addresses carry a hash of its files, so the browser keeps each file until the theme changes, and then fetches the new ones.

## When it breaks

When a theme's files break a rule (a remote address, a file that is not there, `theme.json` that is not JSON), the theme keeps its last good version until the server restarts. The owner gets a notice that says what and where (`theme.css line 12: …`), and Appearance shows it on the theme's card. With no good version, at a start, the theme is not offered, and browsers that chose it use Pocket until it is mended.

A theme that hides what you need to change it back: open the app with `?noext=1` on its address (safe mode). That tab loads no theme and no extensions' browser parts. Choose another theme in Appearance, or mend the folder.

CSS that the browser cannot read is only skipped by the browser, as in any stylesheet: check your change in a tab, with the console open.

## What a theme can and cannot do

A theme is CSS. It runs no code, reads nothing, and sends nothing anywhere. It is still not harmless: CSS can hide parts of the app, or put other words on them (`content:`, an overlay, a font that draws other letters). A theme could make an approval card say the wrong thing. So:

- Only the owner adds themes. Add only ones you trust, as you would an extension, and read their CSS first.
- Everyone signed in can read a theme's files, as they load them. Keep nothing private in a theme folder.
- What Pi writes in a reply never wears a part's look: replies keep no `data-` attributes.

## Themes in the gallery

The gallery lists themes with extensions: Menu → Extensions → **Discover**, then the **Themes** filter. Each theme has a **Theme** tag.

- A theme's page shows its files, who made it, and where they are on GitHub. **View source** shows each file before you install it.
- **Install** gets its files from the commit the index pins and checks each one against its SHA-256. Then Pi Pocket checks the theme as it checks every theme folder (the CSS check too), in a hidden folder. A theme that fails a check is not installed, and the gallery says why. A theme that passes goes into `themes/<id>/`.
- Installing applies nothing. The theme shows in Appearance → Theme, and each person chooses it there.
- **Update** shows a diff of every file before you apply it. The version you had goes to `themes/.removed/`, so your own edits are not lost.
- **Remove** moves the folder to `themes/.removed/`, as Remove in Appearance does. Browsers that used it go back to Pocket.
- When the index revokes the version you have, the gallery says why, and a notice tells the owner.

Where a theme came from is in `.gallery.json` in its folder. It is a hidden file, so it is never served.

To share one of your own themes, choose it in Appearance and tap **Share…**. Pi Pocket checks it, and drafts its entry: the files the theme loads, with their sizes and SHA-256 hashes, and its name and description from `theme.json`. Put the folder in a public GitHub repository as `<id>/` (at the top, or in a folder that you name in the entry), and open the pull request as for an extension ([Sharing yours](publishing.md#sharing-yours)). A theme's entry has `"kind": "theme"` and `themeApi`, and no `declares`.

## Themes that come with Pi Pocket

Two come with it: **Pocket**, the app's own look, and **Lantern**, a calm, warm dark theme with colors of its own (`web/themes/lantern/`: `frame.css` is its frame, `direction.css` and `colors.toml` its turns and palette). Built-in themes are folders in `web/themes/<id>/`, in the same format. They cannot be edited or removed from the app: duplicate one to change it. A change to one is a change to Pi Pocket's code ([self-editing.md](../self-editing.md)).

## Stability

`themeApi` is 1. New tokens, parts, and states come in new releases without changing it; a theme that needs one says so with `minPocket`. A name that must change keeps the old one as an alias for at least one minor release and 90 days, and its removal raises `themeApi` to 2: [reference/theme-surface.md](reference/theme-surface.md#changes) has the rules, after [the API policy](policies/api-stability.md#deprecation). `web/theme-surface.js` lists the names, and a test checks that each is still there.

## Extensions

An extension's stylesheet (`pocket.style()`) loads in the app's layer, so it wins and loses against the app's rules as before, and a theme's rules win over both. A theme can style what an extension adds through the documented tokens, which extensions use too. An extension that adds its own `<link>` instead of using `pocket.style()` would win over the app and the theme alike: use `pocket.style()`.
