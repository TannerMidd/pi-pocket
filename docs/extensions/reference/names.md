# Names

The rules for the names that a module gives. These are the names of its file, extensions, tools, routes, ids, commands, events, and stored data. [Limits](limits.md#names) gives the longest length of each name.

## Extensions and tools

To install an extension with the name of an installed extension replaces that extension. A tool with the name of another tool replaces it in all sessions. Thus Pi Pocket refuses a drop-in that would take a name that Pi Pocket keeps, or a name that another module has. Menu → Extensions says why.

- **Extension names that Pi Pocket keeps:** `coding-tools`, and all names that start with `pocket-`, such as `pocket-core`, `pocket-prompt`, and `pocket-guard`. This is true also when that built-in module is off.
- **Built-in tools:** `read`, `write`, `edit`, `bash`, `artifact`, `artifact_inline`, `browser`, `subagent`, `team`, `schedule`, `codemode`, and `memory`. PiP's tools: `sessions`, `session_read`, `session_start`, `session_send`, `session_follow`, `session_stop`, `session_archive`, `session_schedule`, `approvals`, `repo_watch`, and `session_watch_pr`. The triggers' tool: `watch_pr`.
- **Names that another module has:** the first module to install an extension or tool keeps its name.

Give each extension and tool a name of your own, with a prefix: `example-clock`, `acme_lookup`. To change how a built-in tool works, do not replace it. Wrap it (`wrapTool` in Pi Durable's README), or check its calls with a hook.

## Module files

- A module is a `.ts` file in the drop-in folder.
- Files that start with `_`, or that end in `.test.ts`, are not modules. Use them for helpers and tests.
- A drop-in with the name of a built-in module does not load. The built-in modules are `prompt`, `artifacts`, `browser`, `subagents`, `agent-teams`, `schedules`, `goals`, `plan`, `guard`, `codemode`, `memory`, `pip`, `triggers`, and `gallery`.
- `_pocket.d.ts` in the drop-in folder is Pi Pocket's link to its types. Do not use this name. See [Types for your editor](types.md).

What a module adds to the app uses the name of its file without `.ts`: `server-status.ts` is `server-status`, at `/api/x/server-status/` and `/x/server-status/`. File names are unique across the two folders of modules, so these addresses never collide. A module that adds to the app needs a name of letters, digits, `-`, and `_` that starts with a letter or digit.

## Routes

Each part of a route's path is one of these:

- Letters, digits, and `.`, `_`, `~`, and `-`, but not `.` or `..` alone.
- `:name`: a letter or `_`, then letters, digits, and `_`. One path cannot use the same `:name` two times.

## Browser modules

The `entry` of `web.client(entry)` is the name of a file or folder immediately beside the module. It has letters, digits, `.`, `_`, and `-`, and starts with a letter, a digit, or `_`. It cannot be `node_modules`.

## What a browser module adds

Each rail button, menu row, launcher action, page, and sheet has an `id` in its module. An id has letters, digits, and `.`, `_`, `:`, and `-`, and starts with a letter or digit. To add a thing with the `id` of a thing of the same kind replaces it.

## Commands

- A command's name has lowercase letters, digits, `-`, and `_`. It starts with a letter, and it has at least one `-`: `acme-status`, not `status`. Give it without the `/`.
- The app's own commands are one word each. Thus a new command of the app never takes your name.
- Give the name a prefix of your own. When another module has a command with the name, Pi Pocket refuses yours: the first module keeps the name.
- When a prompt template has the same name, the template wins in the message box.

## Events

The name of an event of `web.send` has letters, digits, and `.`, `_`, `:`, and `-`.

## Documents, tasks, and entries

Your documents are stored data. Name a document kind after your module, as `x.<module>.<name>`: `x.word-count.totals`. Thus no other module uses the same kind. Name your tasks and the kinds of your entries the same way.

After somebody has run your module, do not rename a kind or a name, and do not change what its fields mean. Add new ones beside them.

## Gallery entries

An entry's files are its drop-in's own, and they use the module's name. Thus they never collide with the files of another entry.

- `<name>` has lowercase letters, digits, `-`, and `_`, and starts with a letter or digit. It cannot be the name of a built-in module, and it cannot start with `pocket-`. It cannot be a name that Windows keeps for a device, such as `con` or `nul`.
- The module is `<name>.ts`.
- Its browser module is `<name>.js` or `<name>.mjs` beside it, or the folder `<name>/`.
- Helpers go in the folder `<name>/` too, such as `import { zones } from "./<name>/zones.ts"`. The folder serves no `.ts` files to browsers.
- Each part of a path in the folder has letters, digits, `.`, `_`, and `-`, and starts with a letter, a digit, or `_`. A part cannot be `node_modules`, or a name that Windows reads as another name.
- The extensions and tools of the module follow the rules in [Extensions and tools](#extensions-and-tools).
