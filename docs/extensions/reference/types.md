# Types for your editor

[types/pocket.d.ts](../../../types/pocket.d.ts) has the types of Pi Pocket's public extension API. With it, your editor completes names and finds mistakes, and Pi reads the exact shapes. The reference pages give the same members in words.

## Get the types

Use one of these:

1. **`_pocket.d.ts` in the drop-in folder.** Pi Pocket makes this link to its types file each time that it starts, beside the `node_modules` link. Its leading `_` keeps it from loading as a module. The same import then works on all machines. If you point the link at another readable file, such as your own checkout's types, Pi Pocket leaves it as it is. A file of your own with this name also stays.
2. **The path in Pi Pocket's folder:** `/path/to/pi-pocket/types/pocket.d.ts`.
3. **The copy on the documentation site:** `https://tannermidd.github.io/pi-pocket/docs/pocket.d.ts`. It is for the latest release.

Where Pi Pocket cannot make links (on Windows, or when the system refuses them), `_pocket.d.ts` is a copy of the types file instead. Its first line says so, and Pi Pocket refreshes it at each start when the types change. Do not edit it.

## Import the types

Use `import type`. Node removes it, so the import has no effect when the module runs:

```typescript
import type { Host, Web } from "./_pocket.d.ts";

export default function setup(host: Host, web: Web) {
    web.route("GET", "status", () => ({ folder: host.dataDir }));
}
```

Do not write `import { type Host }`. The gallery's check reads that form as an import that runs, and it refuses a drop-in that imports a file that is not its own.

A browser module is JavaScript. Give the types in JSDoc:

```javascript
/** @param {import("./_pocket.d.ts").Pocket} pocket */
export default function setup(pocket) {
    pocket.rail({ id: "usage", title: "Usage", icon: "pulse", run: () => {} });
}
```

From a browser module in a folder, the path is `../_pocket.d.ts`.

The types file imports types from Pi Durable, Pi AI, and Preact by package name. The drop-in folder's `node_modules` link gives them.

`tsc` skips `<name>.js` when there is a `<name>.ts`. To check both with `tsc`, put the browser module in the folder `<name>/`. An editor checks each file that you open.

## What the types file has

- [`Host`](host.md) and the types that it uses: `SafeText`, `LinkedSessions`, and `LinkedSession`.
- [`Web`](web.md) and the types that it uses: `WebAccess`, `WebMethod`, `WebHandler`, and `WebRequest`.
- [`Command`, `CommandContext`, and `CommandResult`](command-context.md).
- [`Pocket`](pocket.md) and the types that it uses: `BrowserModule`, `Action`, the objects that you give (`RailSpec`, `MenuSpec`, `LauncherSpec`, `PageSpec`, `SheetSpec`, `ToolCallSpec`, `CallSummary`), `Added`, `PageProps`, `SheetProps`, and the props of the pieces.
- `Module`, `PocketExtension`, `PocketUiLocale`, `Person`, `Role`, and `NoticeLevel`, on this page.

The types file does not have the internal members of the host. It does not have Pi Durable's own API either: import `defineExtension`, `defineTool`, and the rest from `@earendil-works/pi-durable`.

Each member has `@since`, and `@experimental` when it applies. [API versions](api-versions.md) tells you what these mean.

## The module

### `Module`

```ts
interface Module {
    default(host: Host, web: Web): Extension | readonly Extension[] | void | Promise<…>;
    pocketApi?: number;
}
```

Since 0.1.0 · Stable

A module: one `.ts` file that default-exports a setup function. [Modules, loading, and errors](../modules.md) tells you how Pi Pocket loads it.

### `default`

```ts
default(host: Host, web: Web): Extension | readonly Extension[] | void | Promise<Extension | readonly Extension[] | void>;
```

Since 0.1.0 · Stable

Sets up the module. It gets the [host](host.md) and [`web`](web.md). It returns the module's extensions: one, a list, or nothing when the module only adds to the app. It can be async. Pi Pocket 0.14.0 added `web`, async setup, and modules that return nothing.

The returned extension may also include `uiLocales`, a list of validated, data-only UI translation packs. They translate only explicit `t()` calls; missing entries remain English. Packs do not run browser code, add routes, or enable the module. This API is experimental until released; see [UI locale packs](../../extensions.md#ui-locale-packs-data-only).

### `PocketExtension`

```ts
type PocketExtension = Extension & {
    readonly uiLocales?: readonly PocketUiLocale[];
};
```

Experimental · Not yet released

Pi Pocket's extension shape, with optional locale data. It wraps an ordinary Pi Durable `Extension`.

### `PocketUiLocale`

```ts
interface PocketUiLocale {
    readonly locale: string;
    readonly label: string;
    readonly default?: boolean;
    readonly strings: Readonly<Record<string, string>>;
    readonly templates?: Readonly<Record<string, string>>;
}
```

Experimental · Not yet released

A canonical language tag and data-only dictionaries. `strings` holds exact source strings without parameters; `templates` holds exact source strings with named `{{placeholders}}`. The loader validates their shapes and enforces placeholder parity. Dynamic values are inserted without translation. See [UI locale packs](../../extensions.md#ui-locale-packs-data-only) for full semantics and limits.

### `pocketApi`

```ts
pocketApi?: number;
```

Since 0.14.0 · Stable

The version of the extension API that the module needs. A Pi Pocket with an older version does not set up the module. See [API versions](api-versions.md#pocketapi).

## Shared types

### `Person`

```ts
interface Person {
    readonly id: string;
    readonly name: string;
    readonly role: Role;
}
```

Since 0.14.0 · Stable

A person: the person who sent a request (`request.user`), who ran a command (`ctx.user`), or who uses a tab (`pocket.me()`).

- `id`: the person's id. `web.send(event, data, { to: id })` sends to this person's tabs.
- `name`: the person's name, as the app shows it.
- `role`: the person's role.

### `Role`

```ts
type Role = "owner" | "guest" | "viewer";
```

Since 0.14.0 · Stable

A person's role. The [Glossary](glossary.md#owner) tells what each role can do.

### `NoticeLevel`

```ts
type NoticeLevel = "info" | "warning" | "error";
```

Since 0.1.0 · Stable

How important a notice is.

## How Pi Pocket keeps the types correct

Pi Pocket's checks fail when the types file and its code do not agree:

- In `npm run check`, `test/public-types.ts` compares the real host, `web`, and command context with the public types, in both directions. It also fails for a new host member that is neither in the types file nor in its list of internal members.
- In `npm run check`, `test/types-file.ts` checks the types file itself.
- In `npm test`, `test/extension-ui.test.ts` compares the members of the real `pocket` with `Pocket`.

A change that adds a member also adds it to the types file, with `@since`, and to its reference page.
