# How tool calls show

A browser module can say how the calls of its own tools show in transcripts and peek tiles. Without this, a call shows as the name of the tool, and its arguments as JSON.

## Describe a tool's calls

Call `pocket.toolCall({ tool, icon or iconPath, label, subject, summary })` in the browser module:

```javascript
pocket.toolCall({
    tool: "my_word_count",
    icon: "search",
    label: () => "count words",
    subject: (args) => `${args.text.length} characters`,
    summary: () => ({ verb: "counted", noun: "text" }),
});
```

- `tool` is the exact name by which Pi runs the tool.
- `label(args)` gives the words of the call's line, for example `"start session"`. It is required.
- `subject(args)` gives what the call acts on. It is optional, as `summary` and the icon are.
- `summary(args)` tells how a group of calls counts this call, as `{ verb, noun, by }`. See below.
- `icon` or `iconPath` is its icon in peek tiles, as for a rail button ([Browser modules](browser-modules.md)).

It returns `{ remove() }`. It goes with the version of the module that added it.

## Groups of calls

When Pi makes many calls, the app counts them in a group's summary, for example "messaged 2 sessions".

- Calls count by the value of their `by` argument. `{ verb: "messaged", noun: "session", by: "to" }` makes "messaged 2 sessions" for calls to two addresses, for any number of calls.
- A kind without `noun` is only its verb, for example "checked linked sessions".

## Rules

- Each function gets a copy of the arguments.
- The label and the subject are each one line, cut to a length ([limits](reference/limits.md#tool-calls)).
- `verb`, `noun`, and `by` have a length limit too. A longer one gives the default display.
- What it gives shows as one line of text, never as HTML.
- When a function throws, or gives something that is not text (or not such a kind), the call shows the default way. The error is in the browser's console.
- `tool` must be a tool that the module's own extensions install. The server lists them with the browser module. Pi Pocket refuses any other name, so no module changes how the calls of another module show.
- A server older than that list does nothing with `toolCall`, and the calls show the default way.
