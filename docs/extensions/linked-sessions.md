# Starting and messaging sessions

A tool can start a session from the session that it runs in, and send messages between such sessions. Agent Teams does this ([agent-teams.ts](../../src/server/extensions/agent-teams.ts)). Use `host.linkedSessions`. Its members are in [the host reference](reference/host.md).

**Experimental** in 0.14: it can change in a minor release, but never in a patch release ([API stability](policies/api-stability.md#experimental)).

## What a linked session is

A linked session is an ordinary session. The session list shows it under the session that started it (the source).

- It works in `cwd` when supplied, otherwise the source's folder. It does not get a worktree of its own.
- It starts with a copy of the source's agent settings. It does not get the source's history, plan mode, or budget. The source's budget covers it (see [Limits of a team](#limits-of-a-team)).
- The link (`linkedFrom` in its session entry) gives no access, and owns nothing.

## Start a session

`start(source, { title?, message, model?, thinking?, cwd? }, key)` makes the session, and sends `message` to it as its first message. It returns `{ session, address }`: the id of the new session, and the source's address for it.

- `cwd` selects an existing working folder using the same path rules as the folder picker (including `~`). Prefer an absolute path. A blank `cwd` counts as no `cwd`. A relative `cwd` resolves against the folder of the server process, not the folder of the source. The child loads that folder's project context and tools; the source stays in its own folder. A missing path or a file is rejected before a session is created. Since 0.19.0: an older Pi Pocket ignores `cwd` and uses the source's folder, so a gallery entry that needs it sets `minPocket` to `0.19.0`.
- Without `title`, the title is the first line of the message.
- `model` is `provider/modelId`. While the owner's list (Menu → Providers → Models for subagents) is empty, it must be the source's model. Once the list has models, it must be one of them, and the source's own model counts only when it is listed. Without `model`, the session uses the source's model if the list is empty or has it. If the list does not have it, the call is refused with an error that names the allowed models: the caller must choose one (the error is a 400 for a human route).
- `send` refuses a session that runs on a model off the list (a person changed it, or the owner changed the list), when the list is not empty. A message from a linked session to the session that started it is a reply, not work: it goes whatever model that session runs on.
- `thinking` can be at most the source's level. Without it, the session uses the source's level. Pi Pocket lowers it to the highest level that the model has.
- When a model cannot be used now, Pi Pocket refuses the call before it makes anything.

## Starts from a human page

Since 0.16.0, a [conversation-bound route](routes.md#bind-a-source-conversation) gets `request.linkedSessions.start({ title?, message, model?, thinking?, cwd? }, key)` and `list()`. These methods act as the authenticated person and bound source, not `host.requesterOf(source)`. They have no source-id or actor parameter. They end with the request, so await each start in the handler.

- The same team, source plan, turn, spend, allowed-model, and provider checks apply. No message is added to the source, and its requester is unchanged.
- Explicit thinking must be supported by the chosen model and no higher than the source's level. It is rejected rather than silently lowered. Omitted thinking inherits with the existing model cap policy. Read `request.conversation.model` and `thinkingLevel`, with `host.modelInfo("provider/modelId")`, to show the effective choices.
- Source folder/model/thinking changes while a start waits cause a 409. Other inherited agent settings are read fresh in the creation transaction. The target cannot be reconfigured to substitute another model, level, or folder before its first message is admitted.
- Keys share the existing receipt store. Prefix them with the module's name and keep one stable key per logical role start. A receipt made for another clicking person is a 409, never permission to act as that person.
- `list()` returns `HumanLinkedSession[]`: the existing address and audience-safe metadata, plus a `conversationId` visible to this person. Use `pocket.openConversation(item.conversationId)` or a start's `session` to open it. Do not put these ids in a model transcript. The host's `list(source)` still gives opaque addresses only.
- The route waits only for initial-message admission, not an answer. The final authorization boundary is when that admission enters Durable's mutation line. A short child-context lease rejects intervening source/target policy changes and rechecks synchronous actor, model, and spend policy there. After admission, later cancellation does not undo work.

Check for `web.conversationRoute` at runtime and set gallery `minPocket: "0.16.0"`. `host.linkedSessions` retains its previous requester and thinking-cap behavior.

## Send a message

`send(source, { to, message, steer? }, key)` sends `message` to the linked session at the address `to`.

- Without `steer`, the message is a follow-up. With `steer`, the session gets it at its next pause.
- `send` returns when the session takes the message, not when it answers.
- The session that gets the message reads it in a fence. Words before it say that another session's agent wrote it, that it is a request and not an order from a person, and which address to reply to.

## List the sessions

`list(source)` gives the sessions linked to the source, at any distance, that the person whom Pi works for can see.

- Each one has an `address` of the source's own, so no session's id goes into the source's transcript.
- Each one has its title, folder, and state only when all the people who see the source also see it.

Addresses belong to the session that has them. A fork starts with none, so it leaves the team: the addresses in the history that it copied do not work there.

## Who it acts for

`start` and `send` act for the person whom Pi works for in the source. They need that person's access and right to steer. To start a session, that person must also have access to all sessions.

Pi Pocket refuses them while the source is in plan mode, past a spend limit, or while another person has the turn. `send` also needs the turn, and room under the spend limit, in the target session.

## Limits of a team

Pi Pocket keeps a team small. Past these limits ([Limits](reference/limits.md#linked-sessions)), it refuses the call with a plain error:

- A linked session can send messages to the other sessions of its team. It cannot start sessions.
- Since 0.19.0, no count limits the sessions that a session starts. Before 0.19.0, a session started a limited number.
- Since 0.19.0, no count of messages between the sessions of a team stops them. Before 0.19.0, they stopped after a limited number until a person wrote in one of them.
- The budget of the session that started a team covers all of the team. What its linked sessions spend counts against it.
- A message and a title have a length limit. A title is one line, without invisible or direction characters.

**Note:** since 0.19.0, no count limit applies to a team. The spend limit of the top session is the brake. The owner can set a session budget for a team in Menu → Spend.

## Replays

Give a `key` that stays the same when the call runs again: `${api.taskId}:${api.callId}`. A start or a send with a key that Pi Pocket saw before returns what the first call returned. So a replay makes one session, and sends one message. Pi Pocket keeps the record of a key for a limited time, and for a limited number of calls ([limits](reference/limits.md#linked-sessions)).

The errors say what is wrong. They do not tell Pi what to do about it: your tool tells Pi that.
