# Prompt sections

A prompt section is a part of Pi's system prompt that your module writes. Use one for a rule that Pi must know in each request, or for a rule that depends on the session.

## Define a section

Use `section` from `@earendil-works/pi-durable`, and give the section to your extension:

```typescript
const rule = section(
    "no_force_push",
    () => "Do not force-push with git. Push normally, or ask the person to.",
);

export default function createNoForcePush() {
    return defineExtension({ name: "my-no-force-push", sections: [rule] });
}
```

- `section(name, render, { tag })`. `render(input, context)` returns the text of the section. To leave the section out, return `undefined`.
- Pi Pocket puts the text between `<name>` and `</name>`. With `{ tag: false }`, it puts the text without the tags.

## Keep the text the same

Sections render before each request. Pi Pocket sends again only the sections that changed, and the model provider can then use its cache.

- Return the same text while nothing changed.
- Put the date in a section, not the time.
- Do not put counters in a section.

## A section for one session

`input.conversationId` is the session. `input.read.snapshot(Doc, input.conversationId, context)` reads a document of that session. Use them to write a section that depends on the session.

The text of a section goes to the model provider. Do not put secrets in it.

## See also

- [examples/no-force-push.ts](../examples/no-force-push.ts) has a section and a hook that work together.
