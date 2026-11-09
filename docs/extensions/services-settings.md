# Events, services, and settings

Since 0.22.0, modules can react to what happens in the app, build on each other, and have settings that the owner changes in the app. These parts are experimental: they can change in a minor release ([API versions](reference/api-versions.md)). Check that they are there to work with an older server:

```typescript
if (typeof host.on !== "function" || typeof web.provide !== "function") {
    return;
}
```

## Events

`host.on(event, listener)` calls `listener` each time something happens in the app ([reference](reference/host.md#on)):

| Event              | When                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ |
| `session.created`  | A session is made: by a person, a fork, a linked start, or a resend.                 |
| `session.renamed`  | A session gets a new title.                                                          |
| `session.archived` | A session is archived, or brought back.                                              |
| `message.sent`     | A person sends Pi a message, a steer or a queued one too.                            |
| `run.started`      | Pi starts to work in a session or a subagent.                                        |
| `run.ended`        | Pi stops: the run finished (`done`), gave up (`failed`), or was stopped (`aborted`). |

```typescript
web.onDispose(
    host.on("message.sent", ({ conversationId, by, text }) => {
        log.push({ conversationId, by, words: text.length });
    }),
);
```

- An event comes after the change is stored, and a listener runs after the work that caused it: it cannot stop or change that work. To stop a tool call, use a [hook](hooks.md).
- A listener that throws or rejects is logged; the others still run.
- PiP's conversation is its person's alone: it sends no events.
- `message.sent` has the words as stored: values that extensions hide are hidden there too ([People's values](people-values.md#hide-a-value)).

## Services

A module can offer an object to other modules, and use theirs. One module keeps a list of machines, say, and another opens ports on them.

```typescript
// machines.ts: offers what it knows.
web.provide({
    list: () => machines.map(({ id, name }) => ({ id, name })),
    sshArguments: (id: string) => argumentsFor(id),
});
```

```typescript
// ports.ts: uses it when it needs it.
type Machines = { list(): { id: string; name: string }[]; sshArguments(id: string): string[] };

const machines = () => {
    const service = web.use("machines") as Partial<Machines> | undefined;

    return typeof service?.list === "function" ? (service as Machines) : undefined;
};

web.route("GET", "machines", () => machines()?.list() ?? []);
web.onService("machines", () => web.send("machines-changed"));
```

- **A module provides one service**, while it loads. `web.use(name)` gives it by the module's name, while that module is on.
- **Ask for it each time.** A reload of the other module replaces its service, and turning it off removes it. Do not keep what `use` gave you in a variable for later.
- **Check its shape before you call it.** Another version of the module can offer another one. Say in your module's description which modules it works with, and which versions.
- **`web.onService(name, listener)`** tells you when the service comes, changes, or goes, so you can show or hide what depends on it.
- **A service runs with its module's code and rights.** Check what callers give it, as you check what a person gives a route.
- Modules load in order. The other one may load before yours, and its service is there while yours loads; or after, and it comes later. `onService` calls only for what changes after you start to listen, not for a service that is there already. So check `web.use(name)` as your module loads, and again in `onService`; or use the service only when you need it, in a route or a tool.

## Settings

A module declares its settings, and core does the rest: it keeps the owner's values, shows a form under the module in Menu → Extensions, and checks each value.

```typescript
web.settings([
    { name: "zone", label: "Time zone", type: "text", default: "UTC" },
    {
        name: "every",
        label: "Check every (minutes)",
        type: "number",
        default: 15,
        min: 1,
        max: 1440,
    },
    { name: "loud", label: "Notify each time", type: "boolean", default: false },
    {
        name: "region",
        label: "Region",
        type: "choice",
        default: "eu",
        choices: [
            { value: "eu", label: "Europe" },
            { value: "us", label: "United States" },
        ],
    },
    { name: "apiKey", label: "API key", type: "text", secret: true },
]);

const every = () => web.setting("every") as number;

web.onSettings(() => restartTimer(every()));
```

- **Types:** `boolean`, `text`, `number` (with `min` and `max`), and `choice`. Each has a `label`, a `description` if you want one, and a `default`.
- **Secrets:** a `text` setting with `secret: true` never leaves the server. The sheet shows only that it is set, and the owner can replace or clear it. Read it on the server with `web.setting`. It is kept in `config.json`, which the server keeps private (mode 0600), with the owner's token.
- **Only the owner changes settings.** Read them with `web.setting(name)` when you need them, and hear changes with `web.onSettings`.
- **In the browser:** `pocket.settings()` gives the values to the people whose tabs load the module, without secrets, and `pocket.onSettings(run)` hears changes.
- **Versions:** when a new version of the module drops a setting, its value goes at the next save. A value that no longer fits a changed field gives the default until the owner sets it again.

## Who can use what

A drop-in runs inside the server with the owner's rights ([the security model](policies/security-model.md#s1-a-drop-in-runs-with-the-owners-rights)). Pi Pocket does not limit which parts of `host` a module uses: a module that wanted more could import `node:fs` and read the data folder itself. So the parts above are not permissions. The protections are that every drop-in starts off, the owner turns it on, the gallery pins and checks its files, and the owner can read every file first (**Ask Pi to review**). Write what your module reads and uses in its description: the gallery's review checks that the code matches it.

## See also

- [The host reference](reference/host.md#events) and [the web reference](reference/web.md#provide).
- [People's values and the browser](people-values.md).
- [Limits](reference/limits.md#events-services-and-settings).
