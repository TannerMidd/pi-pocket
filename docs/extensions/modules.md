# Modules, loading, and errors

A module is one file that Pi Pocket loads. This page tells what the file must be, and how Pi Pocket loads it, loads it again, and reports its errors. For the default export and what it returns, see [A module](../extensions.md#a-module).

## The file

- **TypeScript that Node runs as it is.** Use only erasable syntax: no `enum`, no `namespace`, and no constructor parameter properties. A local import ends in `.ts`.
- **Packages by name.** Import `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/pi-mcp` (Pi's MCP client), and the other packages of Pi Pocket by name. The drop-in folder has a `node_modules` link to Pi Pocket's own packages, so a drop-in gets the same modules that the server runs.
- **A name of its own.** The file name must be different from the name of each built-in module. For example, Pi Pocket does not load a drop-in named `browser.ts`. Give each extension and tool in it a name with a prefix of your own, for example `my-words` and `my_word_count`. Pi Pocket does not load a module that takes a name that Pi Pocket keeps (such as `pocket-…`, or a built-in tool's), or a name that another module has. See [Names](reference/names.md).
- **A description.** Start the file with a `/** … */` comment. Its first sentence says what the module does. The Extensions sheet shows it.

Files that start with `_`, or end in `.test.ts`, are not modules. Use them for helpers and tests. Pi Pocket does not load a helper again when it changes, even when it loads the module that imports it again: a change to a helper needs a restart. Keep the code that you change often in the module itself.

## Turning it on and off

- A drop-in shows in Menu → Extensions when its file is there. It is off.
- When the owner turns it on, Pi Pocket loads it.
- When the owner turns it off, Pi Pocket removes all that it installed, its routes and browser module too.

You cannot turn on a drop-in yourself. Ask the owner to turn it on in Menu → Extensions.

## Loading it again

- When you save a module that is on, Pi Pocket loads it again a moment later ([limits](reference/limits.md#loading)).
- A tool call that runs at that time finishes with the old version. The next call uses the new version.
- When you save a file of the browser module, the tabs load its new version ([Browser modules](browser-modules.md)).
- The latest choice and the latest version win. A load can wait, at the top level of the module or in an `async` default export. When the owner turns the module off, removes it, or saves it again during that wait, the load installs nothing when it ends. Pi Pocket does not report a failure of that load.
- Some editors remove a file for a moment when they save it. This does not remove the module: Pi Pocket removes a module only when its file is still gone a moment later.

## Time limits

- A load has a time limit ([limits](reference/limits.md#loading)): the import, and an `async` default export. A load that takes longer fails.
- When the server starts, all the modules share one time limit. After it, each module has a short limit of its own. So modules that hang delay the start, but not by the full limit for each module.
- Pi Pocket does not stop a load that fails this way. What it started, such as a timer or a connection, continues until the server restarts, but nothing that it registers counts.

Do slow work after the module loads, not while it loads.

## Errors

- When a module does not load (a syntax error, or an error that it throws while it sets up), Pi Pocket tells the owner. The Extensions sheet shows the error. A notice also shows it, when the module failed at the server's start or after an edit.
- Other people see only that the module failed. The error can name the server's folders, or quote a model provider.
- When an edit does not load, the previous version continues to run, with its routes and browser module.

## Deprecated members

A member of the API that will go is marked **Deprecated** in the reference and in `types/pocket.d.ts`, with what to use instead, and when it goes. Nothing is deprecated now. The first release that deprecates a public member also adds a warning that the owner sees when a module uses it. [API stability](policies/api-stability.md) gives the rules: what is public, what is a breaking change, and how long a deprecated member stays.

## Restarts

A restart installs again each module that is on. Work that the module's tasks did not finish continues when the module is installed.
