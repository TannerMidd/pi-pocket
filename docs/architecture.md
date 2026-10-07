# Architecture

How Pi Pocket's parts depend on each other, and the orderings the code relies on. [map.md](map.md) says where things are; this says what to keep when changing them.

## Durable truth and what memory keeps

Pi Durable owns the lasting state of conversations: conversations, entries, tasks, and Pi Pocket's documents (`docs.ts`), in `pocket.sqlite`. People and settings, push subscriptions, uploads, and worktrees are files beside it ([map.md](map.md#data-pi-pocket-or-pi_pocket_dir)). What `PocketApp` keeps in memory about conversations is read back from storage:

- At startup, `#recover` reads each conversation's run, agent, chat, subagents, and who Pi works for in it.
- After that, every commit goes through `#committed`, which keeps the memory up to date.

Some state lives in this process alone, and a restart forgets it. For example:

- who is connected, typing, or away;
- which tool calls wait for approval;
- the browser's pages;
- when each run ended, which peek tiles use;
- invites, which last 15 minutes anyway;
- provider sign-ins in progress.

## Who owns what

`PocketApp` (`app.ts`) creates the app's parts and hands each one the app.

**Its parts:**

- `commands`, `collab`, `alerts`, `providers`, `schedules`, `goals`, `shell`, `spend`
- `workspace`, `transcripts`, `attribution`
- `browsers`

**What stays on `PocketApp`** (the parts call these rather than keeping copies):

- **Access:** `canSee`, `requireSee`, `requireSteer`, `requireDriver`.
- **The conversation tree:** `rootOf`, `parentOf`, `conversationsOf`.
- **Where a conversation works:** `cwdOf`, `agentState`, `sessionMeta`, `isBusy`.
- **Live views:** `room`, `openRoom`, `releaseRoom`.
- **Tabs and peek tiles:** `attach`, `detach`, `setPeeks`.
- **The app's lifecycle:** `open` and `close`.

The harness, models, and settings exist only once `#open` has set them up, after the parts are made. So a part made with the app must not read them in its constructor; it reads them when it is called.

Extensions never see `PocketApp`. They get `PocketHost` (`host.ts`), whose functions call into the app lazily. The HTTP layer parses a request, checks it, calls a part, and writes the answer; it holds no state of its own beyond invites and the event streams' pollers.

## Startup

`PocketApp.#open` runs in this order, and the order matters:

1. Take the data folder's lock. Set up push, Pi's settings, and the HTTP settings for provider streams.
2. Load the models, and register the core tasks and every extension module that is on.
3. Open the storage and the harness.
4. `#recover`:
    - read the session list;
    - for each conversation, in turn: its run, agent, chat, who Pi works for (`attribution.recover`), and its subagents;
    - then write back, in one commit, the authors that a crash kept out of the authors documents (`attribution.repair`).
5. Load spend.
6. Subscribe to commits, approvals, and browser pages.
7. Warm Lancet Guard.
8. Resume the work the last process left unfinished.

Work resumes last, so that everything that follows commits is listening before the first one comes.

## The commit coordinator

Pi Durable publishes each commit's changes in no set order. `#committed` handles them in two passes:

1. **Usage first** (`spend.usageChanged`): what a commit's usage cost belongs to whoever Pi worked for before a message in the same commit changes that.
2. **Then each change:**
    - Document changes go to `#documentCommitted`. It tracks busy and ended runs, agents, the session list, and the documents the rooms show (`ROOM_DOCS`).
    - Submissions go to `attribution.submissionCommitted`.

Everything here is synchronous. A commit listener may not call the harness's session APIs, so a write it causes (noting a message's author) runs in `setImmediate`. Keep this one coordinator: separate listeners would make their registration order a billing rule nobody can see.

Updates to tabs are coalesced:

| What             | How often, at most |
| ---------------- | ------------------ |
| A room's changes | Every 90 ms        |
| Peek tiles       | Once a second      |
| The session list | Every 400 ms       |

## Who Pi works for

A message to Pi names its person in its request id (`requests.ts`):

- `u:<user>:<key>` is a person's own message.
- `p:<user>:<key>` is one sent for a person, such as a scheduled message or a subagent's task.

`attribution.ts` notes each one in the conversation's authors document. Pi works for whoever wrote the newest message (`requesterOf`). A subagent works for whoever its parent worked for when it sent the subagent its last message. Spend, approvals (the "someone else must allow" rule), schedules, and subagents all ask `requesterOf`. A message sent for someone must carry that person in its request id. One that names nobody does not change whom Pi works for: Pi goes on working for whoever it worked for before. Spend, when nobody is known, falls back to whoever started the session, then the owner.

## A request

`http.ts` routes by the first path segment, and turns whatever a route throws into an answer: an `HttpError`'s status and message, or a logged 500.

`/api` (`http/api.ts`) checks, in this order:

1. who is signed in (the cookie, or a bearer token);
2. it notes the quick tunnel a guest came through;
3. the `X-Pocket` header, on everything but GET.

A conversation's routes (`/api/c/:id`) run only after `requireSee`.

Where the other checks live:

- **Commands and collaboration** check steering and driving themselves (`requireSteer`, `requireDriver`). They are called from routes, from tasks, and from each other.
- **Owner-only settings** are checked in `http/api.ts`: extension modules, provider sign-ins, restart. Changing people's access and the approval rule is checked in `app.ts`.
- **Invites** are checked in `http/api.ts` too: viewers and people invited to one session cannot create them.
- **The workspace's path helpers** (`conversationFile`, `readableFile`) leave seeing the conversation to their caller.

Each browser tab is a `Client` (`room.ts`), fed by an event stream or by long polling (`http/events.ts`). On connecting, a tab gets:

1. `hello`;
2. the session list;
3. then, when it shows a conversation, the room's full view;
4. then only what changed.

## The web app

Plain ES modules, served as they are, with no build. Editing a file under `web/` reloads every open tab, and a syntax error blanks the screen for everyone.

**Loading order matters.** `store.js` is the root, and a few modules do work when they load (listed in [map.md](map.md#web-web-preact-and-htm-no-build)). `theme.js` must load before anything that reads `prefs()` as it loads. `store.set` calls subscribers in the order they subscribed. When moving code between modules, keep both orders. `back.js` sits under `store.js` and imports nothing of the app's, so anything may use it.

**History is the back stack (`back.js`).** Only `back.js` writes history. Each route (`/s/12`) and each layer over it (a sheet, the drawer, the launcher, the Files tile or Browser panel where they cover the screen, a file over the tile's tree) is an entry, and each entry says how many layers it stands for and how many steps back the session list's entry is. The app's state is the truth and history follows it a moment later: opening a layer pushes an entry, closing one with a tap goes back past it, and a new route first goes back past the layers above the current one. Back that the person makes closes the layers above the entry it lands on; back to another route reaches `store.js` through `onRoute`. Traversals `back.js` makes itself reach no one. So:

- Navigate with `navigate()` (which calls `pushRoute`); do not call `history.pushState` or `history.back()` elsewhere. To drop a query from the address, use `replaceAddress`, which keeps the entry's marks.
- Something new that covers the screen, or that back should close, is a layer: `useBack(open, close)` in the component that shows it, where `close` makes `open` false. Sheets get theirs from `sheets.js`, one per sheet opened from another (the menu, then the model picker).
- On phones the window clips sideways: the conversation sliding in from the right (a route, a swipe's lean) would make the page wider than the screen, and a phone's browser widen and pan its view to fit.
- A finger's or a mouse's press and click within 280 ms of a layer opening or closing, or a route opening, at a tap (a pointer let go in the 400 ms before) is let go, focus and all: a quick second tap would land on whatever slid in under it (a tile of the sheet that rose, the scrim that closes it). What moves on its own (a reply opening a session, the server closing a sheet, Escape) holds nothing back, and keys and scripts never are.
- New entries wait for the page's first tap or key, since Chrome's back button skips entries a page adds before anyone touches it: the list's entry under a conversation opened straight away on a narrow screen, and the entries of layers already open at load (the chat a notification opened, a panel the tab kept).

**Contracts with the server.**

- Event names and shapes (`hello`, `view`, `chat`, `peek`, …) and the sheet types the server names (`sheet: "chat"`).
- The `pocket.*` keys in local and session storage.
- `ATTACHMENTS_HEADING`, which `ui.js` repeats from `entry-format.ts`.

## Checking a change

- **Every change:** `npm run check` (types, and no unused imports or locals in the TypeScript), `npm run lint`, and `npm test`.
- **Server:** the tests drive a real `PocketApp` with a scripted model, a restart included (`openApp` on the same folder). The built-in browser and peek tiles also run in a real Chromium where one is installed.
- **Web:**
    - `node --check` each file you edit.
    - Then open the app and use what you changed, with the console open.
    - A change that moves code between modules is a move only when the moved code is the same and the loading order above is kept.
