# Surfaces: components and the A2UI adapter

Surfaces are the interactive cards that Pi shows with its `ui` tool: a flat layout of components, data, and buttons, stored by the server ([the design](../design/surfaces.md), [features](../features.md)). A card is data, never code. An extension can add a component to it, and the server can read A2UI messages as a card.

**Experimental, since 0.31.0.** `web.surfaceComponent` and `pocket.surfaceComponent` can change in a minor release, but never in a patch release ([API stability](policies/api-stability.md#experimental)). A module for an older server checks that `web.surfaceComponent` is a function, and a gallery entry that needs it sets `minPocket` to `0.31.0`.

## Add a component

A component has two halves, as a code fence has ([browser modules](browser-modules.md)):

1. On the server, `web.surfaceComponent` registers the type and its schemas. The server uses them to check every card that Pi shows or changes.
2. In the module's browser module, `pocket.surfaceComponent` registers the Preact component that draws it.

```typescript
// The server half, in the module's default export.
web.surfaceComponent({
    type: "x.stars.Rating", // x.<module>.<Name>
    props: obj({ label: str({ maxLength: 40 }), max: opt(int({ minimum: 1, maximum: 10 })) }),
    bind: int({ minimum: 0, maximum: 10 }),
    text: (props, data) => `${props.label}: ${String(data.rating ?? 0)} of ${props.max ?? 5}`,
});
```

```javascript
// The browser half, in its browser module.
pocket.surfaceComponent({
    type: "x.stars.Rating",
    render: ({ props, value, set, disabled }) =>
        pocket.html`<div>
            ${Array.from(
                { length: props.max ?? 5 },
                (_, at) => pocket.html`
                <button disabled=${disabled} onClick=${() => set(at + 1)}>${at < (value ?? 0) ? "★" : "☆"}</button>`,
            )}
        </div>`,
});
```

Pi then uses it like a built-in component: `{ "type": "x.stars.Rating", "label": "Quality", "bind": "/rating" }`.

- The type must start with `x.<module>.`, so it never clashes with a built-in type.
- Every key of a component but `type`, `bind`, and `who` is a prop, and the whole set must fit `props`. Props are literals.
- `bind` is one data path. Without a `bind` schema the component binds nothing. A person's change is a `set` of that path: the server checks the value against `bind` and the control's `who`, as it does for a text field.
- The renderer is the owner's installed code, never the card's. It reads props and data, binds one value, and makes no new kinds of action: `act(buttonId)` presses a Button the card already has.
- A browser without the module (it is off, or the person is invited to one session, where extension browser modules do not load) shows the string that `text(props, data)` gives. `text` goes into the transcript, exports, forks, a chat, and the push form too, so it must not throw and must not hold secrets. It is cut to 500 characters.
- A card that was shown while the module was on stays valid when the module goes off: the card shows the text, and Pi's patches to other parts still work. Pi cannot show a new card with the type until the module is on again.

## A2UI

Pi can show a card from [A2UI](https://a2ui.org) v1.0 messages: `ui` with `action: "a2ui"` and `messages`. The server builds a normal `show` or `patch` from them, and it goes through the same checks as any card (limits, types, who may act). Nothing else about A2UI is trusted: the state always lives on the server, and an action carries only the context the server works out.

| A2UI message       | What the card does                                                                    |
| ------------------ | ------------------------------------------------------------------------------------- |
| `createSurface`    | `show`: the surface's id is kept, so later messages find the card                     |
| `updateComponents` | components upserted by id (`root` is the root); the layout is replaced, so `pv` rises |
| `updateDataModel`  | `set` (or `remove`) at a path, or the whole data model when there is no path          |
| `deleteSurface`    | `close`                                                                               |

Components `Row`, `Column`, `Card`, `Text`, `Image`, `Divider`, `Button`, `TextField`, `CheckBox`, and `ChoicePicker` map to the built-in components of the same name. A `List` whose template is one `Text` becomes a `Table`. `{"path": "/x"}` and `{"@path": "/x"}` are the same, and `{"call": "fn", "args": …}` is a `@call` of the closed set of functions. A button's `event` keeps its `name` and `context`.

The adapter refuses, with the reason in the tool's result and nothing changed: `Video` and `AudioPlayer` (remote media, blocked by the app's content security policy), `Modal`, `Tabs`, `DateTimeInput`, `Slider`, `Icon`, `callAgentFunction` and every `functionCall` except `openUrl`, a catalog other than the basic one, and `sendDataModel` (the state is always on the server).
