# web

`web` is the second argument of a module's default export. With it, a module adds to the app what a tool cannot: routes on the server, a browser module, commands for the message box, and how its own inputs show. [Adding to the app](../app.md) tells you how the parts work together.

Register routes, the browser module, commands, and presentations while the module loads. After that, these calls throw. What you register goes when this version of the module goes: an edit replaces it, or the owner turns the module off.

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

### `presentEntry`

```ts
presentEntry(spec: PresentEntry): void;
```

Since 0.28.0 · Experimental

Says how an input this module sends shows in the transcript, while the module is on. The model still reads the message in full. Nothing registered here is stored.

- `kind` is `x.<module>.<name>`: this module's name, then a name of letters, digits, `_` and `-`.
- `label` is one short line ([limits](limits.md#presentations)).
- `userPrefix`, when set, matches a user message that starts with it only when nobody wrote that message. A message a person sent stays theirs. It is a few characters at least, and cannot start with `[`: the app's own inputs nobody typed (subagent reports, linked sessions, schedules) do ([limits](limits.md#presentations)).
- A module registers a limited number of presentations ([limits](limits.md#presentations)). Two modules cannot share a kind, and no prefix can start another one.
- Turning the module off, or a load that fails, drops the registration. Open transcripts show the change at once, as do rows whose author becomes known.
- An input stored as the module's own kind cannot be sent again from its message sheet, and [`pocket.messages`](pocket.md#messages) leaves it out: it is not a person's message to Pi. A user message that `userPrefix` matched stays one.
- Each browser chooses how these inputs show: a person picks Show, Fold, or Hide in a row's message sheet, and a browser module can read or set that choice for its own kinds with [`pocket.entryPresentation`](pocket.md#entrypresentation).

The module puts a short `summary` string on the entry's data when it submits. The transcript shows `label`, or `label · summary` when that string is there. See [`PresentEntry`](#presententry).

### `publicPage`

```ts
publicPage(handle: PublicPageHandler): void;
```

Since 0.22.0 · Experimental

Draws the module's public pages: what anyone with one of its links sees at `/l/<token>`, with no sign-in. A module has one handler. Pi Pocket sends each page in a sandbox: no script, an opaque origin, and forms that post only to this server. See [`PublicPageHandler`](#publicpagehandler) and [Public pages](../public-pages.md).

### `links`

```ts
readonly links: PublicLinks;
```

Since 0.22.0 · Experimental

Makes, lists, and ends the module's public links. Unlike the registering calls, it works while the module runs: from a route, a tool, a timer, or the page handler. A version of the module that went makes, lists, and ends none. See [`PublicLinks`](#publiclinks).

### `provide`

```ts
provide(service: object): void;
```

Since 0.22.0 · Experimental

Offers other modules an object of this module's own: functions and values that they call with `web.use(module)`. A module provides one service, while it loads. When this version of the module goes (an edit, or the owner turns it off), its service goes too, and modules that listen with `onService` hear it. A service is what it says it is: it runs with the providing module's code, so check what other modules give it, as you check what a person gives a route. See [Extensions that work together](../services-settings.md#services).

### `use`

```ts
use(module: string): unknown;
```

Since 0.22.0 · Experimental

The service that a module offers now, by the module's name, or `undefined` while that module is off, still loading, or offers none. Ask again each time that you need it, and do not keep it: a reload replaces it. Check its shape before you call it, since another version of the module may offer another one.

### `onService`

```ts
onService(module: string, listener: () => void): () => void;
```

Since 0.22.0 · Experimental

Calls `listener` when a module's service comes, changes (the module loads again), or goes. It does not call for a service that is there when you start to listen: check `use` then too. Use it to show or hide what you add to the app that needs that service. It returns how to stop. It stops by itself when this version of your module goes.

### `settings`

```ts
settings(fields: readonly SettingField[]): void;
```

Since 0.22.0 · Experimental

Declares the module's settings, while it loads. Core keeps the owner's values in `config.json`, shows them in Menu → Extensions under the module, and checks each value against its field before it keeps it. A mistake in `fields` throws, so the module does not load and the Extensions sheet says why. See [`SettingField`](#settingfield) and [Extensions that work together](../services-settings.md#settings).

### `setting`

```ts
setting(name: string): SettingValue | undefined;
```

Since 0.22.0 · Experimental

A setting's value now: the owner's, or the field's default, or `undefined` when it has neither. A value that no longer fits the field, from an older version of the module, gives the default. A name the module did not declare throws. Read it when you need it: the owner can change it at any time.

### `onSettings`

```ts
onSettings(listener: () => void): () => void;
```

Since 0.22.0 · Experimental

Calls `listener` after the owner changes the module's settings. The module's tabs hear it too, with `pocket.onSettings`. It returns how to stop, and stops by itself when this version of the module goes.

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
    conversationUsage(conversationId?: ConversationId): Promise<ConversationUsage>;
}
```

Since 0.16.0 · Stable

Authoritative source metadata, plus request-lifetime human linked-session capabilities. An omitted `model` means the source has none. Metadata is a snapshot, not a promise that settings cannot change. A start rejects a source model, thinking level, or folder changed while it waits.

### `ConversationWebRequest.conversationUsage`

```ts
conversationUsage(conversationId?: ConversationId): Promise<ConversationUsage>;
```

Since 0.28.0 · Experimental

A server-side member of `ConversationWebRequest`, available only inside a `web.conversationRoute` handler. Without an id, it reads the bound source. An id can select another visible conversation, including a subagent. It returns committed usage only, with no entries, text, session ids, or write capability.

Use a GET conversation route with `access: "view"` for a status item:

```typescript
web.conversationRoute(
    "GET",
    "usage/:source",
    async (request) => {
        if (typeof request.conversationUsage !== "function") {
            throw web.error(503, "Usage needs Pi Pocket 0.28.0 and a server restart.");
        }

        return request.conversationUsage();
    },
    { conversation: "source", access: "view" },
);
```

The route checks its source and the signed-in person before the handler runs. The member checks them again when called and before returning. A target id requires visibility too. Missing conversations and PiP conversations are refused. Descendant sums and counts include only conversations the person can still see. A retained callback fails after the handler returns or the browser disconnects. There is no actor override. Do not broadcast the result to other people or keep it in a shared document: their visibility can differ.

This addition does not change route access: people invited to one session still cannot use extension web routes. Viewers with access to all sessions can read through a GET route; no steering, turn, or spend check applies to this read. A gallery entry that needs this member sets `minPocket` to `0.28.0`.

Each call reads usage documents and scans stored entries. It also reads the in-memory conversation tree. Cost grows with the stored history, including tool output, of the selected conversation and its descendants, not just their active context. Poll sparingly, not on each streamed token. The result is not an atomic snapshot: work can commit between the ledger and history reads or between conversations.

### `UsageTotals`

```ts
interface UsageTotals {
    readonly requests: number;
    readonly input: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly output: number;
    readonly reasoning?: number;
    readonly cost: number;
    readonly lastPrompt: number;
}
```

Since 0.28.0 · Experimental

- `requests`: the number of stored assistant responses owned by this conversation, including error or aborted responses. Pi's own retry after an error stores a response of its own, so it counts. Requests with no assistant entry, such as compaction attempts and cache-keeper warm requests, are not counted.
- `input`: reported uncached input tokens, summed across requests.
- `cacheRead`: reported input tokens read from a prompt cache.
- `cacheWrite`: reported input tokens written to a prompt cache, including any 1-hour subset. That subset is not added twice.
- `output`: reported output tokens, including any separately reported reasoning tokens.
- `reasoning`: the sum of separately reported reasoning tokens. It is absent when none were reported, and can be 0 when a provider reports 0. Do not add it to `output`.
- `cost`: estimated US dollars from core's usage ledger, not a provider invoice. It includes model and tool usage, as core's spend does.
- `lastPrompt`: `input + cacheRead + cacheWrite` of the newest stored assistant response that reports any of them, by entry id: a failed request with no usage leaves the one before. It is 0 without such a response. It measures the last request, not the next request's context after a reset or compaction.

Token and cost totals come from core's `pi.usage` ledger. They include compaction and auxiliary requests recorded there, even when those requests have no response entry. Tool-reported usage counts too. A fork starts its own ledger; inherited responses do not count toward `requests` or `lastPrompt`. Old responses still count after a compaction or reset. A number that a provider does not report contributes 0; reasoning stays absent until one provider reports it. A conversation with no usage returns zeros and no reasoning field. Results are independent copies; changing a result changes no stored data. A call reads only the entries that came since the last call for the same conversation, so a module can ask often.

### `ConversationUsage`

```ts
interface ConversationUsage {
    readonly own: UsageTotals;
    readonly children: UsageTotals & { readonly count: number };
}
```

Since 0.28.0 · Experimental

`own` covers only the selected conversation. `children` sums every visible conversation it started, at any depth: subagents, linked sessions, and their descendants. It excludes the selected conversation, its ancestors, siblings, and forks. Archived descendants still count. Each conversation counts once, including one with no usage. `children.count` is their count, and `children.lastPrompt` is the sum of each descendant's `lastPrompt`, not the newest prompt across the family. No descendants gives zeros and count 0.

Requested by @Haichiu in #195.

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
- Explicit `thinking` must be a level that the model has; it is never silently lowered. Omission inherits the level of the source, lowered to one that the model has. Use `host.modelInfo` for effective choices.
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

### `SettingField`

```ts
type SettingField =
    | { name: string; label: string; description?: string; type: "boolean"; default?: boolean }
    | {
          name: string;
          label: string;
          description?: string;
          type: "text";
          default?: string;
          placeholder?: string;
          secret?: boolean;
      }
    | {
          name: string;
          label: string;
          description?: string;
          type: "number";
          default?: number;
          min?: number;
          max?: number;
      }
    | {
          name: string;
          label: string;
          description?: string;
          type: "choice";
          default?: string;
          choices: { value: string; label: string }[];
      };
```

Since 0.22.0 · Experimental

One setting.

- `name`: its key: letters, digits, and `_`, up to 40, starting with a letter. Each setting's is its own.
- `label`: what the Extensions sheet calls it, one line of up to 80 characters. `description`: a line of up to 300 under it.
- `type`: `boolean` (a switch), `text` (up to 4096 characters), `number` (with `min` and `max`; `min` is not more than `max`, and a `default` is between them), or `choice` (one of `choices`, up to 50).
- `secret` (text only; on another type it throws): the value never leaves the server, nor does its `default`. The sheet shows only that it is set, and `pocket.settings` leaves both out. Use it for a key or a token.
- `default`: the value until the owner sets one, and again after **Default** or **Clear**.

A module declares 30 settings at most.

### `SettingValue`

```ts
type SettingValue = string | number | boolean;
```

Since 0.22.0 · Experimental

A setting's value: `true` or `false`, text, a number, or a choice's `value`.

### `PublicPageHandler`

```ts
type PublicPageHandler = (
    request: PublicPageRequest,
) => PublicPageAnswer | Promise<PublicPageAnswer>;
```

Since 0.22.0 · Experimental

Draws a public page. A `POST` to a link with `uses` counts one before the handler runs. A handler that throws, or answers with a status of 400 or more, gives it back.

### `PresentEntry`

```ts
interface PresentEntry {
    kind: string;
    label: string;
    userPrefix?: string;
}
```

Since 0.28.0 · Experimental

What [`presentEntry`](#presententry) registers. `kind` is the stored kind. `label` is the line the transcript shows. `userPrefix` matches the start of a user message that nobody wrote.

### `PublicPageAnswer`

```ts
type PublicPageAnswer = string | { html: string; status?: number };
```

Since 0.22.0 · Experimental

The page's HTML, or its HTML with a status from 200 to 599 (200 when not given), up to a [size](limits.md#public-links). An error made with `web.error` shows a short page with its message and status. Any other error shows a page that gives no reason, and the server's log has its words.

### `PublicPageRequest`

```ts
interface PublicPageRequest {
    readonly method: "GET" | "POST";
    readonly link: PublicLinkInfo;
    readonly query: URLSearchParams;
    readonly form: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly context: Context;
    readonly snapshot: DocumentReader["snapshot"];
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
}
```

Since 0.22.0 · Experimental

A request to a public page, from anyone with its address. It has no person.

- `method`: `"GET"` to show the page (`HEAD` comes as `"GET"`), `"POST"` for a form on it.
- `link`: the link that the address names. It is still open.
- `query`: the query string.
- `form`: the fields of a posted form, `application/x-www-form-urlencoded`, as text. The last of a name that comes twice counts. Empty for `GET`.
- `signal`: aborted when the browser stops waiting.
- `snapshot`, `context`, and `commit`: read and change the module's own documents. They end when the handler returns.

### `PublicLinks`

```ts
interface PublicLinks {
    create(link: PublicLinkRequest): Promise<PublicLinkInfo>;
    get(token: string): Promise<PublicLinkInfo | undefined>;
    list(): Promise<PublicLinkInfo[]>;
    end(token: string): Promise<boolean>;
}
```

Since 0.22.0 · Experimental

The module's public links. Each method sees only the links of its own module.

- `create`: makes a link. A request out of its [limits](limits.md#public-links) throws.
- `get`: one of the module's open links, or `undefined`.
- `list`: the module's open links, newest first.
- `end`: ends a link at once, and gives whether there was one to end.

### `PublicLinkRequest`

```ts
interface PublicLinkRequest {
    hours: number;
    uses?: number;
    by?: string;
    conversation?: number;
    data?: unknown;
}
```

Since 0.22.0 · Experimental

What a module asks for when it makes a link.

- `hours`: how long it stays open: more than 0, and 720 (30 days) at most.
- `uses`: how many answered posts it takes before it closes. Without it, any number until its time.
- `by`: who it is for, such as a route's `user.id`.
- `conversation`: the session that it is about.
- `data`: a small JSON value of the module's own, given back with the link.

### `PublicLinkInfo`

```ts
interface PublicLinkInfo {
    readonly token: string;
    readonly path: string;
    readonly url: string | null;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly uses: number | null;
    readonly by: string | null;
    readonly conversation: number | null;
    readonly data: unknown;
}
```

Since 0.22.0 · Experimental

A link, as its module sees it.

- `token`: 32 hex characters, the whole of its access.
- `path`: `/l/<token>`.
- `url`: the whole address on the server's public one (a tunnel's), or `null`. In the browser, use `location.origin` and `path` when it is `null`.
- `createdAt`, `expiresAt`: when it was made and when it closes, in milliseconds since 1970.
- `uses`: how many answers it takes still, or `null` for any number.
- `by`, `conversation`, `data`: as the module gave them, or `null`.

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
