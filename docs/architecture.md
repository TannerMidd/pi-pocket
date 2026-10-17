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
- provider sign-ins in progress.

## Who owns what

`PocketApp` (`app.ts`) creates the app's parts and hands each one the app.

**Its parts:**

- `commands`, `collab`, `alerts`, `providers`, `schedules`, `goals`, `shell`, `spend`
- `workspace`, `transcripts`, `attribution`, `piSessions`, `pip`, `watches`, `hooks`, `memory`
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

## PiP's conversation

PiP (`pip.ts`) is a conversation with a `pip` mark in its session entry, which `sessions()` leaves out of every list. The harness settings select every installed extension but PiP's (`pocket-pip`) by default; PiP's conversation stores its own selection (`PIP_EXTENSIONS`, without bash, write, or edit), which `ensure` sets again each time it opens, so PiP's tools reach no other conversation. Its tools act through `Commands` and `Schedules` as PiP's person, with that person's checks, so `canSee` keeps every PiP from everyone but its person: anyone who could write to it would act as them. Its messages to sessions are once per tool call (a request id hashed from the call's key), and each follow leaves a mark in its list (`FollowsDoc`) when it reports or is stopped, so a replayed call neither sends nor follows twice. A tab's PiP panel is a second client in PiP's room (`setPip`), whose `view` events reach the tab as `pipview`; `watching` counts it, so PiP's answers push nothing while it shows.

## Work from outside the app

A PR watch (`watches.ts`) is a `WatchDoc` in its session and a durable task there, which sleeps until its next look, looks with `gh` (`watches.gh`, which tests replace), and puts what to tell Pi in its checkpoint before sending it: the send's request id is the watch's task and count, so a restart sends it once. Comment ids told, and the commits whose failures and conflicts were told, stay in the watch. Webhooks (`hooks.ts`) are app-wide (`HooksDoc`); `/hook/…` is outside `/api` and its sign-in, and lets a post in only by its hook's secret. Both send through `Commands.submit` as their person, with a `via` that marks the message (`[via PR watch]`, `[via webhook NAME]`), so that person's checks and spend limit apply, and what came from outside is fenced (`fence.ts`, as PiP's session text is): no closing tag survives inside, in any case or spacing. A hook's address and secret are checked before its body is read. A signed hook (`signed`, for GitHub) lets a post in only by GitHub's signature: its secret is never in its address, so the address GitHub shows a repository's admins cannot post. Pi's `watch_pr` names a PR by number, which `gh` finds in the session's own repository, or one elsewhere by address only where `gh`'s account can push (`requirePush` in `github.ts`); what follows `--` is never an option.

A repository watch (`repo-watches.ts`) is an item of the app-wide `RepoWatchesDoc` and a durable task in the conversation it messages (PiP's, or a session's), with the same wait, look, and send phases as a PR watch: a look puts the message in the task's checkpoint, and the send's request id is the task's and its count's, so it goes once. It reads the repository's issues, pulls, workflow runs, releases, and comments through `gh api`, and keeps the ids it told. PiP's tools (`repo_watch`, `session_watch_pr`, `session_start` with `repo`) act through `Pip` as its person; a repository is worked on or watched only where `gh`'s account can push, and `Pip.checkout` finds a session's checkout whose `origin` is the repository, or clones it once into `repos/`.

## Who chooses models

Only people choose models; Pi, PiP, and Pi Pocket itself never pick one on the side. Everything that runs a model uses one a person chose:

- **Sessions** run on the model someone picked, or on what a new session starts with (`Commands.#defaultModel`): the owner's default, even when it is not signed in now, else the last model picked, else Pi's default, else none.
- **Subagents** run on their session's model, at its thinking level or lower (`extensions/subagents.ts`). The owner may allow other models (`subagentModels` in `config.json`: `PocketApp.setSubagentModels` replaces the list, and `allowSubagentModel`, behind `POST /api/subagent-models` that the Providers sheet sends, adds or takes off one model, reading and writing the list with no wait between, so changes that come together all count); with none allowed the tool has no model parameter, and the app rebuilds the module when the list changes. Each call checks the list as it is then: a model not on it is refused, and so is work for a subagent already on one; work for a subagent thinking harder than the session lowers it. Before an allowed model is used its sign-in is asked afresh, so a stale mark neither refuses it nor lets it through. A report of a subagent its model or provider failed (by the provider's words: a sign-in, a missing or refused model, a quota) carries the model and tells Pi to stop and tell its person.
- **Titles, compaction, and PiP's summaries** use the conversation's own model.
- **PiP** passes a model, or names one in what it sends, only when its person named it in their own words (`pip.ts`, with `model-names.ts`): their own messages (`u:` request ids, from the authors document) since PiP's last new context (with those its last compaction kept), and the standing instructions of the watches and webhooks to PiP that they set up; never a watch PiP set up, what was posted, or what GitHub said.
- **Sign-ins:** `Providers` asks subscriptions' sign-ins afresh (the owner's Providers sheet, a model a subagent on another model or PiP is about to use, a run that failed on one, a run answered by a marked one) and keeps, in memory, the ones their provider refused to renew. Only subagents on another model (`resolveModel`, `modelProblem`) and PiP (`Providers.problem`) check before use, and refuse their models. Everything else tries the model: a session's own run and a subagent on its session's model fail where people see them, and a run that failed on an expired sign-in marks it; a title that fails is only logged. `modelList` and `agentInfo` mark them, and the owner is told. A check that began before a sign-in or sign-out here marks nothing.

## Memory

Lessons Pi keeps across sessions are one document for the whole app, `MemoryDoc` (`pocket.memory`), by id. Each is for a project or for everywhere. A project is keyed by the real path of its git common folder (`git rev-parse --git-common-dir`), so a repository and all its worktrees share lessons; outside a repository, by the folder itself. `Memory` (`memory.ts`) works out a folder's project (kept a minute per folder) and keeps the rules:

- The memory extension's section renders, before each request, the lessons in force for the conversation's folder: its project's and everywhere's, not pending, oldest first. It reads committed state only, so it renders the same text until a lesson changes. PiP has no project: it gets everywhere's.
- Pi proposes, the owner approves. Every lesson Pi saves, and every one a person who is not the owner saves, is pending, and no prompt has it until the owner approves it: what Pi read anywhere in its context could have talked it into one. Pi's (or a guest's) new text for a lesson in force, and Pi's forgetting one, are a `proposal` on the lesson, which stays as it was until the owner approves or discards it. The tool's result names the lesson (`details.lesson`), so the transcript offers Approve and Discard under the call. An approval names what it saw (`POST …/memory/:id/approve` with `{ text }` or `{ forget: true }`); when what waits differs, `change` answers 409, so text or a proposal swapped after the owner looked is not approved with it. Pi proposing the text in force withdraws its own waiting proposal. Pending lessons do not count toward a project's or everywhere's cap; approving one does. Only the owner, or whoever saved a lesson, changes or removes it, Pi included (as the person it works for).
- Pi's adds carry the tool call's key, so a replayed call finds its lesson. A subagent's lesson comes from its session (`rootOf`).
- Every write adds an activity line to the session's chat in the same commit. `#committed` tells `Memory` when the document changed; it sends tabs a `memory` event, and the Memory sheet and menu fetch the lessons again (`GET /api/c/:id/memory`).

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

| What                                                                       | How often, at most |
| -------------------------------------------------------------------------- | ------------------ |
| A room's changes                                                           | Every 90 ms        |
| Peek tiles                                                                 | Once a second      |
| The session list, and every subagent to tabs that show the subagents board | Every 400 ms       |

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
- **Owner-only settings** are checked in `http/api.ts`: extension modules, provider sign-ins, restart. Changing people's access, the approval rule, the default model for new sessions, and the models subagents may use is checked in `app.ts`.
- **Invites** are checked in `http/api.ts` too: viewers and people invited to one session cannot create them, and only the owner makes an owner invite. An invite lasts one of `INVITE_MINUTES` (`auth.ts`; an owner invite, always 15) and is kept in `config.json` by its code's hash, so a day's or a week's outlives a restart. Only whoever made one ends it early (`POST /api/invite/cancel`), as the invite sheet does with the one it showed when its settings change, and with one that answers after it closed. One person keeps at most `MAX_INVITES` (`config.ts`) live, their oldest ending first; removing someone ends theirs, and a new owner token ends owner invites not yet used.
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

- Event names and shapes (`hello`, `view`, `chat`, `peek`, `subagents`, …) and the sheet types the server names (`sheet: "chat"`).
- The `pocket.*` keys in local and session storage.
- `ATTACHMENTS_HEADING`, which `ui.js` repeats from `entry-format.ts`.

## Checking a change

- **Every change:** `npm run check` (types, and no unused imports or locals in the TypeScript), `npm run lint`, and `npm test`.
- **Server:** the tests drive a real `PocketApp` with a scripted model, a restart included (`openApp` on the same folder). The built-in browser and peek tiles also run in a real Chromium where one is installed.
- **Web:**
    - `node --check` each file you edit.
    - Then open the app and use what you changed, with the console open.
    - A change that moves code between modules is a move only when the moved code is the same and the loading order above is kept.
