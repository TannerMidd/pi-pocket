# Glossary

One word for each thing. The extension docs and the policies use these words. When the code uses another word, the entry says so.

## People

### owner

The person who runs Pi Pocket on their machine. The owner can do all things. Only the owner turns modules on and off. Code: the role `"owner"`.

### guest

A person whom the owner invited, who can steer sessions. A guest can see all sessions, or only the sessions to which they were invited. Code: the role `"guest"`.

### viewer

A person who can see sessions, but cannot steer them. Code: the role `"viewer"`.

### person

Anyone who signs in to Pi Pocket: the owner, a guest, or a viewer. Code: `user`, as in `request.user`. Say "person" and "people", not "user".

### steer

To send messages to Pi in a session, and to stop Pi there. The owner and guests can steer. Code: the access `"steer"`.

### the turn

When people take turns in a session, the person who has the turn is the only person who can send messages to Pi. Other pages say "drive" for this.

### the person Pi works for

The person whose message started Pi's current work in a session. Pi acts for this person, with this person's rights. Code: `host.requesterOf`. To know this person's role, use `host.roleOf` with the id (since 0.27.0, experimental).

## Sessions

### session

One conversation with Pi, with its folder, its history, and its settings. Code: a session's id is a `conversationId`. Say "session", not "conversation" or "chat".

### folder

The folder where Pi works in a session. Code: `cwd`.

### transcript

The messages and tool calls of a session, as the app shows them.

### card

Plain text that a command puts in a session's transcript, for all the people who see the session. Pi does not get it.

### linked session

A session that another session started with `host.linkedSessions`. It is an ordinary session, and it shows under the session that started it.

### source

The session that starts a linked session, or that sends it a message.

### address

The name that a session uses for one of its linked sessions. It is not the session's id. Each session has its own addresses.

### team

A session and all the sessions linked to it.

### subagent

A session that Pi starts for a part of its work. The subagent reports to the session that started it.

### spend limit

A limit on what Pi can spend: for a session, or for a person. Code: `host.heldBack` says when one stops work.

### budget

The spend limit of a session. A team uses the budget of the session that started it.

### plan mode

A mode of a session where Pi makes a plan and does not change files. Only tools that only read can run.

## Modules

### module

One `.ts` file that default-exports a setup function. Menu → Extensions lists modules. The browser module is a different file.

### extension

What a module returns: a name, with tools, prompt sections, hooks, and tasks. Pi Durable's `defineExtension` makes it. In the app's menus, "extension" means a module.

### drop-in

A module in the drop-in folder. It is the owner's. It stays when Pi Pocket updates, and it is off until the owner turns it on.

### built-in

A module in `src/server/extensions/`. It is part of Pi Pocket.

### data folder

Pi Pocket's folder for its data: `~/.pi-pocket` by default. Code: `host.dataDir`.

### drop-in folder

The folder for drop-ins: `extensions/` in the data folder.

### load

To import a module and set it up. To **reload** is to load it again after an edit.

### version

What one load of a module made: its extensions, routes, browser module, and commands. An edit makes a new version, and the old version goes. Do not mix this up with the API version.

### turn on, turn off

What the owner does to a module in Menu → Extensions. A module that is off does not load.

### host

The first argument of a module's default export. See [host](host.md).

### web

The second argument of a module's default export. See [web](web.md).

### pocket

The argument of a browser module's default export. See [pocket](pocket.md).

### tool

A function that Pi can call. A module defines it with `defineTool`.

### tool call

One call of a tool by Pi, with its arguments and its result. See [How tool calls show](../tool-calls.md).

### prompt section

A part of Pi's system prompt that a module adds.

### hook

A function that checks or changes Pi's tool calls and answers.

### route

An address on the server that a module adds, under `/api/x/<module>/`. A **handler** answers its requests.

### browser module

A `.js` file, or a folder with an `index.js`, that the app loads in the tabs of the people it is for. It gets `pocket`.

### event

Data that a module sends from the server to its browser module, with `web.send`.

### command

A command that a person types in the message box, as `/name`. It runs on the server, and it does not ask Pi. Also called a slash command.

### cleanup

A function that runs when a version of a module goes. Code: `onDispose`.

## The app

### tab

One open copy of the app in a browser.

### rail

The column of buttons at the edge of the app: in the sidebar, in the drawer, and on a phone's home screen.

### menu

The app's menu, from **⋯** in the top bar. A module adds **menu rows** to its App group.

### launcher

The box that finds actions and sessions as a person types: Ctrl+K, or ⌘+K. A module adds **launcher actions** to it.

### page

A view that a module adds in the place of the session.

### sheet

A panel over the app, such as Menu → Extensions. A module can add sheets.

### notice

A short message at the edge of the app. Code: `host.notice`, `pocket.notify`, and the command result `"toast"`.

### piece

One of the app's components that `pocket` gives: `Icon`, `Loader`, `Spinner`, `Markdown`, and `Switch`.

### spec

The object that you give to `pocket.rail`, `pocket.page`, and the others. Its types are `RailSpec`, `PageSpec`, and so on.

### peek tiles

Small cards beside a session that show the live work of other sessions.

### safe mode

A tab opened with `?noext=1` at the end of the app's address loads no browser modules.

## Pi Durable

### Pi Durable

The library that runs Pi's sessions as durable work. Pi Pocket is built on it. Extensions are Pi Durable's.

### task

Durable work that Pi Durable keeps across restarts.

### document

Durable data that a module defines with `defineDoc`. Its **kind** is its name, such as `x.clock.settings`.

### memo

A value that Pi Durable keeps with a tool call. When the call runs again after a restart, it finds the value.

### commit

A change to documents that is done all together, or not at all.

### replay

To run a tool call again after a restart cut it off. Only a tool with `replay: "safe"` runs again.

## The gallery

### gallery

The list of drop-ins that other people wrote: Menu → Extensions → **Find extensions**.

### index

The JSON file that the gallery reads. See [Gallery entry](gallery-entry.md).

### entry

One extension in the index: its files at a pinned commit, and what it declares.

### declares

What an entry says that its module installs.

### revoked

A commit of an extension that people must not use.

## Versions

### API version

The version of the extension API: `web.api` and `pocket.version`. See [API versions](api-versions.md).

### Since

The first release of Pi Pocket that has a member.

### release

A version of Pi Pocket, such as 0.14.0. It is not the API version. "Since 0.14.0" names the first release that has a member.

### Stable

A member that changes only as [API stability](../policies/api-stability.md) says.

### Experimental

A member that can change, or go, in any minor release, but never in a patch release.

### Internal

A member of the host that only Pi Pocket's built-in modules use. It is not in the types file.

## Other names

### Pi

The agent: the AI that works in sessions.

### Pi Pocket

This app, which runs Pi in a browser, for one or more people.

### PiP

The owner's assistant in Pi Pocket, which runs the owner's other sessions.

### Lancet Guard

A built-in module that asks a person before Pi runs a tool call that could be risky.

### approval

A person's answer to a tool call that Lancet Guard holds: allow or deny.

### provider

A company or service that runs models, such as Anthropic or OpenAI. A person signs in to a provider.

## Words that these docs do not use

| Do not use                    | Use                                     |
| ----------------------------- | --------------------------------------- |
| enable, disable               | turn on, turn off                       |
| plugin, add-on                | extension, or module                    |
| chat, thread (for a session)  | session                                 |
| client (for a browser module) | browser module                          |
| toast                         | notice                                  |
| user (for a person)           | person, or the owner, a guest, a viewer |
