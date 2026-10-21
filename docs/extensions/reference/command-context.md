# Command context

A module adds a command with `web.command(name, command)`. This page gives the fields of `command`, the context that its handler gets, and what the handler returns. [Slash commands](../commands.md) tells you how runs are kept, how a person stops one, and how to refuse a run.

The types are `Command`, `CommandContext`, and `CommandResult`, in [types/pocket.d.ts](../../../types/pocket.d.ts).

```typescript
web.command("acme-status", {
    description: "Show this session's folder",
    scope: "conversation",
    handler: (_args, ctx) => ({ type: "card", output: ctx.cwd }),
});
```

## The command

### `description`

```ts
description: string;
```

Since 0.14.0 · Stable

What the command does. The message box's suggestions show it.

### `args`

```ts
args?: string;
```

Since 0.14.0 · Stable

A hint in words for the arguments, such as `"[zone]"`.

### `scope`

```ts
scope: "conversation" | "global";
```

Since 0.14.0 · Stable

Who can run the command: `"conversation"` or `"global"`. [Who may run it](../commands.md#who-may-run-it) in the commands guide tells who each one lets in, and what to check.

### `handler`

```ts
handler(args: string, context: CommandContext): CommandResult | Promise<CommandResult>;
```

Since 0.14.0 · Stable

Runs the command. `args` is all the text after the command's name, as one string. `context` is the [command context](#the-context).

To refuse a run, throw `web.error(status, message)`: the person who ran the command reads `message`. Any other error tells them only "The command failed.", and the owner gets its words in a notice.

## The context

### `user`

```ts
readonly user: Person;
```

Since 0.14.0 · Stable

The person who ran the command, as `{ id, name, role }`.

### `conversationId`

```ts
readonly conversationId: ConversationId;
```

Since 0.14.0 · Stable

The session where the person typed the command.

### `cwd`

```ts
readonly cwd: string;
```

Since 0.14.0 · Stable

The session's folder.

### `signal`

```ts
readonly signal: AbortSignal;
```

Since 0.14.0 · Stable

It aborts when a person stops the command in Menu → Running now. A command has no time limit: the handler must watch `signal`, and end when it aborts. Stopping does not undo what the handler did.

### `snapshot`

```ts
readonly snapshot: DocumentReader["snapshot"];
```

Since 0.14.0 · Stable

Reads a document: `ctx.snapshot(Doc, ctx.conversationId, ctx.context)`.

### `context`

```ts
readonly context: Context;
```

Since 0.14.0 · Stable

The context of the durable task that runs the command. Give it to `snapshot`, and to other calls into Pi Durable that need one.

### `commit`

```ts
commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
```

Since 0.14.0 · Stable

Changes documents in one commit: `await ctx.commit(async (tx) => …)`. It returns what `change` returns. Do work outside Pi Pocket before or after the commit, not in it.

## The result

### `CommandResult`

```ts
type CommandResult =
    { type: "toast"; level: NoticeLevel; message: string } | { type: "card"; output: string };
```

Since 0.14.0 · Stable

What a handler returns.

- `{ type: "toast", level, message }`: a notice for the person who ran the command, in that tab only. `level` is `"info"`, `"warning"`, or `"error"`. A long message is cut.
- `{ type: "card", output }`: plain text in the session where the person typed the command, for all the people who see it. Pi never gets it, and it does not change the person Pi works for. Find in session and export include it. Only the end of a long card is kept, as for a `!` command. Put no secrets in it.

[Limits](limits.md#commands) gives the lengths.
