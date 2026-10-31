# pocket

`pocket` is the app's API for a browser module: the argument of the browser module's default export. With it, a browser module adds rail buttons, menu rows, launcher actions, pages, sheets, panels, and status-line items, and sets how the calls of its tools show. It also calls its module's routes and gets its module's events. [Browser modules](../browser-modules.md) tells you how to write one, and what happens when it fails.

The types are `Pocket` and the types that it uses, in [types/pocket.d.ts](../../../types/pocket.d.ts). A browser module is JavaScript: [Types for your editor](types.md) tells you how to use the types in JSDoc.

## The browser module

### `default`

```ts
default(pocket: Pocket): void | (() => void) | Promise<void | (() => void)>;
```

Since 0.14.0 · Stable

The browser module's default export. The app imports the module and calls this function with `pocket`. When the function returns a function, that function runs when this version goes, as with `pocket.onDispose`.

### `pocketApi`

```ts
pocketApi?: number;
```

Since 0.14.0 · Stable

The version of the extension API that the browser module needs. An app with an older version does not set it up. The app reads it after it imports the module, so keep the module's top level to declarations. [API versions](api-versions.md) tells you more.

## About the module

### `version`

```ts
readonly version: number;
```

Since 0.14.0 · Stable

The version of the extension API. It is the same number as `web.api` on the server.

### `pocketVersion`

```ts
readonly pocketVersion: string | undefined;
```

Since 0.16.0 · Stable

The connected server's package version, from its server metadata. It can be `undefined` when a new browser connects to a server older than 0.16.0. It is not `pocket.version`, which remains the extension API level. This read-only value does not check for updates.

### `module`

```ts
readonly module: string;
```

Since 0.14.0 · Stable

The module's name: the name of its file without `.ts`.

### `title`

```ts
readonly title: string;
```

Since 0.14.0 · Stable

The module's title, as the Extensions sheet shows it.

## Drawing

These are the app's own Preact and htm. Use them, and not a copy of your own, so that your components draw as the app's components do.

### `h`

```ts
readonly h: typeof h;
```

Since 0.14.0 · Stable

Preact's `h`.

### `html`

```ts
html(strings: TemplateStringsArray, ...values: unknown[]): VNode | VNode[];
```

Since 0.14.0 · Stable

htm, bound to the app's Preact: write components as tagged templates, such as `` html`<p>${text}</p>` ``.

### `Fragment`

```ts
readonly Fragment: typeof Fragment;
```

Since 0.14.0 · Stable

Preact's `Fragment`.

### `useState`

```ts
readonly useState: typeof useState;
```

Since 0.14.0 · Stable

Preact's `useState` hook.

### `useEffect`

```ts
readonly useEffect: typeof useEffect;
```

Since 0.14.0 · Stable

Preact's `useEffect` hook.

### `useLayoutEffect`

```ts
readonly useLayoutEffect: typeof useLayoutEffect;
```

Since 0.14.0 · Stable

Preact's `useLayoutEffect` hook.

### `useRef`

```ts
readonly useRef: typeof useRef;
```

Since 0.14.0 · Stable

Preact's `useRef` hook.

### `useMemo`

```ts
readonly useMemo: typeof useMemo;
```

Since 0.14.0 · Stable

Preact's `useMemo` hook.

### `useCallback`

```ts
readonly useCallback: typeof useCallback;
```

Since 0.14.0 · Stable

Preact's `useCallback` hook.

### `useReducer`

```ts
readonly useReducer: typeof useReducer;
```

Since 0.14.0 · Stable

Preact's `useReducer` hook.

## Pieces

The app's own components, so that a module looks like the rest of the app.

### `Icon`

```ts
readonly Icon: FunctionComponent<IconProps>;
```

Since 0.14.0 · Stable

One of the app's icons by `name`, or an icon of your own by `path`. See [`IconProps`](#iconprops).

### `Spinner`

```ts
readonly Spinner: FunctionComponent<LoaderProps>;
```

Since 0.14.0 · Stable

The app's spinner. Screen readers read its `label`. See [`LoaderProps`](#loaderprops).

### `Loader`

```ts
readonly Loader: FunctionComponent<LoaderProps>;
```

Since 0.14.0 · Stable

The app's spinner with its `label` beside it, for a page or sheet that loads. See [`LoaderProps`](#loaderprops).

### `Markdown`

```ts
readonly Markdown: FunctionComponent<MarkdownProps>;
```

Since 0.14.0 · Stable

Shows Markdown. It cleans the HTML that it makes, as the app does for Pi's replies. See [`MarkdownProps`](#markdownprops).

### `Switch`

```ts
readonly Switch: FunctionComponent<SwitchProps>;
```

Since 0.14.0 · Stable

The app's on and off switch. See [`SwitchProps`](#switchprops).

## Who and where

### `me`

```ts
me(): Person | null;
```

Since 0.14.0 · Stable

The person who uses this tab, as `{ id, name, role }`, or `null` before sign-in.

### `conversationId`

```ts
conversationId(): number | null;
```

Since 0.14.0 · Stable

The id of the session that this tab shows, a number as in its address (`/s/12`), or `null` when it shows none.

### `openConversation`

```ts
openConversation(id: number | string): void;
```

Since 0.16.0 · Stable

Open a positive integer conversation id through normal app navigation. This closes the extension page and keeps normal Back behavior. Sheets close when changing conversations; call `pocket.closeSheet()` first to close your own sheet even when that conversation is already open. The server still checks access; an id grants no access. Invalid ids throw. Use a bound start's `session` or a human list item's `conversationId`, not a private app URL.

### `onConversation`

```ts
onConversation(listener: (conversationId: number | null) => void): () => void;
```

Since 0.20.0 · Experimental

Calls `listener` with the id of the session the tab shows, or null, at once, and again each time it changes: another session opens, the person goes to the list, or they lose access to it. Returns how to stop. It also stops when this version of the module goes. A listener that throws is logged, and the others go on.

### `messages`

```ts
messages(options?: MessagesOptions): Promise<MessagePage>;
```

Since 0.20.0 · Experimental

Reads a page of the people's messages in the session the tab shows, oldest first: Pi's answers, tool calls, and notes are not in it. With no `before`, it is the newest `limit` messages (50 by default, up to 200). The page's `before` is the cursor for the page before it, and null at the start. Read pages until `before` is null to have them all. The messages are those of the transcript: after a New context, the earlier ones are not in it.

The server checks the person's access to the session for each page. A page is from the session that the tab showed when it was asked for (`conversationId`): compare it with the one shown now before you use it. It rejects with an error whose `status` is 409 when its cursor is stale, as after a compaction: read again from the newest. Abort it with `signal`. With no session open, or from a version of the module that is gone, the page is empty. See [`MessagesOptions`](#messagesoptions), [`MessagePage`](#messagepage), and [`MessageInfo`](#messageinfo).

The text is what people wrote, and can hold anything they pasted. Keep it in memory only for as long as you show it, and show it as text, not HTML.

### `reveal`

```ts
reveal(id: string): Promise<boolean>;
```

Since 0.20.0 · Experimental

Scrolls the transcript of the session the tab shows to a message, and highlights it, as Find does. It loads earlier entries first when the transcript does not have them yet. A sheet that shows closes, so the transcript shows; the focus stays where it is, and with reduced motion on, it does not scroll smoothly. It resolves true once the message shows, and false when it cannot: it is not in this session's transcript, the session changed while it loaded, or a newer reveal (or a jump in the app) came first. Use the `id` of a [`MessageInfo`](#messageinfo). An id that is not a positive whole number throws.

```js
// An outline of the session's messages, in a sheet: each one jumps to its message.
pocket.sheet({
    id: "outline",
    title: "Outline",
    component() {
        const [messages, setMessages] = pocket.useState(null);

        pocket.useEffect(() => {
            const stop = new AbortController();

            pocket.messages({ limit: 200, signal: stop.signal }).then(
                (page) => setMessages(page.messages),
                () => setMessages([]),
            );

            return () => stop.abort();
        }, []);

        return messages === null
            ? pocket.html`<${pocket.Loader} />`
            : messages.map(
                  (message) =>
                      pocket.html`<button class="list-item" onClick=${() => pocket.reveal(message.id)}>
                          ${message.text.split("\n")[0]}
                      </button>`,
              );
    },
});
```

## Routes and events

### `api`

```ts
api<T = unknown>(
    path: string,
    body?: object,
    options?: { method?: WebMethod; signal?: AbortSignal },
): Promise<T>;
```

Since 0.14.0 · Stable

Calls one of the module's own routes, and gives the JSON that it returns.

- Without `body`, it sends a GET. With `body`, it sends a POST with `body` as JSON. `method` sets another method: `api("items/3", undefined, { method: "DELETE" })`.
- A query string in `path` goes to the handler's `query`: `api("usage?days=7")`.
- `signal` stops the call.
- When the server answers with an error, the promise rejects with an error that has the server's words and its `status`.
- It rejects at once for a path out of the module's routes: a path with a `.` or `..` part, a leading `//`, or a scheme such as `https:`.

### `on`

```ts
on<T = unknown>(event: string, run: (data: T) => void): () => void;
```

Since 0.14.0 · Stable

Calls `run` with the data of each `event` that the module sends with `web.send`. It returns a function: call it to stop. The app keeps no events for a page that is closed. Thus a page that opens must first get the data that is current, and then listen. [Events](../events.md) tells you more.

### `settings`

```ts
settings(): Promise<{ fields: SettingField[]; values: Record<string, SettingValue | null>; set: string[] }>;
```

Since 0.22.0 · Experimental

The module's settings ([`web.settings`](web.md#settings)) as the person in this tab may read them: the fields, each value (the owner's or the default), and which ones the owner set. A secret field's value is left out of `values`; `set` says whether it is set. It rejects with a 404 when the module declares no settings, or is off.

### `onSettings`

```ts
onSettings(run: () => void): () => void;
```

Since 0.22.0 · Experimental

Calls `run` after the owner changes the module's settings: read them again with `settings()`. It returns a function: call it to stop.

## Adding to the app

Each thing that a module adds has an `id` of its own. To add one with the same `id` again replaces it. [Names](names.md#what-a-browser-module-adds) gives the rules for ids.

What a module adds draws at the next frame, one time for all its changes since the last frame. Change what you added from an event, a timer, or an effect, and not while a component draws. A module that changes what it added each time that it draws is stopped in that browser. [Browser modules](../browser-modules.md) tells you about these rules.

### `rail`

```ts
rail(spec: RailSpec): Added<RailSpec>;
```

Since 0.14.0 · Stable

Adds a button on the rail, after the app's own tools. It shows in the sidebar, in the drawer, and on a phone's home screen. See [`RailSpec`](#railspec).

### `menu`

```ts
menu(spec: MenuSpec): Added<MenuSpec>;
```

Since 0.14.0 · Stable

Adds a row in the menu's App group by default. `group: "session"` puts it in the Session group, shown only when a session is open. The `group` field is experimental since 0.21.0. See [`MenuSpec`](#menuspec).

### `launcher`

```ts
launcher(spec: LauncherSpec): Added<LauncherSpec>;
```

Since 0.14.0 · Stable

Adds an action in the launcher (Ctrl+K, or ⌘+K). See [`LauncherSpec`](#launcherspec).

### `page`

```ts
page(spec: PageSpec): Added<PageSpec>;
```

Since 0.14.0 · Stable

Adds a page. A page shows in the place of the session, as the subagents board does. See [`PageSpec`](#pagespec).

### `sheet`

```ts
sheet<P extends object = object>(spec: SheetSpec<P>): Added<SheetSpec<P>>;
```

Since 0.14.0 · Stable

Adds a sheet, as the app's own sheets. See [`SheetSpec`](#sheetspec).

### `panel`

```ts
panel(spec: PanelSpec): Added<PanelSpec>;
```

Since 0.19.0 · Experimental

Adds a panel beside the conversation, in the place where the Browser and Files panels dock. One panel shows at a time: a panel that opens closes the Browser, Files, or People panel, and they close it. On a narrow screen it covers the conversation, and back closes it. The top bar (where there is room) and the places get a button that opens it. See [`PanelSpec`](#panelspec).

### `status`

```ts
status(spec: StatusSpec): Added<StatusSpec>;
```

Since 0.19.0 · Experimental

Adds an item in the status line under the message box, before the spend. With an action, the item is a button. On a line too narrow for one row, the item shows its `short` text, after "1 here" goes and before the guard loses its word. See [`StatusSpec`](#statusspec).

### `topbar`

```ts
topbar(spec: TopbarSpec): Added<TopbarSpec>;
```

Since 0.19.0 · Experimental

Adds a button in the top bar, after `core:browser` and before `core:artifacts`, `core:people`, and the menu. On a phone, and in a narrow pane, it goes from the top bar, as the Files button does. See [`TopbarSpec`](#topbarspec).

### `composerButton`

```ts
composerButton(spec: ComposerButtonSpec): Added<ComposerButtonSpec>;
```

Since 0.19.0 · Experimental

Adds a button on the left of the message box's row, after the app's own (Attach, the model, Plan). Send, Stop, the mic, and Steer, Queue and Interrupt stay on the right. In a narrow message box (a phone's), where they would push Send or Stop out of it, these buttons take a line of their own under the row: two or more up to 480 px wide, one up to 340 px. A single button in a box from 341 to 480 px wide stays in the row, and steps aside while Pi works, as the model chip does, so Stop stays in the row; it comes back when Pi stops. See [`ComposerButtonSpec`](#composerbuttonspec).

### `replyAction`

```ts
replyAction(spec: ReplyActionSpec): Added<ReplyActionSpec>;
```

Since 0.19.0 · Experimental

Adds an action under Pi's answers, before More. Its `run` gets the answer, or its sheet gets it as the prop `reply`. See [`ReplyActionSpec`](#replyactionspec) and [`Reply`](#reply). The actions show under each finished answer, as the app's own (Discuss, Pin, Copy) do.

### `sessionChips`

```ts
sessionChips(spec: SessionChipsSpec): Added<SessionChipsSpec>;
```

Since 0.20.0 · Experimental

Adds chips under the titles of rows in the session list, such as tags. Each row calls `chips` when it draws. Unchanged rows can skip a draw. See [`SessionChipsSpec`](#sessionchipsspec) and [`SessionChip`](#sessionchip). A row with chips is taller. The space beside them opens the session, as the row does.

### `sessionAction`

```ts
sessionAction(spec: SessionActionSpec): Added<SessionActionSpec>;
```

Since 0.20.0 · Experimental

Adds an action on sessions. It shows in the sheet that a finger held on a row opens, in the menu that a right-click on a row opens, and in the bar under the list while sessions are selected (Ctrl/⌘+click, or Select). Its `run` gets the ids of the sessions, or its sheet gets them as the prop `sessions`. See [`SessionActionSpec`](#sessionactionspec).

### `sessionFilter`

```ts
sessionFilter(spec: SessionFilterSpec): Added<SessionFilterSpec>;
```

Since 0.20.0 · Experimental

Adds a filter button in the session list's search field. The field keeps its room: the first 3 filters show, in the order that the server lists the modules, and only those filter the list. A tap does what the button does, such as open a sheet where a person chooses. A sheet opens over the drawer, which stays. While `match` is a function, the filter is on: the button is lit (`data-state="on"`), and the list shows only the sessions that `match` keeps, with every other filter that is on and the search. `update({ match: null })` turns it off. See [`SessionFilterSpec`](#sessionfilterspec).

### `sessionSearch`

```ts
sessionSearch(spec: SessionSearchSpec): Added<SessionSearchSpec>;
```

Since 0.20.0 · Experimental

Adds words that find sessions: the session list's search and the launcher match them after the title and the folder. A row that only a word matches shows the word after its title, and the launcher shows it in the result's details. See [`SessionSearchSpec`](#sessionsearchspec).

### `composerKey`

```ts
composerKey(spec: ComposerKeySpec): Added<ComposerKeySpec>;
```

Since 0.20.0 · Experimental

Adds a key in the message boxes: the session's and PiP's. It comes before the box's own keys, so it can take any of them, Enter too. While an input method composes text, keys go to it, not to modules. When two modules give the same key, the one earlier in the server's order of modules gets it. The Keyboard shortcuts sheet lists it with its `label`. Some keys never reach a page: in a browser tab, the browser keeps keys such as Ctrl+W, Ctrl+T, and Ctrl+N for itself. See [`ComposerKeySpec`](#composerkeyspec) and [`ComposerBox`](#composerbox).

```js
// Ctrl+W deletes the word before the caret, or the selection, as in a terminal.
pocket.composerKey({
    id: "delete-word",
    keys: "Ctrl+W",
    label: "Delete the word before the caret",
    run(box) {
        const start =
            box.start === box.end
                ? box.text.slice(0, box.start).replace(/\S+\s*$|\s+$/, "").length
                : box.start;

        box.set(box.text.slice(0, start) + box.text.slice(box.end), start);
    },
});
```

### `insertText`

```ts
insertText(text: string, options?: { inline?: boolean }): void;
```

Since 0.19.0 · Experimental

Puts text into the message box of the session that the tab shows, after what is there: on a new paragraph, or with `inline: true`, after a space. The person sends it, or not: it never sends. A sheet that shows closes, so the box shows. With no session open, it does nothing. Text past 100,000 characters throws.

### `pip`

```ts
readonly pip: PipApi;
```

Since 0.26.0 · Experimental

The part of `pocket` that talks to the person's PiP, their assistant. It has one method, `pip.ask`. See [`PipApi`](#pipapi).

### `arrange`

```ts
arrange(slot: SlotName, arrangement: Arrangement): { remove(): void };
```

Since 0.19.0 · Experimental

Hides or reorders the items of a slot, the app's own too, in the tabs that load the module. A second call for the same slot replaces the first. `remove` takes it back. When two modules arrange one slot, the one later in the server's order of modules wins. What a person chooses in Appearance → Layout wins over all modules: there, an item that a module hid says so, and the person can show it again. Fixed items always show, in their own places. See [Slots](#slots), [`SlotName`](#slotname), and [`Arrangement`](#arrangement).

### `toolCall`

```ts
toolCall<A = Record<string, unknown>>(spec: ToolCallSpec<A>): { remove(): void };
```

Since 0.14.0 · Stable

Sets how the calls of one of the module's own tools show in transcripts and peek tiles. Without it, a call shows as the tool's name, with its arguments as JSON. It goes with the version that added it. See [`ToolCallSpec`](#toolcallspec). [How tool calls show](../tool-calls.md) tells you more.

## Opening and closing

A module opens and closes only its own pages and sheets. A version that is gone, or that failed, opens and closes nothing.

### `openPage`

```ts
openPage(id: string): void;
```

Since 0.14.0 · Stable

Opens the module's page with this `id`. A sheet or the launcher over the page closes.

### `closePage`

```ts
closePage(): void;
```

Since 0.14.0 · Stable

Closes the module's page that shows, whichever page it is.

### `openSheet`

```ts
openSheet(id: string, props?: object): void;
```

Since 0.14.0 · Stable

Opens the module's sheet with this `id`. Its component gets the fields of `props`.

### `closeSheet`

```ts
closeSheet(): void;
```

Since 0.14.0 · Stable

Closes the module's sheet that shows.

### `openPanel`

```ts
openPanel(id: string): void;
```

Since 0.19.0 · Experimental

Opens the module's panel with this `id`. It takes the place of the panel that shows. A page, or a sheet or the launcher, closes so that the panel shows. With no session open, the panel shows when a session opens.

### `closePanel`

```ts
closePanel(): void;
```

Since 0.19.0 · Experimental

Closes the module's panel that shows, whichever panel it is.

## Notices, styles, and cleanups

### `notify`

```ts
notify(level: NoticeLevel, message: string): void;
```

Since 0.14.0 · Stable

Shows a notice, as the app's own notices: `"info"`, `"warning"`, or `"error"`. A module can show only a few notices in a short time, for all its versions together. Its actions that fail and its stylesheets that do not load count too. The app drops the rest. [Limits](limits.md#browser-modules) gives the numbers. A version that is gone, or that failed, shows none.

### `style`

```ts
style(path: string): void;
```

Since 0.14.0 · Stable

Loads a stylesheet from the browser module's folder, such as `pocket.style("look.css")`, into the app's own cascade layer (a theme's rules win over it). The stylesheet goes with this version. A path out of the folder throws. When the stylesheet does not load, a notice says so. A browser module that is one file has no folder, so it cannot load a stylesheet.

### `onDispose`

```ts
onDispose(dispose: () => void): void;
```

Since 0.14.0 · Stable

Runs `dispose` when this version goes: an edit replaces it, or the owner turns the module off. When the version is already gone, or failed, it runs `dispose` at once. The app does not wait for a browser cleanup: do at once what must be done.

## The objects you give

### `Action`

```ts
type Action =
    | { page: string; sheet?: never; panel?: never; run?: never }
    | { sheet: string; page?: never; panel?: never; run?: never }
    | { panel: string; page?: never; sheet?: never; run?: never }
    | { run: () => unknown; page?: never; sheet?: never; panel?: never };
```

Since 0.14.0 · Stable

What a rail button, a menu row, a launcher action, or a status item does when a person uses it. Give exactly one of these fields:

- `page`: the id of a page that the module adds. The button, row, or action opens it.
- `sheet`: the id of a sheet that the module adds. It opens it.
- `panel` (since 0.19.0, experimental): the id of a panel that the module adds. It opens it.
- `run`: a function that it calls. When the function throws, or its promise rejects, a notice says so.

A rail button or status item that opens a page or a panel shows when it is open. A second tap closes it.

Buttons, rows, and actions of modules show in the order in which the server lists the modules. An edit keeps the module's place.

### `RailSpec`

```ts
type RailSpec = Action & {
    id: string;
    title: string;
    icon?: string;
    iconPath?: string;
    badge?: number | string | null | false;
};
```

Since 0.14.0 · Stable

A button on the rail.

- `id`: the button's id in the module.
- `title`: the button's label.
- `icon`: the name of one of the app's icons, such as `pulse`, `grid`, `globe`, `key`, `chat`, `folder`, or `search`. An unknown name shows `grid`.
- `iconPath`: an icon of your own, as the `d` of a stroked SVG path in a 24 × 24 box.
- `badge`: a short count or word on the button. `0`, `NaN`, `-Infinity`, `""`, `"0"`, `null`, and `false` show no badge, as the app's own counts do at 0. A count that is too large shows a maximum with `+`. Long text is cut, also in the button's label, without cutting a character in two. [Limits](limits.md#browser-modules) gives the numbers.

Modules' rail buttons have a fixed height together. When they need more, they scroll.

### `MenuSpec`

```ts
type MenuSpec = Action & {
    id: string;
    label: string;
    hint?: string;
    group?: "app" | "session";
};
```

Since 0.14.0 · Stable

A row in the menu. It goes in the App group by default.

- `id`: the row's id in the module.
- `label`: the row's words.
- `hint`: short words on the right of the row.
- `group` (since 0.21.0 · experimental): `"app"` (the default) shows the row in the App group, including without a session. `"session"` shows it in the Session group only when a session is open. Older apps ignore the field and use the App group.

### `LauncherSpec`

```ts
type LauncherSpec = Action & {
    id: string;
    label: string;
    detail?: string;
    icon?: string;
    iconPath?: string;
    keywords?: string[];
};
```

Since 0.14.0 · Stable

An action in the launcher.

- `id`: the action's id in the module.
- `label`: the action's words.
- `detail`: a line under the label. The default is the module's title.
- `icon`, `iconPath`: the action's icon, as for a rail button.
- `keywords`: more words that find the action when a person types them.

### `PageSpec`

```ts
interface PageSpec {
    id: string;
    title: string;
    component: ComponentType<PageProps>;
    escape?: boolean;
    swipe?: boolean;
}
```

Since 0.14.0 · Stable

A page in the place of the session. It has its title and a close button. On a phone, it fills the screen.

- `id`: the page's id in the module.
- `title`: the page's title.
- `component`: what the page shows. It gets [`PageProps`](#pageprops).
- `escape`: with `false`, the page keeps Esc for itself. Esc still closes a sheet, the launcher, or PiP over the page. The close button and back still close the page.
- `swipe`: with `false`, no swipe on the page goes back, also at the screen's edge.

Esc and back close a page. Esc does not close it while an input method composes a character. On a narrow touch screen, a swipe to the right on the page goes back. This is not so in a field, or in an area that scrolls sideways. In an app added to the home screen of an iPhone or iPad, a swipe in from the left edge also goes back. A `data-no-swipe` attribute on an element stops the swipe on it and in it, for example on a slider. [Limits](limits.md#browser-modules) gives the width.

### `SheetSpec`

```ts
interface SheetSpec<P extends object = object> {
    id: string;
    title: string;
    component: ComponentType<SheetProps<P>>;
    wide?: boolean;
}
```

Since 0.14.0 · Stable

A sheet, as the app's own sheets.

- `id`: the sheet's id in the module.
- `title`: the sheet's title.
- `component`: what the sheet shows. It gets [`SheetProps`](#sheetprops).
- `wide`: with `true`, the sheet is wider.

A page or sheet can open with an id that the module never added. Then it says that the module no longer has it.

### `PanelSpec`

```ts
interface PanelSpec {
    id: string;
    title: string;
    component: ComponentType<PageProps>;
    icon?: string;
    iconPath?: string;
    badge?: number | string | null | false;
    wide?: boolean;
}
```

Since 0.19.0 · Experimental

A panel beside the conversation.

- `id`: the panel's id in the module.
- `title`: the panel's title, and the label of its buttons.
- `component`: what the panel shows. It gets [`PageProps`](#pageprops). The panel's body scrolls.
- `icon`, `iconPath`: the icon of its buttons, as for a rail button.
- `badge`: a short count or word on its buttons, as for a rail button.
- `wide`: with `true`, the panel takes more of the width beside the conversation.

The panel shows only in a session. The app keeps it open in the tab across a reload, and closes it when its module goes.

### `StatusSpec`

```ts
type StatusSpec = (Action | { page?: never; sheet?: never; panel?: never; run?: never }) & {
    id: string;
    text: string;
    short?: string;
    title?: string;
    tone?: "warn" | "error" | "muted";
    label?: string;
} & Placement;
```

Since 0.19.0 · Experimental

An item in the status line. Give one [`Action`](#action), or none for an item that only shows.

- `id`: the item's id in the module.
- `text`: what the item says, such as `"46W · 74° · 95%"`. Long text is cut, with "…". [Limits](limits.md#browser-modules) gives the length.
- `short`: what it says on a narrow line, such as `"46W"`. Without it, the item keeps `text`.
- `title`: its tooltip. On a touch screen, a tap on the line says it.
- `tone`: its color: `"warn"`, `"error"`, or `"muted"`, greyed, for a service that is out of reach.
- `label`: its name in Appearance → Layout. The default is the module's title.
- `before`, `after`: where it goes. See [`Placement`](#placement).

The items of modules show in the order in which the server lists the modules. Update an item from a timer or an event, not as a component draws.

### `Placement`

```ts
type Placement = { before?: string; after?: never } | { after?: string; before?: never };
```

Since 0.19.0 · Experimental

Where a status item, a top bar button, a message box button, or an action under answers goes in its slot: just before or just after the item with this id, such as `"core:spend"`. When that item is not there, or without either field, it goes in the place that the slot keeps for extensions. A person's order wins. [Slots](#slots) lists the ids.

### `TopbarSpec`

```ts
type TopbarSpec = Action &
    Placement & {
        id: string;
        title: string;
        icon?: string;
        iconPath?: string;
        badge?: number | string | null | false;
    };
```

Since 0.19.0 · Experimental

A button in the top bar. `title`, `icon`, `iconPath`, and `badge` are as for a rail button. A button that opens a page or a panel shows when it is open, and a second tap closes it.

### `ComposerButtonSpec`

```ts
type ComposerButtonSpec = TopbarSpec;
```

Since 0.19.0 · Experimental

A button in the message box's row, with the same fields as a top bar button.

### `Reply`

```ts
interface Reply {
    readonly id: string;
    readonly text: string;
    readonly conversationId: number;
}
```

Since 0.19.0 · Experimental

One of Pi's answers: its id in its session, its words as Markdown, and its session.

### `ReplyActionSpec`

```ts
type ReplyActionSpec = (
    { run: (reply: Reply) => unknown; sheet?: never } | { sheet: string; run?: never }
) &
    Placement & {
        id: string;
        label: string;
        icon?: string;
        iconPath?: string;
    };
```

Since 0.19.0 · Experimental

An action under Pi's answers: its `label`, an icon before it when you give one, and `run` or `sheet`. `run` gets the answer. The sheet gets it as the prop `reply`. When `run` throws or rejects, a notice says so.

### `SessionInfo`

```ts
interface SessionInfo {
    readonly id: number;
    readonly title: string;
    readonly cwd: string;
    readonly archived: boolean;
    readonly updatedAt: number;
}
```

Since 0.20.0 · Experimental

A session as the session list's extension points get it: its id, a number as in its address (`/s/12`), its title, its folder, whether it is archived, and when it last moved up the list, in milliseconds since 1970. It has the fields of [`WebSession`](web.md#websession), the server's view of the same session. It is a frozen copy.

### `SessionChip`

```ts
interface SessionChip {
    label: string;
    title?: string;
    run?: () => unknown;
}
```

Since 0.20.0 · Experimental

- `label`: its words. Past 32 characters, they are cut with "…".
- `title`: its tooltip. By default, its label.
- `run`: what a tap on it does, such as turn on a filter. A chip with `run` is a button. Without `run`, the chip only shows, and a tap on it opens the session.

### `SessionChipsSpec`

```ts
interface SessionChipsSpec {
    id: string;
    chips: (session: SessionInfo) => readonly SessionChip[];
}
```

Since 0.20.0 · Experimental

- `id`: the chips' id in the module.
- `chips`: the chips for a session. Up to 6 show for each module. The row calls it when it draws, so keep it fast, and do not call `pocket` in it. Unchanged rows can skip a draw. Read what it needs from the module's own state. When that state changes, give `update` a new function, so the list draws again: `added.update({ chips: (session) => chipsOf(session) })`.

A `chips` that throws stops its module in that browser, as a failed module stops.

### `SessionActionSpec`

```ts
type SessionActionSpec = (
    | { run: (sessions: readonly number[]) => unknown; sheet?: never }
    | { sheet: string; run?: never }
) & {
    id: string;
    label: string;
    access?: "steer" | "view";
    icon?: string;
    iconPath?: string;
};
```

Since 0.20.0 · Experimental

An action on sessions: its `label` (past 24 characters, cut with "…"), and `run` or `sheet`. By default (`access: "steer"`), only people who can steer see it. Give `access: "view"` for an action that changes nothing, which viewers may use too.

With `icon` or `iconPath`, the action is also a button on each row, beside archive, pin, and mark unread, where a mouse hovers or the keyboard focuses. Only the first such action gets a button: rows keep room for their titles. Touch screens use the row's sheet. `run` gets the ids of the sessions. The sheet gets them as the prop `sessions`. From the bar, they are the selected sessions that the list shows, and the selection then ends. From a row's sheet, it is that session. When `run` throws or rejects, a notice says so.

### `SessionFilterSpec`

```ts
type SessionFilterSpec = Action & {
    id: string;
    title: string;
    icon?: string;
    iconPath?: string;
    badge?: number | string | null | false;
    match?: ((session: SessionInfo) => boolean) | null;
    started?: (id: number) => unknown;
};
```

Since 0.20.0 · Experimental

A filter button. `title`, `icon`, `iconPath`, and `badge` are as for a rail button. It does one thing when tapped, as an [`Action`](#action) does.

- `match`: whether the list keeps a session. Only `true` keeps it. While it is a function, the filter is on. Null or no `match` turns it off. The list can reuse the result until its sessions, grouping, search, or extensions change. Keep it fast, and do not call `pocket` in it. When the module's filter state changes, give `update` a new function: `added.update({ match: (session) => matches(session) })`. A `match` that throws stops its module in that browser, and the list then shows the sessions again.

- `started`: runs when a person starts a session with **New** in the session list's head while the filter is on. It gets the new session's id, so the module can make the session meet the filter, as Session tags gives it the chosen tags. Other ways to start a session (the launcher, Alt+N, the rail) do not run it. When it throws or rejects, a notice says so.

The filter is in each tab that loads the module, not saved for the person: a module that wants its choices to last keeps them itself.

### `SessionSearchSpec`

```ts
interface SessionSearchSpec {
    id: string;
    words: (session: SessionInfo) => readonly string[];
}
```

Since 0.20.0 · Experimental

- `id`: the words' id in the module.
- `words`: the words for a session, up to 32, each up to 100 characters. The search lowercases them. It is called as people search, so keep it fast, and do not call `pocket` in it. Give `update` a new function when the words change.

### `MessagesOptions`

```ts
interface MessagesOptions {
    before?: string | null;
    limit?: number;
    signal?: AbortSignal;
}
```

Since 0.20.0 · Experimental

- `before`: the cursor that a page gave, for the messages before it. None or null: the newest.
- `limit`: how many messages, from 1 to 200. 50 by default. Others throw.
- `signal`: stops the read. The promise then rejects with an AbortError.

### `MessagePage`

```ts
interface MessagePage {
    readonly conversationId: number | null;
    readonly messages: readonly MessageInfo[];
    readonly before: string | null;
}
```

Since 0.20.0 · Experimental

- `conversationId`: the session that the tab showed when the page was asked for.
- `messages`: the messages, oldest first.
- `before`: the cursor for the page before this one, or null at the start.

### `MessageInfo`

```ts
interface MessageInfo {
    readonly id: string;
    readonly text: string;
    readonly clipped: boolean;
    readonly by: { readonly id: string | null; readonly name: string | null };
    readonly at: number | null;
}
```

Since 0.20.0 · Experimental

- `id`: the message's id, for `reveal`. Two messages with the same words have different ids, and an id names the same message after a reload, a restart, and a compaction. A fork's messages have ids of their own. Do not read meaning into it.
- `text`: what the person wrote, without the files attached to it: up to 1,000 characters.
- `clipped`: true when `text` was cut.
- `by`: who wrote it: their id and name, when known. A message from before Pi Pocket kept authors has neither.
- `at`: when it was sent, in milliseconds since 1970 on the server's clock, or null.

### `PipApi`

```ts
interface PipApi {
    ask(text: string, options?: { send?: boolean }): Promise<PipAskResult>;
}
```

Since 0.26.0 · Experimental

- `ask(text, options)`: gives PiP `text` as the person's own message. PiP sees it as it sees typed text.
    - The text starts with a line that names the module (`From the extension “Usage”:`), as an artifact's follow-up starts with its source. So the message never reads as a command, and the person and PiP know where it came from.
    - By default, it opens PiP and puts the text in PiP's message box, after what is there. The person reads it, edits it, and sends it, or not.
    - With `send: true`, it sends the text at once, but only just after the person tapped or pressed a key (other than Escape) anywhere in the app, as a tap serves an artifact's follow-up; it need not be on the module's own controls. One tap serves for 5 seconds and for one send, so ask only from the person's own action. Without a tap, nothing is sent or drafted, and the answer says why. If PiP cannot take the message (it is not ready, or the send fails), a notice says so and the text waits in the box.
    - It works for a person who has PiP. For anyone else, and while the app does not know yet, it does not throw: the answer is `{ ok: false, reason }`.
    - Text that is empty or past 100,000 characters throws, as `insertText` does.

### `PipAskResult`

```ts
type PipAskResult = { ok: true; sent: boolean } | { ok: false; reason: string };
```

Since 0.26.0 · Experimental

- `ok: true`: the text went to PiP. `sent` is true when it was sent, and false when it waits in PiP's message box.
- `ok: false`: nothing happened. `reason` says why, in words for a person: `"PiP is not available"`, `"Sending needs a click or a key press just before"`, or that the module's version is no longer loaded. Do not match on the words: they can change.

### `ComposerKeySpec`

```ts
interface ComposerKeySpec {
    id: string;
    keys: string | readonly string[];
    label: string;
    run: (box: ComposerBox) => unknown;
}
```

Since 0.20.0 · Experimental

- `id`: the key's id in the module.
- `keys`: the key, or a list of up to 8 ([limits](limits.md#the-session-list-and-message-boxes)). A key is modifiers and then a character or a named key, joined by `+`: `"Ctrl+W"`, `"Alt+Backspace"`, `"Mod+Shift+K"`. The modifiers are `Ctrl` (or `Control`), `Alt` (or `Option`), `Shift`, `Meta` (or `Cmd` or `Command`), and `Mod`, which is ⌘ on a Mac and Ctrl elsewhere. A key matches only with exactly its modifiers. The named keys are `Backspace`, `Delete` (or `Del`), `Enter` (or `Return`), `Tab`, `Escape` (or `Esc`), `Space`, the arrows (`ArrowUp` or `Up`, `ArrowDown` or `Down`, and so on), `Home`, `End`, `PageUp`, `PageDown`, `Insert`, and `F1` to `F12`. With Alt, a letter or a digit also matches by its place on the keyboard, because Option on a Mac types another character.
- `label`: what it does, for the Keyboard shortcuts sheet.
- `run`: runs when the key is pressed in a box, with the box. Return `false` to let the key through, to the box and then the browser. Anything else takes the key: the box does nothing more with it. An async `run` takes it. When `run` throws, the key goes through, and a notice says so, as when it rejects.

### `ComposerBox`

```ts
interface ComposerBox {
    readonly where: "session" | "pip";
    readonly text: string;
    readonly start: number;
    readonly end: number;
    set(text: string, start?: number, end?: number): void;
}
```

Since 0.20.0 · Experimental

- `where`: the session's message box, or PiP's.
- `text`, `start`, `end`: the box's text and selection when the key came. With nothing selected, `start` and `end` are the caret.
- `set`: writes new text, as typing does, so the box keeps it as its draft. It puts the caret at `start` (by default, the end of the text), or selects from `start` to `end`. Text past 1,000,000 characters throws.

### `SlotName`

```ts
type SlotName = "topbar" | "status" | "places" | "composer" | "reply";
```

Since 0.19.0 · Experimental

A slot: `"topbar"`, the buttons after the session's title; `"status"`, the status line under the message box; `"places"`, the tiles in the places and at the top of the menu; `"composer"`, the buttons on the left of the message box's row; or `"reply"`, the actions under Pi's answers.

### `Arrangement`

```ts
interface Arrangement {
    hide?: string[];
    order?: string[];
}
```

Since 0.19.0 · Experimental

- `hide`: the ids of items to hide. Fixed items do not hide.
- `order`: ids of items in the order they show. The items in it take the places that those items had, in this order. The other items stay in their places, and so does an item that comes later. Fixed items do not move.

An id that is not in the slot does nothing.

## Slots

A slot is a place in the app that is a list of named items: the app's own items and those of modules. Each item has an id. The app's items are `core:…`. A module's items are `ext:<module>:<id>`, with the `id` that the module gave: a panel's top bar button has the panel's id. The ids of the app's items are kept as the theme surface's names are ([API stability](../policies/api-stability.md)).

What shows comes in layers, the last one wins: each item's default place, then the `before` or `after` of a module's own item, then each module's `arrange`, then the person's own choices in Appearance → Layout. These are kept in the browser.

| Slot       | Ids, in their default order                                                                                                                                        | Fixed                                                                          | Modules' items go           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------- |
| `topbar`   | `core:subagents`, `core:changes`, `core:peeks`, `core:files`, `core:browser`, `core:artifacts`, `core:people`, `core:menu`                                         | `core:menu`, last                                                              | after `core:browser`        |
| `status`   | `core:connection`, `core:here`, `core:speed`, `core:context`, `core:cache`, `core:spend`, `core:background`, `core:guard`                                          | `core:connection`, `core:guard`                                                | after `core:cache`          |
| `places`   | `core:files`, `core:changes`, `core:browser`, `core:artifacts`, `core:chat`, `core:find`, `core:launcher` (touch screens), `core:branch`, `core:pip`, `core:peeks` | none                                                                           | last: a tile for each panel |
| `composer` | `core:places`, `core:attach`, `core:model`, `core:plan`                                                                                                            | none (Send, Stop, the mic, and Steer, Queue and Interrupt are not in the slot) | after `core:plan`           |
| `reply`    | `core:time`, `core:react`, `core:discuss`, `core:pin`, `core:copy`, `core:more`                                                                                    | `core:more`, last                                                              | before `core:more`          |

The `core:time` item shows a completed reply's stored message time. Appearance → Layout can hide or move it.

An item that has nothing to show now shows nothing, wherever it is: Changes with no changes, the cache before the first answer, a quiet button.

### `PageProps`

```ts
interface PageProps {
    pocket: Pocket;
    close(): void;
}
```

Since 0.14.0 · Stable

What the component of a page or sheet gets.

- `pocket`: the `pocket` of the version that added the page or sheet.
- `close`: closes this page or sheet, of this version, while it shows. When you call it later, it closes nothing else. To close whichever page of the module shows, use `pocket.closePage()`.

### `SheetProps`

```ts
type SheetProps<P extends object = object> = P & PageProps;
```

Since 0.14.0 · Stable

What a sheet's component gets: the fields of the `props` that `openSheet` gave, and `pocket` and `close`.

### `ToolCallSpec`

```ts
interface ToolCallSpec<A = Record<string, unknown>> {
    tool: string;
    icon?: string;
    iconPath?: string;
    label: (args: A) => string;
    subject?: (args: A) => string;
    summary?: (args: A) => CallSummary;
}
```

Since 0.14.0 · Stable

How the calls of one tool show, from their arguments.

- `tool`: the tool's name, exactly as Pi calls it. The tool must be one that the module's own extensions install. The app refuses any other tool, so no module changes how the calls of another module show. With a server that is too old to list the module's tools, `toolCall` does nothing.
- `label`: the words of the call's line, such as `"start session"`.
- `subject`: what the call acts on.
- `summary`: how a group of calls counts this call. See [`CallSummary`](#callsummary).
- `icon`, `iconPath`: the call's icon in peek tiles, as for a rail button.

Each function gets a copy of the call's arguments. What it returns shows as one line of text, never as HTML. When a function throws, or returns something that is not text, the call shows the default way. The browser's console has the error.

### `CallSummary`

```ts
interface CallSummary {
    verb: string;
    noun?: string;
    by?: string;
}
```

Since 0.14.0 · Stable

How a group of calls counts a call. The calls count by the values of their argument `by`. For example, `{ verb: "messaged", noun: "session", by: "to" }` gives "messaged 2 sessions" for calls to two addresses, however many calls there are. Without `noun`, the group shows only the verb, such as "checked linked sessions".

### `Added`

```ts
interface Added<S> {
    update(patch: Partial<S>): void;
    remove(): void;
}
```

Since 0.14.0 · Stable

What `rail`, `menu`, `launcher`, `page`, and `sheet` return.

- `update`: changes the fields in `patch`. An update that changes nothing draws nothing again. Values count as the same only when they are the very same value: a new array or function is a change.
- `remove`: removes what was added.

## The props of the pieces

### `IconProps`

```ts
interface IconProps {
    name?: string;
    path?: string;
    size?: number;
}
```

Since 0.14.0 · Stable

- `name`: the name of one of the app's icons.
- `path`: an icon of your own, as for `iconPath`.
- `size`: its width and height, in pixels.

### `LoaderProps`

```ts
interface LoaderProps {
    label?: string;
}
```

Since 0.14.0 · Stable

The props of `Loader` and `Spinner`. `label` says what loads, in words.

### `MarkdownProps`

```ts
interface MarkdownProps {
    text: string;
}
```

Since 0.14.0 · Stable

`text` is the Markdown to show.

### `SwitchProps`

```ts
interface SwitchProps {
    on: boolean;
    label: string;
    onChange: () => void;
    disabled?: boolean;
}
```

Since 0.14.0 · Stable

- `on`: whether the switch is on.
- `label`: the switch's name, for screen readers.
- `onChange`: runs when a person turns the switch. Set `on` again from it.
- `disabled`: with `true`, nobody can turn the switch.

## CSS names Pi Pocket keeps

To look like the app, use its colors and classes. The colors follow the theme. Pi Pocket keeps these names. The rest of its CSS can change. These names are a subset of [the theme surface](theme-surface.md#extensions-css-names), the one full list of the tokens, parts, and states Pi Pocket keeps.

- Colors: `var(--text)`, `var(--muted)`, `var(--accent)`, `var(--bg)`, `var(--card)`, `var(--line)`, `var(--err)`, `var(--warn)`, and `var(--ok)`.
- Classes: `button` (with `primary`), `error-box`, `muted`, `small`, `mono`, and `setting` (a row with a label and a control).
