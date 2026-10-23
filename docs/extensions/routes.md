# Routes

A route is a function on the server that answers requests from your browser module. Keys and other secrets stay on the server, in the route.

## Add a route

`web.route(method, path, handle, { access })` adds a route at `/api/x/<module>/<path>`.

```typescript
web.route("GET", "items/:id", ({ params }) => {
    const item = items.get(params.id);

    if (item === undefined) {
        throw web.error(404, "No such item");
    }

    return item;
});
```

- `method` is `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`.
- `path` is relative to the module's own address, for example `"status"` or `"items/:id"`. A part written `:id` matches any one part of the address.
- Each other part has letters, digits, and `.`, `_`, `~`, and `-`, but is not `.` or `..` alone.
- When two paths match, the more specific one answers, in any order of registration: a fixed part wins over a `:name` part, from the left. So `items/new` wins over `items/:id`.

## The request

`handle(request)` gets `{ method, params, query, body, user, signal, snapshot, context, commit, sessions }`:

- `params`: the `:name` parts of the path.
- `query`: the query string, as `URLSearchParams`. For example, `pocket.api("usage?days=7")` sends `days`.
- `body`: the JSON object that the browser sent. It is empty for `GET` and `DELETE`.
- `user`: who asked, as `{ id, name, role }`.
- `signal`: aborted when the browser stops waiting. Normal handler return does not abort this signal.
- Since 0.20.0 (experimental), `sessions()`: the sessions that this person can see now, as their session list shows them (`{ id, title, cwd, archived, updatedAt }`). Check the session ids that a browser sends against it, and leave out data about sessions that the person cannot see.
- Since 0.16.0, `snapshot` and `context` read fresh module documents. Unlike `signal`, `context.abortSignal` is cancelled on disconnect or handler return, ending the new document and linked-session capabilities. `commit(change)` writes them atomically and returns the callback's answer. It refuses viewers, and callbacks that finish after the request ends roll back. Await writes before returning; do not keep request capabilities in timers. Follow the `x.<module>.…` document naming rule. These are not APIs for changing core documents.

What the handler returns goes back as JSON. `undefined` goes back as `{}`.

## Bind a source conversation

Since 0.16.0, use a distinct capability for routes that start work from a conversation:

```typescript
if (typeof web.conversationRoute !== "function") {
    throw new Error("This module needs Pi Pocket 0.16.0. Update it and restart the server.");
}

web.conversationRoute(
    "POST",
    "runs/:source",
    async (request) => {
        const started = await request.linkedSessions.start(
            { title: "Review", message: "Review the requested change." },
            `x.my-module.review:${String(request.body.runKey)}`,
        );

        return started;
    },
    { conversation: "source", access: "owner" },
);
```

`conversation` names a path parameter that must exist at registration. Before the handler runs, the server resolves the actual session and checks seeing; a mutation also needs steering and the turn. Ordinary route `access` still applies. GET can show a preview without taking the turn. `request.conversation` gives `{ id, title, cwd, model?, thinkingLevel }`. Do not take source settings from a browser body as authority; compare expected preview values with this metadata.

`request.linkedSessions.start(request, key)` and `list()` act as the signed-in clicking person and bound source, not whoever last wrote to Pi there. There is no actor override. Starts check current plan, turn, spend, team and model policy; they reject a source folder/model/thinking change while they wait. Explicit thinking is never silently lowered. Give each logical role start a stable, module-namespaced key; another person cannot replay its receipt. The route waits for starts, not model answers. See [Starting and messaging sessions](linked-sessions.md#starts-from-a-human-page) and the [request reference](reference/web.md#conversationwebrequest).

Use an ordinary owner-only `web.route` for an app-wide catalog save. Its document commit has no source plan, turn, or spend checks.

## Errors

- To answer with an error, throw `web.error(status, message)`, with a status from 400 to 599. The person who asked gets the status and the message as they are. This includes guests and viewers, when the route is for them. Do not put in the message what you would not show them.
- Core request capabilities report their own safe HTTP errors, for example a 409 when source settings changed.
- Any other error is a 500, also an error that has a `status` of its own, as a provider's SDK gives. Such words can quote a key. The owner sees its message; other people see only that the extension failed. The server log has all of it.

## The app's own checks

The app checks each request before your route gets it:

- The person must be signed in.
- The request must have the `X-Pocket` header. A link or a form on another site cannot send it. Your routes need it for `GET` too, so no other site can make a `GET` to them. `pocket.api` always sends it. Anything else that calls your routes must send it too, for example `curl -H 'X-Pocket: 1'`. Without the header, Pi Pocket looks up nothing.

## Text from outside

A `:name` part is text from outside. Pi Pocket decodes the address before it splits it. So it answers 400 for a part that decodes to `..` (for example `..%2F`), or that has a `\` or a NUL in it. A `.` or `..` written as it is never gets to your route: the address resolves it first. But still check a part before you make a file path from it.

## Time

A route has no time limit. A handler that waits keeps its request open until it answers, or until the browser stops waiting, which aborts `signal`. Handler return ends its document and linked-session capabilities too. Give `signal` to what the handler waits for. A linked start's final admission boundary is the start of Durable's admission transaction: once admitted, later cancellation does not undo the start.

## Who may use it

Routes and the browser module are for the owner alone, unless their `access` says more:

| `access`            | Who                                                  |
| ------------------- | ---------------------------------------------------- |
| `"owner"` (default) | The owner                                            |
| `"steer"`           | The owner, and guests who can steer every session    |
| `"view"`            | The owner, guests, and viewers who see every session |

- A person invited to one session never may use them: these parts belong to the whole app.
- Each route checks its own `access`. So a browser module for everyone can have a route for the owner alone.
- `access` is the same for each method. A `POST` route open to `"view"` lets viewers change something through it, though they cannot steer a session. Give a route that changes things `"owner"` or `"steer"`.
- A browser module runs with the rights of the person whose tab loads it. So it can do nothing in a guest's tab that the guest cannot do.

To other people, a route is not there. They get the same 404 as for a path that the module does not have, and a 405 names only the methods that they may use. So another route whose path matches can answer them: `items/:id` answers `items/new`, with `id` `"new"`. Give routes whose paths overlap the same `access`, or check `user.role` in the handler.
