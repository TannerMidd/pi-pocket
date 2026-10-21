# Adding to the app

A module can add to the app what a tool cannot: a page that shows something without Pi, a button on the rail, or a row in the menu. This page tells about the three parts that it can add. The members of `web` are in [the web reference](reference/web.md).

## The three parts

The second argument of the default export, `web`, registers these parts while the module loads:

- **Routes** on the server, under `/api/x/<module>/`. The browser module calls them. Keys and other secrets stay on the server. See [Routes](routes.md).
- **A browser module**: a `.js` file that the app loads in the tabs of the people that it is for. Through `pocket`, the app's API for extensions, it adds rail buttons, pages, sheets, menu rows, and launcher actions, and says how its tools' calls show. See [Browser modules](browser-modules.md).
- **Commands** for the message box (`/name`). They run on the server, and need no browser module. See [Slash commands](commands.md).

```typescript
import type { Host, Web } from "./_pocket.d.ts";

export default function createUsage(_host: Host, web: Web) {
    web.route("GET", "usage", async ({ signal }) => fetchUsage(signal)); // GET /api/x/usage/usage
    web.client("usage.js"); // the browser module beside this file
}
```

[examples/server-status.ts](../examples/server-status.ts) and [examples/server-status.js](../examples/server-status.js) are a complete module with a route, a page, and events.

## The module's name

What a module adds to the app goes by the name of its file. For example, `server-status.ts` has the name `server-status`. Its routes are at `/api/x/server-status/`, and its browser module at `/x/server-status/`.

File names are different across the drop-in folder and the built-in modules, so these addresses never collide. A module that adds to the app must have a name of letters, digits, `-`, and `_`, that starts with a letter or a digit, up to a [length](reference/limits.md#names).

## Versions

The three parts install and go with the module's extensions:

- An edit replaces them in one step.
- When a new version does not load, the parts of the version before stay.
- When the owner turns the module off, Pi Pocket removes them, and closes a page of the module that is open.
