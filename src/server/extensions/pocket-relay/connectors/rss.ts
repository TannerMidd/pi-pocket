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

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

/** The text of an element's content: CDATA as it is, the rest with entities decoded. */
function plain(raw: string): string {
    return raw.includes("<![CDATA[") ? raw.replace(CDATA, "$1") : decode(raw);
}

function stripTags(value: string): string {
    return value
        .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
        .replace(/<[^>]*>/g, "");
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

function escapeName(name: string): string {
    return name.replace(/[.*+?^${}()|[\]\\:-]/g, "\\$&");
}

/** The raw content of the first `<name>`, or undefined. */
function element(block: string, name: string): string | undefined {
    const match = new RegExp(
        `<${escapeName(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeName(name)}\\s*>`,
        "i",
    ).exec(block);

    return match === null ? undefined : match[1];
}

function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function link(block: string): string | undefined {
    const found: { rel: string; value: string }[] = [];

    for (const match of block.matchAll(/<link\b([^>]*?)(?:\/>|>([\s\S]*?)<\/link\s*>)/gi)) {
        const attributes = match[1] ?? "";
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
        const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
        const value = nonEmpty(
            href === null ? plain(match[2] ?? "") : decode(href[1] ?? href[2] ?? ""),
        );

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

function parseItem(block: string): FeedItem {
    const title = heading(element(block, "title") ?? "");
    const authorBlock = element(block, "author");
    const author = nonEmpty(
        authorBlock === undefined
            ? plain(element(block, "dc:creator") ?? "")
            : plain(element(authorBlock, "name") ?? authorBlock),
    );
    const date = nonEmpty(
        plain(
            element(block, "pubDate") ??
                element(block, "published") ??
                element(block, "updated") ??
                element(block, "dc:date") ??
                "",
        ),
    );
    const summary = html(
        element(block, "description") ??
            element(block, "summary") ??
            element(block, "content:encoded") ??
            element(block, "content") ??
            "",
    );
    const href = link(block);
    const id =
        nonEmpty(plain(element(block, "guid") ?? "")) ??
        nonEmpty(plain(element(block, "id") ?? "")) ??
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

/** The items of an RSS or Atom document, in the order they come, and the feed's own title. */
export function parseFeed(xml: string): { title: string | undefined; items: FeedItem[] } {
    // One pass: an item that never closes ends the scan, so the work stays linear.
    const open = /<(item|entry)\b[^<>]*>/gi;
    const bodies: string[] = [];
    let head = "";
    let from = 0;

    for (let match = open.exec(xml); match !== null; match = open.exec(xml)) {
        const close = new RegExp(`</${match[1]}\\s*>`, "gi");

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
