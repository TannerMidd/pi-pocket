# Starting an ordinary session

An extension can start an ordinary session, the same kind a person gets from New session. Use `host.sessions.start`. Its shape is in [the host reference](reference/host.md).

**Experimental, since 0.28.0.** It can change in a minor release, but never in a patch release ([API stability](policies/api-stability.md#experimental)). A module for an older server checks that `host.sessions` is there, and a gallery entry that needs it sets `minPocket` to `0.28.0`.

## What the call does

`start(source, { title?, cwd?, model?, thinking?, message? }, key)` makes a session and returns `{ session }`, its id.

- The session is top-level. It has no `linkedFrom`, and it shows as its own row in the session list. It can itself start linked sessions.
- It works in `cwd` when supplied, otherwise the server's default folder. `cwd` uses the same path rules as the folder picker, including `~`. A missing path or a file is rejected before a session is created.
- Without `title`, the title is the folder's name, as for New session.
- `model` is `provider/modelId`. It must be a model known here, and its provider must be usable now. Without `model`, the session starts on the model a new session would get. The owner's list of models for subagents does not apply: this is an ordinary session, not a subagent and not a linked session.
- `thinking` is any level. Pi Pocket lowers it to the highest level the model has, or uses the model's lowest when it has none that low, as it does for a linked session. This is the named model, or the default model when `model` is not given. Without `thinking`, the session keeps the thinking level it started with.
- With `message`, that text is the session's first message. It is an ordinary message from the person Pi works for in `source`, not a message sent for them.

## Who it acts for

The call acts for the person Pi works for in `source`. That person must be able to see the source, steer, and start sessions.

Pi Pocket refuses the call, and makes nothing, when:

- nobody is the person Pi works for in the source, or that person cannot see the source;
- the source is a PiP conversation;
- that person was invited to one session;
- the source is past its spend limit;
- `model` is unknown, or its provider cannot be used now;
- `cwd` does not name an existing folder;
- `cwd` is a remote workspace, and that person is not the owner;
- `message` is blank, or the session gets no model to send it to (no `model` and no default model).

## Once

Give the call a `key` that stays the same when it runs again, such as `${api.taskId}:${api.callId}`. A second call with the same `key` from the same source returns the session the first call made. It acts for the person the first call acted for, also when someone else wrote in the source since then. It does not check the model, the folder, or the spend limit again: a source that has reached its spend limit since then still gets its session back. When `message` is given, it is sent once: the repeat finds the message the first call sent.

The keys of this call are apart from those of `linkedSessions.start`. The same `key` given to both starts two sessions, one of each kind.
