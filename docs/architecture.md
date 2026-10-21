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
- when each run ended, which peek tiles and session-list squares use, and whether its last run failed;
- provider sign-ins in progress;
- the edit and write calls Changes found in each session's history, so a look reads only the entries added since.

## Who owns what

`PocketApp` (`app.ts`) creates the app's parts and hands each one the app.

**Its parts:**

- `commands`, `extensionCommands`, `collab`, `alerts`, `providers`, `schedules`, `goals`, `shell`, `spend`
- `workspace`, `transcripts`, `attribution`, `piSessions`, `pip`, `watches`, `hooks`, `memory`, `gallery`
- `browsers`, `linkedSessions`

**What stays on `PocketApp`** (the parts call these rather than keeping copies):

- **Access:** `canSee`, `requireSee`, `requireSteer`, `requireDriver`.
- **The conversation tree:** `rootOf`, `parentOf`, `conversationsOf`.
- **Where a conversation works:** `cwdOf`, `agentState`, `sessionMeta`, `isBusy`.
- **Live views:** `room`, `openRoom`, `releaseRoom`.
- **Tabs and peek tiles:** `attach`, `detach`, `setPeeks`.
- **The app's lifecycle:** `open` and `close`.

The harness, models, and settings exist only once `#open` has set them up, after the parts are made. So a part made with the app must not read them in its constructor; it reads them when it is called.

Extensions never see `PocketApp`. They get `PocketHost` (`host.ts`), whose functions call into the app lazily, and `web`, through which they add routes and a browser module to the app. `ExtensionWebs` (`extension-web.ts`) keeps what each module's version added, which the loader commits once the module installed and removes with it, running its cleanups. The HTTP layer parses a request, checks it, calls a part, and writes the answer; it holds no state of its own beyond invites and the event streams' pollers.

## Favorite folders

`FolderFavoritesDoc` (`pocket.folder-favorites`) stores each person's ordered favorite working folders in SQLite. `folder-favorites.ts` reads and changes only the signed-in person's list; explicit star/unstar operations run inside one harness transaction, so concurrent devices do not overwrite unrelated changes. The commit coordinator sends each connected client only its person's list as a `folder-favorites` event. `hello.folderFavorites` supplies the initial list and refreshes it on reconnect. The folder picker shows only what the server committed, so a failed save leaves its list as it was.

## Session tags

Shared tags are an optional `tags` list on `SessionMeta` in the existing version-one `SessionsDoc` (`pocket.sessions`). Absence means no tags: no SQL schema migration, eager backfill or document-version bump is needed. New session entries, imports, linked sessions and forks start untagged; catalogue metadata is not inherited through conversation-document fork settings. Existing field-level metadata writers preserve the optional list.

`POST /api/sessions/tags` calls `Commands.updateSessionTags` with exact IDs and explicit Add/Remove lists. One harness transaction resolves the current person after loading the catalogue, checks steering and visibility on every ordinary session, and validates every projected tag list before mutating any. Missing, hidden, private PiP or over-capacity targets reject the entire batch. Patches merge against the transaction's current state, so unrelated concurrent tag changes survive; opposing edits of the same tag follow commit order. Tagging does not advance `updatedAt` or reorder Recent.

The existing access-filtered sessions projection and events carry tags; there is no global tag catalogue. Browsers derive suggestions only from the sessions they can already see. Account-scoped personal AND filters stay in this browser tab's memory through navigation, reset on page reload, and combine with search and the existing views. Their sheet searches only the authorized tag vocabulary, not sessions or selected membership. Choices scroll in a bounded list, selected filters remain independently removable, and the matching count/Clear tags/Done footer stays outside the scrolling content. Trimming and case-folding the vocabulary query does not alter immediate AND semantics or write metadata. Search-row container queries prioritize the full placeholder over the optional shortcut hint and, at tighter widths, the Filters wording. The filter icon, active count and accessible name remain; sidebar defaults and saved widths do not change. A batch editor snapshots selected IDs intersected with actually rendered rows, excluding collapsed groups and hidden selections; Save never widens or silently shrinks that scope. Single-session editors send a diff of their original draft, not a replacement list. Tag editors show at most six input-matching suggestions from that same authorized vocabulary. Batch removal choices use the captured membership union in a bounded scrolling list, with search for larger unions; queued removals remain separately available even when search hides their rows. The editor content scrolls independently of its Save/Cancel footer. These presentation bounds do not change target scope, the explicit patch contract or access checks.

## Linked sessions

`LinkedSessions` (`linked-sessions.ts`, `app.linkedSessions`, `host.linkedSessions` as `LinkedSessionsApi`) starts a session from another and carries messages between them; Agent Teams (`extensions/agent-teams.ts`, off by default) is its only user. A linked session is an ordinary ownerless session in the source's folder. Its session entry's `linkedFrom` names the session that started it, and nothing else follows from it: it is not in `SubagentsDoc`, `parentOf`, or `rootOf`, so it gives no access, and stopping or archiving one leaves the other as it was.

- **Whom it acts for.** Each call acts as the person Pi works for in the source (`requesterOf`), with their checks: seeing the source, steering, the turn, spend, and, to start one, access to every session. The source in plan mode starts and sends nothing. A message goes through `Commands.submit` as sent for that person (a `p:` request id), with `[via linked session …]` and the message fenced (`defang`), so its text is never a slash command and Pi reads it as a request; the target's checks apply there too. The transcript knows such a message by that label and fence, not by the words before the fence.
- **Once.** Each call's key is hashed with the source into an item of `LinkedSessionCallsDoc` (`pocket.linked-session-calls`), which records the session it made or messaged, whom it acted for, and when. A start writes it in the same commit as the session, then sends the first message; a message's request id is made from the same hash, so a replay finds the session and the message it made. Records are kept 30 days, and the newest 1000.
- **Bounds.** A linked session starts none. Since 0.19.0 no count limits how many a session starts (before, at most 10, counted in the commit that made one). `LinkedSessionRelayDoc` (`pocket.linked-session-relay`) on the team's top session counts messages between its sessions, and a person's own message in any of them (`Commands.submit` without a `via`) sets it back to 0. It is counted in a commit before each message goes, so it survives a restart. Since 0.19.0 no send is refused on that count (before, past 20 were). `Spend` counts a team against its top session's budget: the top session, every session linked under it, and their subagents.
- **What it shows.** Sessions know each other by addresses of their own (`LinkedSessionPeersDoc`, `pocket.linked-session-peers`), so no session id goes into a shared transcript; a fork starts with none. `list` reaches only the sessions the person sees, and names them only when everyone who sees the source sees them too. The session list (`PocketApp.sessions`) gives someone who cannot see the origin `linkedOrigin: true` in place of `linkedFrom`; a scoped person's tabs get their own list in every broadcast, not a filter of everyone's.
- **Models.** A start copies the source's agent settings (model, thinking, instructions, tools), not its history. It takes only the source's model or one on the owner's list for subagents, at no higher thinking than the source's, and only after `Providers.problem` asks its provider afresh: nothing is made with a model that is not allowed or cannot be used now.

**Human extension starts (0.16.0).** `web.conversationRoute` resolves its named source and checks the signed-in person before its handler. Its `linkedSessions.start/list` bind both source and person, without changing source attribution. They reuse the same receipt store and message request ids; human replays cannot adopt another person's receipt. Explicit human thinking choices are rejected rather than lowered. Human lists add an actor-visible `conversationId`; host lists remain opaque. Creation copies fresh inherited agent settings on the mutation line and rejects changed source selection settings. Before the initial message, the intended target folder/model/thinking must still match.

`Commands.submit` has a core-only admission lease for this path. After message preparation, linked sessions authorize source/target documents in a transaction and subscribe synchronously to relevant policy commits. The child context passed to Durable's submission cancels on an intervening change. Its cancellation getter also rechecks current actor/access, model allowance/auth, and spend without asynchronous work. Durable checks that context when queued admission enters the mutation line: this is the final admission boundary, not a promise to undo work after admission. The lease is disposed when submit settles, before post-submit bookkeeping. Legacy host calls retain requester selection and thinking-cap behavior.

Subagents leave Agent Teams out of every subagent (`extensions/subagents.ts`), even while it is off, so turning it on later gives no subagent a way to start sessions.

## PiP's conversation

PiP (`pip.ts`) is a conversation with a `pip` mark in its session entry, which `sessions()` leaves out of every list. The harness settings select every installed extension but PiP's (`pocket-pip`) by default; PiP's conversation stores its own selection (`PIP_EXTENSIONS`, without bash, write, or edit), which `ensure` sets again each time it opens, so PiP's tools reach no other conversation. Its tools act through `Commands` and `Schedules` as PiP's person, with that person's checks, so `canSee` keeps every PiP from everyone but its person: anyone who could write to it would act as them. Its messages to sessions are once per tool call (a request id hashed from the call's key), and each follow leaves a mark in its list (`FollowsDoc`) when it reports or is stopped, so a replayed call neither sends nor follows twice. A tab's PiP panel is a second client in PiP's room (`setPip`), whose `view` events reach the tab as `pipview`; `watching` counts it, so PiP's answers push nothing while it shows.

PiP's header model chip opens the existing picker with its own conversation ID and live view, not the session behind it. Its `pipPanel` configure request uses `Commands.configure`, checks private PiP ownership, and checks `LiveDoc.run` and compactions in the same commit as the model/thinking write. It leaves `lastModel` alone. Ordinary configure requests, including **Open as a conversation**, retain their behavior.

## Work from outside the app

A PR watch (`watches.ts`) is a `WatchDoc` in its session and a durable task there, which sleeps until its next look, looks with `gh` (`watches.gh`, which tests replace), and puts what to tell Pi in its checkpoint before sending it: the send's request id is the watch's task and count, so a restart sends it once. Comment ids told, and the commits whose failures and conflicts were told, stay in the watch. Webhooks (`hooks.ts`) are app-wide (`HooksDoc`); `/hook/…` is outside `/api` and its sign-in, and lets a post in only by its hook's secret. Both send through `Commands.submit` as their person, with a `via` that marks the message (`[via PR watch]`, `[via webhook NAME]`), so that person's checks and spend limit apply, and what came from outside is fenced (`fence.ts`, as PiP's session text is): no closing tag survives inside, in any case or spacing. A hook's address and secret are checked before its body is read. A signed hook (`signed`, for GitHub) lets a post in only by GitHub's signature: its secret is never in its address, so the address GitHub shows a repository's admins cannot post. Pi's `watch_pr` names a PR by number, which `gh` finds in the session's own repository, or one elsewhere by address only where `gh`'s account can push (`requirePush` in `github.ts`); what follows `--` is never an option.

A repository watch (`repo-watches.ts`) is an item of the app-wide `RepoWatchesDoc` and a durable task in the conversation it messages (PiP's, or a session's), with the same wait, look, and send phases as a PR watch: a look puts the message in the task's checkpoint, and the send's request id is the task's and its count's, so it goes once. It reads the repository's issues, pulls, workflow runs, releases, and comments through `gh api`, and keeps the ids it told. PiP's tools (`repo_watch`, `session_watch_pr`, `session_start` with `repo`) act through `Pip` as its person; a repository is worked on or watched only where `gh`'s account can push, and `Pip.checkout` finds a session's checkout whose `origin` is the repository, or clones it once into `repos/`.

## Who chooses models

Only people choose models; Pi, PiP, and Pi Pocket itself never pick one on the side. Everything that runs a model uses one a person chose:

- **Sessions** run on the model someone picked, or on what a new session starts with (`Commands.#defaultModel`): the owner's default, even when it is not signed in now, else a trusted project's model/thinking default, else the last model picked, else Pi's global default, else none. `project-model.ts` reads only the final session folder's `.pi/settings.json` at creation, without a cache; a fresh creation-local global-only settings reader supplies defaults and trust policy without changing `app.settings`. It checks Pi's trust store and global trust policy, validates a complete provider/model pair, and keeps known unsigned models rather than silently substituting one. Invalid trusted settings stop creation with a contained error. Thinking-only settings cannot change another source's model/thinking pair. Owner defaults bypass project settings. Imported sessions, forks, subagents, manual choices, and PiP's own conversation retain their previous selection behavior. A model the person explicitly named to PiP bypasses project defaults before its manual configuration step. Trust gained after creation applies only to later new sessions; existing choices never track file or folder changes. Extra project skill/prompt paths and per-project run policy are not supported yet; the shared app settings and older host APIs are unchanged.
- **Subagents** run on their session's model, at its thinking level or lower (`extensions/subagents.ts`). The owner may allow other models (`subagentModels` in `config.json`: `PocketApp.setSubagentModels` replaces the list, and `allowSubagentModel`, behind `POST /api/subagent-models` that the Providers sheet sends, adds or takes off one model, reading and writing the list with no wait between, so changes that come together all count); with none allowed the tool has no model parameter, and the app rebuilds the module when the list changes. Each call checks the list as it is then: a model not on it is refused, and so is work for a subagent already on one; work for a subagent thinking harder than the session lowers it. Before an allowed model is used its sign-in is asked afresh, so a stale mark neither refuses it nor lets it through. A report of a subagent its model or provider failed (by the provider's words: a sign-in, a missing or refused model, a quota) carries the model and tells Pi to stop and tell its person.
- **Linked sessions** (Agent Teams) start on their session's model, or on one the owner allows for subagents, at their session's thinking level or lower (`linked-sessions.ts`); a model that cannot be used now is refused before the session is made.
- **Titles, compaction, and PiP's summaries** use the conversation's own model.
- **PiP** passes a model, or names one in what it sends, only when its person named it in their own words (`pip.ts`, with `model-names.ts`): their own messages (`u:` request ids, from the authors document) since PiP's last new context (with those its last compaction kept), and the standing instructions of the watches and webhooks to PiP that they set up; never a watch PiP set up, what was posted, or what GitHub said.
- **Sign-ins:** `Providers` asks subscriptions' sign-ins afresh (the owner's Providers sheet, a model a subagent on another model or PiP is about to use, a run that failed on one, a run answered by a marked one) and keeps, in memory, the ones their provider refused to renew. Only subagents on another model (`resolveModel`, `modelProblem`), PiP, and linked sessions as they start (`Providers.problem`) check before use, and refuse their models. Everything else tries the model: a session's own run and a subagent on its session's model fail where people see them, and a run that failed on an expired sign-in marks it; a title that fails is only logged. `modelList` and `agentInfo` mark them, and the owner is told. A check that began before a sign-in or sign-out here marks nothing.

**Manual model refresh.** `Providers.modelRefresh` (`model-refresh.ts`) shares one in-flight refresh across owner tabs. `POST /api/models/refresh` requires the owner and the normal `X-Pocket` header; `hello.server.refreshModels` gates the UI against an older server. It checks local configuration with Pi’s public runtime API before reloading it, then refreshes each configured provider in parallel with a separate eight-second limit and `force: true` (network stays off under `PI_OFFLINE`). Each completed provider sends the existing `models` event and refreshes room views, so a slow provider does not hold back a healthy one. Pi owns cache publication and cancellation generations; failed catalog fetches keep its cached/static models. Refresh never configures a conversation or changes the default or subagent allow-list. Counts compare available provider/id keys before and after; provider errors are safe fixed messages, not raw exceptions that could contain credentials.

`PocketApp.modelList` resolves Pi’s `enabledModels` through the SDK’s `resolveModelScopeWithDiagnostics` against available models, then `modelList` marks scope membership alongside sign-in state. Both `hello` and providers’ `models` updates use that list. Manual refresh rereads Pi settings before recomputing the scope; malformed scope values are ignored so the picker still opens. The model picker’s Scoped / All state lasts only while it is open and filters the list without changing Pi’s settings, the session’s model, or its default. Empty scopes mean all available models, not a ban on picking models.

## Memory

Lessons Pi keeps across sessions are one document for the whole app, `MemoryDoc` (`pocket.memory`), by id. Each is for a project or for everywhere. A project is keyed by the real path of its git common folder (`git rev-parse --git-common-dir`), so a repository and all its worktrees share lessons; outside a repository, by the folder itself. `Memory` (`memory.ts`) works out a folder's project (kept a minute per folder) and keeps the rules:

- The memory extension's section renders, before each request, the lessons in force for the conversation's folder: its project's and everywhere's, not pending, oldest first. It reads committed state only, so it renders the same text until a lesson changes. PiP has no project: it gets everywhere's.
- Pi proposes, the owner approves. Every lesson Pi saves, and every one a person who is not the owner saves, is pending, and no prompt has it until the owner approves it: what Pi read anywhere in its context could have talked it into one. Pi's (or a guest's) new text for a lesson in force, and Pi's forgetting one, are a `proposal` on the lesson, which stays as it was until the owner approves or discards it. The tool's result names the lesson (`details.lesson`), so the transcript offers Approve and Discard under the call. An approval names what it saw (`POST …/memory/:id/approve` with `{ text }` or `{ forget: true }`); when what waits differs, `change` answers 409, so text or a proposal swapped after the owner looked is not approved with it. Pi proposing the text in force withdraws its own waiting proposal. Pending lessons do not count toward a project's or everywhere's cap; approving one does. Only the owner, or whoever saved a lesson, changes or removes it, Pi included (as the person it works for).
- Pi's adds carry the tool call's key, so a replayed call finds its lesson. A subagent's lesson comes from its session (`rootOf`).
- Every write adds an activity line to the session's chat in the same commit. `#committed` tells `Memory` when the document changed; it sends tabs a `memory` event, and the Memory sheet and menu fetch the lessons again (`GET /api/c/:id/memory`).

**PiP's pending queue.** `GET /api/c/:id/memory?pending=all` lists new lessons and proposed edits or forgetting across every project and everywhere. It requires the human owner and their private PiP root as its anchor; queue approvals and discards use the same query on the existing mutation routes. Pi writers, other people, shared-session anchors, and queue add/edit/remove requests are refused before cross-project lookup. Approval retains the existing compare-with-what-was-shown check, limits, and transaction. Activity stays in the private PiP chat, not a shared session. The queue response has `pendingAll: true`, no project or add/edit controls, and project labels on lessons; an older running server's scoped response has no marker, so the new UI asks for a restart rather than claiming to show all projects. Browser memory fetches are keyed by person, role, conversation, and view, and refresh on memory events or a new connection.

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

Everything here is synchronous. A commit listener may not call the harness's session APIs, so a write it causes (noting a message's author, or moving a session up the list when Pi starts work there) runs in `setImmediate`. Keep this one coordinator: separate listeners would make their registration order a billing rule nobody can see.

Updates to tabs are coalesced:

| What                                                                       | How often, at most |
| -------------------------------------------------------------------------- | ------------------ |
| A room's changes                                                           | Every 90 ms        |
| Peek tiles                                                                 | Once a second      |
| The session list, and every subagent to tabs that show the subagents board | Every 400 ms       |

Each room update sends a tab its new entries, the live run, and some small fields. The fields that grow with the session, such as the queue, authors, reactions, and pins, go again only when they differ from what the tab has, because a turn sends an update every 90 ms. The queue sends the first 500 characters of each waiting message's own text (not the files it mentions, and not images: a message of images alone says how many), and the names of the subagents in a message of reports. Its row shows one line, and a paste or a batch of reports can be megabytes.

The message Pi is writing goes as what changed since the tab's last update (`liveMessageDelta` in `projection.ts`, put together by `web/live.js`): the blocks the tab has stay, and the block that grows sends only its new characters. A whole message each time made a long answer cost its length squared. The server keeps the blocks each tab has (`Client.liveBlocks`) and forgets them with each full view, which sends the whole message. Events reach a tab in order on one connection (long polling sends again what a lost answer carried), and a new connection starts with a full view, so a change always fits. One that does not, which should not happen, makes the tab connect again.

A tab's connection names what its code understands (`p`, `PROTOCOL` in `web/store.js`). 2 keeps the queue when an update leaves it out; 3 takes the message as what changed. A tab below 3 gets the whole message with each update, and one that names none (older code, as a tab asleep through an update keeps) also gets the queue with each update, because its code drops a queue that an update leaves out.

The session list goes to a tab only when it differs from the one that tab last got (`Client.sessionsSent`): it is large, and it is worked out again for many changes that leave it as it was.

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

`/api/x/:module/…` (`http/extension-routes.ts`) is an extension module's own route: after the checks above, and the `X-Pocket` header on a GET too (a module's GET may change things, and the cookie goes along with a link from another site), it answers only the people its `access` lets in (`mayUse`: the owner by default; never someone invited to one session). The header is checked before the route is looked up, and a route someone may not use is not there for them (404, and a 405 names only methods they may use), so nobody learns of routes that are not theirs. A `:name` part that decodes to `..` or holds a backslash or NUL is a 400. Only the owner reads a 500's words, but for those a module gave `web.error`, which it chose to show. `/x/:module/:rev/…` serves its browser module's files, outside `/api` but after a sign-in, to the same people: one file, or a folder's regular web files up to 8 MB, never its `.ts` files, hidden files, `node_modules`, or anything reached through a link. Each is opened without following a link or waiting (`O_NOFOLLOW | O_NONBLOCK`), and read only when its handle is a regular file and the file that was checked (the same device and inode, and on Linux the path `/proc/self/fd` gives), so nothing swapped in after the check, a folder on its way included, is read. Where there is no `/proc` (macOS), a folder swapped for a link within the check itself can still lead elsewhere: only someone who can write in the module's folder can do that, and they can already run code in the server, by editing the module.

Since 0.16.0, `extension-request.ts` gives each route fresh `snapshot`, `context`, and `commit` capabilities. They re-resolve the current person; viewers cannot commit, and disconnect or handler return cancels them. A commit checks again after an awaited callback so a detached write cannot outlive the request. These APIs are for module documents, not core state. An unbound catalog save has no source turn, plan, or spend policy. Bound GET routes require source visibility, and bound mutations/commits also require steering and the turn. The bound request exposes authoritative source metadata for previews and actor-bound linked-session starts/listing.

The host's `pocketVersion` and `hello.server.pocketVersion` come from `versions.ts`'s startup-loaded package data. Browser `pocket.pocketVersion` reads that metadata, never disk or an updater; `pocket.version` remains the API level. `pocket.openConversation` calls normal `store.navigate`, retaining Back and server access checks.

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

**Compression and caching (`http/compress.ts`).** Text answers of 1 KB or more (`send`, so JSON, and long-poll answers) go in brotli or gzip, as the request's `Accept-Encoding` allows. An event stream has one compressor for its life, flushed after each event and each ping, so every event reaches the tab at once. `keepsUp` then counts the compressed bytes that the response holds (what the tab took), plus text not yet compressed. The stream keeps `no-transform`, so a proxy leaves the bytes alone. The web app's files (`serveFile`) are `no-cache` with an `ETag`, a hash of the bytes: an unchanged file is a `304`, and an edit changes the hash at once, so a tab never keeps a stale module. The bytes are read and compressed again only when the file's size or times change, and the compressed bytes are kept in memory for each encoding. The app page lists every module that `app.js` imports (found from the files as they are now, so an edit or a new import shows at once) as `modulepreload` links, so the browser fetches them all together, not level by level.

## Extensions' commands

A module registers its commands with `web.command` while it loads. `ExtensionWebs` keeps them with the module's version, as it keeps routes: they count once the version installs, a version that fails leaves the ones before, and turning the module off removes them. Each registration has an id that is new with each version. `hello` lists the commands a person may run (`server.extensionCommands`, without handlers or files: viewers none, guests the conversation ones), and a change to them sends everyone's tabs `hello` again.

`POST /api/c/:id/extension-commands` goes to `app.extensionCommands` (`extension-commands.ts`), not to `app.commands`, which sends messages to Pi. Before a run's task is made, it checks seeing and steering, then driving for a conversation command or the owner for a global one, and that the person has fewer than 4 runs going; a retry of a request checks its person again. Nothing refuses a run once its task is made. The wait ends when the browser stops waiting; the run goes on.

A run is a `pocket.extension-command` task (`COMMAND_TASK`), made in one commit with its request id in the person's `pocket.extension-command-request` document for that session (`CommandRequestsDoc`), which keeps the last 100 finished ones and every one still going. A retry finds that task and waits for its result; the same id with other arguments or another registration is a 409. The handler the request chose is kept in memory until its task takes it. The task marks that it started before the handler runs, and keeps the result in a memo: after a restart, a task with no result reports that it was cut off, and its handler never runs again. A handler's own error words go to the owner in a notice; the person gets them only from `web.error` or an `HttpError`.

A card is a `pocket.extension-command` entry with only `kind` and `data`: no `model`, `head`, or `edits`, so Pi never gets it. Its write's request id is the task's, with no person's prefix (`requests.ts`), so it does not change whom Pi works for. A notice goes back only in the answer to the person who ran it.

In the browser, the composer keeps a command's request id while its send is unresolved, as for `!` commands: sending the same text again after a network error or a 5xx finds the same run. Running now names the command from its task, never its arguments, and shows global ones to the owner alone.

## The web app

Plain ES modules, served as they are, with no build. Editing a file under `web/` reloads every open tab, and a syntax error blanks the screen for everyone.

**Loading order matters.** `store.js` is the root, and a few modules do work when they load (listed in [map.md](map.md#web-web-preact-and-htm-no-build)). `theme.js` must load before anything that reads `prefs()` as it loads. `store.set` calls subscribers in the order they subscribed. When moving code between modules, keep both orders. `back.js` sits under `store.js` and imports nothing of the app's, so anything may use it.

**Drawing while an answer streams (`app.js`, `ui.js`).** Every `store.set` draws the app again from the top, once per microtask; components read `store.state` as they draw. A streaming answer changes `view` (or PiP's `pipView`) several times a second, so what is big and reads neither is wrapped in `apartFromViews`, which skips a change to those two alone: the session list (drawn off-screen on phones) and the rail. A component so wrapped must not read `view` or `pipView`, or anything that changes only with them; `store.set({})` still draws it. Markdown still growing (`cache={false}`) is drawn block by block (`liveBlocks`): each top-level block keeps its HTML from the update before unless its text changed, so an update parses, sanitizes, and colors only the last block. The blocks are found again in the whole text each time, so a later line that changes an earlier block shows; a reference link defined in another block shows as written until the text is whole, and an HTML block with a blank line inside it shows split until then.

**Themes (`themes.ts`, `theme.js`).** The page has three cascade layers, declared in `index.html`: `pocket` (`style.css`, imported into it, and extensions' stylesheets, which `pocket.style()` imports into it after), `palette` (the colors' variables, a `<style>` that `theme.js` writes), and `theme` (a theme folder's stylesheets). A later layer wins whatever the specificity, and an earlier layer's `!important` wins over a later one's, so a theme overrides the app's rules but not its reduced motion. Inline values beat every layer: only what a person sets (the text size, dragged widths, the desktop's wallpaper) is inline, never a palette. A stylesheet added outside the layers (a `<link>`) would beat the app and the theme alike.

The server reads each theme folder (`readTheme`): its `theme.json`, `colors.toml`, and the CSS reachable from `theme.css` by `@import`, whose every `url()`, `image-set()` string, `src()`, and `@import` must name a file of the folder (`themes/css.ts` tokenizes as CSS Syntax 3 does, escapes resolved; `themeFile` resolves as the browser's URL parser). The checked CSS is kept in memory and served from there, with each font, image, and `@import` named by its full address (a path inside a custom property would otherwise resolve against `style.css`); fonts and images are read from disk at each request, only if the same file that was listed, and sniffed. A version that fails its checks leaves the last good one in force for the life of the process, and the owner gets one notice for each new problem. `hello.themes` and the `themes` event carry the list. The theme's addresses carry a hash of its files, so a change gives tabs a new address: `theme.js` adds the new `<style>` and removes the old once it loaded. `pocket.themeCache` keeps the addresses, and `index.html` writes them into the page with `document.write` before anything paints, which a parser-inserted stylesheet blocks; in safe mode it writes none. Reply HTML keeps no `data-` attributes but a code block's language, so Pi's words never match a theme's part selectors.

What a browser shows is its person's choice of theme (`look`) and colors (`theme`, its name from before themes), else the owner's `config.themeDefault` (`hello.server.themeDefault`, kept as `pocket.themeDefault` so the next load paints it before `hello`): `theme.js` keeps the person's own choices (`pocket.appearance`) apart from the ones in force, and which of the two they made (`pocket.themeChosen`), so a new default reaches only browsers that have not chosen. Files under a theme's current version are served `immutable`; any other version serves the files as they are now, uncached. Script that depends on where a region is laid out reads it (`useSide` in `ui.js`, looked at again on `pocket:theme`, which `theme.js` sends once a theme's stylesheets load) rather than assuming the sidebar is on the left.

**Live thinking (`transcript.js`).** `theme.js` owns the browser's opt-in; the tab keeps each session's disclosure state. Only an open disclosure selects and draws a thought, memoized separately from the live timer. The active generation, or the latest saved response in the current turn during tools, is authoritative even when it has no thinking. Response and block identity reset follow-scroll for a new thought; only that response's handoff to storage keeps the reader's position.

**Launcher openings (`app.js`, `launcher.js`).** `LauncherHost` observes store transitions synchronously, before Preact batches renders, and keys each logical opening separately. A rapid close/reopen therefore gets a fresh query, selection, and theme-commit flag even when the outgoing launcher is still present for its fade-out. The launcher focuses after DOM reconciliation and isolates its background only while open. Large primary windows use `aria-hidden` and a focus guard, rather than the costly native `inert` traversal of thousands of controls; the overlay blocks pointer access. Other background layers use `inert`. Attribute observers keep the owners' current intent through retained-layer transitions, and close restores that intent before destination focus is restored. Its combobox keeps focus while arrows or Tab move the active option; search-type buttons are a separate group outside the listbox. Field highlights do not change the fuzzy scorer's text or group-first ordering. Session search first retains the combined title/folder match, then falls back to the strongest individually matching tag from the existing access-filtered sessions projection. Tag hits never become title/folder highlights or generic keyword matches. One passive tag reason fits the existing metadata line, with its full name in the option description; late matches in long names keep preceding grapheme context without cutting a grapheme or losing hit offsets. Narrow results use basename folder context beside that reason. No global tag index, extra mode, list-filter mutation or permission change is involved.

**History is the back stack (`back.js`).** Only `back.js` writes history. Each route (`/s/12`) and each layer over it (a sheet, the drawer, the launcher, the Files tile or Browser panel where they cover the screen, a file over the tile's tree) is an entry, and each entry says how many layers it stands for and how many steps back the session list's entry is. The app's state is the truth and history follows it a moment later: opening a layer pushes an entry, closing one with a tap goes back past it, and a new route first goes back past the layers above the current one. Back that the person makes closes the layers above the entry it lands on; back to another route reaches `store.js` through `onRoute`. Traversals `back.js` makes itself reach no one. So:

- Navigate with `navigate()` (which calls `pushRoute`); do not call `history.pushState` or `history.back()` elsewhere. To drop a query from the address, use `replaceAddress`, which keeps the entry's marks.
- Something new that covers the screen, or that back should close, is a layer: `useBack(open, close)` in the component that shows it, where `close` makes `open` false. Sheets get theirs from `sheets.js`, one per sheet opened from another (the menu, then the model picker).
- On phones the window clips sideways: the conversation sliding in from the right (a route, a swipe's lean) would make the page wider than the screen, and a phone's browser widen and pan its view to fit.
- A finger's or a mouse's press and click within 280 ms of a layer opening or closing, or a route opening, at a tap (a pointer let go in the 400 ms before) is let go, focus and all: a quick second tap would land on whatever slid in under it (a tile of the sheet that rose, the scrim that closes it). What moves on its own (a reply opening a session, the server closing a sheet, Escape) holds nothing back, and keys and scripts never are.
- New entries wait for the page's first tap or key, since Chrome's back button skips entries a page adds before anyone touches it: the list's entry under a conversation opened straight away on a narrow screen, and the entries of layers already open at load (the chat a notification opened, a panel the tab kept).

**PiP chat (`pip.js`, `pip-attachments.js`).** The panel's uploads, submits, image thumbnails, and Markdown image paths use its own conversation ID, never the session behind it. The browser-only attachment draft outlives panel mounts, scopes itself to account and PiP ID, and holds upload identities and submit tokens so late callbacks cannot restore removed files or clear newer drafts. Unknown authentication or conversation IDs during reconnect are not a scope change. Files survive closing and reopening the panel, not a page reload; text keeps its existing local-storage draft. The normal upload and submit endpoints retain their size, file-access, and image-capability checks; PiP does not choose another model for an attachment. Opening the pending-memory sheet uses the private PiP ID even on Home. Panel cleanup restores focus only if it is still in the outgoing panel or on the body, not when a destination sheet already took it.

**PiP resize (`pip-window.js`).** Resize uses pointer capture on the same edge/corner zones for mouse and touch, at widths of 768px and above. The preferred size is local to the account/browser; CSS clamps it to the viewport without overwriting it.

**Extensions hub (`sheets/gallery.js`).** For owners with the gallery on, Extensions and the gallery share Discover, Installed, and Updates. The hub keeps one listing for its cards and embedded detail; `ExtensionsContent` supplies built-in and local module controls. Its list and entry sheet routes retain the same component so phone Back preserves search. Trail keys do not depend on whether the gallery is enabled: turning it off falls back to standalone management without adding another Back step. Source and update reviews stay separate sheets; updates still bind approval to the displayed pin and enabled state.

**Extensions' browser modules (`extension-ui.js`).** `hello` lists the browser modules a person's tabs load (`server.ui`: each module's name, title, and address, with its version in it). The tab imports each, and imports it again when its address changes: the server sends `hello` again when a browser module comes, goes, changes who it is for, or one of the files it serves changes (`ExtensionWebs` watches its folders), and when its module's new version installs other tools. A reload that leaves all that as it was leaves the address as it was, so tabs keep the browser module they loaded (they may hear `hello` again for other reasons). Event streams and poll queues cut off a tab more than 8 MB behind that took nothing for 30 s, or any tab 128 MB behind (`http/events.ts`); it connects again and gets a full view. A large first view is no reason: the tab has had no time to take it. A polling tab with an answer on its way is taking it until it polls again (one that never does ends 60 s after its last poll or answer), and a stream's ping checks too, so a stalled tab is cut off with no new events for it. A browser module is meant to add only through `pocket` (it runs in the page, so nothing stops it from more), and one that throws is caught there: its notice, its row in the Extensions sheet, its page's error box. One that failed stays listed (`dead`) but adds nothing more, until its module installs other tools: then the tab loads it again, as it may have failed on a tool the server did not have yet. Its events come as `ext` (`{ module, event, data }`). How a module's tools' calls show (`pocket.toolCall`) reaches `calls.js` and `turns.js` through setters, as they import nothing. Each `ui` entry lists the tools its module installs (from the loader), and a module describes only those; what a describer gives is used only when it is text. When a module goes, `sheets.js` takes its sheets out of the ones back would bring back (`onExtensionsGone`). A tab in safe mode (`?noext=1`, kept as `pocket.noext` in session storage) loads none of them.

**Contracts with the server.**

- Event names and shapes (`hello`, `view`, `chat`, `peek`, `subagents`, `ext`, …) and the sheet types the server names (`sheet: "chat"`).
- The `pocket.*` keys in local and session storage.
- Extensions' API: `web` on the server and `pocket` in the browser, at `POCKET_API`. Modules outside this repository depend on them: add to them freely, and change what they do only with a new version.
- `ATTACHMENTS_HEADING` and `splitAttachments` (which also reads the form sent before 0.14.0), which `ui.js` repeats from `entry-format.ts`.

## Checking a change

- **Every change:** `npm run check` (types, and no unused imports or locals in the TypeScript), `npm run lint`, and `npm test`.
- **Server:** the tests drive a real `PocketApp` with a scripted model, a restart included (`openApp` on the same folder). The built-in browser and peek tiles also run in a real Chromium where one is installed.
- **Web:**
    - `node --check` each file you edit.
    - Then open the app and use what you changed, with the console open.
    - A change that moves code between modules is a move only when the moved code is the same and the loading order above is kept.
