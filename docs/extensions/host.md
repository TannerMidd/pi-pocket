# Using the host

The host is the first argument of a module's default export. A module gets the app's services only through the host, and adds to the app through `web` ([Adding to the app](app.md)). The host stays the same while modules load again. Its members are in [the host reference](reference/host.md).

## Public and internal members

[The host reference](reference/host.md) lists the public members, and the types file has them. The host has more members, for Pi Pocket's built-in modules only, such as `pip`, `gallery`, and `memory`. They are internal: they are not in the types file, and they can change in any release. Do not use them in a drop-in ([API stability](policies/api-stability.md)).

## Text from other places

Text from a web page, an issue, or a file that a person did not write can try to steer Pi. Before you put such text in a prompt section or a tool's result, make it safe with `host.text`, and tell Pi in the same place that it is data:

- `host.text.quoted(text, max)` gives one line in quotes that the text cannot close. It removes invisible characters and tags, and cuts the line to `max` characters, or to a [default length](reference/limits.md#host).
- `host.text.defang(text)` keeps the lines, but leaves no closing tag in them. Use it for text that you put between tags of your own.

## Check for new members

Pi Pocket loads a module again while the server runs, but the host changes only when the server restarts. So a module can run on a server whose host does not have a member yet.

A module that uses a new member must work without it until the restart:

```typescript
const held = typeof host.heldBack === "function" ? host.heldBack(conversationId) : undefined;
```

A module that calls a member that is not there fails when it first uses it, in each session.

## Model requests

`host.shapeModelRequests(shape)` lets a module shape what every model call sends, after Pi and the caller built the request. Return a replacement payload, or nothing to keep it. The effect lasts until you call the returned function, so pass that to `host.onDispose`.

A shaper can change what a provider bills, or how it answers. Tell the owner that before you ask them to turn the module on.

## Types

To get the types of the host in your editor, import them from `_pocket.d.ts`. Pi Pocket links this file into the drop-in folder:

```typescript
import type { Host, Web } from "./_pocket.d.ts";

export default function createMyModule(host: Host, web: Web) {
    // …
}
```

Use `import type`. Node removes this import when the module runs, so the path only matters to your editor and the type checker. See [Types for your editor](reference/types.md).
