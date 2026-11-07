# Files that come with Pi's sessions

An extension of Pi in the terminal can keep a file of its own beside each Pi session file. An example is the state of a context manager. When the owner continues that session in Pi Pocket, the file can come along. Its Pi Pocket extension registers a companion with [`host.registerPiSessionCompanion`](reference/host.md#registerpisessioncompanion).

The interface is experimental since 0.28.0. It can change in a minor release. A module must check that `host.registerPiSessionCompanion` exists when it supports older servers.

```ts
if (typeof host.registerPiSessionCompanion === "function") {
    web.onDispose(
        host.registerPiSessionCompanion({
            suffix: ".notes.md",
            label: "Notes",
            continued({ conversationId, companion, entries }) {
                // Read `companion`, keep what you need in your own folder.
                return "Brought Pi's notes along.";
            },
        }),
    );
}
```

## What Pi Pocket does

1. The preview of one of Pi's sessions looks for `<session file><suffix>` in the same folder for each companion. It lists the label of each file that it finds under **Includes**. Pi Pocket looks only beside a file that Pi lists.
2. **Continue in Pocket** writes the copy of the session in one commit. Then it calls `continued` of each companion that it found, in turn. The person sees the session only after that.
3. A string that `continued` returns is shown to the person. An error that it throws, or a time-out after one minute, is shown as `<label>: <message>`. The session continues in both cases.

Pi Pocket never reads, copies, or changes the companion file. The extension reads it and keeps what it needs in its own place, for example in `host.dataDir`. The person can continue the same Pi session again later. Then `continued` runs again for the new session.

## Matching Pi's entries to the copy

State that names messages by Pi's entry ids must name them by something that the extension finds in Pi Pocket. `entries` gives the new session's context as its first request sends it, in order. Each item is `{ from?: string; id: EntryId; message: Message }`:

- `message` is the message as the model gets it.
- `id` is the entry in Pi Pocket that gives the message.
- `from` is the id of the entry of Pi's that the entry copies. One of Pi's entries can give more than one message. A message that Pi Pocket made has no `from`, for example the result for a tool call that never finished.

Messages that a Pi compaction summarized are not in `entries`. They are in the session for people to read, but the model does not get them.

[examples/pi-notes.ts](../examples/pi-notes.ts) is a complete module. It carries `<session>.jsonl.notes.md` into the session, and a prompt section shows the notes to Pi.
