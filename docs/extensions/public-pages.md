# Public pages

A public page is a page that a module shows to anyone with its link, with no sign-in: a form for a client, a question for a person who has no account here. The module makes a link, and Pi Pocket serves it at `/l/<token>`. The token is the whole of the access.

Public pages came in 0.22.0, and are experimental: they can change in a minor release ([API versions](reference/api-versions.md)). Check that they are there (`typeof web.publicPage === "function"`) to work with an older server too.

## Make a link, draw its page

```typescript
import type { Host, Web } from "./_pocket.d.ts";

export default function createFeedback(_host: Host, web: Web) {
    // The owner makes a link from the app.
    web.route("POST", "links", (request) =>
        web.links.create({ hours: 24, uses: 1, by: request.user.id, data: { topic: "pricing" } }),
    );

    // What anyone with a link sees, and what their form sends.
    web.publicPage(async (request) => {
        if (request.method === "GET") {
            return `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<form method="post">
    <textarea name="answer" required></textarea>
    <button>Send</button>
</form>`;
        }

        const answer = request.form.answer ?? "";

        if (answer.trim() === "") {
            return { status: 400, html: "<p>Write an answer first.</p>" };
        }

        await saveAnswer(request.link.data, answer); // your own document, with request.commit

        return "<p>Thank you.</p>";
    });
}
```

- `web.links.create({ hours, uses, by, conversation, data })` makes a link. It gives a [`PublicLinkInfo`](reference/web.md#publiclinkinfo): its `token`, its `path` (`/l/<token>`), and its `url` on the server's public address, when it has one (a tunnel's). In the browser, use `url`, or else `location.origin` and `path`.
- `web.publicPage(handle)` draws the module's pages. It is one handler for all of the module's links: `request.link` says which link was opened, with its `data`.
- `web.links.get`, `list`, and `end` read and end the module's own open links. They work at any time while the module runs: from a route, a tool, a timer, or the page handler.

## What a link is

- **It always closes.** `hours` is more than 0, and 720 (30 days) at most. After that, its address answers nothing.
- **It can take a set number of answers.** With `uses`, each `POST` counts one before the handler runs. A handler that throws, or that answers with a status of 400 or more, gives that use back, so the person can mend the form and send it again. So does a handler that takes too long ([Limits](reference/limits.md#public-links)), or whose browser stops waiting: from then on, its `snapshot` and `commit` are refused. Keep what a post changes in `commit`, so a post that gives its use back changes nothing. Two posts at once to a link with one use left: one gets in. A `GET` never counts, so a chat app that opens the link to show a preview uses up nothing.
- **It belongs to its module.** Another module cannot see or end it. While the module is off, the address answers nothing, also for a form that was on its way when it went off. Turned on again, the link works again until it closes.
- **The module can end it at once** with `web.links.end(token)`.
- An address that names no open link, a link that closed, and a module that is off all get the same page: "This link is not open". An address tells nothing about other links.

## What the page can do

Pi Pocket sends every public page with a content security policy that puts it in a sandbox:

- **No script runs**, and the page loads nothing from anywhere: no scripts, fonts, or images from other places (`data:` images work). Put the styles in a `<style>` element.
- **The page has an opaque origin.** A person who opens a link while they are signed in to Pi Pocket lends the page none of their access: it cannot read their cookies or the app's answers. A form cannot call the app's API either, which takes only requests with the `X-Pocket` header.
- **Forms post only to this server.** Give a form `method="post"` and no `action`, so it posts back to its own link.
- No referrer goes to a page that it links to, so the token does not leak. No browser and no search engine keeps the page.

The handler gets a [`PublicPageRequest`](reference/web.md#publicpagerequest):

- Since 0.28.0 (experimental), optional `locale` supplies this request's immutable `lang` and `t(key, english, values?)`. It uses the exact available `pocket_locale` choice, else English, and safe mode uses English. Older servers omit it. The lookup returns text, not escaped HTML; escape it for the page. Never keep a global current language.
- `method`: `"GET"`, or `"POST"` for a form. `HEAD` comes as `"GET"`.
- `form`: the fields of a posted form (`application/x-www-form-urlencoded`), each as text. Nothing else is taken: no JSON and no files.
- `link`: the link, with its `data`, `by`, `conversation`, and how many `uses` it has left. For a post, the count leaves out this one.
- `snapshot`, `context`, and `commit`: read and change the module's own documents, as a route does. They end when the handler returns.
- `signal`: aborted when the browser stops waiting.

It answers with the page's HTML, or `{ html, status }`. Throw `web.error(status, message)` to show a short page with that message. Any other error shows "This page could not be shown", and only the server's log has its words.

## Write it safely

Everyone on the internet who has the link can read the page and send the form.

- **Escape all that you put in the page**: what Pi or a person wrote, and above all what an earlier visitor sent. The sandbox stops scripts, but not HTML that changes what the page says.
- **Treat what comes in as text from a stranger.** Check its length. Before Pi reads it, mark it as data, not instructions ([Text from other places](host.md#text-from-other-places)). A name that someone typed is not who they are.
- **Show only what the link is for.** Do not put the session's transcript, files, or names on the page unless the person who made the link chose to share them.
- **Give links a short life and few uses.** Let the people who made them see and end them.

The owner sees "pages for anyone with a link, no sign-in" for the module in Menu → Extensions.

## Limits

A module keeps a limited number of links open, and each link's `data`, each form, and each page have a size limit ([Limits](reference/limits.md#public-links)).

## See also

- Ask someone (`src/server/extensions/ask-someone.ts`), a built-in module: Pi writes a question, a person shares it as a link for one answer, and the answer comes back to the session.
- [Routes](routes.md): the module's routes for signed-in people.
