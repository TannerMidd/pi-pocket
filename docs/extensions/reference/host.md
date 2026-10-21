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
} | undefined;
```

Since 0.16.0 · Stable

Local metadata for one exact `provider/modelId`, including a known model without configured auth. A bare id or unknown pair returns `undefined`. It does not contact a provider, report sign-in details, or list models. Use it to describe the source model or a model already chosen by the owner. It does not authorize its use; starts still check the current model policy and availability.

### `subagentModels`

```ts
subagentModels(): readonly string[];
```

Since 0.13.1 · Stable

The models that the owner lets subagents use, as `provider/modelId`. A subagent can always use the model of its own session. The list is empty by default. The owner sets it in Menu → Providers → Models for subagents.

### `modelProblem`

```ts
modelProblem(ref: ModelRef, fresh?: boolean): Promise<string | undefined>;
```

Since 0.13.1 · Stable

Why Pi cannot use a model now, in words that Pi can tell a person. For example, Pi Pocket does not know the model, its provider is not signed in, or its sign-in expired. It is `undefined` when Pi can use the model. With `fresh: true`, it asks the provider about the sign-in again first.

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
- `model` is `provider/modelId`. It must be the model of `source`, or a model that the owner lets subagents use. Without it, the session uses the model of `source`.
- `thinking` is a level no higher than the level of `source`. Without it, the session uses the level of `source`. Pi Pocket lowers it to the highest level that the model has.
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

## Internal members

The host has more members, for Pi Pocket's built-in modules only. They are not in the types file, and they can change in any release without notice. Do not use them in a drop-in. [API stability](../policies/api-stability.md) tells you what this means.

- `approvals`: tool calls that wait for a person to allow them.
- `guard`: Lancet Guard.
- `schedules`: scheduled messages, for the schedule tool.
- `goals`: Done when, for the goals module.
- `browsers`: the built-in browser, for the browser tool.
- `memory`: the lessons that Pi keeps across sessions, for the memory tool.
- `watches`: the pull request watches of sessions, for the `watch_pr` tool.
- `repoWatches`: the task of repository watches, for the triggers module.
- `pip`: what the tools of PiP, the owner's assistant, do.
- `pipCompaction`: PiP's own summaries when its context is compacted.
- `gallery`: the extension gallery, for its own routes.
