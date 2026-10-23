# web

`web` is the second argument of a module's default export. With it, a module adds to the app what a tool cannot: routes on the server, a browser module, and commands for the message box. [Adding to the app](../app.md) tells you how the parts work together.

Register routes, the browser module, and commands while the module loads. After that, these calls throw. What you register goes when this version of the module goes: an edit replaces it, or the owner turns the module off.

The types are `Web` and the types that it uses, in [types/pocket.d.ts](../../../types/pocket.d.ts).

## About the module

### `api`

```ts
readonly api: number;
```

Since 0.14.0 · Stable

The version of the extension API. [API versions](api-versions.md) tells you when it changes.

### `module`

```ts
readonly module: string;
```

Since 0.14.0 · Stable

The module's name: the name of its file without `.ts`. The routes of `server-status.ts` are under `/api/x/server-status/`.

## Registering

### `route`

```ts
route(method: WebMethod, path: string, handle: WebHandler, options?: { access?: WebAccess }): void;
```

Since 0.14.0 · Stable

Adds a route at `/api/x/<module>/<path>`. `handle` answers its requests.

- `method` is a [`WebMethod`](#webmethod).
- `path` is relative to the module's routes: `"status"`, or `"items/:id"`. A part written `:name` matches any one part of the address. [Names](names.md#routes) gives the characters that a part can have.
- When paths overlap, the most specific path answers, whatever the order of registration. From the left, a fixed part comes before a `:name` part: `items/new` comes before `items/:id`.
- `access` says who can use the route. The default is `"owner"`. See [`WebAccess`](#webaccess).
- A method and a path of the same shape can have only one route.

[Routes](../routes.md) tells you about the checks that come before a handler, errors, and what to check in a handler.

### `conversationRoute`

```ts
conversationRoute(
    method: WebMethod,
    path: string,
    handle: (request: ConversationWebRequest) => unknown,
    options: { conversation: string; access?: WebAccess },
): void;
```

Since 0.16.0 · Stable

Register a route with an authorized conversation binding. `conversation` names a required path parameter, without `:`: for `"runs/:source"`, use `{ conversation: "source" }`. Registration refuses a name not in the path. All ordinary route access and header checks still apply; people invited to one session cannot use it. Before the handler runs, GET requires seeing the actual source; other methods also require steering and the turn. Missing, invalid, private PiP, or inaccessible sources never reach the handler. Check `typeof web.conversationRoute === "function"` on older servers.

### `client`

```ts
client(entry: string, options?: { access?: WebAccess }): void;
```

Since 0.14.0 · Stable

Sets the module's browser module. A module has one browser module at most.

- `entry` is the name of a file or folder immediately beside the module. It must not be a link. [Names](names.md#browser-modules) gives the characters that it can have.
- A `.js` or `.mjs` file is served alone.
- A folder must have an `index.js`, which loads first and can import the other files of the folder.
- `access` says whose tabs load it. The default is `"owner"`. See [`WebAccess`](#webaccess).

[Browser modules](../browser-modules.md) tells you which files a folder serves, and when tabs load a new version.

### `command`

```ts
command(name: string, command: Command): void;
```

Since 0.14.0 · Stable

Adds the command `/name` to the message box, for the people who can run it. The command runs on the server, and it does not ask Pi.

- [Names](names.md#commands) gives the rules for `name`.
- [Command context](command-context.md) gives the fields of `command` and what its handler gets and returns.
- [Slash commands](../commands.md) tells you who can run a command, how a run is kept, and how a person stops it.

## Sending and answering

### `send`

```ts
send(event: string, data?: unknown, options?: { to?: string }): void;
```

Since 0.14.0 · Stable

Sends an event to the browser module. There, `pocket.on(event, run)` gets it.

- `data` is a value that JSON can hold.
- Without `to`, the event goes to the tabs of all the people that the browser module's `access` lets in. With `to`, it goes only to the tabs of the person with that id.
- Send events only after the module has loaded, and only from a module that has a browser module. Other events go nowhere.
- `send` never throws, because modules call it mostly from timers. When it cannot send an event, it writes the reason to the server's log, one time for each kind of mistake in a version.

[Events](../events.md) tells you about the limits, and about tabs that fall behind.

### `error`

```ts
error(status: number, message: string): Error;
```

Since 0.14.0 · Stable

Makes an error for a route or a command handler to throw: `throw web.error(404, "No such item")`. The person who asked gets `status` and `message` as they are. `status` is from 400 to 599.

Do not put text in `message` that this person must not see. Any other error that a handler throws gives a status of 500, and only the owner sees its words.

### `onDispose`

```ts
onDispose(dispose: () => unknown): void;
```

Since 0.14.0 · Stable

Runs `dispose` when this version of the module goes: an edit replaces it, the owner turns it off, or the server stops. Stop timers and close connections there. `dispose` can return a promise. [Cleanups](../cleanups.md) tells you how long a stopping server waits for it.

## Requests

### `WebHandler`

```ts
type WebHandler = (request: WebRequest) => unknown;
```

Since 0.14.0 · Stable

Answers the requests of a route. The value that it returns goes back as JSON, and `undefined` goes back as `{}`. It can be async.

### `WebRequest`

```ts
interface WebRequest {
    readonly method: WebMethod;
    readonly params: Readonly<Record<string, string>>;
    readonly query: URLSearchParams;
    readonly body: Readonly<Record<string, unknown>>;
    readonly user: Person;
    readonly signal: AbortSignal;
    readonly snapshot: DocumentReader["snapshot"];
    readonly context: Context;
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
    sessions(): readonly WebSession[];
}
```

Since 0.14.0 · Stable

What a handler gets.

- `method`: the request's method.
- `params`: the values of the path's `:name` parts, by name. They are text from outside: check a value before you make a file path from it.
- `query`: the query string. `pocket.api("usage?days=7")` sends `days`.
- `body`: the JSON object that the browser sent. It is empty for GET and DELETE.
- `user`: the person who asked, as `{ id, name, role }`.
- `signal`: it aborts when the browser stops waiting for the answer, not on normal handler return. Give it to the work that the handler waits for.
- Since 0.16.0, `snapshot` reads fresh committed documents with `context`. Its `context.abortSignal` is cancelled on disconnect or handler return, independently of the older `signal`. `commit` changes the module's own documents atomically and returns the callback's answer. Follow the `x.<module>.…` naming rule. Viewers cannot commit, even through a GET open to `view`.
- Document operations recheck the current person. Retaining a request, its context, or a callback does not extend its lifetime: commits after disconnect or handler return are refused, and an unfinished callback rolls back. Await all writes before returning. These APIs are for module documents, not core's internal documents or a way to start model work.
- An unbound catalog save has no source plan, turn, or spend checks. A bound commit also requires the source's current steering and turn rights.
- Since 0.20.0 (experimental), `sessions()` gives the sessions that the person who asked can see now, as their session list shows them, archived ones too. See [`WebSession`](#websession). Use it to check the ids that a browser sends, and to keep data about sessions from people who cannot see them. Each call reads the list again.

### `WebSession`

```ts
interface WebSession {
    readonly id: number;
    readonly title: string;
    readonly cwd: string;
    readonly archived: boolean;
    readonly updatedAt: number;
}
```

Since 0.20.0 · Experimental

A session in a person's session list: its id, a number as in its address (`/s/12`), its title, its folder, whether it is archived, and when it last moved up the list, in milliseconds since 1970. It has no subagents, and no PiP's conversation.

### `ConversationWebRequest`

```ts
interface ConversationWebRequest extends WebRequest {
    readonly conversation: {
        readonly id: ConversationId;
        readonly title: string;
        readonly cwd: string;
        readonly model?: ModelRef;
        readonly thinkingLevel: ModelThinkingLevel;
    };
    readonly linkedSessions: HumanLinkedSessions;
}
```

Since 0.16.0 · Stable

Authoritative source metadata, plus request-lifetime human linked-session capabilities. An omitted `model` means the source has none. Metadata is a snapshot, not a promise that settings cannot change. A start rejects a source model, thinking level, or folder changed while it waits.

### `HumanLinkedSessions`

```ts
interface HumanLinkedSessions {
    start(
        request: {
            title?: string;
            message: string;
            model?: string;
            thinking?: ModelThinkingLevel;
            cwd?: string;
        },
        key: string,
    ): Promise<{ session: ConversationId; address: string }>;
    list(): Promise<HumanLinkedSession[]>;
}
```

Since 0.16.0 · Stable

`cwd` is since 0.19.0. It names an existing folder for the new session, as in [`host.linkedSessions.start`](host.md#linkedsessions). A blank `cwd` counts as no `cwd`. A relative `cwd` resolves against the folder of the server process, not the folder of the source. An older Pi Pocket ignores it.

- `start` acts as the authenticated person and bound source, never the source's last requester. There is no actor override. Current seeing, steering, turn, plan, spend, team, model allow-list, and provider checks apply. The person must see all sessions to start one.
- Explicit `thinking` must be supported and no higher than the source's level; it is never silently lowered. Omission inherits with the existing model cap policy. Use `host.modelInfo` for effective choices.
- Use a stable, module-namespaced key. A receipt belongs to the same clicking person; a key recorded for someone else is a 409. Starts and their initial message reuse the existing linked-session receipt and request ids. No source message or source attribution is changed.
- `list` returns only linked sessions the clicking person can see. GET needs seeing, not driving. It exposes ids for human navigation, not for a model transcript. Other metadata keeps the shared-audience rule.
- Both methods end with the request. A start waits for admission of its initial message, not a model answer. The final authorization boundary is the start of Durable's submission admission on its mutation line. Intervening source/target policy changes invalidate the short admission lease; config, access, model allowance, and spend are checked again there. Once admitted, later cancellation or policy changes do not undo work.

### `HumanLinkedSession`

```ts
interface HumanLinkedSession extends LinkedSession {
    conversationId: ConversationId;
}
```

Since 0.16.0 · Stable

`conversationId` is visible to the authenticated person and can be passed to `pocket.openConversation`. `address` remains the source's opaque address. `title`, `cwd`, `busy`, and `archived` still show only when the source's whole audience sees this session.

### `WebMethod`

```ts
type WebMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
```

Since 0.14.0 · Stable

The methods that a route can have.

## Access

### `WebAccess`

```ts
type WebAccess = "owner" | "steer" | "view";
```

Since 0.14.0 · Stable

Who can use a route, or whose tabs load a browser module.

- `"owner"`, the default: the owner alone.
- `"steer"`: the owner, and guests who can steer all sessions.
- `"view"`: the owner, guests, and viewers who can see all sessions.

A person invited to one session never can, because these parts belong to the whole app. Each route has its own `access`, so a browser module for everyone can call a route for the owner alone.

`access` is the same for all methods. A POST route with `"view"` lets viewers change something through it, though they cannot steer a session. Give `"owner"` or `"steer"` to a route that changes things.

To a person that its `access` does not let in, a route is not there. The person gets the same 404 as for a path that the module does not have. Thus another route whose path matches can answer the person. Give the same `access` to routes whose paths overlap, or check `user.role` in the handler.
