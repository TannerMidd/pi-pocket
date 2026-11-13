# Relay connectors

The relay is a built-in extension, **Relay**, that is off by default. It connects a chat service or a feed to a session: what people write there reaches Pi as fenced data, and Pi answers with the `relay_reply` tool. The owner turns it on in Menu → **Extensions** → **Relay** and adds connectors in Menu → **Relay**.

A **connector** is one kind of connection: `discord`, `telegram`, `slack`, `matrix`, `http`, and `rss` come with Pi Pocket. A drop-in extension can add a kind of its own. This page tells how. A drop-in that only needs to deliver data to a session, without a connection that the owner sets up, uses [`host.inbox`](inbox.md) instead.

**Experimental, since 0.29.0.** The service has `api: 1`. It can change in a minor release, but never in a patch release ([API stability](policies/api-stability.md#experimental)).

## How it works

- A connector makes outbound connections only: it polls an address, or it keeps a stream open. The server needs no public address and no separate relay service. A service that can only push needs a [webhook](../features.md) instead (Menu → **Webhooks and watches**). A webhook uses the same inbox path.
- A connector calls `context.emit(events)`. The relay filters the events, keeps them on disk in a queue, and delivers them one by one to the session through `host.inbox.deliver`.
- Each event id is delivered once. The inbox key is `relay-<connector id>-<event id>`, so this is also true after a restart. An event waits in the queue on disk until the session takes it.
- A connector's error never stops the server. It shows as the connector's status, and the relay tries again with a longer wait each time.

## What the owner sets

For each connector the owner gives:

- a name (60 characters at most) and the session that gets its messages. Pi works for the owner who saved the connector;
- the connector's own fields (the fields you declare);
- instructions for Pi (2,000 characters at most). Without them, Pi reads: "A message came through the relay. Read it. Answer it when it asks something of you, or when the owner's instructions say so.";
- owner IDs: ids of the owner's own accounts on the service (20 at most). Pi reads these senders as trusted, and they have no limit for each author;
- **mention only**, when the connector says `mentions: true`;
- a limit of messages for each author in an hour (default 10, 1 to 120) and for the whole connector in an hour (default 30, 1 to 600).

The relay keeps 50 connectors at most.

To move a bot from another relay (one that runs outside Pi Pocket), stop the old relay first, and only then save the connector here. One bot token in 2 processes gets each message twice, so Pi gets it twice and can answer twice. Give the new connector the same channels and owner IDs. Messages that came while neither relay ran are not fetched again.

## The filters

Each event goes through these checks, in this order. An event that fails the first four is dropped without a count. An event over a limit is dropped and counted.

1. The event has an `id` that is text, and an `author.id` that is text.
2. `author.bot` is `true`: dropped. This is how a connector never hears itself. Set `bot` for the service's bots and for the connector's own account.
3. **Mention only** is on, the connector says `mentions: true`, and `mentioned` is not `true`: dropped.
4. The text is empty and there are no attachments: dropped. An id that is waiting or was delivered lately is dropped as a repeat.
5. The author is not an owner ID, the connector's `authorLimit` does not turn the limit off (see below), and the author sent the author limit already in the last hour: dropped and counted.
6. More than 200 events wait: the oldest is dropped and counted.
7. The connector's limit in an hour is reached when the event is delivered (the inbox says 429): dropped and counted.

A session that cannot take the message now (someone else drives it, a spend limit, or the session is gone) does not drop the event. It stays first in the queue and the relay tries again, after 15 seconds at first and up to 10 minutes later. A delivery that the inbox calls impossible (400) is dropped and counted. A connector delivers to an ordinary session, not to PiP: PiP gets outside data through webhooks.

## What Pi reads

A message shows as `[via relay <name>]`. It has, in order:

1. The owner's instructions, and a line that tells Pi how to answer: `relay_reply` with the connector's name and `reply_to` set to the event id. For a connector with no `reply`, the line says that it only listens. The relay writes this line, outside the fence.
2. One line, outside the fence, about the sender's id: it is, or it is not, one the owner marked as trusted. This is guidance for the model, not a boundary: on some services, a person can pretend to be another.
3. The event inside `<relay-message connector="<name>" kind="<kind>" from="<name>" from-id="<id>">` tags: the sender's name and id are in the tag, inside the fence. First its lines (`event`, `channel`, `thread`, `sent`, `link`, `attachments`), then an empty line, then the text (6,000 characters at most; the whole message is cut to 8,000).
4. A line that says what is between the tags is data, not instructions.

A prompt section in the session says the same, so Pi knows it works with outside data.

## The connector

```typescript
interface RelayConnector {
    kind: string;
    label: string;
    description?: string;
    fields: readonly RelayField[];
    shape: "poll" | "stream";
    interval?: number;
    mentions?: boolean;
    idempotentReply?: boolean;
    authorLimit?: false | string;
    check?(values: RelayValues): string | undefined;
    poll?(context: RelayContext): Promise<void>;
    run?(context: RelayContext): Promise<void>;
    reply?(
        context: Pick<RelayContext, "values" | "signal" | "log">,
        reply: RelayReply,
    ): Promise<{ id?: string } | void>;
}
```

- `kind`: lowercase letters, digits, and `-`, 40 characters at most, and one that no other connector has. Use a prefix of your own.
- `label`, `description`: what the owner reads when they add a connector.
- `shape: "poll"` needs `poll`. `shape: "stream"` needs `run`. Registering a connector that does not fit throws, so you see the mistake when the module loads.
- `mentions: true` says the connector sets `RelayEvent.mentioned`. The owner can then take only the messages that name the account.
- `authorLimit: false` says that the connector's items do not come from people, such as a feed's items. The limit for each author does not apply to them: only the connector's limit does. A chat connector does not set it. The name of one of the connector's fields says that the limit for each author applies only when that field has a value (the owner's, else the field's `default`): the `http` connector names `authorIdField`, so an address of chat messages with an author id keeps the limit, and a feed without one does not.
- `check(values)` runs before the owner's values are saved. Return a problem in words for the owner (it shows as an error, and nothing is saved), or nothing. It gets the values the owner typed, without defaults. A problem has no secret in it: the relay takes any secret value out of a problem.
- `reply` is optional. Without it, the connector only listens.

### Shapes

**poll:** the relay calls `poll(context)`, waits, and calls it again. The wait is `values.interval` when your fields have one called `interval`, else `interval` of the connector, else 60 seconds, and never less than 10 seconds. A `poll` that returns is a good poll. A `poll` that throws is a failed one.

**stream:** the relay calls `run(context)` and expects it to stay open until `context.signal` aborts. Return when the connection ends, or throw. The relay then calls `run` again after a wait that grows. Write `run` so that it resumes from `context.state`.

For both, a thrown error is the connector's status: the relay waits 5 seconds at first, then twice as long each time, up to 15 minutes, and adds up to 20% of random time. When the connector stops (the owner turns it off or edits it, or the relay module loads again), `context.signal` aborts: stop at once. The relay waits 3 seconds for a connector to stop.

### Fields

```typescript
interface RelayField {
    name: string;
    label: string;
    type: "text" | "secret" | "number" | "boolean" | "choice" | "textarea";
    description?: string;
    placeholder?: string;
    default?: string | number | boolean;
    required?: boolean;
    min?: number;
    max?: number;
    choices?: { value: string; label: string }[];
    multiline?: boolean;
}

type RelayValues = Readonly<Record<string, string | number | boolean | undefined>>;
```

- `name`: a letter, then letters, digits, and `_`, 40 characters at most, and each name once. A name that is wrong throws when the connector registers.
- `text` is one line, 8,192 characters at most. `textarea` has more lines, 8,192 characters at most. `number` follows `min` and `max`. `choice` is one of the `choices`. `boolean` is `true` or `false`.
- `secret` is a text of 8,192 characters at most for a token or a key. It never goes to the owner's browser: the sheet shows only whether it is set, and the owner keeps, replaces, or clears it. The server hides the values with `host.hide`, so Pi and people cannot read them in a transcript, and the relay takes them out of every error and status. The relay refuses to save a secret of fewer than 4 characters: it cannot hide one that short. In a `multiline` field of headers, this applies only to a credential header (`Authorization`, `Cookie`, or a name with `key`, `token`, `secret`, `auth`, `pass`, `session`, or `signature`): a short value of another header (`Accept: */*`) is saved, and not hidden. A secret never goes in a `description` or a default.
- `multiline: true` on a `secret` field: the sheet draws it as a masked text area of more lines (the `http` connector's headers). The relay reads its lines as headers, one `Name: value` on each line, for the rule on short values above. A password input would join the lines.
- `required: true`: the owner must give a value, or the field must have a `default`.
- `context.values` has each field's value as the owner set it, else the `default`, else `undefined`. The object is frozen.

### Events

```typescript
interface RelayAuthor {
    id: string;
    name: string;
    bot?: boolean;
}

interface RelayEvent {
    id: string;
    text: string;
    author: RelayAuthor;
    channel?: string;
    channelName?: string;
    thread?: string;
    mentioned?: boolean;
    url?: string;
    at?: number;
    attachments?: string[];
    files?: RelayFile[];
}

interface RelayFile {
    name: string;
    type?: string;
    size?: number;
    ref: string;
}
```

- `id` is unique in this connector, and the same each time the event comes. Use the service's own id. The relay delivers an id once, so an id that is not stable sends the same message again, and an id that is reused loses messages.
- `author.id` is what the owner lists as trusted. Use the service's stable id for the account, never a name that a person can change. When a source has no people (a feed), use one id for the whole source, and set `authorLimit: false` so that only the connector's limit applies (the `rss` connector does this, and the `http` connector when its author id field is empty). Without it, the limit for each author limits the source.
- `channel` is where the event came from, and where a reply goes (a channel, a chat, a room). `thread` is a thread in it. `channelName` is for Pi to read.
- `mentioned` is `true` when the event names the connector's own account, or came in a direct message.
- `at` is in milliseconds since 1970. `url` is a link. `attachments` are one-line descriptions (a name, a type, a size), never content.
- `files` are attachments Pi can download, for a connector with `fetch`. The relay keeps 10 for each event and lists them by number. `ref` is yours (a URL, a file id): it stays on the server, and Pi never sees it.

### The context

```typescript
interface RelayContext {
    readonly values: RelayValues;
    readonly state: Readonly<Record<string, unknown>>;
    save(state: Record<string, unknown>): void;
    emit(events: readonly RelayEvent[]): Promise<void>;
    readonly signal: AbortSignal;
    status(text: string): void;
    log(text: string): void;
    sleep(ms: number): Promise<void>;
}
```

- `emit(events)` hands events to the relay. It resolves when the relay has filtered them and written the ones it keeps to disk: they will reach the session. It rejects when the connector has stopped, or when the relay could not write its files (then the events are not stored: do not save your cursor). Save your cursor **after** `emit` resolves: a restart between the two then gives the events again, and the ids stop a repeat.
- `state` is what you saved last. It lasts across reloads and restarts, and it is `{}` at first. `save(state)` replaces it. It must be JSON of 64 KB or less. A larger one is not kept, and the relay logs it. Keep a cursor or a session id in it, not the events.
- `status(text)` sets one short line in the connector's status (120 characters at most), such as `connected`. `log(text)` writes a line in the server's log with the connector's name. Neither may have a secret in it, and the relay takes out the secrets it knows.
- `sleep(ms)` waits, and ends early when the connector stops. It never rejects.
- Do not start a timer or a socket that `signal` does not close.
- Never throw in a listener of `signal`'s `abort` event: an error there stops the whole server. Close a socket with code 1000 or 4000 (`ws.close(1001)` throws).

A poll connector with no past: on its first poll, do not emit what was there before. The owner did not ask for the old messages. Save a cursor first (the example does), and emit from the next poll. The `rss` and `http` connectors do this.

### Replies

```typescript
interface RelayReply {
    text: string;
    to?: RelayEvent;
    channel?: string;
    thread?: string;
    key: string;
    files?: { name: string; type: string; data: Uint8Array }[];
}
```

Pi calls `relay_reply` with `text`, and usually `reply_to`, the event id. The relay then calls your `reply` with:

- `to`: the event Pi answers. It has only the `id`, `channel`, and `thread` that the relay kept, and the author's id. The relay keeps the last 200 events that it delivered: an older id gives Pi an error.
- `channel` and `thread`: those of `to`. Without `to`, there are none: use a default channel from your fields.
- `key`: the same for a call that runs again after a restart. The relay keeps the keys of the last 2,000 replies, and two calls with one key at once send once. Before it calls `reply`, the relay writes the key down as sending. When a send fails, or a restart cuts it off, the relay sends that key again only for a connector with `idempotentReply: true`, a service that sends one key once (Discord's nonce with `enforce_nonce`, Matrix's transaction id). Any other connector does not send it again, so a reply never shows twice; Pi hears that it may have gone out.

Return `{ id }`, the id the service gave, or nothing. A call that takes more than 30 seconds is aborted: pass `context.signal` to your requests. A thrown error goes to Pi as an error, with secrets taken out. The `reply` gets only `values`, `signal`, and `log`.

### Files

A connector that sends files declares `files: { max, maxBytes }`: `max` files of `maxBytes` each at most in one reply. Pi gives paths in `relay_reply`'s `files`. The relay reads each one and gives your `reply` the bytes in `reply.files`. The relay refuses a path outside the session's folder (after it follows links), a path with a hidden part (a name that starts with `.`, except the `.relay` folder), a file in the server's data folder, and a file over the caps. A connector without `files` refuses a reply with files, and nothing is sent. One reply sends 100 MB of files in all at most. With files, a reply has 120 seconds, and about 1 second more for each MB.

A connector that downloads attachments has `fetch(context, file, maxBytes)`. It returns `{ data, type }`, with `maxBytes` (25 MB) at most. Pi calls `relay_fetch` with the event id and the attachment's number. The relay writes the file to `.relay/<event>/<number>-<name>` in the session's folder, with a safe name. It refuses a file over the cap, and a web page (`text/html`) in place of a file that did not name that type. Errors go to Pi without secrets and without links. Download only from the service's own file hosts, and never send the token to a host that is not the service's.

| Kind     | Sends files                                                                             | Fetches attachments                                                           |
| -------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Discord  | Yes: 10 files, 10 MB each                                                               | Yes                                                                           |
| Slack    | Yes: 10 files, 50 MB each, in one message with the text (needs the `files:write` scope) | Yes, from `files.slack.com` only (needs the `files:read` scope)               |
| Telegram | Yes: 10 files, 50 MB each; an image of 10 MB or less goes as a photo                    | Yes: photos, documents, video, and sound, 20 MB at most (the Bot API's limit) |
| Matrix   | Yes: 10 files, 50 MB each (or the homeserver's lower limit), each as its own event      | Yes, from the homeserver only; not from an encrypted room                     |
| HTTP     | No                                                                                      | No                                                                            |
| RSS      | No: it only listens                                                                     | No                                                                            |

Limits of the built-in kinds:

- Slack and Telegram have no idempotency key. The relay does not send again a reply that a restart or an error cut off. Slack shares the text and all the files in one call, so it sends all or nothing. Telegram sends each part on its own, so a cut-off reply can stay partly sent (the text without a file, or some of the files).
- Telegram sends each file as its own message. A short text (1,024 characters or fewer) is the first file's caption. A photo that Telegram refuses goes again as a document. A local Bot API server in `--local` mode gives paths on its disk: the relay cannot fetch from it.
- Matrix sends the text and each file as separate events, each with its own transaction id. A homeserver keeps transaction ids for a limited time (Synapse about 30 minutes): a replay after a longer stop can show the reply twice. A replay uploads the files again.

`relay_reply` and `relay_fetch` are deferred tools: they are offered only in sessions that a connector delivers to. The relay adds them to the session's `modelTools` when a connector is saved, and takes them out when no connector delivers there any more. Pi gives `connector` (the name) when more than one connector delivers to the session.

### Errors

```typescript
class RelayError extends Error {
    constructor(message: string, options?: { retryAfter?: number; fatal?: boolean });
}
```

- `retryAfter`: wait this many milliseconds at least before the next try. Use it for a rate limit. The wait still grows when the tries keep failing (from 1 second), and it is one day at most.
- `fatal: true`: stop the connector. Use it for a token the service refused. The connector stays stopped until the owner edits it and saves. It stays stopped across restarts too.
- Any other error backs off, as above.

Use the class from the service (`service.RelayError`). The relay also reads `retryAfter` and `fatal` from any error that has them. Write messages that tell the owner what to do, such as "The bot token was refused. Check it.", and that never hold a token, an address with a key, or a header.

## The built-in connectors

| Kind       | Shape  | The owner gives                                                                                                       | Replies | Notes                                                                                                                                                     |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discord`  | stream | A bot token, channel IDs (empty: all the bot sees), direct messages on or off, a reply channel.                       | Yes     | The Developer Portal needs **Message Content Intent**. A nonce makes a reply once.                                                                        |
| `telegram` | stream | A bot token, chat IDs (empty: all), a default reply chat.                                                             | Yes     |                                                                                                                                                           |
| `slack`    | stream | An app token (`xapp-…`, Socket Mode) and a bot token (`xoxb-…`), channel IDs (empty: all), a default reply channel.   | Yes     |                                                                                                                                                           |
| `matrix`   | stream | A homeserver address, an access token, room IDs (empty: joined rooms), a default reply room.                          | Yes     | A transaction id makes a reply once.                                                                                                                      |
| `http`     | poll   | An address that answers with JSON, headers, the fields of an item, an optional cursor, and an optional reply address. | Yes     | Items must come oldest first. Without a cursor, it watches the newest 500 items and remembers 2,000 ids. It does not follow a redirect to another origin. |
| `rss`      | poll   | A feed address (RSS or Atom). Default every 15 minutes.                                                               | No      | The first poll records the feed and delivers nothing.                                                                                                     |

## Your own connector

A drop-in registers its connector with the relay's service:

```typescript
const service = web.use("pocket-relay");
```

The service is an object: `{ api: 1, register, RelayError }`. `register(connector)` returns a function that removes the connector. A connector that is removed stops, and the owner's connectors of that kind show as not available until the kind comes back. They keep their settings and their state.

Three rules for a drop-in:

- **Check the service.** Check that `api` is 1 and that `register` is a function before you call it. The relay can be off, or load later, or be a newer one.
- **Register again when the relay loads again.** The relay's connectors are gone when it reloads. Listen with `web.onService("pocket-relay", …)`, remove your old registration, and register again. The listener runs when the service comes, changes, or goes. It does not run for a service that is there already, so also register when your module loads.
- **Remove it when you go.** Pass the removing function to `web.onDispose`, so an edit of your module does not leave an old connector.

A kind that is registered twice throws. A connector that fails the checks above throws when it registers.

### An example

This drop-in listens to an [ntfy](https://ntfy.sh) topic. It polls, so it needs no open port. It copies the types it needs from this page, because a drop-in cannot import Pi Pocket's source. Copy it to `~/.pi-pocket/extensions/ntfy-relay.ts`, turn it on in Menu → **Extensions**, turn on **Relay**, and add an **ntfy** connector in Menu → **Relay**.

```typescript title="ntfy-relay.ts"
/**
 * An ntfy connector for the relay: it polls a topic and delivers each new message to a session.
 */
import type { Web } from "./_pocket.d.ts";

type RelayValues = Readonly<Record<string, string | number | boolean | undefined>>;

interface RelayField {
    name: string;
    label: string;
    type: "text" | "secret" | "number" | "boolean" | "choice" | "textarea";
    description?: string;
    default?: string | number | boolean;
    required?: boolean;
    min?: number;
    max?: number;
}

interface RelayEvent {
    id: string;
    text: string;
    author: { id: string; name: string; bot?: boolean };
    channel?: string;
    at?: number;
}

interface RelayContext {
    readonly values: RelayValues;
    readonly state: Readonly<Record<string, unknown>>;
    save(state: Record<string, unknown>): void;
    emit(events: readonly RelayEvent[]): Promise<void>;
    readonly signal: AbortSignal;
}

interface RelayConnector {
    kind: string;
    label: string;
    description?: string;
    shape: "poll" | "stream";
    interval?: number;
    fields: readonly RelayField[];
    check?(values: RelayValues): string | undefined;
    poll?(context: RelayContext): Promise<void>;
}

type RelayErrorClass = new (
    message: string,
    options?: { retryAfter?: number; fatal?: boolean },
) => Error;

interface RelayService {
    api: number;
    register(connector: RelayConnector): () => void;
    RelayError: RelayErrorClass;
}

interface NtfyMessage {
    id: string;
    time: number;
    event: string;
    topic: string;
    title?: string;
    message?: string;
}

function ntfy(RelayError: RelayErrorClass): RelayConnector {
    return {
        kind: "ntfy",
        label: "ntfy",
        description: "The messages of an ntfy topic.",
        shape: "poll",
        interval: 60,
        fields: [
            { name: "topic", label: "Topic", type: "text", required: true },
            { name: "server", label: "Server", type: "text", default: "https://ntfy.sh" },
            {
                name: "token",
                label: "Access token",
                type: "secret",
                description: "For a private topic.",
            },
            {
                name: "interval",
                label: "Seconds between polls",
                type: "number",
                default: 60,
                min: 10,
                max: 3600,
            },
        ],
        check(values) {
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(values.topic ?? ""))) {
                return "A topic is 1 to 64 letters, digits, - or _.";
            }

            return URL.canParse(String(values.server ?? "https://ntfy.sh"))
                ? undefined
                : "The server is not an address.";
        },
        async poll(context) {
            const server = String(context.values.server).replace(/\/+$/, "");
            const topic = String(context.values.topic);
            let since = typeof context.state.since === "string" ? context.state.since : undefined;

            // The first poll takes no old messages: start from now, and keep that.
            if (since === undefined) {
                since = String(Math.floor(Date.now() / 1000));
                context.save({ since });
            }

            const token = context.values.token;
            const response = await fetch(
                `${server}/${encodeURIComponent(topic)}/json?poll=1&since=${encodeURIComponent(since)}`,
                {
                    headers:
                        typeof token === "string" && token !== ""
                            ? { authorization: `Bearer ${token}` }
                            : {},
                    signal: AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]),
                },
            );

            if (response.status === 401 || response.status === 403) {
                throw new RelayError("ntfy refused the access token. Check it.", { fatal: true });
            }

            if (response.status === 429) {
                throw new RelayError("ntfy limited the requests.", { retryAfter: 60_000 });
            }

            if (!response.ok) {
                throw new Error(`ntfy answered ${response.status}.`);
            }

            const messages = (await response.text())
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) => JSON.parse(line) as NtfyMessage)
                .filter((message) => message.event === "message");

            if (messages.length === 0) {
                return;
            }

            await context.emit(
                messages.map((message) => ({
                    id: message.id,
                    text: [message.title, message.message].filter(Boolean).join("\n"),
                    // A topic has no people: one author id makes the limit for each author a limit for the topic.
                    author: { id: `ntfy:${message.topic}`, name: `ntfy ${message.topic}` },
                    channel: message.topic,
                    at: message.time * 1000,
                })),
            );
            // After emit: a restart in between gives the messages again, and their ids stop a repeat.
            context.save({ since: messages[messages.length - 1]!.id });
        },
    };
}

export default function createNtfyRelay(_host: unknown, web: Web) {
    if (typeof web.use !== "function" || typeof web.onService !== "function") {
        return;
    }

    let remove: (() => void) | undefined;

    const connect = () => {
        remove?.();
        remove = undefined;

        const service = web.use("pocket-relay") as Partial<RelayService> | undefined;

        if (
            service?.api === 1 &&
            typeof service.register === "function" &&
            service.RelayError !== undefined
        ) {
            remove = service.register(ntfy(service.RelayError));
        }
    };

    connect();
    web.onService("pocket-relay", connect);
    web.onDispose(() => remove?.());
}
```

The connector is listen-only: a topic is not a conversation, and a reply posted to it would come back as a new message. A connector for a chat service adds `reply` and sets `mentions: true`.

## Where the data is

The relay keeps two files in `<data folder>/x.pocket-relay/`, each with mode 0600:

- `connectors.json`: the owner's connectors, with their secret values.
- `state.json`: each connector's saved state, its queue, the ids it delivered lately, the replies it sent, its counts, and its last error.

Lancet Guard blocks Pi's tools from every `x.*` folder in the data folder, so Pi cannot read these files. Do not keep a secret anywhere else. The owner's browser gets no secret value: only whether each secret is set.

## Limits

- Connectors: 50. Name: 60 characters. Instructions: 2,000 characters. Owner IDs: 20, each one word of 100 characters or fewer.
- Limit in an hour, for each author: 1 to 120, default 10. For the connector: 1 to 600, default 30. The count for the connector is the inbox's `limit`, in memory: a restart forgives it. The count for each author is kept in `state.json`.
- Events waiting: 200. Events remembered for replies: 200. Replies remembered: 2,000. Saved state: 64 KB. A reply's wait: 30 seconds.
- Poll wait: 10 seconds at least. Backoff: 5 seconds to 15 minutes. Delivery retry: 15 seconds to 10 minutes.
