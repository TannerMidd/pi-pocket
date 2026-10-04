# Project map

Where things are in Pi Pocket, for agents working on it. [AGENTS.md](../AGENTS.md) has the rules for editing it while it runs; [features.md](features.md) says what each feature does.

## Processes

`bin/pi-pocket.js` checks Node, then runs `src/launcher/main.ts`. The launcher asks how devices connect (`access.ts`: this device, LAN, Cloudflare quick tunnel, Tailscale), runs the server (`src/server/main.ts`) as a child, restarts it on exit code 75 or a crash, and keeps the tunnel up. The server opens one `PocketApp` and serves it with `http.ts`.

## Data (`~/.pi-pocket/`, or `PI_POCKET_DIR`)

- `pocket.sqlite`: Pi Durable's storage: conversations, entries, tasks, and Pi Pocket's documents.
- `config.json`: people, roles, hashed tokens, settings. `push.json`: VAPID keys and push subscriptions.
- `uploads/<conversation>/`, `worktrees/` (sessions' git worktrees), `extensions/` (the owner's drop-ins).

## Server: `src/server/`

| File | Owns |
| --- | --- |
| `app.ts` | `PocketApp`: the harness, the commit listener that feeds everything else, connected tabs, access checks (`canSee`, `requireSteer`, `requireDriver`), the session list, `hello`, uploads |
| `room.ts` | One conversation's live view for its tabs: Pi Durable's view plus `ROOM_DOCS`, sent every 90 ms as changes |
| `projection.ts` | Entries as compact JSON for browsers; `usageCost` |
| `commands.ts` | What people ask of Pi: sessions, messages, forks and resends, model and folder, reset, instructions, plan mode, goals, schedules, worktrees |
| `collab.ts` | Chat, activity lines (`addActivity`), reactions, pins, notes, typing, take turns |
| `alerts.ts` | Push notifications: who hears about what |
| `http.ts` | Static files, the `/api` routes, the event stream (`/api/events`, or `/api/poll`), uploads, artifacts, invites |
| `docs.ts` | Every durable document Pi Pocket defines |
| `host.ts` | `PocketHost` (what extensions get) and `Approvals` |
| `reload.ts` | Extension loader: built-ins in `ORDER`, drop-ins, live reload |
| `config.ts`, `auth.ts` | People and settings; cookies, tokens, invites |
| `requests.ts` | Request ids, which say whose each message to Pi is (`u:` a person's own, `p:` sent for a person) |
| `resend.ts` | A message sent again: the task made with its fork that sends it |
| `schedules.ts`, `when.ts` | Scheduled messages (a durable task) and their time grammar |
| `goals.ts` | "Done when" checks |
| `spend.ts` | Cost per conversation and person; limits |
| `changes.ts`, `worktrees.ts`, `git.ts` | The Changes sheet, per-session worktrees, and the git runner both use |
| `running.ts` | Running now, from Pi Durable's task graph |
| `prompts.ts` | Pi's prompt templates as slash commands |
| `providers.ts`, `net.ts` | Provider sign-ins; HTTP settings for provider streams |
| `lancet.ts` | Loads Lancet Guard from Pi's install |
| `push.ts` | Web Push without dependencies (RFC 8291, 8292) |
| `export.ts` | A session as Markdown |
| `errors.ts`, `paths.ts` | `HttpError` and input checks; `~` paths |

## Extensions: `src/server/extensions/`

Each default-exports `(host: PocketHost) => Extension | Extension[]` and is installed in this order: `prompt` (system prompt), `artifacts` (artifact tool), `subagents` (subagent tool and its tasks), `schedules` (schedule tool; installs the schedule task), `goals` (hook after each answer), `plan` (tool hook and prompt section), `guard` (tool hook that asks for approval), `codemode` (codemode tool; a script's calls go through the same hooks).

## Web: `web/` (Preact and htm, no build)

| File | Owns |
| --- | --- |
| `store.js` | State, the event stream (SSE, or long polling when a tunnel holds it back), `api()`, `actions` |
| `app.js` | Layout, top bar, routing |
| `transcript.js` | Messages, tool cards, approvals, breadcrumbs |
| `composer.js` | Message box, chips, plan and goal bars |
| `commands.js` | Slash commands and prompt templates |
| `sheets.js` | The menu and every sheet |
| `chat.js` | People panel: chat, pins, notes |
| `sessions.js` | Session list, sign-in |
| `notify.js`, `sw.js` | Push, the icon badge, approvals from notifications, shares |
| `share.js` | Share to Pi |
| `ui.js` | htm binding, Markdown, icons, `Sheet`, `Diff` |

## How a message travels

1. `POST /api/c/:id/submit` → `commands.submit`: checks access, turns, and spend, expands a template, then `conversation.submit()` with request id `u:<userId>:<clientId>`. The request id makes a retry a no-op and names the author.
2. Pi Durable runs the generation and tool tasks, committing each step to `pocket.sqlite`. Extension hooks run inside those tasks.
3. `app.ts`'s commit listener hears every commit: it records authors, tracks busy conversations and spend, and tells the rooms.
4. Each room sends its tabs what changed. `store.js` applies it, and Preact renders.

## Adding things

- **A document:** define it in `docs.ts`. To show it live, add it to `ROOM_DOCS` and the view in `room.ts`, and read it in `store.js`.
- **A command:** a method in `commands.ts` (check access first), a route in `http.ts`, an action in `store.js`, then the UI.
- **A built-in extension:** a file in `extensions/`, its place in `ORDER` and its title in `TITLES` (`reload.ts`), and the order asserted in `test/app.test.ts`.
- **A slash command:** `web/commands.js`.

## Rules that are easy to break

- Browsers only see committed state. Nothing is shown before it is stored.
- Document kinds, scopes, and fork settings are stored data: never change them.
- Hooks get only `memo` and `snapshot`. Anything a replay must not repeat goes in a memo or behind an idempotent request id.
- Whose work Pi does comes from request ids (`requests.ts`): a message sent for someone needs their id in its request id, or it counts as nobody's. At startup, what a crash kept out of the authors document is read back from Pi Durable's records.
- A tool is `replay: "safe"` only if running it twice is harmless.
- Extensions reach the app only through `PocketHost`.
- Server code is erasable TypeScript with `.ts` imports. Comments are plain sentences.

## Tests: `test/`

`npm test` runs every `*.test.ts` with Node's test runner. `helpers.ts` provides a scripted model (`scriptedModel(route)`: `faux-1`, `faux-2`, `faux-vision`), `openApp` (the same data folder again is a restart; `now` moves the clock), `newSession`, `say`, `until`, and `fakeTab`. The scripted model costs nothing: spend tests write `pi.usage` themselves. There are no browser tests.
