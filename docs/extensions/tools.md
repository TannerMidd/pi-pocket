# Tools

A tool is a function that Pi can call. Pi gets the name, the description, and the parameters of each tool with each request, and calls a tool when its task needs it.

## Define a tool

Use `defineTool` from `@earendil-works/pi-durable`, and give the tool to your extension:

```typescript
const wordCount = defineTool({
    name: "my_word_count",
    description: "Count the words in a text.",
    parameters: Type.Object({ text: Type.String({ description: "The text to count" }) }),
    replay: "safe",
    execute: async (args) => ({
        content: [{ type: "text" as const, text: `${countWords(args.text)} words` }],
    }),
});

export default function createMyWords() {
    return defineExtension({ name: "my-words", tools: [wordCount] });
}
```

- `name` must be different from the name of each other tool ([Names](reference/names.md)). Use a prefix of your own.
- `description` and `parameters` go to the model with each request. Keep them short and exact.
- `parameters` is a TypeBox schema (`Type` from `@earendil-works/pi-ai`). Pi Durable checks the arguments against it before `execute` runs.
- `execute(args, api, context)` does the work.

## Return a result

- Return `{ content: [{ type: "text", text }] }`. The model reads the text.
- To give the model an error, throw an `Error`. The model gets its message as an error result.
- `api.output(text)` streams output while the tool runs. When `execute` returns no `content`, this output becomes the result.

## Restarts and replays

A restart of the server can stop a tool call while it runs. Then the call is replayed: it runs again, or the model gets "interrupted".

- Set `replay: "safe"` only when it does no harm to run the call two times. For example, the tool only reads, or it does an action with a key, so that a second run finds the result of the first.
- Without `replay: "safe"`, the tool is unsafe to replay. A call that a restart stops comes back to the model as interrupted, and does not run again. This is the default.
- `api.memo(name, context)` reads a value that is kept with this call. `api.memo(name, value, context)` stores it. A replay after a restart finds the value. Use a memo for work that must not occur two times, for example a message that you send.
- `api.conversationId`, `api.taskId`, and `api.callId` identify the call. The key `${api.taskId}:${api.callId}` stays the same when the call runs again.

## Plan mode

`annotations: { readOnlyHint: true }`, as in Pi's tool definitions, says that the tool does not change files or other state. Plan mode lets such a tool run. Pi Pocket does not check this: it is your promise. A tool that only changes the conversation, such as context management, can also use it. Plan mode ignores the hint on a built-in tool, so a wrap cannot let a built-in tool run in plan mode.

Pi Durable's type for `defineTool` does not have `annotations` yet. TypeScript reports it as an unknown property, but the module loads and works, because Node does not check types. To keep the type checker quiet, add it after `defineTool`:

```typescript
const lookup = Object.assign(defineTool({ … }), { annotations: { readOnlyHint: true } });
```

## Files, documents, and the session

- `api.env` gives the files and the shell of the session's folder. `(await api.agent(context)).cwd` is the folder.
- `api.snapshot(Doc, api.conversationId, context)` reads a document, for example one of Pi Pocket's in `src/server/docs.ts`.

## See also

- [Your first extension](first-extension.md) makes a tool, step by step.
- [examples/clock.ts](../examples/clock.ts) is a tool that reads a document of its own.
- [How tool calls show](tool-calls.md) tells how to show your tool's calls in words.
- Pi Durable's README (`node_modules/@earendil-works/pi-durable/README.md`) tells all about tools.
