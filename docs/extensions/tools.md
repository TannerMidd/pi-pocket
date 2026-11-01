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
        output: [{ type: "text" as const, text: `${countWords(args.text)} words` }],
    }),
});

// It returns `output`, so it needs version 2 of the extension API: Pi Pocket 0.18 says so, and does not load it.
export const pocketApi = 2;

export default function createMyWords() {
    return defineExtension({ name: "my-words", tools: [wordCount] });
}
```

- `name` must be different from the name of each other tool ([Names](reference/names.md)). Use a prefix of your own.
- `description` and `parameters` go to the model with each request. Keep them short and exact.
- `deferred: true` keeps a tool out of the requests until Pi loads it with `tool_search`, which only the Tool search module offers: while it is off, Pi cannot load the tool. Use it for a tool that few conversations need, or for a large set of tools. `test/prompt-budget.test.ts` keeps Pi Pocket's own prompt and tools at 16,000 characters in a plain session.
- `parameters` is a TypeBox schema (`Type` from `@earendil-works/pi-ai`). Pi Durable checks the arguments against it before `execute` runs.
- `execute(args, api, context)` does the work.

## Return a result

- Return `{ output: [{ type: "text", text }] }`. The model reads the text.
- Pi Durable 1.2 renamed the result field `content` to `output`. Pi Pocket still reads `content` from what `execute` of a drop-in's tool returns, but new code must use `output`. A hook (`afterTool`) or a wrap (`wrapTool`) that reads or returns a result must use `output` too. A module that returns `output` exports `pocketApi = 2` ([API versions](reference/api-versions.md)): Pi Pocket 0.18 then refuses it with a clear message.
- To give the model an error, throw an `Error`. The model gets its message as an error result.
- `api.output(text)` streams output while the tool runs. When `execute` returns no `output`, this output becomes the result.

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

## Call a model

A tool can ask a model itself, for example to choose each step of a browser run. Use the session's model, through Pi Durable:

```typescript
if (host.heldBack(api.conversationId) !== undefined) {
    throw new Error("A spend limit holds this session back.");
}

const chosen = (await api.agent(context)).model;
const model = chosen && api.models.getModel(chosen.provider, chosen.modelId);

if (model === undefined) {
    throw new Error("This session has no model.");
}

const reply = await api.models.completeSimple(model, {
    messages: [
        { role: "user", content: [{ type: "text", text: question }], timestamp: Date.now() },
    ],
});
```

- The provider's request limits apply, as to Pi's own requests.
- The session's spend does not count this reply by itself. Add `reply.usage` to Pi Durable's `UsageDoc` for the session, in a `commit`, as Pi Pocket's titles do ([titles.ts](../../src/server/titles.ts)). Check `host.heldBack` before each call, so a spend limit stops your tool too.
- Say in your tool's result what the model decided, so Pi and the people can follow it.

## See also

- [Your first extension](first-extension.md) makes a tool, step by step.
- [examples/clock.ts](../examples/clock.ts) is a tool that reads a document of its own.
- [How tool calls show](tool-calls.md) tells how to show your tool's calls in words.
- Pi Durable's README (`node_modules/@earendil-works/pi-durable/README.md`) tells all about tools.
