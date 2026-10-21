# Hooks

A hook runs before or after Pi's tool calls and answers. It can stop a tool call, or send Pi on with another message.

## Define a hook

Use `hook` from `@earendil-works/pi-durable`. This hook stops each bash call that force-pushes with git:

```typescript
const noForcePush = hook(ToolTask, {
    beforeTool: (call) => {
        const command = (call.arguments as { command?: unknown }).command;

        return call.name === "bash" && typeof command === "string" && FORCE_PUSH.test(command)
            ? { block: "Force-pushing is turned off here." }
            : undefined;
    },
});

export default function createNoForcePush() {
    return defineExtension({ name: "my-no-force-push", hooks: [noForcePush] });
}
```

There are two kinds of hooks:

- `hook(ToolTask, { beforeTool, afterTool })` runs around tool calls.
- `hook(GenerationTask, { beforeRequest, afterResponse, onYield, afterTools })` runs around the model's requests and answers.

## Stop a tool call

`beforeTool(call, api, context)` gets `call.name` and `call.arguments` before the call runs.

- To stop the call, return `{ block: "the reason" }`. The model gets the reason as an error.
- To let the call run, return `undefined`.

The calls of codemode scripts also go through `beforeTool`.

## Send Pi on

`onYield(answer, api, context)` runs after Pi's last answer. To send Pi on with another message, return `{ continue: "the message" }`. Done when does this ([goals.ts](../../src/server/extensions/goals.ts)).

## Restarts

A hook can run again after a restart. Keep work that must occur one time in `api.memo`. Lancet Guard does this with an approval ([guard.ts](../../src/server/extensions/guard.ts)).

A hook that guards something returns `{ block: … }` to stop a call, with the reason Pi gets. A `beforeTool` hook that throws an error also stops the call (Pi gets `Tool call blocked:` and the error's words), but other hooks that throw do not stop anything: Pi Durable reports the error and goes on. Inside a codemode script, an `afterTool` hook that throws fails that one call of the script.

## See also

- [examples/no-force-push.ts](../examples/no-force-push.ts) is the hook above, with a prompt section that tells Pi about it.
- Do not get around a block of another hook, or of a person: see [Rules that are easy to break](../extensions.md#rules-that-are-easy-to-break).
