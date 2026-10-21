# API versions

This page tells how Pi Pocket marks the age and the stability of each part of the extension API. It also tells how a module works with an older or a newer Pi Pocket. [API stability](../policies/api-stability.md) gives the rules for changes and for removals.

## The API version

`web.api` on the server and `pocket.version` in the browser give the version of the extension API. It is 1 now.

The version goes up only when a change breaks something that modules use. Additions do not change it.

## `pocketApi`

A module can export `pocketApi`: the server module, the browser module, or both.

```typescript
export const pocketApi = 1;
```

A Pi Pocket with an older API version does not set up such a module. It says why in the Extensions sheet.

The browser reads `pocketApi` after it imports the browser module. Thus keep the browser module's top level to declarations, and do its work in the default export.

## Since, Stable, Experimental, and Internal

Each member in the reference and in [types/pocket.d.ts](../../../types/pocket.d.ts) has two marks:

- **Since 0.14.0**: the first release of Pi Pocket that has the member. A pre-release counts as its release. In the types file, this is `@since`.
- **Stable**: the member changes only as the stability policy says.
- **Experimental**: the member can change, or go, in any minor release (`0.15.0`), but never in a patch release (`0.14.1`). See A4 and A14 in [API stability](../policies/api-stability.md#experimental). In the types file, this is `@experimental`. In 0.14.0, `host.linkedSessions` is the only experimental member.

Some members of the host are **internal**: only Pi Pocket's built-in modules use them. They are not in the types file. They can change in any release. [host](host.md#internal-members) lists them.

## Older and newer Pi Pocket

### Members that are new

Pi Pocket reloads a module when you edit it, but the host changes only when the server restarts. A module that uses a member that is new to the host must work without it until then. Check that the member is there, and do as before when it is not:

```typescript
if (typeof host.heldBack === "function") {
    // Use host.heldBack.
}
```

A module that calls a member that is not there fails at its first use, in all sessions.

### Pi Pocket before 0.14.0

A Pi Pocket before 0.14.0 knows neither `pocketApi` nor `web`. There, a module that adds to the app fails at its first `web.route` or `web.client`. The Extensions sheet shows the error.

### Gallery entries

A gallery entry gives `pocketApi` and `minPocket`: the API version and the oldest Pi Pocket that the extension needs. The gallery hides an entry that needs a newer API or a newer Pi Pocket. See [Gallery entry](gallery-entry.md#pocketapi).

## When each part came

Each member in the reference has its own Since line. These parts came together:

| Part                                               | Since  |
| -------------------------------------------------- | ------ |
| Built-in modules, the host, tools, sections, hooks | 0.1.0  |
| Drop-ins in the drop-in folder                     | 0.3.0  |
| `web`: routes, browser modules, events, cleanups   | 0.14.0 |
| `pocketApi`, `web.api`, and `pocket.version`       | 0.14.0 |
| Slash commands (`web.command`)                     | 0.14.0 |
| `pocket.toolCall`                                  | 0.14.0 |
| `host.linkedSessions`                              | 0.14.0 |
