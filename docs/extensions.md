# Writing extensions

An extension gives Pi something new: a **tool** it can call, a **section** of its system prompt, a **hook** that checks or changes its tool calls and answers, or a durable **task**. Pi Pocket's own features are built this way (`src/server/extensions/`), and the owner can add their own without touching Pi Pocket's code.

Extensions are Pi Durable's. Its README covers the parts in depth: `node_modules/@earendil-works/pi-durable/README.md` in Pi Pocket's folder (Extensions, Tools, System Prompt, Hooks, Your Own State). This page is what Pi Pocket adds, and how to write one that holds up.

## Drop-in or built-in

- **Drop-in**: a file in `~/.pi-pocket/extensions/` (the data folder's `extensions/`). It survives updates to Pi Pocket, starts off, and the owner turns it on in Menu → Extensions. Use this for anything one person or one machine wants.

A drop-in runs inside the server, with the owner's rights: it can read `config.json` (the owner's token with it) and every session, and Lancet Guard never sees what its code does. Show the owner the whole file, and say what it does, before you ask them to turn it on.

- **Built-in**: a file in `src/server/extensions/`. It is part of Pi Pocket for everyone who uses this copy. Use this only for a change to Pi Pocket itself, and read [self-editing.md](self-editing.md) first.

## A module

One `.ts` file that default-exports a function. Pi Pocket calls it with the host (below) and installs what it returns: one extension, or a list.

```typescript
/**
 * A clock tool: the date and time now, in any time zone. The first sentence of this comment is the module's
 * description in the Extensions sheet.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const clock = defineTool({
    name: "clock",
    description: "The date and time now, in a time zone such as Europe/Berlin.",
    parameters: Type.Object({ zone: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (args) => ({
        content: [
            {
                type: "text" as const,
                text: new Date().toLocaleString("en-US", { timeZone: args.zone }),
            },
        ],
    }),
});

export default function createClock() {
    return defineExtension({ name: "example-clock", tools: [clock] });
}
```

Working examples, tested with every `npm test` (`test/docs-examples.test.ts`):

- [examples/clock.ts](examples/clock.ts): a tool.
- [examples/no-force-push.ts](examples/no-force-push.ts): a hook that blocks some bash calls, and a prompt section that says so.

The file:

- is TypeScript that Node runs as it is: only erasable syntax (no `enum`, no `namespace`, no constructor parameter properties). Imports of local files end in `.ts`.
- imports `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and the rest of Pi Pocket's packages by name. The drop-in folder has a `node_modules` link to Pi Pocket's own, so a drop-in gets the very modules the server runs.
- has a file name no built-in module has (a drop-in named `browser.ts` is not loaded). Files that start with `_` or end in `.test.ts` are not modules: use them for helpers and tests. A helper is not reloaded when it changes, even when the module that imports it is: a change to it takes a restart. Keep what you will change often in the module itself.
- starts with a `/** … */` comment whose first sentence says what it does.

### Names

Installing an extension with a name already installed replaces it, and a tool with the name of another replaces it in every session. So Pi Pocket refuses a drop-in that would take a name it keeps for itself, or one another module already has, and says so in Menu → Extensions:

- Extension names `coding-tools`, `pocket-core`, and anything starting with `pocket-` (`pocket-prompt`, `pocket-guard`, and the rest), whether that built-in is on or off.
- The built-in tools: `read`, `write`, `edit`, `bash`, `artifact`, `browser`, `subagent`, `schedule`, and `codemode`.
- An extension or tool name another module installed: the first one in keeps it.

Give every extension and tool a name of your own, with a prefix (`example-clock`, `acme_lookup`). To change how a built-in tool works, wrap it (`wrapTool` in Pi Durable's README) or check its calls with a hook, rather than replacing it.

## Loading, reloading, and errors

- A drop-in shows in Menu → Extensions as soon as its file is there, off. Turning it on loads it; turning it off uninstalls what it installed.
- Saving a module that is on reloads it about 300 ms later. A tool call already running finishes on the old code; the next one gets the new code.
- A module that fails to load (a syntax error, a throw while building) is reported in the app and in the Extensions sheet. An edit that fails keeps the previous version running.
- A restart installs every module that is on again. Work an extension's tasks left pending resumes once it is installed.

You cannot turn a drop-in on yourself: ask the owner to, in Menu → Extensions.

## Tools

`defineTool({ name, description, parameters, execute, replay })`. `parameters` is a TypeBox schema (`Type` from `@earendil-works/pi-ai`); the arguments are checked against it before `execute(args, api, context)` runs.

- Return `{ content: [{ type: "text", text }] }`. Throw an `Error` to give the model an error result with its message.
- `replay: "safe"` only when running the call twice is harmless (reading, or an action keyed so a repeat finds the first one's result). The default is unsafe: a call cut off by a restart comes back to the model as interrupted instead of running again.
- `api.conversationId`, `api.taskId`, `api.callId` say which call this is. `${api.taskId}:${api.callId}` is a key that stays the same if the call runs again.
- `api.env` is the session folder's files and shell; `(await api.agent(context)).cwd` is the folder.
- `api.output(text)` streams running output, which becomes the result when `execute` returns no `content`.
- `api.memo(name, context)` reads, and `api.memo(name, value, context)` stores, a value kept with this call: a repeat after a restart finds it. Use it for anything that must not happen twice.
- `api.snapshot(Doc, api.conversationId, context)` reads a document, such as Pi Pocket's in `src/server/docs.ts`.

The tool's description and parameters go into every request: keep them short and exact.

## Prompt sections

`section(name, render, { tag })`: `render(input, context)` returns text, or `undefined` to leave the section out. By default it is wrapped in `<name>…</name>`; `{ tag: false }` leaves it bare.

Sections render before every request, and only those that changed are sent again. Return the same text while nothing changed: the date, not the time; no counters. `input.conversationId` and `input.read.snapshot(Doc, input.conversationId, context)` let a section depend on the session.

## Hooks

`hook(ToolTask, { beforeTool, afterTool })` and `hook(GenerationTask, { beforeRequest, afterResponse, onYield, afterTools })`.

- `beforeTool(call, api, context)` sees `call.name` and `call.arguments` before the call runs. Return `{ block: "why" }` to stop it (the model gets the reason as an error), or `undefined` to let it run. Codemode scripts' calls go through it too.
- `onYield(answer, api, context)` runs after Pi's final answer. Return `{ continue: "message" }` to send Pi on with another message, as Done when does (`extensions/goals.ts`).
- A hook can run again after a restart. Keep what must happen once in `api.memo`, as `extensions/guard.ts` does with an approval.

## The host

What the default export receives. Extensions reach the app only through it; it stays the same while modules reload.

| Member                           | What it is                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `dataDir`, `agentDir`            | Pi Pocket's data folder; Pi's (`~/.pi/agent`)                                                      |
| `notice(level, message)`         | Report something to the server log and the app (`"info"`, `"warning"`, `"error"`)                  |
| `resolveModel(spec)`             | `provider/modelId` (or a bare id) to an available model, or an error naming the choices            |
| `requesterOf(conversationId)`    | The id of the person Pi works for in a session now                                                 |
| `skillPaths()`                   | The extra skill folders in Pi's settings                                                           |
| `skills(cwd)`                    | Pi's skills for a session working in `cwd`, from every place Pi looks                              |
| `heldBack(conversationId)`       | Why work Pi would start there with nobody asking may not start now (a spend limit), or `undefined` |
| `onLimitsChanged(listener)`      | Call `listener` when the owner changes a spend limit; returns how to stop                          |
| `approvals`, `guard`             | Calls waiting for a person to allow them; Lancet Guard                                             |
| `schedules`, `goals`, `browsers` | Scheduled messages, Done when, and the built-in browser, as their extensions use them              |

To type it, import the type by the absolute path of `src/server/host.ts`: `import type { PocketHost } from "/path/to/pi-pocket/src/server/host.ts";`. A type import is gone when the module runs, so the path only matters to the type checker.

## Rules that are easy to break

- **Nothing twice.** A restart can run a hook or a safe tool again. Anything that must happen once (a message sent, money spent, a file appended to) goes behind `api.memo` or a key that makes a repeat find the first.
- **No surprise state.** Keep state in Pi Durable documents or memos, not in variables: a reload starts the module over, and a restart starts the process over.
- **Do not block.** Tools run in the server process: use async file and process calls, never `execSync` or a busy loop. A slow tool holds up only its call; a blocked event loop holds up everyone.
- **Do not get around a block.** A guard or a person said no for a reason.
- **Secrets stay out.** Text in a section, a tool's description, or a result goes to the model provider.

## Testing

Copy the module into a test app's data folder and turn it on, as `test/docs-examples.test.ts` does: `openApp` with a scripted model (`test/helpers.ts`), the file in `<dataDir>/extensions/`, `app.setExtensionEnabled(owner, file, true)`, then a session whose scripted model calls the tool. Nothing reaches a real provider, and nothing touches the live data.

For a drop-in, run the test from Pi Pocket's folder with the module copied in, or check it by hand: turn it on, ask Pi to use it in a session made for the purpose, and watch Menu → Extensions and the app's notices for errors.

## A built-in extension

A new file in `src/server/extensions/` is loaded into the running server about 300 ms after it is first saved, on, for everyone: there is no way to try it there first. So write it as a drop-in, check it on a copy ([self-editing.md](self-editing.md#check-it-on-a-copy)), and move it in when it works.

Then, in `src/server/reload.ts`, give it its place in `ORDER` and its title in `TITLES` (and `OFF_BY_DEFAULT` if it should start off), and add its tools' names to `BUILT_IN_TOOLS`, so no drop-in takes them (`test/dropins.test.ts` fails until you do). Name the extension `pocket-…`. `reload.ts` is not an extension: these take effect at the next restart. `test/app.test.ts` asserts the order.
