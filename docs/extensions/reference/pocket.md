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

Adds a row in the App group of the menu. See [`MenuSpec`](#menuspec).

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

Adds a button on the left of the message box's row, after the app's own (Attach, the model, Plan). Send, Stop, the mic, and Steer, Queue and Interrupt stay on the right. See [`ComposerButtonSpec`](#composerbuttonspec).

### `replyAction`

```ts
replyAction(spec: ReplyActionSpec): Added<ReplyActionSpec>;
```

Since 0.19.0 · Experimental

Adds an action under Pi's answers, before More. Its `run` gets the answer, or its sheet gets it as the prop `reply`. See [`ReplyActionSpec`](#replyactionspec) and [`Reply`](#reply). The actions show under each finished answer, as the app's own (Discuss, Pin, Copy) do.

### `insertText`

```ts
insertText(text: string, options?: { inline?: boolean }): void;
```

Since 0.19.0 · Experimental

Puts text into the message box of the session that the tab shows, after what is there: on a new paragraph, or with `inline: true`, after a space. The person sends it, or not: it never sends. A sheet that shows closes, so the box shows. With no session open, it does nothing. Text past 100,000 characters throws.

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
};
```

Since 0.14.0 · Stable

A row in the App group of the menu.

- `id`: the row's id in the module.
- `label`: the row's words.
- `hint`: short words on the right of the row.

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

| Slot       | Ids, in their default order                                                                                                       | Fixed                                                                          | Modules' items go           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------- |
| `topbar`   | `core:subagents`, `core:changes`, `core:peeks`, `core:files`, `core:browser`, `core:artifacts`, `core:people`, `core:menu`        | `core:menu`, last                                                              | after `core:browser`        |
| `status`   | `core:connection`, `core:here`, `core:speed`, `core:context`, `core:cache`, `core:spend`, `core:guard`                            | `core:connection`, `core:guard`                                                | after `core:cache`          |
| `places`   | `core:files`, `core:changes`, `core:browser`, `core:artifacts`, `core:chat`, `core:find`, `core:branch`, `core:pip`, `core:peeks` | none                                                                           | last: a tile for each panel |
| `composer` | `core:places`, `core:attach`, `core:model`, `core:plan`                                                                           | none (Send, Stop, the mic, and Steer, Queue and Interrupt are not in the slot) | after `core:plan`           |
| `reply`    | `core:react`, `core:discuss`, `core:pin`, `core:copy`, `core:more`                                                                | `core:more`, last                                                              | before `core:more`          |

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
