# Changing Pi Pocket's code while it runs

People often change Pi Pocket from inside itself. You can run on the server that you change, and so can all the other people who use it. [AGENTS.md](../AGENTS.md) gives the rules in short; this page gives all of them.

Change a git checkout only. In a copy installed with npm (in a `node_modules` folder), the next update with npm replaces each edit, and the folder often belongs to another user. An update from the app (Menu → Update Pi Pocket) of a global npm install also swaps the whole package folder, so it removes edits there too.

Before you start, read [map.md](map.md) to find the code that you need, and the part of [architecture.md](architecture.md) about it. Say what you will change. Then wait for a yes, unless the person asked for exactly that change.

## When a change takes effect

| You save                             | What happens                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A file in `web/`                     | Each open browser loads again, at once. A syntax error makes the app blank for everyone, you too.                                           |
| A module in `src/server/extensions/` | The server installs it again about 300 ms later. If it does not load, the previous version continues to run, and the app reports the error. |
| Any other file in `src/server/`      | Nothing, until the server restarts.                                                                                                         |
| `docs/`, `test/`                     | Nothing runs it, except `npm test`.                                                                                                         |

So a change to an extension module and to other server code goes live in two parts. The module goes live at once, on the server as it started. A module that calls something that the rest of the change adds (a new member of the host, a new function in `src/server/`) breaks until the restart. Make it check that the new part is there, and do as before when it is not ([extensions/host.md](extensions/host.md)).

## After each save

- **`web/*.js`:** run `node --check web/<file>.js` at once, before anything else. If the app went blank, this tells why. Check the change in a browser (below). There are tests for a few of the web app's risks (`test/*-ui.test.ts`), not for most of it.
- **An extension module:** watch for the reload notice, or its error, in the app.
- **Other server code:** run `npm run check`.
- **A page in `docs/`:** a new page needs a row in `docs-site/src/sidebar.mjs`, or the docs build fails. To check the links, anchors, and the reference, run `cd docs-site && npm ci && npm run check` (the site's own packages, never at the root). The root `npm run check` also checks that the reference and `types/pocket.d.ts` agree.

Then, before you say that the change is done:

```sh
npm run format   # Prettier and ESLint's fixes
npm run lint
npm run check    # TypeScript
npm test         # every test; the browser tests need Chromium
```

`npm test` takes a few minutes. While you work, run the tests of the part that you changed (`node --test test/<name>.test.ts`). Run all of them before you say that the change is done, or before you ask for a restart. If you do not run a check, say which.

Keep [map.md](map.md), [architecture.md](architecture.md), and [features.md](features.md) true. When a change moves code, adds a dependency between parts, or changes what people see, update them in the same change.

## Check it on a copy

Never try a change on the server that people use, and never with their data. There are two ways:

- **A test.** `test/helpers.ts` opens the app on a temporary data folder with a scripted model (`openApp`, `newSession`, `say`, `until`). Most features have a test in `test/` that you can copy. `test/mobile-ui.test.ts` drives the whole web app in Chromium at the size of a phone.
- **A copy that you can open.** `test/serve.ts` runs the code of this folder on a temporary data folder. Its scripted model answers "echo: …", and costs nothing. It prints sign-in links for an owner and a guest. Web files and extension modules load again in it when you save them. Restart it after any other server change.

The copy runs until you stop it. So start it in the background from a tool call, or the call waits forever:

```sh
nohup node test/serve.ts > /tmp/pocket-copy.log 2>&1 &
sleep 5; cat /tmp/pocket-copy.log   # the sign-in links, and the kill that stops it
```

Open a link with the browser tool, also at the `mobile` viewport, because most people use a phone. Read its console for errors.

Stop the copy with the `kill <id>` that it printed. This also deletes its data; `kill -9` would leave the data in the temporary folder. Use that id, not `$!`: after `cd somewhere && node … &`, `$!` is the shell's id, not the copy's.

The copy listens on `127.0.0.2:8899`. Browsers keep cookies for each host, not for each port: a sign-in to a copy on `127.0.0.1` or `localhost` would sign the same browser out of the real server. macOS answers only on `127.0.0.1`. There, run `node test/serve.ts 8899 127.0.0.1`, and open the real server as `localhost` at the same time.

## Restarting

Server changes outside `extensions/` need a restart. Only the owner can restart, from Menu → **Restart server**. This menu item shows when Pi Pocket runs under its launcher, as `pi-pocket` does.

- **Never restart while your own tool call runs**, and never on your own. Finish the edit, run `npm run check` and `npm test`, and then ask the person to restart.
- Work that runs continues after a restart. A tool call that the restart stopped, and that is not safe to repeat, comes back to the model as interrupted.
- A server that does not start stops Pi Pocket for everyone, and you cannot correct it from the app. The launcher tries again and again, more slowly each time, and prints the error in its terminal. A correction of the file is enough: the next try uses it. While an update from the app is under way, the launcher goes back to the version before instead.
- Changes that are not committed stop an update from the app (Menu → Update Pi Pocket): commit them, or put them aside with `git stash`, first.

## Undo a change that breaks it

- **A blank app** (a syntax error in `web/`): the server is good, and your work continues. Correct the file; each browser loads again.
- **An extension that does not load:** the previous version still runs. Correct the file, or turn off the module in Menu → Extensions.
- **A server that does not start:** a person at the machine corrects the file, or puts it back with `git checkout -- <file>`. Look at `git diff` first: it can have other work in it. The launcher uses the file when it tries again.

Work in small steps, and check each step. Then the step to undo is small.

## Rules that are easy to break

The full list is in [map.md](map.md#rules-that-are-easy-to-break). These cost the most:

- **Stored data is forever.** Pi Pocket reads back the document kinds in `src/server/docs.ts`, the entry kinds and message markers in `src/server/entry-format.ts`, and the fields of `config.json` from what it stored. Never rename them, and never change what they mean: add new ones beside them. An older Pi Pocket can read a newer `config.json`, so a new field must be one that it can ignore.
- **Only erasable TypeScript** in `src/`: no `enum`, no `namespace`, and no parameter properties. Imports end in `.ts`. Node runs the code as it is.
- **The web app has no build.** It is plain ES modules with Preact and htm. Lay out the markup by hand ([AGENTS.md](../AGENTS.md) tells how). In htm, a line break is not a space.
- **Phones first.** Controls must be big enough for a thumb (about 40 px), nothing can be wider than the screen, and back closes what opened last (`useBack`, [map.md](map.md#adding-things)). Check at 390 × 844.
