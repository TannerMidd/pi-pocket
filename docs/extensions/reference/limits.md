# Limits

All the numbers that limit a module, in one place. Each group links to the guide that tells why the limit is there and what happens past it. The guides link here, and do not repeat the numbers.

## Loading

[Modules, loading, and errors](../modules.md)

- **Reload after an edit:** about 300 ms after you save a module that is on.
- **A file that goes:** Pi Pocket removes a module only when its file is still gone 300 ms later.
- **Time to load:** 30 s at most for one load: the import, and an async default export.
- **Time to load at the server's start:** all the modules share 30 s. After that, each module that is left has 2 s.

## Names

[Names](names.md)

- **A module that adds to the app:** a name of 64 characters at most. [Modules, loading, and errors](../modules.md)
- **An id of a rail button, menu row, launcher action, page, sheet, panel, status item, top bar button, message box button, or action under answers:** 64 characters at most. [Browser modules](../browser-modules.md)
- **A command's name:** 64 characters at most. [Slash commands](../commands.md)
- **An event's name:** 1 to 64 characters. [Events](../events.md)
- **A gallery entry's name:** 2 to 64 characters. [Publishing to the gallery](../publishing.md)

## Host

[Using the host](../host.md)

- **`host.text.quoted`:** cuts the line to 120 characters when you give no `max`.
- **`host.fetchPublic`:** by default, 5 redirects, a body of 10 MiB after it is decoded, and 30 s for the whole request. `maxRedirects` can be 20 at most. `maxBytes` can be any size from 0. `timeoutMs` can be from 1 ms to 2,147,483,647 ms.

## Linked sessions

[Starting and messaging sessions](../linked-sessions.md)

- **Sessions that one session starts:** no limit, since 0.19.0. Before 0.19.0, 10 at most. A linked session cannot start sessions.
- **Messages between the sessions of a team:** no limit, since 0.19.0. Before 0.19.0, 20 at most since a person last wrote in one of them. The spend limit of the session that started the team still applies.
- **A message:** 20,000 characters at most.
- **A title:** one line of 120 characters at most.
- **A call's key:** Pi Pocket keeps the record of a `key` for 30 days, and the records of the last 1,000 calls of each session.

**Note:** since 0.19.0, no count limit applies to a team. The spend limit of the top session is the brake. The owner can set a session budget for a team in Menu → Spend.

## Browser modules

[Browser modules](../browser-modules.md)

- **A file that a browser module serves:** 8 MB at most.
- **Files that count for a new version:** the first 2000 served files, in 500 folders at most. An edit past these does not load the module again.
- **Folders that Pi Pocket watches for edits:** the first 64. It sees an edit deeper at its next look.
- **Calls to `pocket` in one task:** past 1000, over more than 1 s, the module stops in that browser.
- **Pages and sheets that a module opens or closes:** past 300 in 1 s, the module stops. With no task between them, it stops past 1000, or at 5 or more over more than 1 s.
- **Redraws in a hidden tab:** by a timer of 100 ms, which the browser can make slower.
- **Notices from `pocket.notify`:** 5 every 5 s for a module, for all its versions together. The app drops the rest.
- **The text of `pocket.pip.ask`:** 1 to 100,000 characters. Others throw. A send needs a tap just before it: it serves for 5 s and for one send.
- **Rail buttons of modules:** no limit of their own. A rail with more buttons than room scrolls as a whole, and fades the edge where more is. The folded rail keeps up to a third of the window for its sessions first.
- **A count on a rail button:** a count past 99, and `Infinity`, shows "99+".
- **Text on a rail button:** past 24 characters, it is cut to 23 characters and "…". A panel's badge is the same.
- **Text of a status item:** past 40 characters, `text` and `short` are cut to 39 characters and "…".
- **Swipe back on a page:** on touch screens up to 699 px wide.

## The session list and message boxes

[Browser modules](../browser-modules.md#the-session-list), [The pocket reference](pocket.md)

- **Keys of one `composerKey`:** a list of 8 at most.
- **`ComposerBox.set`:** a text of 1,000,000 characters at most. A longer one throws.
- **Chips under one row:** 6 at most for each module.
- **A chip's `label`:** past 32 characters, it is cut to 31 characters and "…".
- **Words of one session for `sessionSearch`:** 32 at most, of 100 characters each at most.
- **Filters:** 3 show in the search field, and only those 3 filter the list.
- **A session action's `label`:** past 24 characters, it is cut to 23 characters and "…".
- **`pocket.messages`:** a page of 1 to 200 messages, 50 by default. Others throw.
- **A message's `text`:** 1,000 characters at most. `clipped` tells when it was cut.

## Artifacts

[Artifacts](../../features.md)

- **Saved state of an artifact (`pocket-state-set`):** 16 KB of JSON at most for one value. A schema is 1 to 64 letters, digits, and `. _ : -`.
- **Saves:** 20 in 10 s for one person and one artifact. Past that, the save fails.
- **Saved values of a session:** 300 at most, for all its artifacts and people together.
- **Assets of a version (since 0.26.0):** 200 files at most, 5 MB for one, 20 MB for all. A name is a relative path of 200 characters at most, with no `.` or `..` segment. A group is a lowercase kebab-case slug of 64 characters at most.
- **A private asset address:** it is valid for 12 hours.
- **Design:** a tweaks manifest has 40 knobs at most; a page sends 60 messages a second at most; 2 renders run at once and each takes 90 s at most; a design system file is 16 KB at most.
- **Shares of a session:** 100 at most at once. A share lasts 1 day, 7 days, or 30 days, or until it is ended (`hours` left out).

## Tool calls

[How tool calls show](../tool-calls.md)

- **A call's label:** one line, cut to 80 characters.
- **A call's subject:** one line, cut to 160 characters.
- **The words of a summary:** `verb`, `noun`, and `by` are 60 characters at most each. A longer one gives the default display.

## Events

[Events](../events.md)

- **The data of one event:** 256 KB of JSON at most.
- **Events that a version of a module sends:** 100 each second at most, and 1 MB of them. The rest of that second's events are dropped.
- **A tab that falls behind:** Pi Pocket cuts it off when it is more than 8 MB behind and takes nothing for 30 s. It also cuts off a tab that is more than 128 MB behind. The tab then connects again, with no old events.

## Events, services, and settings

[Events, services, and settings](../services-settings.md)

- **Settings of one module:** 30 at most. A name is up to 40 characters, a label up to 80, a description up to 300, and a text value up to 4096. A choice setting has 1 to 50 choices.
- **Services:** one for each module.
- **Events:** each listener gets each event once, after the change is stored; nothing is kept for a listener added later.

## Asking people and hidden values

[People's values and the browser](../people-values.md)

- **An ask's card:** a title of 120 characters, words of 2000, up to 6 fields, and a button of 30 characters. A field's name is up to 40 characters, its label up to 80.
- **A value typed on a card:** 1 to 4096 characters.
- **A hidden value:** 4 to 4096 characters, and 2000 values hidden at once in all.
- **What streams late:** command output holds back up to the longest hidden value's length less one character, until the command ends.
- **Variables for one command:** 256 KB in all; a name is up to 128 characters. A provider has 5 seconds for one command; past that, it adds nothing.
- **A snapshot's controls as data:** 500 at most; a select's options, 50.

## Public links

[Public pages](../public-pages.md)

- **How long a link stays open:** more than 0 hours, and 720 hours (30 days) at most.
- **Uses of one link:** 1 to 1000, or any number until it closes.
- **Open links of one module:** 200 at most. Links that closed do not count.
- **A link's `data`:** 4 KB of JSON at most.
- **A posted form:** 64 KB and 50 fields at most. Its body must arrive in 15 s.
- **Forms read at the same time:** 16 in all, and 2 to one link. More get "Busy: try again in a moment".
- **A page that a handler answers with:** 1 MB at most.
- **Page handlers running at the same time:** 32 in all, and 4 for one link. More get "Busy". A handler has 30 s: after that, its reads and writes are refused, and the page says it could not be shown.
- **A link that took its last use:** kept 10 minutes, so that a page that refuses the post can give the use back. It answers nothing meanwhile.

## Commands

[Slash commands](../commands.md)

- **Commands of one module:** 50 at most.
- **A command's `description` and `args`:** 200 characters at most each.
- **The arguments that a person types:** 4000 characters at most.
- **A toast's message:** cut to 500 characters.
- **A card:** Pi Pocket keeps the last 30,000 characters.
- **Runs of one person:** 4 at the same time, in all sessions together. Pi Pocket refuses a fifth run until one ends.
- **Kept requests:** Pi Pocket keeps the request ids of the last 100 finished runs of each person in each session. The same text sent again from the same tab finds the first run only while its id is kept.

## Cleanups

[Cleanups](../cleanups.md)

- **A cleanup when the server stops:** Pi Pocket waits 3 s at most for the cleanups that return a promise.

## Gallery

[Publishing to the gallery](../publishing.md), [Gallery entry](gallery-entry.md)

- **The index:** 4 MB at most, with 2000 entries at most.
- **The index's `name`:** 80 characters at most. Its `repo`: 160 characters at most.
- **An extension's files:** 50 at most, of 512 KB each at most, and 2 MB together at most.
- **A theme's files:** 200 at most, and 16 MB together at most. `theme.json`, `colors.toml`, and `colors-light.toml`: 8 KB each at most. Its CSS: 256 KB together at most. A font or an image: 4 MB at most.
- **A theme's `name`:** 2 to 48 characters.
- **A file's name:** 200 characters at most, and four folders deep at most, with `<name>/` as the first folder. Each part of it is 100 characters at most.
- **`title`:** 60 characters at most. **`description`:** 600 characters at most.
- **`tags`:** 10 at most, of 24 characters each at most.
- **`author.name`:** 60 characters at most. **`author.github`:** 39 characters at most.
- **`version`:** 32 characters at most.
- **`minPocket`:** three numbers of 4 digits at most each, such as `0.14.0`.
- **`source.repo`:** an owner of 39 characters at most, and a repository name of 100 characters at most. **`source.path`:** 200 characters at most, and four folders deep at most.
- **Each list in `declares`:** 100 names at most. An extension, tool, hook, or section name is 64 characters at most. A route's path is 200 characters at most. A command, with its scope, is 80 characters at most.
- **`revoked`:** 50 commits at most, each with a reason of 300 characters at most.
- **Looks for revoked versions:** two times a day, while extensions from the index are installed.

## Themes

[Themes](../themes.md)

- **A theme's id (its folder's name):** 2 to 48 characters.
- **`theme.json`:** 8 KB. Its `name` and `author`: 60 characters each; its `description`: 200; its `version` and `minPocket`: 32.
- **`colors.toml` and `colors-light.toml`:** 8 KB each.
- **All of a theme's CSS:** 256 KB together.
- **A font or an image:** 4 MB.
- **Everything a theme serves:** 16 MB, and 200 files.
- **Folders:** 4 deep under the theme's own; Pi Pocket looks at 2,000 files and folders in it at most.
