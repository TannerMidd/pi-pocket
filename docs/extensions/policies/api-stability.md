# The public API and how it changes

This page tells which interfaces of Pi Pocket are for extensions, what Pi Pocket promises about them, and how they change. [The reference](../reference/host.md) and the exact types in [types/pocket.d.ts](../../../types/pocket.d.ts) tell what each interface is, and the guides tell how to use it. This page does not repeat them.

## Terms

- **Public:** an interface in the list below. Pi Pocket keeps it, or changes it only by the rules on this page.
- **Internal:** all other code and data. It can change in any release, with no notice.
- **Stable:** public, and not experimental or deprecated. All public interfaces are stable unless the docs mark them.
- **Experimental:** public, but it can change or go in any minor release, never in a patch release.
- **Deprecated:** public, but it will go. A replacement is available.
- **Breaking change:** a change after which a module that obeys the docs can fail, or work differently.
- **Addition:** a change after which every such module works as before.

## What is public

Each item below is public as the reference and the guides describe it: its names, its shapes, its behavior, and the [limits](../reference/limits.md).

### 1. The module

- A `.ts` file in the drop-in folder (`extensions/` in the data folder), with the `node_modules` link to Pi Pocket's packages.
- The default export `(host, web)`. It can be `async`. It returns one extension, a list, or nothing. Pi Pocket installs all of it or none of it.
- `export const pocketApi`.
- The first sentence of the module's `/** … */` comment, which is its description.
- Files that start with `_` or end in `.test.ts` are not modules.
- Loading, reloading, and errors ([Modules, loading, and errors](../modules.md)), with the times in [Limits](../reference/limits.md#loading).
- The types in [types/pocket.d.ts](../../../types/pocket.d.ts): `Module`, `Host`, `SafeText`, `LinkedSessions`, `LinkedSession`, `Web`, `WebRequest`, `ConversationWebRequest`, `HumanLinkedSessions`, `HumanLinkedSession`, `WebHandler`, `WebAccess`, `WebMethod`, `Command`, `CommandContext`, `CommandResult`, `BrowserModule`, `Pocket`, the specs and props of what a browser module adds, `Person`, `Role`, and `NoticeLevel`. Import them with `import type` from `./_pocket.d.ts` in the drop-in folder ([Types for your editor](../reference/types.md)): the import goes away at run time.
- `src/server/host.ts` is internal. Its types (`PocketHost`, `ExtensionWeb`, and the others) are Pi Pocket's own, and can change in any release. `test/public-types.ts` checks that they fit the public types.

### 2. Names

- The names that Pi Pocket keeps for itself ([Names](../reference/names.md)): extension names that start with `pocket-`, the extension name `coding-tools`, the names of built-in modules, and the names of built-in tools.
- The rules for the names of modules, tools, commands, routes, and the IDs of what a browser module adds.
- The paths of a module's routes, `/api/x/<module>/`, and of its browser files, `/x/<module>/`.
- **Promises:** the names of Pi Pocket's own extensions start with `pocket-` (or are `coding-tools`). Its own commands never have a `-`. Its own document kinds, task names, and browser storage keys never start with `x.`.

### 3. `host`

These members are public:

- `dataDir`, `agentDir`, `pocketVersion` (running-server package version, since 0.16.0)
- `notice(level, message, id?)`
- `resolveModel(spec)`, `subagentModels()`, `modelProblem(ref, fresh?)`, `modelInfo(spec)` (exact local metadata, since 0.16.0)
- `requesterOf(conversationId)`
- `roleOf(personId)` (experimental, since 0.27.0)
- `skillPaths()`, `skills(cwd)`
- `heldBack(conversationId)`, `onLimitsChanged(listener)`
- `linkedSessions`: `start`, `send`, `list` (experimental in 0.14, see [Experimental](#experimental))
- `text`: `quoted`, `defang`
- `thinkingLevels`
- `fetchPublic(url, init)` (experimental, since 0.20.0)
- `ask(request, context)`, `hide(value)`, `commandEnv(provider)`, `browser(conversationId, options)` (experimental, since 0.22.0: [People's values and the browser](../people-values.md))
- `on(event, listener)` and the events of `AppEvents` (experimental, since 0.22.0: [Events, services, and settings](../services-settings.md))

These members are on `host` for Pi Pocket's own built-in extensions: `guard`, `approvals`, `schedules`, `goals`, `browsers`, `memory`, `watches`, `repoWatches`, `gallery`, `updates`, `pip`, and `pipCompaction`. They are **internal**. A drop-in can read them, but their shapes can change in any release. One of them becomes public only through a request for an extension point ([core-or-extension.md](core-or-extension.md#ask-for-a-new-extension-point)).

The host's members do not change while modules reload. A new member comes only after a restart, so a module that uses a new member must check that it is there ([Using the host](../host.md)).

### 4. `web`

- `api`, `module`, `route`, `conversationRoute` (since 0.16.0), `client`, `command`, `send`, `error`, and `onDispose`.
- `provide`, `use`, `onService`, `settings`, `setting`, and `onSettings` (experimental, since 0.22.0: [Events, services, and settings](../services-settings.md)).
- `publicPage` and `links` (experimental, since 0.22.0): pages at `/l/<token>` for anyone with a module's link, what a page handler gets (`PublicPageRequest`), and what its answer does ([Public pages](../public-pages.md)).
- What a route handler gets (`WebRequest`: `method`, `params`, `query`, `body`, `user`, `signal`; since 0.16.0 also request-lifetime `snapshot`, `context`, `commit`), and what its answer does.
- A conversation-bound request's `conversation` metadata and human `linkedSessions.start` / `list`, with their authenticated-actor, receipt, and admission checks (since 0.16.0).
- The route paths, the methods, the `access` values (`owner`, `steer`, `view`), and the `X-Pocket` header that every call to a route must have.

### 5. A command's `ctx` and result

- `ctx`: `user`, `conversationId`, `cwd`, `signal`, `snapshot`, `context`, and `commit`.
- The results `{ type: "toast", level, message }` and `{ type: "card", output }`.
- The scopes `conversation` and `global`, and who may run each.

### 6. `pocket`

- `version`, `module`, `title`, and `pocketVersion` (connected-server package version, since 0.16.0; not the API level).
- `h`, `html`, `Fragment`, and the hooks: `useState`, `useEffect`, `useLayoutEffect`, `useRef`, `useMemo`, `useCallback`, and `useReducer`.
- The pieces `Icon`, `Loader`, `Spinner`, `Markdown`, and `Switch`, with the props that [pocket](../reference/pocket.md) gives.
- `api`, `on`, `rail`, `menu`, `launcher`, `page`, `sheet`, `toolCall`, `openPage`, `closePage`, `openSheet`, `closeSheet`, `notify`, `me`, `conversationId`, `openConversation` (since 0.16.0), `style`, and `onDispose`.
- What a page's or a sheet's component gets: `pocket`, `close`, and a sheet's `props`.
- The icon names that [pocket](../reference/pocket.md) lists. Other icon names can go. An unknown name shows `grid`, so a module does not fail.
- Safe mode: `?noext=1` and `?noext=0` on the app's address.

### 7. CSS

- The variables `--text`, `--muted`, `--accent`, `--bg`, `--card`, `--line`, `--err`, `--warn`, and `--ok`. They follow the theme.
- The classes `button` (with `primary`), `error-box`, `muted`, `small`, `mono`, and `setting`.
- All other CSS is internal: other classes, other variables, the structure of the page, and the IDs of its elements.
- Themes, new in 0.14.0, have a public surface of their own: the tokens, `data-part` names, and states in the theme surface reference.

### 8. Events

- `web.send(event, data, { to })` on the server and `pocket.on(event, run)` in the browser, with their limits.
- A module's events are its own. An event goes only to the browser module of the module that sent it. Pi Pocket does not keep any event name for itself, and it reads none of them.
- The app's own events between the server and its tabs (`hello`, `view`, `chat`, `ext`, and the others) are internal.

### 9. Names for stored data

- The rule to name document kinds, tasks, entry kinds, and browser storage keys `x.<module>.…`, and to keep a name once people used it: [Rules that are easy to break](../../extensions.md#rules-that-are-easy-to-break).
- **Promise:** core's names start with `pocket.`, and core never uses `x.` names, in the store or in the browser.

### 10. The gallery entry format

- Index format 1, and the fields of an entry, as the index's [README](https://github.com/TannerMidd/pi-pocket-extensions#an-entry) gives them. Where the README and `src/server/gallery/entry.ts` do not agree, `entry.ts` is correct.
- Pi Pocket refuses an entry with a field that it does not know. So an entry can use a new field only when its `minPocket` is a release that reads that field. Tools that make entries (**Share…**) leave a new field out when it is empty, as they do with `declares.commands`.
- A change to the meaning of a field, or a new field that is necessary, needs a new index format. Pi Pocket reads only its own format.
- The `<name>.gallery.json` file next to an installed drop-in, the gallery's routes, and its screens are internal.

## What is internal

- All files under `src/` and `web/`, and what they export, `src/server/host.ts` too. The public types are in `types/pocket.d.ts` ([The module](#1-the-module)).
- The app's HTTP API, other than a module's own routes under `/api/x/<module>/`.
- The events between the server and its tabs, and the `pocket.*` keys in browser storage.
- Pi Pocket's document kinds (`pocket.*`), and the shapes of its documents, entries, and tasks. A module can read them with `api.snapshot`, but their fields can change.
- `config.json`, `pocket.sqlite`, and the rest of the data folder, except `extensions/`.
- All CSS that is not in [CSS](#7-css).
- The words of errors, notices, logs, and the system prompt.
- The tools of built-in extensions: their arguments and results. Only their names are public, as reserved names. One exception, since 0.22.0 and experimental: the `browser` tool's `action` and the arguments that name its target (`ref`, `selector`, `label`, `x`, and `y`), so that a hook can guard what Pi types ([People's values and the browser](../people-values.md)).
- The `host` members for built-in extensions ([host](#3-host)).
- The test helpers in `test/`. The index's checks use them, and pin the Pi Pocket version they use.

## Packages from Earendil

Extensions import `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and the other packages that Pi Pocket has. Earendil makes them, not Pi Pocket. Pi Durable is experimental, and its API can change between its releases. Pi Pocket pins their versions in `package.json`, and a drop-in gets the same versions through the `node_modules` link.

- **A1. The release notes name each update of a pinned package** in "For extension authors".\
  _Reason:_ an author can then find the cause when a module breaks after an update.
- **A2. When an update breaks a use that the guides document** (`defineTool`, `section`, `hook`, `api.memo`, `api.snapshot`, `wrapTool`, and the others), the notes tell what changed and how to change a module, and `pocketApi` goes up (A7).\
  _Reason:_ authors learn these uses from Pi Pocket's docs, and they check one number for all that a module uses.

## Stability levels

### Stable

All public interfaces are stable, unless the docs mark them experimental or deprecated.

### Experimental

- **A3. The docs mark an experimental member.** The reference writes "Since … · Experimental" under the member. In `types/pocket.d.ts`, its comment has `@experimental`. The docs build checks that the two agree.\
  _Reason:_ authors must know before they use it.
- **A4. An experimental member can change or go in any minor release, with no deprecation, but never in a patch release (A14).** The release notes say so.\
  _Reason:_ a new interface must be able to change while its first users find its problems.
- **A5. An experimental member becomes stable when the release notes say so.**\
  _Reason:_ the change of status is then easy to find.
- **A5.1. An experimental member is ready to become stable when all of these are true:**
    - at least two modules use it that are not by the same author, and at least one of them is not built in (a gallery extension, or a drop-in shared in an issue);
    - one minor release went out with no change to its signature or to what it does;
    - its reference, a guide, and a test of its own are in place, and its limits are on the limits page;
    - no issue about it is open that asks for a change that would break modules.

    Each minor release, the maintainers look at the experimental members that meet these, and either make them stable in the release notes or say what still stops them.\
    _Reason:_ an interface is right when it served people other than the one who asked for it, without changes.

- **A6. A gallery entry that uses an experimental member should say so in its description.**\
  _Reason:_ the owner then knows that an update of Pi Pocket can break it.

`host.linkedSessions` remains experimental in 0.16.0. The human-bound `linkedSessions` on a conversation route is a separate stable interface, added in 0.16.0. Other public members are stable unless marked otherwise.

Since 0.19.0, these `pocket` members are experimental too: `panel`, `openPanel`, `closePanel`, `status`, `topbar`, `composerButton`, `replyAction`, `insertText`, `arrange`, and their types. The `core:` ids of the items in slots are public, with the same promise as the names of the theme surface.

Since 0.22.0, these are experimental too: `web.publicPage` and `web.links`; `host.ask`, `hide`, `commandEnv`, and `browser`; `host.on`; `web.provide`, `use`, `onService`, `settings`, `setting`, and `onSettings`; `pocket.settings` and `onSettings`; and their types. So are the `browser` tool's `action` and target arguments, for hooks.

Since 0.26.0, `pocket.pip` (`ask`) is experimental, with `PipApi` and `PipAskResult`.

Since 0.27.0, `host.roleOf(personId)` is experimental, and so is the `scroll` field of `host.browser`'s `snapshot()`.

Since 0.20.0, the session list's extension points are experimental: `pocket.sessionChips`, `sessionAction`, `sessionFilter`, and `sessionSearch`, `WebRequest.sessions`, and their types. So is `pocket.composerKey`, with `ComposerKeySpec` and `ComposerBox`, and so are `pocket.onConversation`, `messages`, and `reveal`, with `MessagesOptions`, `MessagePage`, and `MessageInfo`. So are `host.registerModelProvider`, and `host.fetchPublic` with `PublicFetchInit`.

### Deprecated

See [Deprecation](#deprecation).

## Version rules

### `pocketApi`

- `POCKET_API` is one number for the whole public API, on the server and in the browser. `web.api` and `pocket.version` give it. It was 1 from Pi Pocket 0.14.0. It is 2 from 0.19.0, because the Pi Durable 1.2 rename of `content` to `output` breaks a hook or a wrap that returns `content` (A2, A7). The oldest supported version is 1 (A9).
- **A7. `pocketApi` goes up by one in a release that has a breaking change to a stable member.** A release with many breaking changes adds one.\
  _Reason:_ one number tells if a module can work, with no need to compare release numbers.
- **A8. Additions do not change `pocketApi`. Changes to experimental members do not change it.**\
  _Reason:_ a number that moves for each addition says nothing about breaks.
- A module's `pocketApi` export is the API version that the module was written for. Pi Pocket does not load a module that needs a newer API. It says so in the Extensions sheet. A gallery entry's `pocketApi` is the same number. The gallery hides an entry that needs a newer API.
- **A9. Pi Pocket loads modules that were written for the previous `pocketApi` for at least the deprecation period ([A17](#minimum-time)).** After that, it refuses them with an error that tells the owner to update the module. A module with no `pocketApi` export counts as version 1.\
  _Reason:_ authors get the same time to update as for one deprecated member, and an old module fails with a clear message, not at its first use of a member that is gone.

### `minPocket` and additions

- **A10. A module that uses an addition checks for it at run time,** as `typeof web.command === "function"`. In the gallery, it also sets `minPocket` to the release that added it.\
  _Reason:_ the server's part changes only after a restart, so a running server can have an older `host` and `web` than its files.
- **A11. `minPocket` names a release, such as `0.15.0`, not a pre-release.** Pi Pocket counts `0.15.0-beta.2` as `0.15.0`.\
  _Reason:_ a beta can change before the release, and an entry for a beta can break on the release.

### Breaking changes

These are breaking changes when they touch a stable member:

- remove or rename a member, a field, an option, an `access` value, or a CSS name;
- change the type or the meaning of a parameter, a field, or a result;
- make an optional parameter or field necessary;
- accept less than before: a stricter check, a lower limit, or a shorter time limit;
- give a module less than before: fewer fields, or a narrower `access`;
- change a default, such as the `owner` default of `access`;
- change when Pi Pocket calls a module's code, where the docs say when;
- change a naming rule for stored data, or the paths of routes;
- change the gallery entry format so that Pi Pocket refuses a valid entry.

### Additions

- a new member, option, field, icon, or CSS name;
- a higher limit, or a longer time limit;
- a new optional field in the gallery entry, used with `minPocket` ([The gallery entry format](#10-the-gallery-entry-format));
- a fix that makes the behavior agree with the docs.

### Not covered

These can change in any release: the words of errors and notices, timing that the docs do not give, speed, the look of the app beyond the CSS names, and all that is internal.

### Reserved names

- **A12. Pi Pocket can keep a new name for itself in any minor release:** a module, an extension, a tool, a command, or a theme id (a theme or a palette that comes with Pi Pocket). The release notes list it.\
  _Reason:_ new built-in features need names. A module with its own prefix ([Names](../reference/names.md)) never meets them.
- When a new reserved name is the name of a drop-in, Pi Pocket refuses the drop-in, and the Extensions sheet says why. For example, 0.14 keeps the tool `team` and the module `agent-teams`.
- When a new reserved theme id is the id of a theme folder of the owner's, Pi Pocket does not read that folder, and tells the owner. The gallery does not accept a theme entry with a reserved id. For example, 0.14 keeps the theme `lantern`.

### Security fixes

- **A13. A security fix can change or remove a stable member with no deprecation period, in any release, a patch included.** The release notes say so under "Security". Pi Pocket keeps the change as small as the fix permits.\
  _Reason:_ owners must not stay at risk for the length of a deprecation period.

### Pi Pocket's version and `pocketApi`

- Pi Pocket's version is `0.Y.Z` before 1.0. `Y` is the minor release. `Z` is the patch.
- **A14. A patch release (`0.14.1`) has fixes only.** It has no additions, no breaking changes to stable members, and no new deprecations. Only a security fix (A13) can break.\
  _Reason:_ an owner must be able to take a patch with no risk to their extensions, and each `minPocket` is then a `.0` release.
- **A15. A minor release (`0.15.0`) can add, deprecate, and change experimental members.** It can remove a deprecated member after its minimum time. Then `pocketApi` goes up.\
  _Reason:_ authors then read the notes of minor releases only, to know what changes.
- **A16. Pre-releases (`0.15.0-beta.1`) have no promise.** Members can change from one beta to the next.\
  _Reason:_ betas are for tests of new interfaces before they become stable.
- Since 0.16.0, `host.pocketVersion` and browser `pocket.pocketVersion` report the running server's package version. The browser value is undefined with an older server. Neither fetches updates or controls restarts. Additions in 0.16.0 leave `pocketApi` at 1.
- The two numbers move apart. Many releases of Pi Pocket can have `pocketApi` 1. `pocketApi` tells if a module can work. `minPocket` tells from which release.

### Before 1.0

- Pi Pocket is young. Its public API is small, and it will grow.
- The rules on this page are in force before 1.0. They can change in a minor release. A change that gives authors less is told as a breaking change is.
- Pi Durable is experimental (see Limitations in the [README](../../../README.md#limitations)).
- At 1.0, Pi Pocket plans to follow semantic versioning: breaking changes only in a major release. This page will say so then.

## Deprecation

### How a member is deprecated

1. The replacement ships first, or in the same release. If the feature goes with no replacement, the notes say so.
2. In `types/pocket.d.ts`, the member gets `@deprecated` with what to use instead and when it goes: "Deprecated in 0.15.0. Use `web.example`. It goes in 0.17.0 or later, and not before 2027-02-01." Editors then show it.
3. Its page in the reference gets the line "Since 0.14.0 · Deprecated", with the same words under it. The docs build checks that the reference and the types file agree.
4. The release notes list it under "Deprecated", in "For extension authors".

### Minimum time

- **A17. A deprecated member stays for at least one minor release and at least 90 days, from the first stable release that deprecates it.** The later of the two applies. Experimental members have no minimum (A4). Security fixes have none (A13).\
  _Reason:_ an author who updates a few times a year must have time to see the warning and change the module.

### Removal

- **A18. A deprecated member goes only in a minor release, after its minimum time.** That release raises `pocketApi` by one.\
  _Reason:_ authors then know when to look, and one number shows the break.
- The release notes list it under "Removed", with what to use instead.

### Theme parts

- **A20. When what a theme part names leaves the app, the part goes with it, in the same release, with a release note.** A theme's rules for it then match nothing, and the rest of the theme works as before. A part whose region stays but changes its name keeps the old name as an alias, by A17 and A18.\
  _Reason:_ the app cannot keep a screen for the sake of a selector; a rename costs nothing to keep.

## Release notes: "For extension authors"

- **A19. The notes of each release have a section "For extension authors".** The 0.14 betas already have it. It uses these headings, in this order, with one line and a link for each item:
    - **Added**
    - **Changed:** changes to experimental members, and fixes that authors can see.
    - **Deprecated:** each with its replacement and its earliest removal. The first release with a deprecated member also tells how the owner sees the warning ([Warnings](#warnings)).
    - **Removed:** and the new `pocketApi`.
    - **Reserved names**
    - **Security:** changes with no deprecation period (A13).
    - **Packages:** updates of the pinned packages from Earendil (A1).

    When nothing changed, the section says "No changes."\
    _Reason:_ authors read one place, and "No changes" is also information.

## Warnings

- Nothing is deprecated now, and Pi Pocket shows no deprecation warnings. The first release that deprecates a public member adds a warning that the owner sees when a module uses it. Its notes say so under "Deprecated".
- Since 0.19.0 (`pocketApi` 2), Pi Pocket checks the oldest supported `pocketApi` (A9). It is 1: a module that exports 1, or no `pocketApi`, loads. A module for an older version is refused, with an error that tells the owner to update the module.
