# Project map

Where things are in Pi Pocket, for agents working on it. [index.md](index.md) lists every guide; [AGENTS.md](../AGENTS.md) and [self-editing.md](self-editing.md) have the rules for editing it while it runs; [architecture.md](architecture.md) explains how the parts depend on each other and the orderings they rely on; [features.md](features.md) says what each feature does.

## Processes

`bin/pi-pocket.js` checks Node, then runs `src/launcher/main.ts`. The launcher reads its options (`options.ts`), asks how devices connect (`access.ts`: this device, LAN, Cloudflare quick tunnel, Tailscale), runs the server (`src/server/main.ts`) as a child, restarts it on exit code 75 or a crash, and keeps the tunnel up. `term.ts` draws its menu, panel, and QR code in the terminal. The server takes the data folder's lock, opens one `PocketApp`, and serves it with `http.ts`.

## Data (`~/.pi-pocket/`, or `PI_POCKET_DIR`)

- `pocket.sqlite`: Pi Durable's storage: conversations, entries, tasks, and Pi Pocket's documents.
- `config.json`: people, roles, hashed tokens, settings. `push.json`: VAPID keys and push subscriptions.
- `uploads/<conversation>/`, `worktrees/` (sessions' git worktrees), `extensions/` (the owner's drop-ins), `browser/profile/` (the built-in browser's profile; each session's cookies live in memory only).

## Server: `src/server/`

A module split into parts keeps its name for the part others import, with the rest in a folder of the same name beside it (`http.ts` and `http/`, `browser.ts` and `browser/`). Modules import what they use from the module that owns it; there are no barrels. `PocketApp` creates the app's parts and hands each one the app; callers use them as fields (`app.workspace.viewFile(…)`, `app.attribution.requesterOf(…)`).

### The core

| File                    | Owns                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`               | The server process: options, the port, signals, then `PocketApp.open` and `createHandler`                                                                                                                                                                             |
| `app.ts`                | `PocketApp`: opening the harness, reading state back at startup (`#recover`), the commit coordinator (`#committed`), connected tabs and their peek tiles, access checks (`canSee`, `requireSteer`, `requireDriver`), the session list, `hello`, extensions on and off |
| `attribution.ts`        | Who Pi works for: who wrote each message to Pi or whose work it is (authors documents, from request ids), who queued each submission; read back at startup                                                                                                            |
| `room.ts`               | One conversation's live view for its tabs: Pi Durable's view plus `ROOM_DOCS`, sent every 90 ms as changes; its peek tile (`peek`, at most once a second) for the tabs that show it (`PocketApp.setPeeks`)                                                            |
| `projection.ts`         | Entries as compact JSON for browsers; `usageCost`                                                                                                                                                                                                                     |
| `entry-format.ts`       | The kinds of Pi Pocket's own entries, and the markers it writes into message text (`[from: …]`, attached files). Stored data and the web app depend on their exact values                                                                                             |
| `docs.ts`               | Every durable document Pi Pocket defines                                                                                                                                                                                                                              |
| `host.ts`, `reload.ts`  | `PocketHost` (what extensions get) and `Approvals`; the extension loader: built-ins in `ORDER`, drop-ins (never with a name Pi Pocket keeps, `BUILT_IN_TOOLS`), live reload; per-module native command registration (`BUILT_IN_COMMANDS`)                             |
| `lock.ts`               | One process per data folder                                                                                                                                                                                                                                           |
| `errors.ts`, `paths.ts` | `HttpError`, `describe`, and input checks; `~` paths                                                                                                                                                                                                                  |

### People

| File                   | Owns                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `config.ts`, `auth.ts` | People and settings; cookies, tokens, invites                                                    |
| `requests.ts`          | Request ids, which say whose each message to Pi is (`u:` a person's own, `p:` sent for a person) |
| `collab.ts`            | Chat, activity lines (`addActivity`), reactions, pins, notes, typing, take turns                 |
| `alerts.ts`, `push.ts` | Push notifications: who hears about what; Web Push without dependencies (RFC 8291, 8292)         |
| `spend.ts`             | Cost per conversation and person; limits                                                         |

### What people ask of Pi

| File                      | Owns                                                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.ts`             | What people ask of Pi: sessions, messages (with skills, templates, and mentioned files expanded), forks and resends, model and folder, reset, instructions, plan mode, goals, schedules, worktrees, notes Pi is told |
| `resend.ts`               | A message sent again: the task made with its fork that sends it                                                                                                                                                      |
| `extension-commands.ts`   | Native command admission, access, task-backed receipts and retries, display-only cards, and stopping                                                                                                                 |
| `shell.ts`                | `!` and `!!` commands: a background task per command that runs it and writes a `pocket.shell` entry; a restart cuts it off rather than running it again                                                              |
| `schedules.ts`, `when.ts` | Scheduled messages (a durable task) and their time grammar                                                                                                                                                           |
| `goals.ts`                | "Done when" checks                                                                                                                                                                                                   |
| `titles.ts`               | A short title for a session with a long first message, from a small model of its provider                                                                                                                            |
| `prompts.ts`              | Pi's prompt templates and skills (`/skill:name`) as slash commands                                                                                                                                                   |
| `models.ts`               | The models people can pick, the one a conversation runs with, and finding one by name                                                                                                                                |
| `running.ts`              | Running now, from Pi Durable's task graph                                                                                                                                                                            |

### A conversation's folder and history

| File                                   | Owns                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.ts`                         | `app.workspace`: which files a person may load or read through a conversation, the file viewer, the files for `@` mentions, Changes, uploads, new folders from the folder picker                   |
| `transcripts.ts`                       | `app.transcripts`: stored history as people read it: an entry (its own, or one a fork inherited), the images in it, what came before the active context, and the session as Markdown               |
| `files.ts`                             | The files in a session's folder for `@` mentions: git's list, or a capped walk; kept briefly per folder, versioned, and compressed once. The file viewer's reads, and the paths a message mentions |
| `changes.ts`, `worktrees.ts`, `git.ts` | The Files tile's Changes (and undoing a file there), per-session worktrees, and the git runner both use                                                                                            |
| `branches.ts`                          | A session's git branch: read from the repository's HEAD for its view (`Room` looks every few seconds), listed and switched for the branch picker                                                   |
| `export.ts`                            | A session as Markdown                                                                                                                                                                              |

### HTTP: `http.ts` and `http/`

| File                          | Owns                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.ts`                     | The one request handler: which part answers a path, and the error boundary that turns what it throws into a status                                              |
| `http/api.ts`                 | `/api`: signing in, the `X-Pocket` header, and the app-wide routes (people, sessions, peeks, spend, folders, settings, extensions, providers, invites, restart) |
| `http/conversation-routes.ts` | `/api/c/:id`: one conversation's routes, after the API checked that the person may see it                                                                       |
| `http/browser-routes.ts`      | `/api/c/:id/browser`: the Browser panel's frames, console, and input                                                                                            |
| `http/push-routes.ts`         | `/api/push`: this device's subscription, what to notify about, a test                                                                                           |
| `http/events.ts`              | Each tab's events: the event stream (`/api/events`), or long polling (`/api/poll`) where a tunnel holds streams back                                            |
| `http/assets.ts`              | The web app's files, the vendored modules, the app's content security policy, and image files                                                                   |
| `http/sign-in.ts`             | `/login`, `/join/:code`, and `/share` before the service worker takes shares                                                                                    |
| `http/artifacts.ts`           | `/a/…`: an artifact as its own page, in a sandbox; `/a/frame`, the page a reply's HTML runs in once someone taps Run                                            |
| `http/io.ts`                  | What every route uses: reading a body, writing JSON, `ApiRequest`                                                                                               |

### The built-in browser: `browser.ts` and `browser/`

| File                                     | Owns                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `browser.ts`                             | `Browsers`: one headless Chromium for every conversation, started with the first page and stopped after the last; each conversation's page |
| `browser/page.ts`                        | `BrowserPage`: one conversation's page: its events, screencast frames, console, navigation, and what Pi and people do to it                |
| `browser/cdp.ts`                         | The DevTools protocol over a pipe (`--remote-debugging-pipe`), and the Chromium process; `BrowserError`                                    |
| `browser/discovery.ts`                   | Finding a Chromium-based browser on this machine, and where its profile goes                                                               |
| `browser/page-scripts.ts`                | The scripts that run inside a page: the outline with refs for Pi, finding a target, selecting                                              |
| `browser/keys.ts`                        | Key names and combinations as key events                                                                                                   |
| `browser/viewport.ts`, `browser/urls.ts` | Page sizes and their presets; what people and Pi type, made into addresses                                                                 |
| `browser/local-servers.ts`               | The web servers running on this machine, for the panel's start screen                                                                      |

### Elsewhere

| File                     | Owns                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `providers.ts`, `net.ts` | Provider sign-ins; HTTP settings for provider streams                                           |
| `lancet.ts`              | Loads Lancet Guard from Pi's install                                                            |
| `omarchy.ts`             | The Omarchy desktop's current theme and wallpaper, read-only, for Follow desktop (`/api/theme`) |

## Extensions: `src/server/extensions/`

Each default-exports `(host: PocketHost) => Extension | Extension[]` and is installed in this order: `prompt` (system prompt, with where Pi Pocket's docs are), `artifacts` (artifact tool), `browser` (browser tool and its prompt section; through `host.browsers`), `subagents` (subagent tool and its tasks), `schedules` (schedule tool; installs the schedule task), `goals` (hook after each answer), `plan` (tool hook and prompt section), `guard` (tool hook that asks for approval), `codemode` (codemode tool; a script's calls go through the same hooks).

## Web: `web/` (Preact and htm, no build)

Plain ES modules, loaded as they are. `store.js` holds the shared state, and nothing imports in a circle. Some modules do work when they load: `back.js` (it hears back and forward), `store.js`, `ui.js` (Markdown and sanitizer setup, document listeners), `theme.js` (the saved appearance, which `prefs()` reads), `peeks.js`, `browser-panel.js` and `files-panel.js` (the panels' saved widths), `rich.js` (gives `Markdown` its rich block), `sheets.js` (a step back for each sheet opened from another), and `app.js`. `store.set` calls subscribers in the order they subscribed, so keep the order in which modules load when moving code between them.

| File                   | Owns                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store.js`             | State, the event stream (SSE, or long polling when a tunnel holds it back), `api()`, `actions`                                                                                                                                                                                                                                                                                   |
| `back.js`              | The back stack: routes and the layers over them (sheets, the drawer, panels that cover the screen, a file over the tree) as history entries, so back closes what opened last; `useBack`, `pushRoute`, `goHome`, the list put under a conversation opened straight away, taps let go that land on what just slid in                                                               |
| `gestures.js`          | Touch gestures, each following its own finger by its identifier, passive where they can be: sheets dragged down and the drawer dragged left to close (`useDragToClose`); on phones, swipes on the conversation (right back, left Files), in Files (right back), and up from the message box (the places); a swipe in from the left edge goes back in an iPhone's home screen app |
| `app.js`               | Layout (tiled windows), top bar, notices, keyboard shortcuts, routing                                                                                                                                                                                                                                                                                                            |
| `transcript.js`        | Messages, tool and native-command cards, approvals, breadcrumbs                                                                                                                                                                                                                                                                                                                  |
| `calls.js`             | A tool call in one line, for tool cards and peek tiles                                                                                                                                                                                                                                                                                                                           |
| `composer.js`          | Message box, chips, plan and goal bars, `@` file suggestions, `!` commands, ↑ and Ctrl+R history, long-paste placeholders                                                                                                                                                                                                                                                        |
| `history.js`           | What this browser sent, for ↑ and Ctrl+R                                                                                                                                                                                                                                                                                                                                         |
| `files.js`             | `@` mentions: the folder's file list, fetched once and checked in the background, and matched here as people type                                                                                                                                                                                                                                                                |
| `commands.js`          | Built-in and native extension slash commands, prompt templates, and tab-local native request retries                                                                                                                                                                                                                                                                             |
| `sheets.js`            | Which sheet is open, and the component that shows it                                                                                                                                                                                                                                                                                                                             |
| `sheets/*.js`          | One sheet (or a few close ones) each: the model and branch pickers, folder, extensions, providers, people and invites, the file viewer (`FileView`, which the Files tile shows too), find, spend, running now, schedules, worktree, appearance, shortcuts, the menu                                                                                                              |
| `peeks.js`             | Peek tiles: their switch, which sessions get one and in what order, the column and the strip, the watch list                                                                                                                                                                                                                                                                     |
| `chat.js`              | People panel: chat, pins, notes; the chat sheet                                                                                                                                                                                                                                                                                                                                  |
| `avatar.js`            | People's avatars and colors                                                                                                                                                                                                                                                                                                                                                      |
| `sessions.js`          | Session list (sidebar, drawer), selecting rows and archiving them with undo (`setArchived`), the folded rail                                                                                                                                                                                                                                                                     |
| `home.js`, `signin.js` | The wide home screen; the sign-in screen                                                                                                                                                                                                                                                                                                                                         |
| `notify.js`, `sw.js`   | Push, the icon badge, approvals from notifications, shares; the notifications sheet                                                                                                                                                                                                                                                                                              |
| `share.js`             | Share to Pi                                                                                                                                                                                                                                                                                                                                                                      |
| `ui.js`                | htm binding, Markdown (code blocks colored and labeled, split into parts around the blocks `rich.js` draws), formatting, icons, `Sheet`, `Switch`, `item` (a menu row), `usePresence` (animate out), `useSlide` (sliding indicators)                                                                                                                                             |
| `theme.js`             | Appearance: palettes as CSS variables, Follow desktop, tiling, motion, text size, sidebar shape, pins; the theme reveal                                                                                                                                                                                                                                                          |
| `themes.js`            | Omarchy's themes as palettes, generated from `/usr/share/omarchy/themes/*/colors.toml`                                                                                                                                                                                                                                                                                           |
| `launcher.js`          | The Ctrl/⌘+K launcher: sessions, actions, and themes, with live theme previews                                                                                                                                                                                                                                                                                                   |
| `browser.js`           | Whether the Browser panel is open, and opening an address in it                                                                                                                                                                                                                                                                                                                  |
| `browser-panel.js`     | The Browser panel: frames by long polling, taps, drags, wheel, and keys as input events, the address bar, sizes, the console, the start screen                                                                                                                                                                                                                                   |
| `files-panel.js`       | The Files tile: whether it is open and on which tab, the folder's tree (folders read as they open), Go to file, the open file beside the tree, and the Changes tab                                                                                                                                                                                                               |
| `diff.js`              | The diff viewer: one file's diff (unified or split, line numbers, colors, changed words, hidden lines on request), `DiffBlock` for tool cards and replies, and `DiffReview`, every change file by file with viewed marks                                                                                                                                                         |
| `diff-parse.js`        | Diffs as data, without the DOM: unified diffs and Pi's edit format as files, hunks, and lines; rows that pair changed lines by likeness; the words that changed                                                                                                                                                                                                                  |
| `rich.js`              | Code blocks in replies that show more than code (a page previewed, with Run; an SVG; a diff), given to `Markdown` at load (`setRichBlock`); `HtmlPreview`, `Highlighted`                                                                                                                                                                                                         |
| `run-frame.js`         | `RunFrame`: a reply's HTML run on a tap, in the server's sandboxed `/a/frame` page, sized to fit it                                                                                                                                                                                                                                                                              |
| `highlight.js`         | Syntax colors without dependencies: `highlightLines` gives escaped HTML with flat `hl-` spans per line, which `diff.js` marks changed words in                                                                                                                                                                                                                                   |

## How a message travels

1. `POST /api/c/:id/submit` → `commands.submit`: checks access, turns, and spend, expands a template, then `conversation.submit()` with request id `u:<userId>:<clientId>`. The request id makes a retry a no-op and names the author.
2. Pi Durable runs the generation and tool tasks, committing each step to `pocket.sqlite`. Extension hooks run inside those tasks.
3. `app.ts`'s commit coordinator (`#committed`) hears every commit: spend counts usage first, then each document change updates what the app keeps in memory and the rooms that show it, and `attribution.ts` notes who each message is for.
4. Each room sends its tabs what changed. `store.js` applies it, and Preact renders.

## Adding things

- **A document:** define it in `docs.ts`. To show it live, add it to `ROOM_DOCS` and the view in `room.ts`, and read it in `store.js`.
- **A command:** a method in `commands.ts` (check access first), a route in `http/conversation-routes.ts` (or `http/api.ts` for one that is not about a conversation), an action in `store.js`, then the UI.
- **A sheet:** a component in `web/sheets/`, a case in `sheetBody` (`web/sheets.js`), and `openSheet({ type })` where it opens.
- **Something back should close** (a screen over the conversation, a view that takes another's place on a phone): `useBack(open, close)` from `web/back.js` in the component that shows it. Sheets already have it.
- **A built-in extension:** a file in `extensions/` (its extension named `pocket-…`), its place in `ORDER`, its title in `TITLES`, and its tools in `BUILT_IN_TOOLS` (`reload.ts`), and the order asserted in `test/app.test.ts`.
- **A built-in slash command:** `web/commands.js`, with its name reserved in `BUILT_IN_COMMANDS` (`reload.ts`).
- **An extension command:** declare it with `host.commands.register` while the module builds; the loader owns registration and removal. See [extensions.md](extensions.md#commands-for-people).

## Rules that are easy to break

- Browsers only see committed state. Nothing is shown before it is stored.
- Document kinds, scopes, and fork settings are stored data: never change them.
- Hooks get only `memo` and `snapshot`. Anything a replay must not repeat goes in a memo or behind an idempotent request id.
- Whose work Pi does comes from request ids (`requests.ts`): a message sent for someone needs their id in its request id; one without it leaves Pi working for whoever it worked for before. At startup, what a crash kept out of the authors document is read back from Pi Durable's records.
- A tool is `replay: "safe"` only if running it twice is harmless.
- Extensions reach the app only through `PocketHost`.
- Server code is erasable TypeScript with `.ts` imports. Comments are plain sentences.

## Tests: `test/`

`npm test` runs every `*.test.ts` with Node's test runner. `helpers.ts` provides a scripted model (`scriptedModel(route)`: `faux-1`, `faux-2`, `faux-vision`), `openApp` (the same data folder again is a restart; `now` moves the clock), `newSession`, `say`, `until`, and `fakeTab`. The scripted model costs nothing: spend tests write `pi.usage` themselves. `browser.test.ts` drives a real Chromium, where one is installed, for the built-in browser, and `peeks-ui.test.ts` and `mobile-ui.test.ts` load the whole web app in it and test peek tiles, and the app at phone size, there. `docs-examples.test.ts` loads the example extensions in `docs/examples/` as drop-ins, and checks the docs' links and the prompt's paths to them. `extension-commands.test.ts` checks command registration and lifecycle; `extension-command-runs.test.ts` exercises the HTTP, permission, storage, and restart paths; `extension-command-clock.test.ts` checks the shared command/tool preference in the clock example. `extension-commands-ui.test.ts` drives the real phone-sized app, including retries and stopping. `extension-command-crash.test.ts` uses `fixtures/native-command-crash.ts` to kill real HTTP servers at persisted checkpoints, inspect SQLite before recovery, and retry without repeating effects. Other web paths may have no tests: check a change in a browser, on a copy (`node test/serve.ts`: this folder's code, its own temporary data, a scripted model).
