# The security model for extension authors

This page collects, for authors, what [SECURITY.md](../../../SECURITY.md) and the guides say about extensions. It adds rules for authors. Each section names its sources. When this page and a source do not agree, the source is correct. Tell us in an issue.

## Who is who

- **The owner** runs Pi Pocket. The server runs as the owner's user on the machine.
- **Guests** are people whom the owner invited with the role guest. A guest can steer, in every session or only in the sessions of the invite.
- **Viewers** are people whom the owner invited with the role viewer. A viewer reads, reacts, and chats, in every session or only in the sessions of the invite. A viewer cannot make Pi do anything.
- **Pi** is the model. It does what people ask. It can also do what text from outside asks, if that text gets into its context (prompt injection).
- **Other modules** run in the same server, with the same rights as yours.

Owner, guest, and viewer are three separate roles. A person has one of them.

Anyone who can steer a session can make Pi call every tool that is on there. That includes guests who were invited to only that session.

## S1. A drop-in runs with the owner's rights

Sources: SECURITY.md, "Drop-in extensions"; [Drop-in or built-in](../../extensions.md#drop-in-or-built-in).

A module's server part runs inside the server. It can read `config.json` (with the owner's token), every session, Pi's sign-ins, and every file that the owner's user can read. It can start processes and open network connections. There is no sandbox. A drop-in starts off, and only the owner turns it on.

- **S1.1. Do only what the description says.**\
  _Reason:_ the description is how the owner decides to trust the module.
- **S1.2. Read only the data that the module needs. Name, in the description, each secret and each file outside the module's own data that it reads, and why.**\
  _Reason:_ the owner cannot see what the code reads unless they read all of it.
- **S1.3. Do not read the owner's token to call the app's own API.**\
  _Reason:_ then the module acts as the owner, past every check of who may act.

## S2. A browser module runs with the rights of the person whose tab loads it

Sources: SECURITY.md, "Drop-in extensions"; [Browser modules](../browser-modules.md); [Who may use it](../routes.md#who-may-use-it); architecture.md, "Extensions' browser modules".

A browser module runs in the app's own page, in the tab of each person whom its `access` lets in. It has that person's rights. In a guest's tab, it can do nothing that the guest cannot do. In the owner's tab, it can do all that the owner can do. The page's content security policy stops it from loading scripts and styles from other sites, and from requests to other sites. It does not stop all ways out: code in the page can send the page to another address, for example.

- **S2.1. Use `pocket` and the module's own routes only.** Do not call the app's own API, and do not read or change the app's page.\
  _Reason:_ nothing stops a browser module from doing more, so this rule is the only limit. The app's API is internal, too.
- **S2.2. Do not send the page, or data from it, to another site.**\
  _Reason:_ it can send what the person sees to someone else.
- **S2.3. Keep nothing secret in the browser module's folder.** Everyone whom the module is for can read each file of a web type (`.js`, `.css`, `.json`, images, fonts) in it.\
  _Reason:_ the server serves these files to each of those people.
- **S2.4. Keep keys on the server. Call other services from a route, not from the browser.**\
  _Reason:_ the content security policy blocks those calls in the browser, and a key in the browser is a key for everyone whom the module is for.

## S3. Who reaches routes and the browser module

Sources: [Routes](../routes.md); architecture.md, "A request".

| `access`            | Who                                                 |
| ------------------- | --------------------------------------------------- |
| `"owner"` (default) | The owner                                           |
| `"steer"`           | The owner, and guests who can steer every session   |
| `"view"`            | The owner, guests, and viewers who see all sessions |

People who were invited to one session never reach a module's routes or its browser module. Each route has its own `access`. To a person whom its `access` does not let in, a route is not there (404). Every call needs the `X-Pocket` header, a GET too, so a link or a form on another site cannot call a route.

- **S3.1. Give `"owner"` or `"steer"` to a route that changes something.** `access` applies to every method. A POST route with `"view"` lets viewers change something, but viewers must not make anything happen.\
  _Reason:_ a viewer must not be able to act.
- **S3.2. Give routes with paths that overlap the same `access`, or check `user.role` in the handler.**\
  _Reason:_ when a person cannot use one route, another route with a matching path can answer them (`items/:id` for `items/new`).
    - **S3.3. Check each `:name` part before you make a file path with it.** The server refuses `..`, `\`, and NUL, but nothing else.\
      _Reason:_ a path part is text from outside.

Since 0.16.0, request document commits also reject viewers and expire on disconnect or handler return. These capabilities are for the module's own documents, not core state. An ordinary catalog save does not require a source turn or spend allowance. A `web.conversationRoute` adds actual-source authorization before the handler: GET needs seeing, mutations need steering and the turn. It does not bypass ordinary route `access` or permit single-session invitees.

Bound linked starts act as the clicking person, never the source's last requester, and a receipt cannot be replayed as another person. They recheck source and target policy before initial-message admission. Source folder/model/thinking changes or conflicting target settings are rejected. The admission boundary is the start of Durable's submission transaction; later cancellation does not undo admitted work. Keep human list `conversationId` values in the UI, not a shared model transcript. `pocket.openConversation` uses normal server-authorized navigation; it grants no access. `host.modelInfo` exposes only local metadata for an exact pair, never sign-in data or a new model list.

## S4. Who runs commands

Sources: SECURITY.md, "Drop-in extensions"; [Slash commands](../commands.md#who-may-run-it).

[Who may run it](../commands.md#who-may-run-it) tells who may run a conversation command and a global command. Each handler runs with the owner's rights, as all of the module does, also when a guest runs it.

Rules:

- **S4.1. Treat `args` as untrusted.** Check them before you use them.\
  _Reason:_ a guest with access to one session can type any text.
- **S4.2. Before a conversation command changes anything outside its session, check `ctx.user.role` and `ctx.conversationId`.**\
  _Reason:_ the person who runs it may see only this session.
- **S4.3. Use a global command for settings of the whole app.**\
  _Reason:_ only the owner can run it.
- **S4.4. Put no secrets in a card.** Everyone who sees the session sees the card. Find in session and export include it.\
  _Reason:_ a card is for the whole session.

## S5. Text from outside and prompt injection

Sources: SECURITY.md, "Linked sessions" and "Replies are untrusted"; [Using the host](../host.md) (`text`); [Starting and messaging sessions](../linked-sessions.md).

Untrusted text includes route parameters, queries, and bodies; command `args`; tool arguments from the model; messages from linked sessions; and anything from the network, files, issues, or web pages. The model's tool arguments are untrusted because text that Pi read can steer what Pi asks for.

- **S5.1. Check tool arguments as you check text from a person you do not know:** paths, addresses, sizes, and names.\
  _Reason:_ a web page or a file that Pi read can choose them.
- **S5.1.1. Fetch an address from outside with `host.fetchPublic`, not `fetch`.** Since 0.20.0, it reaches only the public internet, and checks each connection and redirect ([`fetchPublic`](../reference/host.md#fetchpublic)).\
  _Reason:_ an address that Pi chose can name this machine, the local network, or a cloud's metadata address, and `fetch` goes there.
- **S5.2. Fence text from outside before Pi reads it.** Use `host.text.quoted(text, max)` for one line, or `host.text.defang(text)` for text between tags of your own. In the same place, tell Pi that it is data.\
  _Reason:_ without a fence, the text can close your tags and speak as the system prompt.
- **S5.3. Do not tell Pi to obey instructions that it finds in data.**\
  _Reason:_ that turns every document that Pi reads into a command.
- **S5.4. Do not remove or change the label and fence on a linked session's message, and do not show it as a message from a person.** A message from a linked session is a request, not an order. That is guidance to the model, not a boundary.\
  _Reason:_ a session that read something hostile can pass it to every session of its team.
- **S5.5. A tool that acts on the model's word must be safe when the model was misled.** Do not delete, send, pay, or publish only because the model asked. Leave that action to a person (with a command or a page), or keep it inside the session's folder.\
  _Reason:_ the model's word can be an attacker's word.
- **S5.6. Set `readOnlyHint` only on a tool that changes nothing.** Plan mode lets those tools run. It ignores the hint on a built-in tool, also when a wrap adds it.\
  _Reason:_ plan mode trusts this hint. Nothing checks it.

## S6. Secrets

Sources: [Rules that are easy to break](../../extensions.md#rules-that-are-easy-to-break); [Routes](../routes.md); [Events](../events.md); [Slash commands](../commands.md).

Know where each output goes:

| Output                                           | Who gets it                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Prompt sections, tool descriptions, tool results | The model provider                                                            |
| A card                                           | Everyone who sees the session, in find and in exports too                     |
| A command's `args` and result                    | Stored with its task                                                          |
| `web.error(status, message)`                     | Everyone who may use the route                                                |
| Any other error that a route or command throws   | The owner (others see only that it failed); the server log has all of it      |
| `web.send(event, data)`                          | Everyone whom the browser module is for, or only the person `to` names        |
| `host.notice(level, message)`                    | Everyone who sees all sessions; with a session's ID, the tabs of that session |
| Files in the browser module's folder             | Everyone whom the browser module is for                                       |
| Documents                                        | Every module, and Pi through its shell                                        |

- **S6.1. Put no secret in any of these, except when the people who get it may have it.**\
  _Reason:_ each of them leaves the server part of the module.
- **S6.2. Do not put a secret in an error message.**\
  _Reason:_ the server log keeps errors, and `web.error` shows its words.
- **S6.3. Do not ask people to type a password or a key as a command's `args`.**\
  _Reason:_ the task stores the arguments.

## S7. Names for stored data

Sources: [Rules that are easy to break](../../extensions.md#rules-that-are-easy-to-break).

[Rules that are easy to break](../../extensions.md#rules-that-are-easy-to-break) tells how to name your document kinds, tasks, entry kinds, and browser storage keys, and that a name stays once people used it.

- **S7.1. Obey that rule.**\
  _Reason:_ then no other module's data meets yours, and stored data with an old name is not lost.
- The name stops collisions. It does not keep data private: any module can read any document.

## S8. What Lancet Guard does not see

Sources: SECURITY.md, "Approvals", "The built-in browser", and "Drop-in extensions"; [Drop-in or built-in](../../extensions.md#drop-in-or-built-in); [Hooks](../hooks.md).

Lancet Guard is off by default. When it is on, it judges each `bash`, `write`, and `edit` call before it runs, codemode's calls included. Risky calls wait for a person to approve them. It does not see:

- what a module's own code does: its file reads, processes, and network calls;
- what an extension's tool does inside, even when the tool runs a shell command;
- routes, commands, and browser modules;
- the built-in browser.

Rules:

- **S8.1. Do not make a tool that runs a command or writes a file that the model chose.** Let Pi use `bash`, `write`, and `edit` for that.\
  _Reason:_ the guard sees those tools, and it does not see yours.
- **S8.2. Do not get around a block.** Do not answer, skip, or turn off the guard or an approval from a module.\
  _Reason:_ a guard or a person said no for a reason.
- **S8.3. When a tool must run a program, name the program and its use in the tool's description and in the module's description.**\
  _Reason:_ the owner knows then what runs with no guard.

## Report a problem

- **A problem in Pi Pocket:** read [SECURITY.md](../../../SECURITY.md). Report it in private. Do not open a public issue.
- **A problem in a gallery extension:** report it in private in the index, [TannerMidd/pi-pocket-extensions](https://github.com/TannerMidd/pi-pocket-extensions): **Security → Report a vulnerability**. Tell its author too. Do not open a public issue. The maintainers then act as [gallery-review.md](gallery-review.md#revoke-withdraw-and-remove) says.

## Before you share a module

- [ ] The description says what the module does, each secret and outside file it reads, and each host it contacts (S1.2).
- [ ] Routes that change something are `"owner"` or `"steer"` (S3.1).
- [ ] Conversation commands check `args`, the person, and the session (S4).
- [ ] Text from outside is fenced before Pi reads it (S5.2).
- [ ] `readOnlyHint` is only on tools that change nothing (S5.6).
- [ ] No secret goes to the model, to cards, to events for everyone, or to errors (S6).
- [ ] Stored data is named `x.<module>.<name>` (S7.1).
- [ ] No tool runs a command or writes a file that the model chose (S8.1).
