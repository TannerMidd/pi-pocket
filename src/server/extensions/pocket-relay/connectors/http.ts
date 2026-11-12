/** The relay's generic HTTP connector: polls a JSON address for new items, and can reply with a request. */
import { createHash } from "node:crypto";
import { keyOf, readCapped } from "./rss.ts";
import {
    RelayError,
    type RelayConnector,
    type RelayContext,
    type RelayEvent,
    type RelayField,
    type RelayReply,
    type RelayValues,
} from "../types.ts";

const SEEN_LIMIT = 2000;
const MAX_ITEMS = 500;
const DEFAULT_REPLY_BODY = '{"text": {{text}}}';
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const fields: readonly RelayField[] = [
    {
        name: "url",
        label: "Address",
        type: "text",
        required: true,
        placeholder: "https://example.com/api/messages",
        description: "The address to poll. It must answer with JSON.",
    },
    {
        name: "headers",
        label: "Headers",
        type: "secret",
        multiline: true,
        description:
            "One Name: value on each line, for example Authorization: Bearer … . Sent with every poll.",
    },
    {
        name: "interval",
        label: "Seconds between polls",
        type: "number",
        default: 60,
        min: 10,
        max: 86400,
    },
    {
        name: "itemsPath",
        label: "Items path",
        type: "text",
        placeholder: "data.messages",
        description:
            "Dot path to the list in the answer. Leave empty when the answer is the list. The list must run oldest first: the connector delivers new items in the order the API lists them.",
    },
    {
        name: "idField",
        label: "Id field",
        type: "text",
        default: "id",
        description: "Dot path in an item to its unique id.",
    },
    {
        name: "authorIdField",
        label: "Author id field",
        type: "text",
        description: "Optional. Dot path in an item to the author's id.",
    },
    {
        name: "authorNameField",
        label: "Author name field",
        type: "text",
        description: "Optional. Dot path in an item to the author's name.",
    },
    {
        name: "channelField",
        label: "Channel field",
        type: "text",
        description: "Optional. Dot path in an item to the channel a reply goes to.",
    },
    {
        name: "textTemplate",
        label: "Text template",
        type: "text",
        default: "{{text}}",
        description: "The text of an event. {{a.b}} is replaced with that dot path of the item.",
    },
    {
        name: "cursorParam",
        label: "Cursor parameter",
        type: "text",
        description:
            "Optional. The query parameter that carries the cursor. Use it with the cursor field. Without both, the connector remembers the ids it has seen (up to 1000).",
    },
    {
        name: "cursorField",
        label: "Cursor field",
        type: "text",
        description:
            "Optional. Dot path in an item. The last item's value is sent as the cursor parameter on the next poll.",
    },
    {
        name: "replyUrl",
        label: "Reply address",
        type: "text",
        description:
            "Optional. Where a reply goes. {{channel}}, {{thread}} and {{replyTo}} are filled in, URL-encoded. Without it, this connector cannot reply.",
    },
    {
        name: "replyMethod",
        label: "Reply method",
        type: "choice",
        default: "POST",
        choices: [
            { value: "POST", label: "POST" },
            { value: "PUT", label: "PUT" },
        ],
    },
    {
        name: "replyHeaders",
        label: "Reply headers",
        type: "secret",
        multiline: true,
        description: "One Name: value on each line, sent with a reply.",
    },
    {
        name: "replyBody",
        label: "Reply body",
        type: "textarea",
        default: DEFAULT_REPLY_BODY,
        description:
            "A JSON template. {{text}}, {{channel}}, {{thread}}, {{replyTo}} and {{key}} are filled in as JSON strings, quotes included.",
    },
];

function text(values: RelayValues, name: string): string {
    const value = values[name];

    return typeof value === "string" ? value.trim() : "";
}

/** Parse "Name: value" lines. Returns the headers, or a problem in words (it never repeats a value). */
function parseHeaders(raw: string, label: string): Record<string, string> | string {
    const headers: Record<string, string> = {};
    const lines = raw.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
        if (line.trim() === "") {
            continue;
        }

        const colon = line.indexOf(":");
        const name = colon > 0 ? line.slice(0, colon).trim() : "";

        if (!HEADER_NAME.test(name)) {
            return `${label}, line ${index + 1}: write each header as Name: value.`;
        }

        const value = line.slice(colon + 1).trim();

        if (/[\r\n\0]/.test(value)) {
            return `${label}, line ${index + 1}: the value is not valid.`;
        }

        headers[name] = value;
    }

    return headers;
}

function pick(source: unknown, path: string): unknown {
    let current = source;

    for (const part of path.split(".")) {
        if (part === "") {
            continue;
        }

        if (current === null || typeof current !== "object") {
            return undefined;
        }

        current = (current as Record<string, unknown>)[part];
    }

    return current;
}

function asText(value: unknown): string {
    if (value === undefined || value === null) {
        return "";
    }

    return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function fillTemplate(template: string, item: unknown): string {
    return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path: string) =>
        asText(pick(item, path)),
    );
}

/** One pass, so a value that holds `{{key}}` is not filled in again. */
function fillReply(
    template: string,
    data: Record<string, string>,
    encode: (value: string) => string,
): string {
    return template.replace(/\{\{\s*(text|channel|thread|replyTo|key)\s*\}\}/g, (_match, name) =>
        encode(data[name as string] ?? ""),
    );
}

/** A value in the reply address: `.` and `..` would change the path, and a URL reads `%2E` the same way. */
const encodePart = (value: string): string => {
    if (value === "." || value === "..") {
        throw new Error("The reply address cannot take a value of . or ..");
    }

    return encodeURIComponent(value);
};

const SAMPLE = { text: "x", channel: "x", thread: "x", replyTo: "x", key: "x" };

function checkUrl(value: string, label: string): string | undefined {
    try {
        const url = new URL(value);

        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return `${label} must start with http:// or https://.`;
        }
    } catch {
        return `${label} is not a valid address.`;
    }

    return undefined;
}

function retryAfterOf(response: Response): number {
    const header = response.headers.get("retry-after");
    const seconds = header === null ? NaN : Number(header);

    if (Number.isFinite(seconds)) {
        return Math.max(1, seconds) * 1000;
    }

    const date = header === null ? NaN : Date.parse(header);

    return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : 60_000;
}

/** Throws the right error for a bad answer. The message never holds a header value or the address. */
function failOn(response: Response, what: string): never {
    if (response.status === 401 || response.status === 403) {
        throw new RelayError(
            `${what} was refused (${response.status}). Check the headers and the permission.`,
            { fatal: true },
        );
    }

    if (response.status === 429) {
        throw new RelayError(`${what} was rate limited (429).`, {
            retryAfter: retryAfterOf(response),
        });
    }

    throw new Error(`${what} failed with status ${response.status}.`);
}

const MAX_REDIRECTS = 5;

/** Follows a redirect to the same origin only: another origin would get the custom headers. */
async function fetchSameOrigin(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
): Promise<Response> {
    let target = url;
    let next = init;

    for (let hops = 0; ; hops += 1) {
        const response = await fetch(target, { ...next, redirect: "manual", signal });
        const location = response.headers.get("location");

        if (response.status < 300 || response.status >= 400 || location === null) {
            return response;
        }

        const to = new URL(location, target);

        if (to.origin !== new URL(target).origin) {
            throw new RelayError(
                "The server redirected to another address, which is not followed.",
            );
        }

        if (hops >= MAX_REDIRECTS) {
            throw new RelayError("The server redirected too many times.");
        }

        void response.body?.cancel();
        target = to.toString();

        if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) && next.method === "POST")
        ) {
            next = { ...next, method: "GET", body: undefined };
        }
    }
}

async function send(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
        return await fetchSameOrigin(
            url,
            init,
            AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        );
    } catch (error) {
        if (error instanceof RelayError) {
            throw error;
        }

        if (signal.aborted) {
            throw error;
        }

        const name = error instanceof Error ? error.name : "";

        throw new Error(
            name === "TimeoutError"
                ? "The request timed out."
                : "The request could not reach the server. Check the address.",
        );
    }
}

function check(values: RelayValues): string | undefined {
    const url = text(values, "url");

    if (url === "") {
        return "Address is required.";
    }

    const bad = checkUrl(url, "Address");

    if (bad !== undefined) {
        return bad;
    }

    const headers = parseHeaders(text(values, "headers"), "Headers");

    if (typeof headers === "string") {
        return headers;
    }

    if ((text(values, "cursorParam") === "") !== (text(values, "cursorField") === "")) {
        return "Set both the cursor parameter and the cursor field, or neither.";
    }

    const replyUrl = text(values, "replyUrl");

    if (replyUrl === "") {
        return undefined;
    }

    const badReply = checkUrl(fillReply(replyUrl, SAMPLE, encodeURIComponent), "Reply address");

    if (badReply !== undefined) {
        return badReply;
    }

    const replyHeaders = parseHeaders(text(values, "replyHeaders"), "Reply headers");

    if (typeof replyHeaders === "string") {
        return replyHeaders;
    }

    try {
        JSON.parse(
            fillReply(text(values, "replyBody") || DEFAULT_REPLY_BODY, SAMPLE, JSON.stringify),
        );
    } catch {
        return "Reply body is not valid JSON once {{text}} and the other names are filled in.";
    }

    return undefined;
}

function toEvent(item: unknown, values: RelayValues, url: string): RelayEvent | undefined {
    const idField = text(values, "idField") || "id";
    const rawId = pick(item, idField);
    const id =
        rawId === undefined || rawId === null || typeof rawId === "object"
            ? createHash("sha1")
                  .update(JSON.stringify(item) ?? "")
                  .digest("hex")
                  .slice(0, 20)
            : String(rawId);
    const authorIdField = text(values, "authorIdField");
    const authorNameField = text(values, "authorNameField");
    const channelField = text(values, "channelField");
    const authorId = authorIdField === "" ? "" : asText(pick(item, authorIdField));
    const authorName = authorNameField === "" ? "" : asText(pick(item, authorNameField));
    const channel = channelField === "" ? "" : asText(pick(item, channelField));
    const host = new URL(url).host;
    const body = fillTemplate(text(values, "textTemplate") || "{{text}}", item).trim();

    return {
        id,
        text: body,
        author: { id: authorId || authorName || host, name: authorName || authorId || host },
        ...(channel === "" ? {} : { channel }),
    };
}

async function poll(context: RelayContext): Promise<void> {
    const { values } = context;
    const base = text(values, "url");
    const headers = parseHeaders(text(values, "headers"), "Headers");

    if (typeof headers === "string") {
        throw new RelayError(headers, { fatal: true });
    }

    const cursorParam = text(values, "cursorParam");
    const cursorField = text(values, "cursorField");
    const useCursor = cursorParam !== "" && cursorField !== "";
    const state = context.state;
    const baseline = state.started !== true;
    const cursor = typeof state.cursor === "string" ? state.cursor : "";
    const target = new URL(base);

    if (useCursor && cursor !== "") {
        target.searchParams.set(cursorParam, cursor);
    }

    const response = await send(
        target.toString(),
        { headers: { accept: "application/json", ...headers } },
        context.signal,
    );

    if (!response.ok) {
        failOn(response, "The poll");
    }

    const raw = await readCapped(response);
    let data: unknown;

    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error("The answer is not valid JSON.");
    }

    const itemsPath = text(values, "itemsPath");
    const whole = itemsPath === "" ? data : pick(data, itemsPath);

    if (!Array.isArray(whole)) {
        throw new Error("The items path does not point to a list in the answer.");
    }

    const last: unknown = whole.length > 0 ? whole[whole.length - 1] : undefined;
    const lastCursor = useCursor && last !== undefined ? asText(pick(last, cursorField)) : "";
    const nextCursor = lastCursor === "" ? cursor : lastCursor;
    // The list runs oldest first: without a cursor, the newest MAX_ITEMS are the ones to watch.
    const list = useCursor ? whole : whole.slice(-MAX_ITEMS);
    const events = list.flatMap((item) => {
        const event = toEvent(item, values, base);

        return event === undefined ? [] : [event];
    });

    if (useCursor) {
        if (!baseline && events.length > 0) {
            await context.emit(events);
        }

        context.save({ started: true, cursor: nextCursor });

        return;
    }

    const seen = Array.isArray(state.seen) ? (state.seen as string[]) : [];
    const known = new Set(seen);
    const once = new Set<string>();
    const fresh = events.filter((event) => {
        const first = !once.has(event.id);

        once.add(event.id);

        return first && !known.has(keyOf(event.id)) && !known.has(event.id);
    });

    if (!baseline && fresh.length > 0) {
        await context.emit(fresh);
    }

    const current = new Set(events.map((event) => keyOf(event.id)).reverse());

    context.save({
        started: true,
        seen: [...current, ...seen.filter((key) => !current.has(key))].slice(0, SEEN_LIMIT),
    });
}

async function reply(
    context: Pick<RelayContext, "values" | "signal" | "log">,
    message: RelayReply,
): Promise<{ id?: string } | void> {
    const { values } = context;
    const replyUrl = text(values, "replyUrl");

    if (replyUrl === "") {
        throw new Error("This connector has no reply address.");
    }

    const headers = parseHeaders(text(values, "replyHeaders"), "Reply headers");

    if (typeof headers === "string") {
        throw new RelayError(headers, { fatal: true });
    }

    const data = {
        text: message.text,
        channel: message.to?.channel ?? message.channel ?? "",
        thread: message.to?.thread ?? message.thread ?? "",
        replyTo: message.to?.id ?? "",
        key: message.key,
    };
    const url = fillReply(replyUrl, data, encodePart);
    const body = fillReply(text(values, "replyBody") || DEFAULT_REPLY_BODY, data, JSON.stringify);
    const response = await send(
        url,
        {
            method: text(values, "replyMethod") === "PUT" ? "PUT" : "POST",
            headers: {
                "content-type": "application/json",
                ...headers,
                "Idempotency-Key": message.key,
            },
            body,
        },
        context.signal,
    );

    if (!response.ok) {
        failOn(response, "The reply");
    }

    try {
        const id = pick(JSON.parse(await readCapped(response)), "id");

        return typeof id === "string" || typeof id === "number" ? { id: String(id) } : undefined;
    } catch {
        return undefined;
    }
}

const connector: RelayConnector = {
    kind: "http",
    label: "HTTP (JSON)",
    description: "Polls any JSON address for new items, and can send a reply with a request.",
    shape: "poll",
    interval: 60,
    fields,
    check,
    poll,
    reply,
};

export default connector;
