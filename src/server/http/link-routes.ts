/**
 * `/l/<token>`: a page an extension module shows to anyone with the address (`public-links.ts`). No sign-in and no
 * `X-Pocket` header: the token is the whole of the access. The module's page handler draws it; a form on it posts
 * back to the same address. The page runs in an opaque origin, with no script: whoever opens it while signed in to the
 * app lends it none of their access.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { DocumentReader } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import { describe, HttpError } from "../errors.ts";
import { exposedError } from "../extension-web.ts";
import type { PublicPageRequest } from "../host.ts";
import { escapeHtml, readBody, send } from "./io.ts";
import { pageLocale } from "./locale.ts";

/** The largest form a public page takes: answers in words, not files. */
export const MAX_FORM = 64 * 1024;
/** The most fields a form may have. */
const MAX_FIELDS = 50;
/** The largest page a handler may answer with. */
const MAX_PAGE = 1024 * 1024;
/**
 * Posts read at once, to all links and to one: a known address must not let anyone make the server hold many bodies, nor
 * keep other links' posts out.
 */
const MAX_READING = 16;
const MAX_READING_LINK = 2;
let reading = 0;
const readingBy = new Map<string, number>();

/** Page handlers running at once, for all links and for one: a slow page must not let one address hold the server. */
const MAX_RUNNING = 32;
const MAX_RUNNING_LINK = 4;
let running = 0;
const runningBy = new Map<string, number>();

/** How long a post's body may take, and a page handler: past it, its reads and writes are refused. Tests shorten them. */
export const linkReads = { timeoutMs: 15_000, handlerMs: 30_000 };

/**
 * What every public page is sent with. `sandbox` gives it an opaque origin with no script, so it can read nothing of the
 * app (no cookie, storage, or API answer); it loads nothing from anywhere, and its forms post only to this server. A
 * form can reach no route of the app's API, which takes only requests with the `X-Pocket` header. No referrer, so the
 * address does not leak to a page it links to; no cache, and no search engine.
 */
export const LINK_HEADERS: Readonly<Record<string, string>> = {
    "content-security-policy":
        "sandbox allow-forms; default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "x-frame-options": "DENY",
};

/** The page for a link that answers nothing, or a failure: the same for each, so an address tells nothing of others. */
function plainPage(title: string, text: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 48px 20px; color: #222; background: #f6f6f4; }
main { max-width: 34rem; margin: 0 auto; }
h1 { font-size: 1.3rem; }
@media (prefers-color-scheme: dark) { body { color: #eee; background: #161616; } }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body>
</html>
`;
}

function answerPage(response: ServerResponse, status: number, html: string): void {
    send(response, status, html, "text/html; charset=utf-8", { ...LINK_HEADERS });
}

const CLOSED_TITLE = "This link is not open";
const CLOSED_TEXT =
    "It may have closed, taken its answer already, or been ended. Ask whoever sent it for a new one.";

/** A posted form's fields: urlencoded text alone. The last of a name that comes twice counts. */
async function readForm(request: IncomingMessage, token: string): Promise<Record<string, string>> {
    const type = String(request.headers["content-type"] ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();

    if (type !== "application/x-www-form-urlencoded") {
        throw new HttpError(415, "This page takes a form.");
    }

    if (Number(request.headers["content-length"] ?? 0) > MAX_FORM) {
        throw new HttpError(413, "That is too long to send.");
    }

    if (reading >= MAX_READING || (readingBy.get(token) ?? 0) >= MAX_READING_LINK) {
        throw new HttpError(503, "Busy: try again in a moment.");
    }

    reading += 1;
    readingBy.set(token, (readingBy.get(token) ?? 0) + 1);

    // Past its time, the form is let go of without closing the connection, so the person gets a page that says why;
    // the answer closes the connection after it (`linkRoute`).
    let timer: NodeJS.Timeout | undefined;
    const tooLate = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            request.pause();
            reject(new HttpError(408, "The form took too long to arrive."));
        }, linkReads.timeoutMs);
    });
    const read = readBody(request, MAX_FORM);
    let body: Buffer;

    // The read that lost the race ends when the connection does; that is no error of anyone's.
    read.catch(() => {});

    try {
        body = await Promise.race([read, tooLate]);
    } catch (error) {
        if (error instanceof HttpError) {
            throw error;
        }

        throw new HttpError(400, "The form did not arrive whole.");
    } finally {
        clearTimeout(timer);
        reading -= 1;

        const left = (readingBy.get(token) ?? 1) - 1;

        if (left > 0) {
            readingBy.set(token, left);
        } else {
            readingBy.delete(token);
        }
    }

    const fields = [...new URLSearchParams(body.toString("utf8"))];

    if (fields.length > MAX_FIELDS) {
        throw new HttpError(413, "That form has too many fields.");
    }

    // `fromEntries` defines own properties: a field named `__proto__` is only a field.
    return Object.freeze(Object.fromEntries(fields));
}

export async function linkRoute(
    app: PocketApp,
    request: IncomingMessage,
    response: ServerResponse,
    token: string | undefined,
    url: URL,
): Promise<void> {
    const locale = pageLocale(app, request, url);
    const method = request.method === "HEAD" ? "GET" : request.method;

    if (method !== "GET" && method !== "POST") {
        response.setHeader("allow", "GET, HEAD, POST");

        return answerPage(response, 405, plainPage("Not here", "This page is only read or sent."));
    }

    const found = token === undefined ? undefined : await app.publicLinks.open(token);
    const page = found === undefined ? undefined : app.webs.publicPage(found.module);

    // A closed link, a token that names nothing, and a module turned off look the same.
    if (found === undefined || page === undefined) {
        return answerPage(response, 404, plainPage(CLOSED_TITLE, CLOSED_TEXT));
    }

    let { link } = found;
    let form: Record<string, string> = Object.freeze({});
    let claimed = false;

    if (method === "POST") {
        try {
            form = await readForm(request, link.token);
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 400;

            // What is left of a body that took too long is not read: the connection closes after this page.
            if (status === 408) {
                response.setHeader("connection", "close");
            }

            return answerPage(
                response,
                status,
                plainPage("Not sent", error instanceof HttpError ? error.message : "Try again."),
            );
        }

        // One answer counts before the module sees it, so two posts at once to a link for one answer let in one.
        const counted = await app.publicLinks.claim(link.token);

        if (counted === undefined) {
            return answerPage(response, 410, plainPage(CLOSED_TITLE, CLOSED_TEXT));
        }

        link = counted;
        claimed = true;
    }

    // The module may have been turned off or replaced while the form arrived: only the version that is on answers.
    const current = app.webs.publicPage(found.module);
    const busy = running >= MAX_RUNNING || (runningBy.get(link.token) ?? 0) >= MAX_RUNNING_LINK;

    if (current?.part !== page.part || busy) {
        if (claimed) {
            await app.publicLinks.refund(link.token).catch(() => {});
        }

        return busy
            ? answerPage(response, 503, plainPage("Busy", "Try again in a moment."))
            : answerPage(response, 404, plainPage(CLOSED_TITLE, CLOSED_TEXT));
    }

    running += 1;
    runningBy.set(link.token, (runningBy.get(link.token) ?? 0) + 1);

    const gone = new AbortController();
    const done = new AbortController();
    const context = withAbortSignal(done.signal, BACKGROUND_CONTEXT);

    response.once("close", () => {
        if (!response.writableFinished) {
            gone.abort();
            done.abort();
        }
    });

    const input: PublicPageRequest = {
        locale,
        method,
        link: Object.freeze(link),
        query: url.searchParams,
        form,
        signal: gone.signal,
        context,
        snapshot: (async (...args: unknown[]) => {
            args[args.length - 1] = context;

            return Reflect.apply(app.harness.snapshot, app.harness, args);
        }) as DocumentReader["snapshot"],
        commit: (change) => app.harness.commit(change, context),
    };

    let status = 200;
    let html: string;
    let deadline: NodeJS.Timeout | undefined;
    // Past its time, or when the browser goes, the handler is not waited for: a handler that ignores the abort must not
    // keep its place among those running. What it does after is refused (its context has ended), and a late failure is
    // only logged.
    const stopped = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
            // First the reason, then the aborts: a promise settles once.
            reject(new HttpError(504, "This page took too long. Try again later."));
            gone.abort();
            done.abort();
        }, linkReads.handlerMs);
        gone.signal.addEventListener("abort", () =>
            reject(new HttpError(499, "The browser stopped waiting.")),
        );
    });

    stopped.catch(() => {});

    try {
        const handled = Promise.resolve().then(() => page.handle(Object.freeze(input)));

        handled.catch((error: unknown) => {
            if (done.signal.aborted) {
                app.log(
                    `${page.part.file}: a public page failed after it was stopped: ${describe(error)}`,
                );
            }
        });

        const answer = await Promise.race([handled, stopped]);

        if (typeof answer === "string") {
            html = answer;
        } else if (
            typeof answer === "object" &&
            answer !== null &&
            typeof answer.html === "string" &&
            (answer.status === undefined ||
                (Number.isInteger(answer.status) && answer.status >= 200 && answer.status <= 599))
        ) {
            html = answer.html;
            status = answer.status ?? 200;
        } else {
            throw new Error("web.publicPage: answer with HTML, or { html, status }");
        }

        if (Buffer.byteLength(html) > MAX_PAGE) {
            throw new Error(`web.publicPage: a page is ${MAX_PAGE} bytes at most`);
        }
    } catch (error) {
        const exposed =
            exposedError(error) ??
            (error instanceof HttpError
                ? { status: error.status, message: error.message }
                : undefined);

        if (exposed === undefined) {
            app.log(`${page.part.file}: a public page failed: ${describe(error)}`);
        }

        status = exposed?.status ?? 500;
        html = plainPage(
            "Something went wrong",
            exposed?.message ?? "This page could not be shown. Try again later.",
        );
    } finally {
        clearTimeout(deadline);
        done.abort();
        running -= 1;

        const left = (runningBy.get(link.token) ?? 1) - 1;

        if (left > 0) {
            runningBy.set(link.token, left);
        } else {
            runningBy.delete(link.token);
        }
    }

    // A post the page refused gave no answer: it does not use up the link, and the person can try again.
    if (claimed && status >= 400) {
        await app.publicLinks.refund(link.token).catch((error: unknown) => {
            app.log(`A public link's use was not given back: ${describe(error)}`);
        });
    }

    if (response.destroyed || response.writableEnded) {
        return;
    }

    answerPage(response, status, html);
}
