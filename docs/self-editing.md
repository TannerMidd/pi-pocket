# Changing Pi Pocket's code while it runs

Pi Pocket is often changed from inside itself: you may be running on the very server you edit, and so may everyone else using it. [AGENTS.md](../AGENTS.md) has the rules in short; this page is the whole of it.

Before you start, read [map.md](map.md) for where the code you need is, and the part of [architecture.md](architecture.md) about it. Say what you will change, and wait for a yes unless you were asked for exactly that.

## When a change takes effect

| You save                             | What happens                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A file in `web/`                     | Every open browser reloads, at once. A syntax error blanks the app for everyone, you included.                                                       |
| A module in `src/server/extensions/` | It is reinstalled into the running server about 300 ms later. If it fails to load, the previous version keeps running and the app reports the error. |
| Any other file in `src/server/`      | Nothing, until the server restarts.                                                                                                                  |
| `docs/`, `test/`                     | Nothing runs it, except `npm test`.                                                                                                                  |

So a change to an extension module and to other server code goes live in halves: the module at once, against the server as it was started. A module that calls something the rest of the change adds (a new member of the host, a new function in `src/server/`) breaks until the restart. Have it check that the new part is there, and do as before when it is not (`docs/extensions.md`, the host).

## After every save

- **`web/*.js`:** `node --check web/<file>.js` at once, before anything else. If the app went blank, this says why. Check the change in a browser (below): there are tests for some of the web app (`test/mobile-ui.test.ts`, `test/peeks-ui.test.ts`), not all of it.
- **An extension module:** watch for the reload notice, or its error, in the app.
- **Other server code:** `npm run check`.

Then, before you call it done:

```sh
npm run format   # Prettier and ESLint's fixes
npm run lint
npm run check    # TypeScript
npm test         # every test; the browser tests need Chromium
```

`npm test` takes a few minutes. While you work, run the tests of the part you changed (`node --test test/<name>.test.ts`); run them all before you call it done or ask for a restart. If you leave a check out, say which.

Keep [map.md](map.md), [architecture.md](architecture.md), and [features.md](features.md) true: a change that moves code, adds a dependency between parts, or changes what people see updates them in the same change.

## Check it on a copy

Never try a change on the server people use, and never with their data. Two ways:

- **A test.** `test/helpers.ts` opens the app on a temporary data folder with a scripted model (`openApp`, `newSession`, `say`, `until`). Most features have a test in `test/` to copy from. `test/mobile-ui.test.ts` drives the whole web app in Chromium at phone size.
- **A copy you can open.** `test/serve.ts` runs this folder's code on a temporary data folder, with a scripted model that answers "echo: …" and costs nothing, and prints sign-in links for an owner and a guest. Web files and extension modules reload in it as you save; restart it after any other server change.

It runs until stopped, so start it in the background from a tool call, or the call waits for ever:

```sh
nohup node test/serve.ts > /tmp/pocket-copy.log 2>&1 &
sleep 5; cat /tmp/pocket-copy.log   # the sign-in links, and the kill that stops it
```

Open a link with the browser tool (at the `mobile` viewport too: most people use a phone), and read its console for errors. Stop it with the `kill <id>` it printed, which also deletes its data (`kill -9` would leave the data behind in the temporary folder). Use that id, not `$!`: after `cd somewhere && node … &`, `$!` is the shell's, not the copy's.

It listens on `127.0.0.2:8899`. Browsers keep cookies per host, not per port: signing in to a copy on `127.0.0.1` or `localhost` would sign the same browser out of the real server. macOS answers on `127.0.0.1` only: there, run `node test/serve.ts 8899 127.0.0.1`, and open the real server as `localhost` meanwhile.

## Restarting

Server changes outside `extensions/` need a restart. Only the owner can, from Menu → **Restart server** (shown when Pi Pocket runs under its launcher, as `pi-pocket` does).

- **Never restart while your own tool call runs**, and never on your own: finish the edit, run `npm run check` and `npm test`, then ask the person to restart.
- Running work resumes after a restart. A tool call that was cut off and is not safe to repeat comes back to the model as interrupted.
- A server that fails to start takes Pi Pocket down for everyone, and you cannot fix it from the app. The launcher keeps trying, more slowly each time, and prints the error in its terminal. Fixing the file is enough: its next try picks the fix up.

## Getting a broken change back

- **A blank app** (a syntax error in `web/`): the server is fine and your work goes on. Fix the file; every browser reloads.
- **An extension that will not load:** the previous version still runs. Fix the file, or turn the module off in Menu → Extensions.
- **A server that will not start:** someone at the machine fixes the file, or puts it back with `git checkout -- <file>` (see `git diff` first: it may hold other work). The launcher picks it up.

Work in small steps, each one checked, so the step to undo is small.

## Rules that are easy to break

The full list is in [map.md](map.md#rules-that-are-easy-to-break). The ones that cost the most:

- **Stored data is forever.** Document kinds in `src/server/docs.ts`, entry kinds and message markers in `src/server/entry-format.ts`, and the fields of `config.json` are read back from what is stored. Never rename them or change their meaning; add new ones beside them. An older Pi Pocket may read a newer `config.json`: a new field must be one it can ignore.
- **Erasable TypeScript only** in `src/` (no `enum`, no `namespace`, no parameter properties), with `.ts` imports. Node runs it as it is.
- **The web app has no build.** Plain ES modules with Preact and htm; markup is laid out by hand ([AGENTS.md](../AGENTS.md) says how). In htm, a line break is not a space.
- **Phones first.** Controls a thumb can hit (about 40 px), nothing wider than the screen, and back closes what opened last (`useBack`, [map.md](map.md#adding-things)). Check at 390 × 844.
- **Do not commit, push, or publish** unless asked. Show the diff instead.
