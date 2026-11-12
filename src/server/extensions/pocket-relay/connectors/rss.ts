/** The relay's RSS and Atom connector: polls a feed address and delivers the items it has not seen. */
import { createHash } from "node:crypto";
import {
    RelayError,
    type RelayConnector,
    type RelayContext,
    type RelayEvent,
    type RelayValues,
} from "../types.ts";

const SEEN_LIMIT = 2000;
const MAX_ITEMS = 500;
const MAX_BODY = 5_000_000;
const SUMMARY_LIMIT = 1500;

const ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
};

function decode(value: string): string {
    return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (match, dec, hex, name) => {
        if (name !== undefined) {
            return ENTITIES[name as string] ?? match;
        }

        const code = dec !== undefined ? Number(dec) : parseInt(hex as string, 16);

        try {
            return String.fromCodePoint(code);
        } catch {
            return match;
        }
    });
}

/** The text of an element's content: CDATA as it is, the rest with entities decoded. */
function plain(raw: string): string {
    return raw.includes("<![CDATA[") ? unwrap(raw) : decode(raw);
}

/** Every scan below walks the text once, so no input can make it quadratic. */
function unwrap(raw: string): string {
    let out = "";
    let from = 0;

    for (;;) {
        const start = raw.indexOf("<![CDATA[", from);
        const end = start === -1 ? -1 : raw.indexOf("]]>", start + 9);

        if (end === -1) {
            return out + raw.slice(from);
        }

        out += raw.slice(from, start) + raw.slice(start + 9, end);
        from = end + 3;
    }
}

const BREAKS = /(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b/iy;

function stripTags(value: string): string {
    let out = "";
    let from = 0;

    for (let open = value.indexOf("<"); open !== -1; open = value.indexOf("<", from)) {
        const close = value.indexOf(">", open);

        if (close === -1) {
            break;
        }

        BREAKS.lastIndex = open + 1;
        out += value.slice(from, open) + (BREAKS.test(value) ? "\n" : "");
        from = close + 1;
    }

    return out + value.slice(from);
}

/** A title: markup inside CDATA is removed, and escaped text stays as it is. */
function heading(raw: string): string {
    return (raw.includes("<![CDATA[") ? stripTags(plain(raw)) : plain(raw))
        .replace(/\s+/g, " ")
        .trim();
}

/** The text of an HTML element's content, without tags. */
function html(raw: string): string {
    const stripped = stripTags(plain(raw));

    return decode(stripped)
        .replace(/[ \t\u00a0]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

const TAG = /<(\/?)([^\s<>/]*)([^<>]*)>/g;

interface Link {
    attributes: string;
    text: string;
}

/**
 * The raw content of the first `<name>` for each wanted name (lower case), and every `<link>`, in one pass over
 * the tags. An element with no end tag is left out.
 */
function scan(block: string, wanted: ReadonlySet<string>) {
    const tag = new RegExp(TAG.source, "g");
    const starts = new Map<string, number>();
    const found = new Map<string, string>();
    const links: Link[] = [];
    let inner: Link[] = [];
    let pending: { attributes: string; start: number } | undefined;

    for (let match = tag.exec(block); match !== null; match = tag.exec(block)) {
        const name = (match[2] ?? "").toLowerCase();
        const attributes = match[3] ?? "";

        if (!wanted.has(name)) {
            continue;
        }

        if (match[1] === "/") {
            if (attributes.trim() !== "") {
                continue;
            }

            if (name === "link" && pending !== undefined) {
                links.push({
                    attributes: pending.attributes,
                    text: block.slice(pending.start, match.index),
                });
                pending = undefined;
                inner = [];
            } else if (starts.has(name) && !found.has(name)) {
                found.set(name, block.slice(starts.get(name), match.index));
            }
        } else if (name === "link") {
            if (attributes.endsWith("/")) {
                (pending === undefined ? links : inner).push({
                    attributes: attributes.slice(0, -1),
                    text: "",
                });
            } else if (pending === undefined) {
                pending = { attributes, start: tag.lastIndex };
            }
        } else if (!starts.has(name) && (attributes === "" || /^\s/.test(attributes))) {
            starts.set(name, tag.lastIndex);
        }
    }

    return { found, links: pending === undefined ? links : [...links, ...inner] };
}

/** The raw content of the first `<name>`, or undefined. */
function element(block: string, name: string): string | undefined {
    const lower = name.toLowerCase();

    return scan(block, new Set([lower])).found.get(lower);
}

function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function pickLink(links: Link[]): string | undefined {
    const found: { rel: string; value: string }[] = [];

    for (const { attributes, text } of links) {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
        const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
        const value = nonEmpty(href === null ? plain(text) : decode(href[1] ?? href[2] ?? ""));

        if (value !== undefined) {
            found.push({ rel: rel === null ? "alternate" : (rel[1] ?? rel[2] ?? ""), value });
        }
    }

    return (found.find((entry) => entry.rel === "alternate") ?? found[0])?.value;
}

interface FeedItem {
    id: string;
    title: string;
    summary: string;
    link: string | undefined;
    author: string | undefined;
    at: number | undefined;
}

const ITEM_NAMES = new Set([
    "title",
    "author",
    "dc:creator",
    "pubdate",
    "published",
    "updated",
    "dc:date",
    "description",
    "summary",
    "content:encoded",
    "content",
    "guid",
    "id",
    "link",
]);

function parseItem(block: string): FeedItem {
    const { found, links } = scan(block, ITEM_NAMES);
    const title = heading(found.get("title") ?? "");
    const authorBlock = found.get("author");
    const author = nonEmpty(
        authorBlock === undefined
            ? plain(found.get("dc:creator") ?? "")
            : plain(element(authorBlock, "name") ?? authorBlock),
    );
    const date = nonEmpty(
        plain(
            found.get("pubdate") ??
                found.get("published") ??
                found.get("updated") ??
                found.get("dc:date") ??
                "",
        ),
    );
    const summary = html(
        found.get("description") ??
            found.get("summary") ??
            found.get("content:encoded") ??
            found.get("content") ??
            "",
    );
    const href = pickLink(links);
    const id =
        nonEmpty(plain(found.get("guid") ?? "")) ??
        nonEmpty(plain(found.get("id") ?? "")) ??
        href ??
        createHash("sha1")
            .update(`${title}\n${date ?? ""}`)
            .digest("hex")
            .slice(0, 20);
    const parsed = date === undefined ? NaN : Date.parse(date);

    return {
        id,
        title,
        summary,
        link: href,
        author,
        at: Number.isFinite(parsed) ? parsed : undefined,
    };
}

const CLOSE_ITEM = /<\/item\s*>/gi;
const CLOSE_ENTRY = /<\/entry\s*>/gi;

/** The items of an RSS or Atom document, in the order they come, and the feed's own title. */
export function parseFeed(xml: string): { title: string | undefined; items: FeedItem[] } {
    // One pass: an item that never closes ends the scan, so the work stays linear.
    const open = /<(item|entry)\b[^<>]*>/gi;
    const bodies: string[] = [];
    let head = "";
    let from = 0;

    for (let match = open.exec(xml); match !== null; match = open.exec(xml)) {
        const close = match[1]!.toLowerCase() === "item" ? CLOSE_ITEM : CLOSE_ENTRY;

        close.lastIndex = open.lastIndex;

        const ended = close.exec(xml);

        if (ended === null) {
            break;
        }

        head += xml.slice(from, match.index);
        from = close.lastIndex;
        open.lastIndex = from;

        if (bodies.length < MAX_ITEMS) {
            bodies.push(xml.slice(match.index + match[0].length, ended.index));
        }
    }

    head += xml.slice(from);

    if (bodies.length === 0 && !/<(?:rss|feed|rdf:RDF)\b/i.test(xml)) {
        throw new Error("The answer is not an RSS or Atom feed.");
    }

    return {
        title: nonEmpty(heading(element(head, "title") ?? "")),
        items: bodies.map(parseItem),
    };
}

/** Reads an answer's text, and refuses one larger than `max` bytes, so one answer cannot fill the memory. */
export async function readCapped(response: Response, max = MAX_BODY): Promise<string> {
    const declared = Number(response.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > max) {
        throw new Error("The answer is too large.");
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    while (reader !== undefined) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        size += value.byteLength;

        if (size > max) {
            void reader.cancel();

            throw new Error("The answer is too large.");
        }

        chunks.push(value);
    }

    return Buffer.concat(chunks).toString("utf8");
}

/** An id is kept as a short hash: 2,000 URLs would pass the 64 KB the relay keeps for a connector. */
export const keyOf = (id: string): string =>
    createHash("sha1").update(id).digest("base64url").slice(0, 16);

function retryAfterOf(response: Response): number {
    const header = response.headers.get("retry-after");
    const seconds = header === null ? NaN : Number(header);

    if (Number.isFinite(seconds)) {
        return Math.max(1, seconds) * 1000;
    }

    const date = header === null ? NaN : Date.parse(header);

    return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : 60_000;
}

function check(values: RelayValues): string | undefined {
    const value = typeof values.url === "string" ? values.url.trim() : "";

    if (value === "") {
        return "Address is required.";
    }

    try {
        const url = new URL(value);

        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return "Address must start with http:// or https://.";
        }
    } catch {
        return "Address is not a valid address.";
    }

    return undefined;
}

function cut(value: string): string {
    return value.length > SUMMARY_LIMIT ? `${value.slice(0, SUMMARY_LIMIT).trimEnd()}…` : value;
}

async function poll(context: RelayContext): Promise<void> {
    const address = String(context.values.url ?? "").trim();
    const state = context.state;
    const headers: Record<string, string> = {
        accept: "application/atom+xml, application/rss+xml, application/xml, text/xml, */*;q=0.5",
        "user-agent": "PiPocket-Relay",
    };

    if (typeof state.etag === "string") {
        headers["if-none-match"] = state.etag;
    }

    if (typeof state.lastModified === "string") {
        headers["if-modified-since"] = state.lastModified;
    }

    let response: Response;

    try {
        response = await fetch(address, {
            headers,
            signal: AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]),
        });
    } catch (error) {
        if (context.signal.aborted) {
            throw error;
        }

        throw new Error(
            error instanceof Error && error.name === "TimeoutError"
                ? "The feed request timed out."
                : "The feed could not be reached. Check the address.",
        );
    }

    if (response.status === 304) {
        return;
    }

    if (response.status === 401 || response.status === 403) {
        throw new RelayError(`The feed refused the request (${response.status}).`, {
            fatal: true,
        });
    }

    if (response.status === 429) {
        throw new RelayError("The feed rate limited the request (429).", {
            retryAfter: retryAfterOf(response),
        });
    }

    if (!response.ok) {
        throw new Error(`The feed failed with status ${response.status}.`);
    }

    const feed = parseFeed(await readCapped(response));
    const host = new URL(address).host;
    const seen = Array.isArray(state.seen) ? (state.seen as string[]) : undefined;
    const known = new Set(seen ?? []);
    const keys = new Set<string>();
    const ids = new Set<string>();
    const fresh: FeedItem[] = [];

    for (const item of feed.items) {
        if (!ids.has(item.id) && !known.has(keyOf(item.id)) && !known.has(item.id)) {
            fresh.push(item);
        }

        ids.add(item.id);
        keys.add(keyOf(item.id));
    }

    fresh.reverse();

    if (fresh.every((item) => item.at !== undefined)) {
        fresh.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    }

    if (seen !== undefined && fresh.length > 0) {
        const events: RelayEvent[] = fresh.map((item) => ({
            id: item.id,
            text: [item.title, cut(item.summary), item.link]
                .filter((part): part is string => part !== undefined && part !== "")
                .join("\n\n"),
            author: { id: host, name: item.author ?? feed.title ?? host },
            ...(item.link === undefined ? {} : { url: item.link }),
            ...(item.at === undefined ? {} : { at: item.at }),
        }));

        await context.emit(events);
    }

    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");

    context.save({
        seen: [...keys, ...(seen ?? []).filter((key) => !keys.has(key))].slice(0, SEEN_LIMIT),
        ...(etag === null ? {} : { etag }),
        ...(lastModified === null ? {} : { lastModified }),
    });
}

const connector: RelayConnector = {
    kind: "rss",
    label: "RSS / Atom feed",
    description: "Delivers the new items of an RSS or Atom feed.",
    shape: "poll",
    interval: 900,
    fields: [
        {
            name: "url",
            label: "Feed address",
            type: "text",
            required: true,
            placeholder: "https://example.com/feed.xml",
        },
        {
            name: "interval",
            label: "Seconds between polls",
            type: "number",
            default: 900,
            min: 60,
            max: 86400,
        },
    ],
    check,
    poll,
};

export default connector;
