# host

The host is the first argument of a module's default export. A module uses it to read from Pi Pocket and to report to it. To add to the app, a module uses [`web`](web.md), the second argument.

The host does not change when a module reloads. It changes only when the server restarts. Thus a module that uses a member newer than the running server must check that the member is there. [Using the host](../host.md) tells you how.

The types are `Host` and the types that it uses, in [types/pocket.d.ts](../../../types/pocket.d.ts). [Types for your editor](types.md) tells you how to import them.

## Running version

### `pocketVersion`

```ts
readonly pocketVersion: string;
```

Since 0.16.0 · Stable

The running server's package version, including a pre-release suffix when present. It is read at server startup, not from files that an update replaced later. It is not the extension API level (`web.api`). Check that this member exists on older servers. A version-monitor extension can compare this value with a release obtained by its own server code, then show a notice; this member does not fetch updates or restart the server.

## Folders

### `dataDir`

```ts
readonly dataDir: string;
```

Since 0.1.0 · Stable

Pi Pocket's data folder. It is `~/.pi-pocket`, unless `PI_POCKET_DIR` or the `--data` option gives another folder. The drop-in folder is `extensions/` in it.

### `agentDir`

```ts
readonly agentDir: string;
```

Since 0.1.0 · Stable

Pi's own folder, usually `~/.pi/agent`. Pi keeps its sign-ins, models, settings, skills, and prompt templates there.

## Skills

### `skillPaths`

```ts
skillPaths(): string[];
```

Since 0.1.0 · Stable

The extra skill folders that Pi's settings give.

### `skills`

```ts
skills(cwd: string): Skill[];
```

Since 0.12.0 · Stable

Pi's skills for a session that works in the folder `cwd`. The list has the skills from all the places where Pi looks.

## Models

### `resolveModel`

```ts
resolveModel(spec: string): ModelRef;
```

Since 0.1.0 · Stable

Finds a model from `provider/modelId`, or from a model id alone. The model must be signed in, and its sign-in must work. When there is no such model, it throws an error. The error names no other models: the choice of model is the person's.

### `modelInfo`

```ts
modelInfo(spec: string): {
    model: ModelRef;
    name: string;
    thinkingLevels: ModelThinkingLevel[];
    contextWindow?: number;
    cost?: { input: number; output: number };
} | undefined;
```

Since 0.16.0 · Stable

Local metadata for one exact `provider/modelId`, including a known model without configured auth. Since 0.20.0 it can also give `contextWindow` (tokens) and `cost` (dollars per million input and output tokens); `cost` is left out when the catalog has no price (an unknown or free model), and `contextWindow` can be 0 when unknown, so check for both. A bare id or unknown pair returns `undefined`. It does not contact a provider, report sign-in details, or list models. Use it to describe the source model or a model already chosen by the owner. It does not authorize its use; starts still check the current model policy and availability.

### `subagentModels`

```ts
subagentModels(): readonly string[];
```

Since 0.13.1 · Stable

The models that the owner lets subagents use, as `provider/modelId`. While the list is empty (the default), a subagent runs on the model of its own session. Once it has models, subagents and linked sessions run only on those: the model of the session when it is listed and none is named; when it is not listed, the caller must name a listed model. The owner sets it in Menu → Providers → Models for subagents.

### `modelProblem`

```ts
modelProblem(ref: ModelRef, fresh?: boolean): Promise<string | undefined>;
```

Since 0.13.1 · Stable

Why Pi cannot use a model now, in words that Pi can tell a person. For example, Pi Pocket does not know the model, its provider is not signed in, or its sign-in expired. It is `undefined` when Pi can use the model. With `fresh: true`, it asks the provider about the sign-in again first.

### `registerModelProvider`

```ts
registerModelProvider(provider: string, config: ProviderConfig): () => void;
```

Since 0.20.0 · Experimental

Registers a model provider with Pi's model runtime, as a Pi extension does. `config` is Pi's own `ProviderConfig`: the provider's name, base URL, API key, API, headers, and models or `refreshModels` function. When Pi refuses the config, the call throws and changes nothing. Open tabs get the provider's models once Pi refreshed it locally.

The return value removes the provider again. Give it to `web.onDispose`, or the provider stays after the module is edited or turned off:

```ts
web.onDispose(host.registerModelProvider("example", config));
```

The last registration of a name wins: Pi uses its config alone, not merged with the one before. Its removal puts back the registration before it, from another module or from an older version that is still in force. A removal of a registration that is not the last one changes nothing in Pi. So a version that a reload replaces can call its removal safely, and a new version that fails to load leaves the old version's provider in place.

A name can be a built-in provider's, or one in Pi's `models.json`. The registration then changes that provider until its removal, and the API key the owner stored for it still applies. With another `baseUrl`, the owner's stored key goes to that address. Say so when you ask the owner to turn the module on.

Two things to know about how Pi refreshes models.

First, registration refreshes models locally only. A provider whose catalog comes from `refreshModels` alone shows no models until a network refresh, as with the app's **Refresh models** action. To look right away, ship a fallback list: a small static `models` with the provider's most common models. The network pass replaces it.

Second, every refresh, even a local one, calls `refreshModels`. When `allowNetwork` is false, return the models you have: `stored?.models ?? []`, or another fallback list. Returning `[]` empties the provider in Pi until the next network pass, because an empty list still counts as the provider's answer.

### `shapeModelRequests`

```ts
shapeModelRequests(
    shape: (payload: unknown, model: Model<Api>) => unknown | undefined,
): () => void;
```

Since 0.18.0 · Experimental

Shapes the request that every model call sends. `shape` gets the payload Pi built and the model, and returns a replacement payload (or a promise of one), or `undefined` to keep it. A shaper that throws is logged and skipped. It runs after Pi and the caller shaped the request, closest to the wire. The return value stops the shaping. Only the modules that the owner turned on shape requests.

A shaper can change what a provider bills or how it answers, and its effect lasts until it is removed. Say so when you ask the owner to turn the module on.

### `thinkingLevels`

```ts
readonly thinkingLevels: readonly ModelThinkingLevel[];
```

Since 0.14.0 · Stable

The thinking levels, lowest first. They have the names that models and sessions use.

## People and limits

### `requesterOf`

```ts
requesterOf(conversationId: ConversationId): string | undefined;
```

Since 0.3.0 · Stable

The id of the person that Pi works for in a session now. This is the person whose message started Pi's current work.

### `roleOf`

```ts
roleOf(personId: string): Role | undefined;
```

Since 0.27.0 · Experimental

The role of a person by id: `"owner"`, `"guest"`, or `"viewer"`. It is `undefined` for an id that is not a person here. It reads the role that core uses, so a module does not keep its own copy. Use it with `requesterOf` to know if Pi works for the owner. It can change in a minor release. Check that it is there first: `host.roleOf?.(id)`.

### `heldBack`

```ts
heldBack(conversationId: ConversationId): string | undefined;
```

Since 0.12.0 · Stable

Why Pi cannot start work in a session now when nobody asked for it, for example to read a subagent's report. The reason is a spend limit: the session's limit, or the limit of the person who pays there. It is `undefined` when Pi can start.

### `onLimitsChanged`

```ts
onLimitsChanged(listener: () => void): () => void;
```

Since 0.12.0 · Stable

Calls `listener` each time the owner changes a spend limit. It returns a function: call it to stop.

## Events

### `on`

```ts
on<E extends AppEventName>(event: E, listener: (data: AppEvents[E]) => unknown): () => void;
```

Since 0.22.0 · Experimental

Calls `listener` each time something happens in the app: a session is made, renamed, or archived, a person sends Pi a message, or Pi starts or stops working. Each event comes after the change is stored. A listener runs after the work that caused it, never in its way: one that throws or rejects is logged, and the other listeners still run. Each one gets its own frozen copy of the data. It returns how to stop: pass that to `web.onDispose`. PiP's conversation is its person's alone, and sends no events. An unknown event name throws. See [`AppEvents`](#appevents).

```typescript
web.onDispose(
    host.on("run.ended", ({ conversationId, session }) => {
        if (conversationId === session) {
            counts.set(session, (counts.get(session) ?? 0) + 1);
        }
    }),
);
```

## Asking people, hiding values, and the browser

These came in 0.22.0, and are experimental. [People's values and the browser](../people-values.md) tells how to use them together.

### `ask`

```ts
ask(request: AskRequest, context: Context): Promise<AskAnswer>;
```

Since 0.22.0 · Experimental

Asks the person Pi works for, on a card in the session, as an approval asks. The card shows the request's `title`, its `text`, a field for each of its `fields` (a hidden one for a `secret`), and a button. Only the person Pi works for can send it (the owner, when nobody is known); anyone who can steer can decline it. It notifies that person, as an approval does.

What they type comes back in the answer's `values`, and nowhere else: not to Pi, into the transcript, or to the other people in the session. A plain Allow, such as from a notification, is refused: each field must be filled in. Do not keep the values in a memo or a document, where a restart would find them. Without a memo, a call that a restart cut off comes back as interrupted, and asks again when Pi tries again. See [`AskRequest`](#askrequest) and [`AskAnswer`](#askanswer).

### `hide`

```ts
hide(value: HiddenValue): () => void;
```

Since 0.22.0 · Experimental

Hides a value from what Pi and people read, until the returned function is called. Each one becomes `[label]`:

- in the output of commands as it streams: bash's live output and its result, a `!` command's card, and a check's output. A value split across two chunks is held back until it can be told apart, so up to its length less one character comes later than the rest;
- in every tool's result (what the model reads, what programs read, and its details, keys too), before it is stored;
- in people's messages to Pi, the files a message brings along, and an edit sent again: a value pasted there is replaced before the message is stored, sent to the model, or made the session's title. A `!` command that holds one is refused, since it runs as stored.

With `conversationId`, it is hidden in that session and its subagents. A guess that matches shows as `[label]`, so hide only a value that cannot be guessed, never a short code.

It does not reach a file that a command writes (such as bash's spill file for long output), entries from before the value was hidden, or a value that a command changed (encoded, reversed). Hide each form that you expect, such as its base64, as a value of its own. It keeps values out of transcripts by accident: it is not a boundary against a command that leaks a value on purpose. Pass the returned function to `web.onDispose`. See [`HiddenValue`](#hiddenvalue).

### `commandEnv`

```ts
commandEnv(provider: CommandEnvProvider): () => void;
```

Since 0.22.0 · Experimental

Adds environment variables to the commands that run in sessions: Pi's bash, people's `!` commands, and Done when's checks. Before each command, each provider gets the command, its folder, and its session, and gives variables to add, or nothing. A later provider's variable wins over an earlier one's. A provider that throws, or takes more than 5 seconds, adds nothing, and the server's log says why; the command still runs. Use it to put a value into `$NAME` for the commands that name it, so the value does not go through Pi. Hide the value with `hide` too. Pass the returned function to `web.onDispose`. See [`CommandEnvProvider`](#commandenvprovider).

### `browser`

```ts
browser(
    conversationId: ConversationId,
    options?: { open?: boolean },
): Promise<BrowserPageHandle | undefined>;
```

Since 0.22.0 · Experimental

A session's browser page: the one that Pi's `browser` tool and the people in the session use. With `open: true`, it opens the page when it is not open. It is `undefined` while the Browser module is off, and without `open`, when no page is open. See [`BrowserPageHandle`](#browserpagehandle).

## Notices and text

### `notice`

```ts
notice(level: NoticeLevel, message: string, conversationId?: ConversationId): void;
```

Since 0.1.0 · Stable

Reports something to the server's log and to the app. `level` is `"info"`, `"warning"`, or `"error"`. With `conversationId`, only the tabs of that session show the notice. Pi Pocket 0.13.1 added `conversationId`.

### `text`

```ts
readonly text: SafeText;
```

Since 0.14.0 · Stable

Makes text from other places safe for Pi to read: from a web page, an issue, or a file that a person did not write. In the same place, tell Pi that the text is data.

#### `text.quoted`

```ts
quoted(text: string, max?: number): string;
```

Since 0.14.0 · Stable

Gives the text as one line in quotes that the text cannot close. It removes invisible characters and tags, and it cuts the line to `max` characters. [Limits](limits.md#host) gives the default `max`.

#### `text.defang`

```ts
defang(text: string): string;
```

Since 0.14.0 · Stable

Keeps the lines of the text, but leaves no closing tag in it. Use it for text that you put between tags of your own.

## Public web pages

### `fetchPublic`

```ts
fetchPublic(url: string | URL, init?: PublicFetchInit): Promise<Response>;
```

Since 0.20.0 · Experimental

Fetches an address that came from outside (from Pi, a page, or a person) as `fetch` does, but filters non-public ranges and this machine's interface addresses. Use it for each address that the module did not write itself: a tool that reads a page that Pi names, a crawl, or a link from a search result.

- It takes only `http` and `https` addresses, with no user or password in them.
- It refuses an IP address that is not public: loopback, private, link-local, shared (`100.64.0.0/10`), multicast, and the ranges set apart for documentation and later use. In IPv6, only global unicast addresses (`2000::/3`) are public, less the ranges set apart in it. An IPv4-mapped IPv6 address is checked as its IPv4 address.
- It also refuses every IPv4 and IPv6 address on this machine's network interfaces, including public ones. It reads the interface list fresh for each address check. Equivalent IPv6 spellings and IPv4-mapped addresses receive the same check.
- It resolves a name when it connects, and refuses the name when any of its addresses is in a non-public range or on a local interface. The connection goes only to an address that it checked. So a name that resolves to a public address first and to a private one later (DNS rebinding) cannot reach the private one.
- It checks each redirect the same way. A 303, and a `POST` that a 301 or 302 sends on, become a `GET`. A redirect to another origin drops the `Authorization`, `Cookie`, and `Proxy-Authorization` headers.
- It stops at a size, a time, and a number of redirects ([limits](limits.md#host)). Give `init` other values.
- It uses its own connections, not the HTTP proxy in Pi's settings: a proxy resolves names itself, out of the check's reach. Behind a proxy that is the only way out, it cannot connect.

The filter does not inspect routes. It cannot detect a public address that routes back into the network through NAT reflection or internally routed public ranges. Network controls must restrict those paths when needed.

A refusal throws an `Error` with a `code`:

- `"POCKET_NOT_PUBLIC"`: the URL is not allowed, or a literal, DNS answer, or redirect address is in a non-public range or on a local interface.
- `"POCKET_TOO_LARGE"`: the body is larger than `maxBytes`. An uncompressed response whose `Content-Length` is larger is refused at once. Otherwise the error comes when you read the body, as it is decoded.
- `"POCKET_REDIRECTS"`: more redirects than `maxRedirects`, or a redirect with `redirect: "error"`.

Other failures, such as a name that does not resolve, reject as `fetch` does. The response's `url` is the address of the last redirect, and `redirected` says whether it followed one.

The text of a page is text from outside: give it to Pi through [`text`](#text) ([Text from other places](../host.md#text-from-other-places)). [examples/read-page.ts](../../examples/read-page.ts) is a tool that uses both.

#### `PublicFetchInit`

```ts
interface PublicFetchInit {
    method?: string;
    headers?: Record<string, string> | [string, string][] | Headers;
    body?: string | Uint8Array;
    signal?: AbortSignal;
    redirect?: "follow" | "manual" | "error";
    maxRedirects?: number;
    maxBytes?: number;
    timeoutMs?: number;
}
```

Since 0.20.0 · Experimental

What `fetchPublic` takes besides the address.

- `method`, `headers`, and `signal`: as for `fetch`. `method` is `GET` by default.
- `body`: a string or bytes, which a 307 or 308 redirect sends again.
- `redirect`: `"follow"` (the default) follows redirects and checks each address. `"manual"` gives the redirect response. `"error"` throws on a redirect.
- `maxRedirects`: the redirects to follow at most.
- `maxBytes`: the size of the body at most, after it is decoded.
- `timeoutMs`: the time for the whole request at most, the body included.

## Linked sessions

### `linkedSessions`

```ts
readonly linkedSessions: LinkedSessions;
```

Since 0.14.0 · Experimental

Lets a tool start sessions from the session that it runs in, and send messages between them, as Agent Teams does. A linked session is an ordinary session. [Starting and messaging sessions](../linked-sessions.md) tells you how they work, what they cannot do, and how to call them.

Each call acts as the person that Pi works for in `source`, and that person's checks apply. Give each call a `key` that stays the same when the call runs again, such as `${api.taskId}:${api.callId}`. A second call with the same `key` does nothing again: it returns what the first call returned.

#### `linkedSessions.start`

```ts
start(
    source: ConversationId,
    request: { title?: string; message: string; model?: string; thinking?: string; cwd?: string },
    key: string,
): Promise<{ session: ConversationId; address: string }>;
```

Since 0.14.0 · Experimental

Makes a session linked to `source` and sends it `message` as its first message. It returns the new session's id, and the address that `source` uses for it.

- The new session works in `cwd` when supplied, otherwise the folder of `source`. `cwd` must name an existing folder and uses the normal folder-picker path rules. A blank `cwd` counts as no `cwd`. A relative `cwd` resolves against the folder of the server process, not the folder of the source. `cwd` is since 0.19.0: an older Pi Pocket ignores it and uses the folder of `source`, so a gallery entry that needs it sets `minPocket` to `0.19.0`. It gets a copy of the agent settings of `source`, but not its history.
- Without `title`, the title is the first line of `message`.
- `model` is `provider/modelId`. While the owner's list of models for subagents is empty, it must be the model of `source`. Once the list has models, it must be one of them. Without it, the session uses the model of `source` when the list is empty or has it. Otherwise `start` is refused with an error that names the allowed models.
- `thinking` can be any level, also one above the level of `source`. Without it, the session uses the level of `source`. Pi Pocket lowers it to the highest level that the model has, or uses the lowest level of the model when it has none that low.
- When Pi cannot use the model now, `start` makes nothing and throws an error.

#### `linkedSessions.send`

```ts
send(
    source: ConversationId,
    request: { to: string; message: string; steer?: boolean },
    key: string,
): Promise<void>;
```

Since 0.14.0 · Experimental

Sends `message` to the linked session at the address `to`. Without `steer`, the message is a follow-up. With `steer: true`, the session gets it at its next pause. `send` returns when the session takes the message, not when it answers.

The session that gets the message reads it between tags. Words before it say that the agent of another session wrote it, and that it is a request, not a person's order. They also give the address to reply to.

#### `linkedSessions.list`

```ts
list(source: ConversationId): Promise<LinkedSession[]>;
```

Since 0.14.0 · Experimental

The sessions linked to `source`, at any distance, that the person Pi works for can see. Each has an address of the `source` session's own, so no session id goes into its transcript.

#### `LinkedSession`

```ts
interface LinkedSession {
    address: string;
    title?: string;
    cwd?: string;
    busy?: boolean;
    archived?: boolean;
}
```

Since 0.14.0 · Experimental

A linked session, as `list` gives it.

- `address`: the address that the asking session uses for it. It is never the session's id.
- `title`, `cwd` (its folder), `busy` (Pi works in it now), and `archived`: these are there only when all the people who see the asking session see this session too.

## Types for events

### `AppEvents`

```ts
interface AppEvents {
    "session.created": {
        conversationId: number;
        cwd: string;
        createdBy?: string;
        forkedFrom?: number;
        linkedFrom?: number;
    };
    "session.renamed": { conversationId: number; title: string };
    "session.archived": { conversationId: number; archived: boolean };
    "message.sent": {
        conversationId: number;
        by: string;
        submissionId: string;
        text: string;
        via?: string;
    };
    "run.started": { conversationId: number; session: number };
    "run.ended": { conversationId: number; session: number };
}
```

Since 0.22.0 · Experimental

What each event's listener gets.

- `session.created`: a session in the list was made, by a person, a fork (`forkedFrom`), a linked start (`linkedFrom`), or a resend. `createdBy` is a person's id. Subagents are not sessions in the list, and send none.
- `session.renamed`, `session.archived`: its new title, or whether it is archived now.
- `message.sent`: a person's message to Pi, a steer or a queued one too. `by` is their id. `text` is the words as stored, with values that extensions hide already hidden and attachments left out. `via` names what sent it for them, such as PiP or a schedule.
- `run.started`, `run.ended`: Pi started or stopped working in a conversation. `conversationId` is that conversation, a session's or a subagent's; `session` is the session it belongs to.

### `AppEventName`

```ts
type AppEventName = keyof AppEvents;
```

Since 0.22.0 · Experimental

The name of an event: `"session.created"`, `"session.renamed"`, `"session.archived"`, `"message.sent"`, `"run.started"`, or `"run.ended"`.

## Types for asking, hiding, and the browser

### `AskRequest`

```ts
interface AskRequest {
    readonly conversationId: ConversationId;
    readonly id: string;
    readonly taskId: TaskId;
    readonly callId?: string;
    readonly title: string;
    readonly text?: string;
    readonly fields?: readonly AskField[];
    readonly submit?: string;
}
```

Since 0.22.0 · Experimental

- `id`: unique while the card waits, and the same when the call asks again, such as `${api.taskId}:${api.callId}`. A new ask with the id of one that waits replaces it, and the one before is declined.
- `taskId`, `callId`: the call that asks, so the card and its answer show with it.
- `title`: one line, up to 120 characters. `text`: up to 2000.
- `fields`: up to 6. None makes a question that the button alone answers, such as "Solve the CAPTCHA in the browser, then tap Done".
- `submit`: the button's words, up to 30 characters. "Send" by default, "Done" with no fields.

### `AskField`

```ts
interface AskField {
    name: string;
    label: string;
    header?: string;
    choices?: AskChoice[];
    multiple?: boolean;
    other?: boolean;
    secret?: boolean;
    placeholder?: string;
    autocomplete?: string;
}

interface AskChoice {
    label: string;
    description?: string;
}
```

Since 0.22.0 · Experimental. `header`, `choices`, `multiple`, `other`, and `AskChoice` since 0.27.0.

- `name`: the value's key in the answer: letters, digits, and `_`, up to 40, starting with a letter. Each field's is its own.
- `label`: what the card says above the field, one line of up to 80 characters. A field with `choices` has its question here, up to 300.
- `header`: a short tag over the field, such as "Database", up to 12 characters.
- `choices`: 2 to 4 answers to pick, shown as buttons, with different labels. A choice's `label` is one line of up to 60 characters, and its `description`, under it, of up to 160. The field's value is the label chosen.
- `multiple`: with `choices`, the person can choose one or more. The value is their labels, one per line, in the order of `choices`.
- `other`: with `choices`, the person can type an answer of their own instead, and the value is what they typed. Its `placeholder` is the words of that field while it is empty.
- A value that is not one of the choices (and with no `other`) is refused, with an error that names the field, never the value.
- `secret`: a hidden input, as for a password. Not for a field with `choices`.
- `autocomplete`: a hint for the browser and the phone's keyboard, such as `username`, `current-password`, or `one-time-code`. Not for a field with `choices`.

### `AskAnswer`

```ts
type AskAnswer =
    | {
          readonly answered: true;
          readonly by: string;
          readonly values: Readonly<Record<string, string>>;
      }
    | { readonly answered: false; readonly by: string };
```

Since 0.22.0 · Experimental

What the person did. `by` is the name of who answered or declined. Each value is 1 to 4096 characters.

### `HiddenValue`

```ts
interface HiddenValue {
    value: string;
    label: string;
    conversationId?: number;
}
```

Since 0.22.0 · Experimental

- `value`: 4 to 4096 characters. A shorter one would turn up in ordinary output by chance. 2000 values at most are hidden at once.
- `label`: what shows in its place, as `[label]`, such as `[secret GITHUB_TOKEN]`: 1 to 60 letters, digits, spaces, and `_ . : -`.
- `conversationId`: only in this session. Without it, in every session.

### `CommandRun`

```ts
interface CommandRun {
    readonly conversationId: number;
    readonly command: string | readonly string[];
    readonly cwd: string;
}
```

Since 0.22.0 · Experimental

A command about to run: its session, the command as the shell gets it (or a program and its arguments), and its folder.

### `CommandEnvProvider`

```ts
type CommandEnvProvider = (
    run: CommandRun,
) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>;
```

Since 0.22.0 · Experimental

Gives the variables to add to one command. A name is letters, digits, and `_`, not starting with a digit; a value has no NUL. A variable that breaks these is left out. The variables of all providers for one command are 256 KB at most.

### `BrowserTarget`

```ts
interface BrowserTarget {
    readonly ref?: string;
    readonly selector?: string;
    readonly label?: string;
    readonly x?: number;
    readonly y?: number;
}
```

Since 0.22.0 · Experimental

What to act on: a ref from the last snapshot (`e12`), a CSS selector, the visible text or label of an element, or a point in CSS pixels of the viewport.

### `BrowserControl`

```ts
interface BrowserControl {
    ref: string;
    role: string;
    name: string;
    kind: string;
    disabled: boolean;
    inView: boolean;
    value?: string;
    placeholder?: string;
    checked?: boolean;
    options?: string[];
    href?: string;
}
```

Since 0.22.0 · Experimental

One control of a snapshot, as data, up to 500 of them.

- `role`: `button`, `link`, `textbox`, `checkbox`, `combobox`, and so on, or `clickable` for an element that only looks clickable.
- `kind`: an input's type (`text`, `password`, `email`, and so on), `textarea`, `select`, or the element's tag.
- `value`: a field's or a select's value. A password field's is `••••` when it holds one, and never its value.
- `options`: a select's options, up to 50. `href`: a link's address.

### `BrowserPageHandle`

```ts
interface BrowserPageHandle {
    readonly url: string;
    readonly title: string;
    snapshot(): Promise<{
        text: string;
        controls: BrowserControl[];
        truncated: boolean;
        scroll: { y: number; viewport: number; height: number };
    }>;
    inspect(
        target: BrowserTarget,
    ): Promise<{ label: string; kind: string; editable: boolean; password: boolean }>;
    navigate(url: string): Promise<void>;
    click(target: BrowserTarget): Promise<{ label: string; navigated: boolean }>;
    type(target: BrowserTarget, text: string, options?: { submit?: boolean }): Promise<string>;
    fill(target: BrowserTarget, value: string): Promise<string>;
    select(target: BrowserTarget, value: string): Promise<string>;
    press(key: string): Promise<void>;
    scroll(target?: BrowserTarget, dy?: number): Promise<string>;
    waitFor(options: { text?: string; selector?: string; timeoutMs?: number }): Promise<boolean>;
}
```

Since 0.22.0 · Experimental

The page, with what Pi's `browser` tool does, but no script to run in it.

- `snapshot`: the page as Pi reads it (`text`), and its controls as data. Refs last until the next snapshot, Pi's too.
- `inspect`: what a target is, scrolled into view: its description, its `kind`, and whether it is a field (`editable`) or a password field.
- `fill`: puts a person's value into a field (not a select), replacing what it holds. The target is a ref, a selector, or a label, not a point. It throws and fills nothing when something covers the field, or when the focus does not reach it. The value is not in what it returns, and the snapshot shows a password field's as `••••`. Pi can still read a field's value with its `evaluate`: hide the value with `hide` too.
- `inspect` with a point (`x`, `y`) says what is at that point, without scrolling or acting on it.
- `type`, `click`, `select`, `press`, `scroll`, `waitFor`, `navigate`: as the `browser` tool's actions. `navigate` takes an http(s) address, host:port, or a file path.
- What they return: `type`, `select`, and `scroll` give the description of what they acted on; `click` gives it with whether the page went elsewhere (`navigated`); `waitFor` gives whether what it waited for showed; `navigate` and `press` give nothing.

## Internal members

The host has more members, for Pi Pocket's built-in modules only. They are not in the types file, and they can change in any release without notice. Do not use them in a drop-in. [API stability](../policies/api-stability.md) tells you what this means.

- `approvals`: tool calls that wait for a person to allow them.
- `guard`: Lancet Guard.
- `schedules`: scheduled messages, for the schedule tool. `schedules.limits` holds the limits in force (`perSession`, `chars`, `repeatMinutes`, `aheadDays`); the schedules module copies the owner's settings into it, so a module should read it and not change it. A server from before 0.24.0 has no `limits`.
- `background`: commands Pi runs in the background, for the background tool: `start`, `read`, `stop`, `list`, and `limits` (`running`, which the background module copies from the owner's setting). A server from before 0.24.0 has none.
- `goals`: Done when, for the goals module.
- `browsers`: the built-in browser, for the browser tool.
- `memory`: the lessons that Pi keeps across sessions, for the memory tool.
- `watches`: the pull request watches of sessions, for the `watch_pr` tool.
- `repoWatches`: the task of repository watches, for the triggers module.
- `pip`: what the tools of PiP, the owner's assistant, do.
- `pipCompaction`: PiP's own summaries when its context is compacted.
- `gallery`: the extension gallery, for its own routes.
- `updates`: updates of Pi Pocket itself, for the Updates module's routes. Its status says how the copy was installed (`installKind`: `git`, `npm-global`, `npm-local`, `npx`, or `unknown`) and what stands in the way of an update from the app.
