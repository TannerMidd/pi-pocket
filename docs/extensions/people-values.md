# People's values and the browser

Some values must not go through Pi: a password, an API key, a one-time code. Whatever Pi reads goes to the model provider and into the transcript, where everyone in the session can read it. Since 0.22.0, four members of the host let an extension use such values without Pi seeing them, and drive the session's browser page. They are experimental: they can change in a minor release ([API versions](reference/api-versions.md)).

| Member                                            | What it does                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`host.ask`](reference/host.md#ask)               | Asks the person Pi works for, on a card, and gives their answer to the extension alone.  |
| [`host.hide`](reference/host.md#hide)             | Takes a value out of command output, every tool's result, and people's messages to Pi.   |
| [`host.commandEnv`](reference/host.md#commandenv) | Adds environment variables to a command, so a value reaches it as `$NAME`.               |
| [`host.browser`](reference/host.md#browser)       | The session's browser page: read its controls as data, click, type, and fill in a value. |

A module that uses them checks that they are there, and adds nothing on an older server:

```typescript
if (typeof host.ask !== "function") {
    return;
}
```

## Ask the person

`host.ask` shows a card in the session, as an approval does: a title, some words, fields, and a button. Only the person Pi works for can send it, and the app notifies them. Anyone who can steer can decline it.

```typescript
const answer = await host.ask(
    {
        conversationId: api.conversationId,
        id: `${api.taskId}:${api.callId}`,
        taskId: api.taskId,
        callId: api.callId,
        title: `Sign in to ${site}`,
        fields: [
            { name: "user", label: "Username", autocomplete: "username" },
            { name: "password", label: "Password", secret: true, autocomplete: "current-password" },
        ],
        submit: "Fill in",
    },
    context,
);

if (!answer.answered) {
    throw new Error(`${answer.by} declined to sign in.`);
}
```

- The values are in `answer.values`, by field name. They are not in the transcript, nor sent to the other people in the session. A plain Allow, as from a notification, is refused: each field must be filled in.
- With no fields, the card is a question that the button answers: "Solve the CAPTCHA in the browser, then tap Done".
- Since 0.27.0, a field can have `choices`: 2 to 4 answers that show as buttons, with `multiple` for one or more and `other` for an answer the person types. Its value is the label chosen (labels one per line with `multiple`). Pi's own `ask` tool uses them ([the reference](reference/host.md#askfield)).
- **Do not keep the values** in `api.memo` or a document: a restart would find them there. A tool that asks is not safe to replay (the default), so a call that a restart cut off comes back as interrupted, and Pi asks again.
- Tell Pi what happened, never the values: "Signed in as the person".

## Hide a value

`host.hide` keeps a value out of what Pi and people read, from now until you call the function that it returns. It becomes `[label]`:

- in command output as it streams: bash's live output and its result, a `!` command's card, and Done when's checks. A value split across two chunks of output is held back until it can be told apart;
- in every tool's result, before it is stored: what the model reads, what programs read, and its details;
- in people's messages to Pi: a value that someone pastes into a message, or into an edit they send again, is replaced before it is stored or sent to the model. The session's title, made from the first message, does not have it either.

```typescript
const unhide = host.hide({ value: token, label: "secret GITHUB_TOKEN" });

web.onDispose(unhide);
```

Hide a value as soon as you have it, before any tool can give it back. A value is 4 characters at least: a shorter one would turn up in ordinary output by chance. `conversationId` hides it in one session only, and in that session's subagents.

A file that a message brings along (`@notes.txt`) is hidden too. A `!` command that holds a hidden value is refused: it would be stored and shown as typed, so give the value to commands with `host.commandEnv` instead.

Hiding replaces a value where it shows, so it tells whether a guess is right: anyone who can write in the session can send a guess, and see `[label]` if it matches. Hide only values that cannot be guessed, such as a password, a key, or a token. Do not count on it for a short code, such as a PIN, in a session that others share.

Hiding finds the value as it is. It does not find it encoded, reversed, or cut up by a command, nor in a file that a command writes. Hide each form that you expect, such as its base64, as a value of its own. This keeps values out of transcripts by accident and by default: it is not a boundary against a command, or a model, that leaks a value on purpose. Say so to the people who use your extension.

## Give a command a value

`host.commandEnv` adds environment variables to commands that run in sessions. Before each command, your provider gets the command, its folder, and its session:

```typescript
web.onDispose(
    host.commandEnv(({ command, conversationId }) => {
        if (typeof command !== "string" || !command.includes("$GITHUB_TOKEN")) {
            return undefined;
        }

        // Only for the owner's work: a guest's message must not use the owner's key.
        const by = host.requesterOf(conversationId as ConversationId);

        return by === ownerId ? { GITHUB_TOKEN: token } : undefined;
    }),
);
```

Pi then writes `curl -H "Authorization: Bearer $GITHUB_TOKEN" …`, and the shell puts the value in. The stored call keeps `$GITHUB_TOKEN`, not the value. Hide the value too: a command can print it.

A provider that throws, or takes more than 5 seconds, adds nothing, the command still runs, and the server's log says why. Give only the variables that the command names, and decide who may use each value: the provider runs for every command in every session, also for work that a guest's message started.

## Drive the browser page

`host.browser(conversationId, { open: true })` gives the session's browser page: the one that Pi's `browser` tool and the people in the session use. It is `undefined` while the Browser module is off.

```typescript
const page = await host.browser(api.conversationId, { open: true });

if (page === undefined) {
    return "Turn on the Browser module first.";
}

const { controls } = await page.snapshot();
const password = controls.find((control) => control.kind === "password");
const user = controls.find((control) => control.kind === "email" || control.name.match(/user/i));

if (password === undefined || user === undefined) {
    return "This page has no sign-in form.";
}

const { user: name = "", password: secret = "" } = answer.values;

// Hide first: if hiding refuses a value (shorter than 4 characters, say), nothing went into the page.
web.onDispose(
    host.hide({
        value: secret,
        label: "password",
        conversationId: Number(api.conversationId),
    }),
);
await page.fill({ ref: user.ref }, name);
await page.fill({ ref: password.ref }, secret);
await page.press("Enter");
```

- `snapshot()` gives the page as Pi reads it, and its controls as data: each one's ref, role, name, kind, and value. A password field's value is `••••` when it holds one, never its value.
- `snapshot()` also gives `scroll: { y, viewport, height }` in CSS pixels (since 0.27.0, experimental): the top of the viewport, its height, and the page's height. There is more below when `y + viewport < height`, and more above when `y > 0`.
- `fill` puts a person's value into a field, and returns only what the field is. It fills only a field named by a ref, a selector, or a label, never a point, and fills nothing when something covers the field or the focus does not reach it, so a value never lands in another field. `type` types as Pi types.
- A value filled into a field that is not a password field shows in that field: in screenshots, in the Browser panel that the people in the session watch, and in the snapshot's `value`. Fill secrets only into password fields.
- `inspect` says what a target is, and whether it is a password field. A `beforeTool` hook can use it to refuse Pi's own `type` into a password field ([Hooks](hooks.md)), as below.
- The handle runs no script in the page. Pi's `browser` tool still can (`evaluate`), and so can read a field's value: hide the value too.

### Keep Pi from typing a password

Pi's `browser` tool takes an `action`, and names its target with `ref`, `selector`, `label`, or `x` and `y`. These arguments are public for hooks (experimental). A hook can check the target before Pi types:

```typescript
import { hook, ToolTask } from "@earendil-works/pi-durable";

const TARGET = ["ref", "selector", "label", "x", "y"] as const;

const noTypedPasswords = hook(ToolTask, {
    beforeTool: async (call, api) => {
        const args = call.arguments as Record<string, unknown>;

        if (call.name !== "browser" || args.action !== "type") {
            return undefined;
        }

        const at = Object.fromEntries(
            TARGET.filter((key) => key in args).map((key) => [key, args[key]]),
        );

        // Without a target, Pi types where the focus is, which inspect cannot see.
        if (Object.keys(at).length === 0) {
            return { block: "Name the field to type into." };
        }

        const page = await host.browser(api.conversationId);
        const found = await page?.inspect(at).catch(() => undefined);

        return found?.password ? { block: "Use the sign-in card for passwords." } : undefined;
    },
});
```

Return it in your extension's `hooks`. It is a guard against mistakes: Pi can still press keys one at a time, or set a value with `evaluate`.

## Together: a sign-in

A tool `sign_in` that Pi calls when it meets a sign-in page:

1. `host.browser` gives the page, and its snapshot gives the fields.
2. `host.ask` asks the person for the username and the password.
3. `host.hide` hides the password in this session, before anything else.
4. `fill` puts them in, and `press("Enter")` sends the form.
5. The result tells Pi that the person signed in, with a new snapshot: never the values.

## See also

- [The host reference](reference/host.md#asking-people-hiding-values-and-the-browser): the members and their types.
- [Hooks](hooks.md), to refuse a call before it runs.
- [Limits](reference/limits.md#asking-people-and-hidden-values): sizes and counts.
