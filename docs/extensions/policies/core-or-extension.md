# Core or extension

This page tells where a change goes: into Pi Pocket's core, or into an extension. Read it before you write code, and before you open a pull request. [extensions.md](../../extensions.md) tells how to write an extension.

## Terms

- **Core** is the code that Pi Pocket keeps for all people and all extensions. It is the server (`src/server/`, but not `src/server/extensions/`), the app (`web/`), and the interfaces that extensions use: `host`, `web`, and `pocket`.
- An **extension** is a module that Pi Pocket loads through its extension loader. The owner can turn each one off in **Menu → Extensions**, except the system prompt (`prompt.ts`). There are three types:
    - A **built-in extension** is a module in `src/server/extensions/`. It comes with Pi Pocket.
    - A **gallery extension** is a drop-in that its author keeps in their own repository. The gallery lists it ([gallery-review.md](gallery-review.md)).
    - A **drop-in** is a module in the owner's `~/.pi-pocket/extensions/` folder.
- An **extension point** is a part of the public API that lets an extension add to Pi Pocket or change it. [api-stability.md](api-stability.md) lists them.

## The decision

Ask these questions in this order. The first "yes" gives the answer.

- **C1. Does it decide who may do what? Then it is core.** Sign-in, roles, invites, the sessions that a person can see, steering and turns, approvals, and the `access` checks of routes and commands are core.\
  _Reason:_ a check must be in one place. A module can forget a check, and the owner can turn a module off.
- **C2. Does it change stored data that other parts read, or the rules for how data lasts? Then it is core.** The session list, the documents in `src/server/docs.ts`, replay after a restart, and the keys that make an action happen once are core.\
  _Reason:_ stored data lives longer than code. A format that changes with one module can break every session that has the data.
- **C3. Does it spend money or choose a model? Then it is core.** Spend limits, budgets, the rule that only people choose models, and the list of models for subagents are core.\
  _Reason:_ a limit that one module can go around is not a limit.
- **C4. Does it protect against an attack? Then it is core.** The fences around text from outside, the content security policy, path checks, and limits on growth are core.\
  _Reason:_ protection that is optional is off for some people.
- **C5. Must it work the same for every extension or every person? Then the mechanism is core, as an extension point.**\
  _Reason:_ two copies of one mechanism become different over time, and each copy has its own bugs.
- **C6. If all the answers are "no", it is an extension.** Optional workflows, integrations with outside services, presentation preferences, and the process of one team are extensions.\
  _Reason:_ core stays small, and people who do not want a feature do not carry it.

### A feature with two parts

- **C7. Split it. Put the mechanism in core, and the workflow in an extension.**\
  _Reason:_ other extensions can then use the mechanism, and people can turn the workflow off.
- **C8. Do not add a setting to core for one workflow. Write an extension.**\
  _Reason:_ all people see each setting in core, and the maintainers must keep it.
- **C9. Do not copy a core check into an extension. Use it through `host` or `web`, or ask for an extension point.**\
  _Reason:_ a copy does not change when core fixes the check.
- **C10. Do not patch core from a module.** A module must not change core's objects at run time (replace a method, change a prototype). It must not import core's files at run time.\
  _Reason:_ core's internal files can change in any release ([api-stability.md](api-stability.md#what-is-internal)).

### Which type of extension

- **C11. Make a drop-in when one person or one machine needs it.**\
  _Reason:_ it survives updates, and nobody else has to keep it.
- **C12. Make a gallery extension when other people can use it.** Its author keeps it in their own repository.\
  _Reason:_ people can share it with no change to Pi Pocket.
- **C13. Make a built-in extension only when Pi Pocket must ship it.** It is part of the default experience, or it is the interface to a part of core (as the gallery is).\
  _Reason:_ the maintainers keep each built-in extension for all people.
- **C14. A new built-in extension uses only `host` and `web` at run time.** Type imports from core are permitted. Agent Teams obeys this rule. The built-in extensions from before 0.14 do not have to change.\
  _Reason:_ the module then shows that the public API is sufficient, and it can move to the gallery later.

## Examples from Pi Pocket

### Linked sessions and Agent Teams

- **Core: linked sessions** (`linked-sessions.ts`, `host.linkedSessions`). Core starts a linked session, carries messages, and lists the sessions. It acts with the rights of the person Pi works for. It refuses work in plan mode. It counts the cost of the team against the budget of the top session. It stops a team at its [limits](../reference/limits.md#linked-sessions) of sessions, and of messages with no message from a person. It uses keys, so a replay acts once. It gives sessions addresses, so no session ID goes into a transcript.
- **Extension: Agent Teams** (`extensions/agent-teams.ts` and `agent-teams.js`). The `team` tool, its words to Pi, and how its calls show. It is off by default. At run time it uses only `host` and `web`, as a drop-in does.
- **Why:** pull request #84 first put Agent Teams in core. In 0.14 the mechanism stayed in core, because it decides permissions, stored data, and spend (C1 to C3). The workflow became a built-in extension (C6, C7). Another team workflow can use the same linked sessions.

### Commands

- **Core: `web.command`** (pull request #36). Core decides who may run a command. It makes a durable task for each run, so a retry runs the handler once. It shows the run in **Menu → Running now**, and stops it there. It keeps limits, and it writes cards that Pi does not read.
- **Extension: each command.** For example, `/clock-zone` in [examples/clock.ts](../../examples/clock.ts).
- **Why:** the mechanism decides permissions and stored data (C1, C2). Each command is a workflow (C6).

### The gallery

- **Core: the trust rules** (`src/server/gallery/`, `host.gallery`). Core reads the index strictly. It downloads files only over https, from the pinned commit. It checks each SHA-256. It installs everything off, and it never updates by itself. It warns about revoked versions.
- **Built-in extension: the gallery** (`gallery.ts`, `pocket-gallery`). Its routes and its screens. When the owner turns it off, it reads nothing.
- **Why:** the checks protect the owner (C4). The screens are optional (C6), but Pi Pocket must ship them (C13).

### Subscription usage

- **Gallery extension: `subscription-usage`** ([TannerMidd/pocket-subscription-usage](https://github.com/TannerMidd/pocket-subscription-usage)). A page that shows how much of the owner's Claude, ChatGPT, and OpenCode Go plans is used.
- **Core: nothing new.** It uses only `web.route` and `web.client`.
- **Why:** it is an integration with outside services, and only some owners have them (C6, C12). It reads the owner's sign-ins, so the gallery review checks that its description says so ([gallery-review.md](gallery-review.md#what-gets-refused)).

### Interface languages (#64, proposed)

- **Core:** `t()` for the app's fixed text, the fallback to English, and the loader for locale packs.
- **Extension:** each language, as a locale pack that has only data.
- **Why:** the keys and the fallback must be the same on all screens (C5). A language is the preference of some people (C6).

### Themes (#90, 0.14.0)

- **Core:** the theme surface, which every theme can change: tokens (CSS variables), the `data-part` names of the parts of the screen, and their documented states. Also the loading and the checks of theme folders.
- **Not core:** each theme, as a folder in `~/.pi-pocket/themes/`. Duplicate the Pocket theme, change the copy, and choose it in settings.
- **Why:** the tokens and the parts must be the same for every theme (C5). The look is a preference (C6). The default theme stays the one that Pi Pocket ships.
- The theme guide and the theme surface reference tell what a theme can change.

### Session tags (#118, 0.20.0)

- **Core:** the session list's extension points: chips on rows (`pocket.sessionChips`), words for the search and the launcher (`pocket.sessionSearch`), filters beside the search (`pocket.sessionFilter`), and actions on sessions (`pocket.sessionAction`). On the server, `request.sessions()` gives the sessions that a person can see, so a route checks ids with core's own rule.
- **Built-in extension: Session tags** (`extensions/session-tags.ts` and `session-tags/`). Its document of tags, its routes, its chips, filter, and sheets. It is off by default. At run time it uses only `host` and `web`, as a drop-in does.
- **Why:** pull request #118, by Jeroen Dee (@jeroendee), first put tags in core, on the session list's stored data. Tags are a way to organize work that only some people want (C6), so the workflow became an extension, and the mechanism a set of extension points that other modules can use (C7). Who can see a session stays in core (C1, C9).

### Web access (#126, 0.20.0)

- **Core: `host.fetchPublic`.** A fetch that reaches only the public internet: it checks the address of each connection and each redirect, so a name that changes its address (DNS rebinding) gets nowhere, and it stops at a size and a time.
- **Gallery extension: web search.** Its providers, keys, routing, settings sheet, request counts, and tools. At run time it uses only `host`, `web`, and `pocket`, as a drop-in does.
- **Why:** pull request #126 first put search, its settings, and its routes in core. Search providers are integrations with outside services that only some owners want (C6, C8, C12). The check that keeps a fetched address off this machine and its networks protects against an attack (C4), and each module that reads a page needs the same one (C5, C9), so it became an extension point. [examples/read-page.ts](../../examples/read-page.ts) is its first user (C15).

## Ask for a new extension point

When the public API cannot do what you need, ask for an extension point. Do not keep a patch to core in a fork if you can stop.

1. Open an issue in [TannerMidd/pi-pocket](https://github.com/TannerMidd/pi-pocket/issues). Use the title "Extension point: <what it lets an extension do>".
2. Show the patch that your fork has today: a link to the commit, or the diff. Mark the lines that are the extension point, and the lines that are your workflow.
3. Tell what your extension does, in one paragraph.
4. Tell which parts of the public API you tried, and why they are not sufficient.
5. Propose the smallest interface that removes the patch: its names, its shapes, and who may call it.
6. Answer C1 to C5 for it. Tell if it touches permissions, stored data, spend, or security.
7. Name other extensions that can use it, if you know of them.

_Reason:_ a real patch shows the real need, and the smallest change that serves it.

A maintainer answers with one of these:

- **Use what is there.** The maintainer shows how.
- **A new extension point.** It comes as experimental first ([api-stability.md](api-stability.md#experimental)).
- **A change to core.** The behavior is for all people, so it goes into core (C1 to C5).
- **No.** The maintainer gives the reason when possible.

### Rules for extension points

- **C15. Each new extension point has a user when it ships:** a built-in extension, a gallery extension, or a tested example in [docs/examples/](../../examples/). `host.linkedSessions` and `pocket.toolCall` shipped with Agent Teams, and `web.command` with the clock example.\
  _Reason:_ an interface with no user is a guess, and a wrong guess becomes a public API that Pi Pocket must keep.

## Pull requests

- **C16. In the pull request, say where the change goes, and name the rule that decides it (C1 to C14).**\
  _Reason:_ the reviewer then uses the same test that you used.
- **C17. Send a change to core and the extension that uses it as separate commits.**\
  _Reason:_ the maintainer can then take the core part alone, as with linked sessions and Agent Teams.
