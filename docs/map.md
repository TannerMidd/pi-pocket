# Project map

Where things are in Pi Pocket, for agents working on it. [AGENTS.md](../AGENTS.md) has the rules for editing it while it runs; [architecture.md](architecture.md) explains how the parts depend on each other and the orderings they rely on; [features.md](features.md) says what each feature does.

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
| `host.ts`, `reload.ts`  | `PocketHost` (what extensions get) and `Approvals`; the extension loader: built-ins in `ORDER`, drop-ins, live reload                                                                                                                                                 |
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
| `workspace.ts`                         | `app.workspace`: which files a person may load or read through a conversation, the file viewer, the files for `@` mentions, Changes, uploads                                                       |
| `transcripts.ts`                       | `app.transcripts`: stored history as people read it: an entry (its own, or one a fork inherited), the images in it, what came before the active context, and the session as Markdown               |
| `files.ts`                             | The files in a session's folder for `@` mentions: git's list, or a capped walk; kept briefly per folder, versioned, and compressed once. The file viewer's reads, and the paths a message mentions |
| `changes.ts`, `worktrees.ts`, `git.ts` | The Changes sheet (and undoing a file there), per-session worktrees, and the git runner both use                                                                                                   |
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
| `http/artifacts.ts`           | `/a/…`: an artifact as its own page, in a sandbox                                                                                                               |
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

Each default-exports `(host: PocketHost) => Extension | Extension[]` and is installed in this order: `prompt` (system prompt), `artifacts` (artifact tool), `browser` (browser tool and its prompt section; through `host.browsers`), `subagents` (subagent tool and its tasks), `schedules` (schedule tool; installs the schedule task), `goals` (hook after each answer), `plan` (tool hook and prompt section), `guard` (tool hook that asks for approval), `codemode` (codemode tool; a script's calls go through the same hooks).

## Web: `web/` (Preact and htm, no build)

Plain ES modules, loaded as they are. `store.js` holds the shared state, and nothing imports in a circle. Some modules do work when they load: `store.js`, `ui.js` (Markdown and sanitizer setup, document listeners), `theme.js` (the saved appearance, which `prefs()` reads), `peeks.js`, `browser-panel.js` (the panel's saved width), and `app.js`. `store.set` calls subscribers in the order they subscribed, so keep the order in which modules load when moving code between them.

| File                   | Owns                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store.js`             | State, the event stream (SSE, or long polling when a tunnel holds it back), `api()`, `actions`                                                                                                                      |
| `app.js`               | Layout (tiled windows), top bar, notices, keyboard shortcuts, routing                                                                                                                                               |
| `transcript.js`        | Messages, tool cards, approvals, breadcrumbs                                                                                                                                                                        |
| `calls.js`             | A tool call in one line, for tool cards and peek tiles                                                                                                                                                              |
| `composer.js`          | Message box, chips, plan and goal bars, `@` file suggestions, `!` commands, ↑ and Ctrl+R history, long-paste placeholders                                                                                           |
| `history.js`           | What this browser sent, for ↑ and Ctrl+R                                                                                                                                                                            |
| `files.js`             | `@` mentions: the folder's file list, fetched once and checked in the background, and matched here as people type                                                                                                   |
| `commands.js`          | Slash commands and prompt templates                                                                                                                                                                                 |
| `sheets.js`            | Which sheet is open, and the component that shows it                                                                                                                                                                |
| `sheets/*.js`          | One sheet (or a few close ones) each: the model picker, folder, extensions, providers, people and invites, changes, the file viewer, find, spend, running now, schedules, worktree, appearance, shortcuts, the menu |
| `peeks.js`             | Peek tiles: their switch, which sessions get one and in what order, the column and the strip, the watch list                                                                                                        |
| `chat.js`              | People panel: chat, pins, notes; the chat sheet                                                                                                                                                                     |
| `avatar.js`            | People's avatars and colors                                                                                                                                                                                         |
| `sessions.js`          | Session list (sidebar, drawer), selecting rows and archiving them with undo (`setArchived`), the folded rail                                                                                                        |
| `home.js`, `signin.js` | The wide home screen; the sign-in screen                                                                                                                                                                            |
| `notify.js`, `sw.js`   | Push, the icon badge, approvals from notifications, shares; the notifications sheet                                                                                                                                 |
| `share.js`             | Share to Pi                                                                                                                                                                                                         |
| `ui.js`                | htm binding, Markdown, formatting, icons, `Sheet`, `Diff`, `Switch`, `item` (a menu row), `usePresence` (animate out), `useSlide` (sliding indicators)                                                              |
| `theme.js`             | Appearance: palettes as CSS variables, Follow desktop, tiling, motion, text size, sidebar shape, pins; the theme reveal                                                                                             |
| `themes.js`            | Omarchy's themes as palettes, generated from `/usr/share/omarchy/themes/*/colors.toml`                                                                                                                              |
| `launcher.js`          | The Ctrl/⌘+K launcher: sessions, actions, and themes, with live theme previews                                                                                                                                      |
| `browser.js`           | Whether the Browser panel is open, and opening an address in it                                                                                                                                                     |
| `browser-panel.js`     | The Browser panel: frames by long polling, taps, drags, wheel, and keys as input events, the address bar, sizes, the console, the start screen                                                                      |

## How a message travels

1. `POST /api/c/:id/submit` → `commands.submit`: checks access, turns, and spend, expands a template, then `conversation.submit()` with request id `u:<userId>:<clientId>`. The request id makes a retry a no-op and names the author.
2. Pi Durable runs the generation and tool tasks, committing each step to `pocket.sqlite`. Extension hooks run inside those tasks.
3. `app.ts`'s commit coordinator (`#committed`) hears every commit: spend counts usage first, then each document change updates what the app keeps in memory and the rooms that show it, and `attribution.ts` notes who each message is for.
4. Each room sends its tabs what changed. `store.js` applies it, and Preact renders.

## Adding things

- **A document:** define it in `docs.ts`. To show it live, add it to `ROOM_DOCS` and the view in `room.ts`, and read it in `store.js`.
- **A command:** a method in `commands.ts` (check access first), a route in `http/conversation-routes.ts` (or `http/api.ts` for one that is not about a conversation), an action in `store.js`, then the UI.
- **A sheet:** a component in `web/sheets/`, a case in `sheetBody` (`web/sheets.js`), and `openSheet({ type })` where it opens.
- **A built-in extension:** a file in `extensions/`, its place in `ORDER` and its title in `TITLES` (`reload.ts`), and the order asserted in `test/app.test.ts`.
- **A slash command:** `web/commands.js`.

## Rules that are easy to break

- Browsers only see committed state. Nothing is shown before it is stored.
- Document kinds, scopes, and fork settings are stored data: never change them.
- Hooks get only `memo` and `snapshot`. Anything a replay must not repeat goes in a memo or behind an idempotent request id.
- Whose work Pi does comes from request ids (`requests.ts`): a message sent for someone needs their id in its request id; one without it leaves Pi working for whoever it worked for before. At startup, what a crash kept out of the authors document is read back from Pi Durable's records.
- A tool is `replay: "safe"` only if running it twice is harmless.
- Extensions reach the app only through `PocketHost`.
- Server code is erasable TypeScript with `.ts` imports. Comments are plain sentences.

## Tests: `test/`

`npm test` runs every `*.test.ts` with Node's test runner. `helpers.ts` provides a scripted model (`scriptedModel(route)`: `faux-1`, `faux-2`, `faux-vision`), `openApp` (the same data folder again is a restart; `now` moves the clock), `newSession`, `say`, `until`, and `fakeTab`. The scripted model costs nothing: spend tests write `pi.usage` themselves. `browser.test.ts` drives a real Chromium, where one is installed, for the built-in browser, and `peeks-ui.test.ts` loads the whole web app in it and tests peek tiles there. The rest of the web app has no tests: check a change to it in a browser.
