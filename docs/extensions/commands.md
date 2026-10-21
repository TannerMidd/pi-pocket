# Slash commands

A command runs on the server when a person types `/name` in the message box. It does not ask Pi. Use it to show a status, or to change a setting, without a model.

## Add a command

`web.command(name, { description, args, scope, handler })` adds `/name` to the suggestions of the message box, for the people who may run it.

```typescript
web.command("my-status", {
    description: "Show this session's folder",
    scope: "conversation",
    handler: (_args, ctx) => ({ type: "card", output: ctx.cwd }),
});
```

The [clock example](../examples/clock.ts) has a command: `/clock-zone Europe/Berlin` sets the session's time zone, and `/clock-zone` shows it. The members of `ctx` are in [the command context reference](reference/command-context.md).

- **`name`**: lowercase letters, digits, `-`, and `_`, without the `/`, up to a [length](reference/limits.md#names). It starts with a letter, and has at least one `-`: `my-status`, not `status`. The app's own commands are one word each, so a new command of the app never takes your name. Give it a prefix of your own.
    - Pi Pocket refuses a name that a command of another module has. The first module keeps it.
    - A prompt template with the same name wins in the message box.
- **`description`**: shows in the suggestions.
- **`args`**: a hint in words, such as `"[zone]"`. It is optional.
- `description` and `args` have a [length limit](reference/limits.md#commands), and a module has a limited number of commands.

## The handler

`handler(args, ctx)` gets all the text after the name as one string, up to a [length](reference/limits.md#commands).

- `ctx.user` is who ran the command, as `{ id, name, role }`.
- `ctx.conversationId` is the session, and `ctx.cwd` its folder.
- To read a document, use `ctx.snapshot(Doc, ctx.conversationId, ctx.context)`.
- To change documents, use `await ctx.commit(async (tx) => …)`. It returns what its function returns. Keep work outside Pi Pocket out of the commit.

## What it returns

- **`{ type: "toast", level, message }`**: a notice for the person who ran the command, in that tab only. `level` is `"info"`, `"warning"`, or `"error"`. Pi Pocket cuts a long message ([limits](reference/limits.md#commands)).
- **`{ type: "card", output }`**: plain text in the session where the person typed the command, for all the people who see it.
    - Pi never gets it, and it does not change whom Pi works for.
    - Find in session and export include it.
    - Pi Pocket keeps only its end ([limits](reference/limits.md#commands)), as for a `!` command.
    - Put no secrets in it.

## Errors

- To refuse, throw `web.error(status, message)`, or let the app's own errors through. The person who ran the command reads `message`.
- For any other error, the person reads only "The command failed." The owner gets its words in a notice, because they can name the server's folders or quote a secret.

## Who may run it

`scope` says who may run the command:

- **`"conversation"`**: each person who may steer the session. While people take turns, only the person who drives. Guests invited to one session can run it there.
- **`"global"`**: the owner alone, in each session that the owner sees. Use it for settings of the whole app. Its card still goes to the session where the owner typed it, for all the people in it. While another person drives, the app shows the owner no message box in that session: the owner runs the command from another session, or takes the wheel first.
- Viewers run no commands, and see none in the suggestions.

The handler runs with the owner's rights, as all of the module does. A conversation command is offered to each person who can steer the session, also to people invited to that session only. So:

- Its `args` are untrusted text. Check them.
- Check `ctx.user.role` and `ctx.conversationId` before you change anything outside that session.

## Runs

Each run is a durable task, kept by the person who ran it, the session, and the request's id.

- When a reply gets lost, the same text sent again from the same tab finds the first run, and gets its result. The handler runs one time. Pi Pocket keeps the ids of a person's recent runs only ([limits](reference/limits.md#commands)).
- A restart of the server never runs a handler again. The person hears that it was stopped, because it can have done a part of its work.
- Menu → **Running now** shows a command while it runs, and can stop it. People who steer stop conversation commands; the owner stops global commands.
- To stop a run aborts `ctx.signal`. It does not undo what the handler did. A stop just after the handler wrote its card leaves the card, and the run says that it was stopped.

A command has no time limit. The handler must watch `ctx.signal`, and end when it aborts.

- One person can have only a few runs at the same time, over all sessions ([limits](reference/limits.md#commands)). Pi Pocket refuses one more until one ends. So a handler that never ends holds one run until the server restarts.
- Pi Pocket stores the arguments and the result with the task. Do not ask people to type a password in a command.

## Versions

Commands install and go with the module's version, as routes do:

- An edit replaces them in one step.
- When a new version does not load, the commands of the version before stay.
- When the owner turns the module off, Pi Pocket removes them.
- A run that started keeps the handler that it started with.

Menu → **Extensions** lists the commands of a module, each with its scope.
