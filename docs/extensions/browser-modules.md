# Browser modules

A browser module is JavaScript that the app loads in the tabs of the people that it is for. It adds rail buttons, pages, sheets, menu rows, and launcher actions to the app. It gets `pocket`, the app's API for extensions. The members of `pocket` are in [the pocket reference](reference/pocket.md).

## Add a browser module

On the server, `web.client(entry, { access })` gives the module a browser module. `access` says who loads it ([Who may use it](routes.md#who-may-use-it)).

`entry` is the name of a file or a folder beside the module, not a link. The name has letters, digits, `.`, `_`, and `-`, and starts with a letter, a digit, or `_`.

- **A `.js` or `.mjs` file.** Pi Pocket serves this file alone.
- **A folder.** Its `index.js` loads first, and can import the other files of the folder. A stylesheet, or any other file, needs a folder.

## The default export

The app imports the browser module, and calls its default export with `pocket`. When the default export returns a function, that function runs when the module goes, as `pocket.onDispose` does.

```javascript
export const pocketApi = 1;

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    function Usage() {
        const [usage, setUsage] = useState(null);
        const [error, setError] = useState(null);

        useEffect(() => {
            const stop = new AbortController();

            pocket.api("usage", undefined, { signal: stop.signal }).then(setUsage, (failure) => {
                if (!stop.signal.aborted) {
                    setError(failure.message);
                }
            });

            return () => stop.abort();
        }, []);

        if (error) {
            return html`<div class="error-box">${error}</div>`;
        }

        return usage ? html`<p>${usage.total} tokens today</p>` : html`<${pocket.Loader} />`;
    }

    pocket.page({ id: "usage", title: "Usage", component: Usage });
    pocket.rail({ id: "usage", title: "Usage", icon: "pulse", page: "usage" });
}
```

Keep the top level of the module to declarations, and do its work in the default export: the app checks `pocketApi` after it imports the module ([API versions](reference/api-versions.md)).

## What the folder serves

- A folder serves its `.js`, `.mjs`, `.css`, and `.json` files, its images, and its fonts.
- It never serves `.ts` files, hidden files, `node_modules`, or a file through a link. A link could lead to such a file, or out of the folder.
- It serves files up to a size [limit](reference/limits.md#browser-modules).
- All the people that the browser module is for can read each file of those types in the folder. Keep no secret there. Keep the module's own data, such as a cache or settings, in another place: beside the module, or in a folder of its own in the data folder.
- When the file or the folder goes, or becomes a link, Pi Pocket tells the owner. Tabs cannot load the browser module until it is back.

## New versions

When you save a file that the folder serves, the browser module gets a new address, and the tabs load it again. This also applies to a folder that you make in it later.

- Only the types that the folder serves count. A `.log` or `.txt` file does not count, so a write to one loads nothing again. A `.json` file or an image counts.
- The version in the address is only for this. Each version serves the files as they are now.
- Only a [limited number](reference/limits.md#browser-modules) of files and folders count. An edit past those gives no new address, so open tabs keep their version until the page loads again.
- Pi Pocket watches a [limited number](reference/limits.md#browser-modules) of folders. It sees an edit in a deeper folder at its next look: when something that it watches changes, or when the module loads again.

## Rail buttons, menu rows, and launcher actions

- **`rail({ id, title, icon or iconPath, badge, … })`** adds a button on the rail, after the app's own tools. It shows in the sidebar, in the drawer, and on a phone's home screen. The buttons of modules take a [limited height](reference/limits.md#browser-modules), and scroll past that.
    - `icon` is the name of one of the app's icons: `pulse`, `grid`, `globe`, `key`, `chat`, `folder`, `search`, and more. An unknown name shows `grid`. `iconPath` is a 24×24 stroked SVG path of your own.
    - `badge` is a short count or word on the button. `0`, `NaN`, `-Infinity`, `""`, `"0"`, `null`, and `false` show no badge, as the app's own counts hide at 0. A large count, and `Infinity`, show as a capped count. Other numbers, negative or with decimals, show as they are. Long text is cut, with "…", in the button's label too, without cutting a character in two. The [limits](reference/limits.md#browser-modules) give the sizes.
- **`menu({ id, label, hint, … })`** adds a row to the menu's App group.
- **`launcher({ id, label, detail, icon or iconPath, keywords, … })`** adds an action to the launcher (Ctrl+K or ⌘+K).

Each of these does one thing when a person uses it:

- `page: "id"` opens a page that the module adds. A rail button that opens a page shows that the page is open, and closes it on a second tap.
- `sheet: "id"` opens a sheet that the module adds.
- `run: () => …` runs a function.

The buttons, rows, and actions of modules show in the order that the server lists the modules. An edit keeps a module's place.

## Pages and sheets

**`page({ id, title, component, escape, swipe })`** shows in the place of the conversation, as the subagents board does, with its title and a close button. On a phone, it fills the screen.

- Esc and back close it. Esc never closes it while an input method composes a character.
- `escape: false` keeps Esc for the page. Esc still closes a sheet, the launcher, or PiP over it, and the close button and back still close the page.
- On a narrow touch screen ([limits](reference/limits.md#browser-modules)), a swipe to the right on the page goes back. A swipe in a field or in a sideways scroller does not. In an app on an iPhone's or iPad's home screen, a swipe in from the left edge also goes back.
- `swipe: false` starts no back swipe on the page, at the edge too. A `data-no-swipe` attribute on an element starts no swipe on it or in it: use it on a slider, or a canvas that people draw on.

**`sheet({ id, title, component, wide })`** adds a sheet like the app's own.

The components of pages and sheets get `pocket` and `close`. A sheet's component also gets the `props` that it was opened with (`pocket.openSheet(id, props)`).

- `close` closes only that page or sheet, of that version, while it shows. When you keep it for later, it closes nothing else. `pocket.closePage()` closes the module's page that shows.
- A page or sheet with an `id` that the module never added says that the module no longer has it.

## Ids and updates

- Each thing that a module adds has an `id` of its own: letters, digits, `.`, `_`, `:`, and `-`, that starts with a letter or a digit, up to a [length](reference/limits.md#names).
- To add a thing with the same `id` again replaces it.
- Each `rail`, `menu`, `launcher`, `page`, and `sheet` returns `{ update(patch), remove() }`. `update` takes an object.

## Redraws

The app draws what a module changed at the next frame, one time for all its changes. So a module costs the app one redraw in each frame at most, at any refresh rate, as an animation does. A hidden tab draws no frames, so it draws by a short timer ([limits](reference/limits.md#browser-modules)), which the browser can slow.

- Adding the same thing again, or an update that changes nothing, draws nothing.
- Values are the same only when they are the very same value. A new array or function is a change, each time.
- Many changes at the same time draw one time.

Change what the module added from an event, a timer, or an effect, not while a component draws. Give each effect its dependencies. A module that changes what it added each time it draws, or each time an effect of its drawing runs, redraws the app in each frame until the owner turns it off. Pi Pocket does not stop it.

Pi Pocket stops a module in that browser, as one that failed ("was stopped in this browser: it redraws without end"), until the page loads again or the module changes, when:

- One task makes too many calls to `pocket`, over more than one second ([limits](reference/limits.md#browser-modules)). All of `pocket` counts, but not `h`, `html`, `Fragment`, the hooks, and the components. This stops a loop of microtasks, which holds the page, and also a long batch with heavy work between its calls. Then its calls throw until the next task, `pocket.api` too, so an `await` loop rejects and a `.then` chain stops.
- It opens and closes its pages or sheets too many times in one second, or again and again with no task between ([limits](reference/limits.md#browser-modules)).

Nothing outside a module can stop a loop that never yields and calls nothing of `pocket`. This is also true for a loop that catches the error that the calls of a stopped module throw. Such a loop holds the tab.

## Look like the app

- The pieces take what the app's own pieces take: `Icon({ name or path, size })`, `Loader({ label })`, `Spinner({ label })`, `Markdown({ text })`, and `Switch({ on, label, onChange, disabled })`.
- Use the app's colors, which follow the theme: `var(--text)`, `var(--muted)`, `var(--accent)`, `var(--bg)`, `var(--card)`, `var(--line)`, `var(--err)`, `var(--warn)`, and `var(--ok)`.
- Use these classes: `button` (with `primary`), `error-box`, `muted`, `small`, `mono`, and `setting` (a row with a label and a control).

Pi Pocket keeps these names. They are part of [the theme surface](reference/theme-surface.md#extensions-css-names), and a module can use its other tokens too. The rest of its CSS can change.

To load a stylesheet of your own, put it in the module's folder, and call `pocket.style(path)`. The stylesheet goes in the app's own cascade layer: it wins and loses against the app's rules by specificity and order, and a theme's rules win over both. Do not add a `<link>` of your own: it would be outside the layers, and win over the app and the theme alike.

## When it fails

A browser module fails alone, and the rest of the app continues.

- A module that throws while it loads or sets up says so in a notice, and in Menu → Extensions ("In this browser: …"). What it added goes. What it tries later, such as a timer that it left, adds and opens nothing, and its `onDispose` runs at once.
- When the component of a page or sheet throws, or a component in it, its place shows "… failed:" and the reason. This stays until the page or sheet closes, or until the module replaces the component (adds it again, or calls `update({ component })`). An error with no value shows "it gave no reason". Always throw an `Error`.
- Some throws can escape this: from a class's constructor, from a method that is a getter, and from an effect's cleanup when the component goes. From a lifecycle method that is a class field, such as `componentWillMount = () => …`, the box shows Preact's own words when the component first draws.
- A `run` that throws or rejects says so in a notice.
- Only the browser's console catches what an event handler in a component throws. Catch it in the handler, and show what went wrong.

An edit loads the module again. A module that did not import for another reason, such as the network, loads again when the page loads again. When the owner turns a module off, its page and sheet close, and back does not open its sheets again.

## Safe mode

A browser module that hangs or breaks the tab can keep you from the Extensions sheet, where you turn it off. Safe mode loads no browser modules in one tab.

1. Open the app with `?noext=1` at the end of its address, for example `https://…/?noext=1`. On a sign-in link, put it in the page to go to next: `/login?token=…&next=/?noext=1`.
2. A notice says that the tab is in safe mode. In the Extensions sheet, each module that the tab would load says "off in this tab".
3. Turn off the module that breaks the app. Its server part still runs until you turn it off.
4. To leave safe mode, use the button in the Extensions sheet, or open the app with `?noext=0` (or `false`, `off`, or `no`).

The tab keeps safe mode when it loads again (in its session storage, `pocket.noext`). Other tabs do not. An app on a home screen has no address bar: open the address in the browser.

## Other sites

The page allows nothing from another site. The app's content security policy allows scripts and requests only to the app itself. To show data from another service, get it in a route on the server, where its key stays.

## See also

- [How tool calls show](tool-calls.md): `pocket.toolCall`.
- [Events](events.md): live updates from the server.
- [examples/server-status.js](../examples/server-status.js): a page on the rail, with a route and events.
