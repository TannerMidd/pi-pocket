/** Pure readers for Pi session files. Neither the server nor the runner writes these files. */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Message } from "@earendil-works/pi-ai";
import {
    buildSessionProjection,
    convertToLlm,
    CURRENT_SESSION_VERSION,
    migrateSessionEntries,
    parseSessionEntries,
    type FileEntry,
    type SessionEntry,
    type SessionHeader,
    sessionEntryToContextMessages,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";
/** Pi's variable for its sessions folder (`ENV_SESSION_DIR` in its config, which the package does not export). */
export const SESSION_DIR_VARIABLE = "PI_CODING_AGENT_SESSION_DIR";
/** How long a list of Pi's sessions answers "is this one of them?" for a preview or a continue after it. */
export const FOUND_FOR_MS = 5_000;
/** How many sessions a list holds, newest first: a search looks through them all first. */
export const MAX_LISTED = 300;
/** How many of its last messages a session's preview shows. */
const PREVIEW_MESSAGES = 6;
const PREVIEW_TEXT = 600;
/** How much of a file a preview reads at a time, from its end. */
const TAIL_CHUNK = 1024 * 1024;
/** How much of a file's start holds its header line, at most. */
const HEADER_BYTES = 64 * 1024;
const TITLE_LENGTH = 80;
/** What a tool call that never finished in Pi gets as its result. */
const NOT_RUN = "Not run: the Pi session ended before this call finished.";

/** A message of the copy, in order: what it is, and the entry of Pi's it comes from (none for a result made here). */
export type PiEntry =
    | { kind: "user" | "assistant" | "toolResult"; from?: string; message: Message }
    /** `head`: the first entry of Pi's the compaction keeps, or null when it keeps none. */
    | { kind: "compaction"; from: string; head: string | null; message: Message };

/** A Pi session as it continues here. */
export type PiSession = {
    id: string;
    cwd: string;
    title: string;
    /** Message entries in the file, as `pi -r` counts them: more later means Pi went on in the terminal. */
    count: number;
    model: { provider: string; modelId: string } | null;
    thinkingLevel: string;
    entries: PiEntry[];
    /** Pi's context edits on the current branch: the entry of Pi's they change, and its messages for Pi (none: left out). */
    edits: { target: string; messages: Message[] }[];
};

/** A session file Pi Pocket cannot continue, and why, in words for people. */
export class PiSessionError extends Error {}

/**
 * The entries from the first to `leafId`, along `parentId`. A file whose entries lead back to one already passed is
 * damaged: Pi's own walk along them, which comes next, would never end.
 */
function branchTo(entries: readonly SessionEntry[], leafId: string): SessionEntry[] {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const path: SessionEntry[] = [];
    const seen = new Set<string>();

    for (
        let entry = byId.get(leafId);
        entry !== undefined;
        entry = entry.parentId === null ? undefined : byId.get(entry.parentId)
    ) {
        if (seen.has(entry.id)) {
            throw new PiSessionError(
                "This Pi session file is damaged: its entries lead in a circle.",
            );
        }

        seen.add(entry.id);
        path.push(entry);
    }

    return path.reverse();
}

/** The first of `sorted` (ascending) at or after `from`, or undefined. */
function firstFrom(sorted: readonly number[], from: number): number | undefined {
    let low = 0;
    let high = sorted.length;

    while (low < high) {
        const middle = (low + high) >> 1;

        if (sorted[middle]! < from) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return sorted[low];
}

/** What an entry of Pi's gives the model, as Pi sends it; Pi's system messages stay behind for Pi Pocket's own. */
function forModel(messages: Parameters<typeof convertToLlm>[0]): Message[] {
    return convertToLlm(messages).filter((message) => message.role !== "system");
}

/** The text of a message's text parts; none for a message without content, which old or edited files can have. */
function textOf(message: Message): string {
    if (typeof message.content === "string") {
        return message.content;
    }

    if (!Array.isArray(message.content)) {
        return "";
    }

    return message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim();
}

/**
 * A session file's entries, read a line at a time, as `parseSessionEntries` reads them: a line that is not JSON (a
 * last one cut off while Pi writes it) is skipped. A file is never held whole as text, so its size has no limit but
 * the memory its entries take: big files are mostly images, kept once as their entries' strings.
 */
export async function readSessionEntries(path: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    const lines = createInterface({
        input: createReadStream(path, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });

    for await (const line of lines) {
        if (line.trim() === "") {
            continue;
        }

        try {
            entries.push(JSON.parse(line));
        } catch {
            // As Pi reads it: the line is left out.
        }
    }

    return entries;
}

/**
 * A file's lines from its end, last first, read a chunk at a time: a preview needs only the last few messages, so a
 * big file is not read whole for them. A line is decoded once whole, so a character split between chunks stays whole.
 */
export async function* linesFromEnd(path: string): AsyncGenerator<string> {
    const handle = await open(path, "r");

    try {
        let position = (await handle.stat()).size;
        // The bytes of the line being read, from its first chunk read so far to its end.
        let rest: Buffer[] = [];

        while (position > 0) {
            const size = Math.min(TAIL_CHUNK, position);
            const part = Buffer.allocUnsafe(size);

            position -= size;

            // A file rewritten shorter while it is read (Pi migrates an old one in place) ends the walk: the rest of
            // the chunk would be memory never written, not the file.
            if ((await handle.read(part, 0, size, position)).bytesRead < size) {
                return;
            }

            let end = size;

            while (end > 0) {
                const at = part.lastIndexOf(10, end - 1);

                if (at === -1) {
                    break;
                }

                yield Buffer.concat([part.subarray(at + 1, end), ...rest]).toString("utf8");
                rest = [];
                end = at;
            }

            rest.unshift(part.subarray(0, end));
        }

        yield Buffer.concat(rest).toString("utf8");
    } finally {
        await handle.close();
    }
}

/** A file's first line, as JSON, or undefined when it is not. */
export async function firstEntry(path: string): Promise<FileEntry | undefined> {
    const handle = await open(path, "r");

    try {
        const start = Buffer.allocUnsafe(HEADER_BYTES);
        const { bytesRead } = await handle.read(start, 0, HEADER_BYTES, 0);
        const end = start.subarray(0, bytesRead).indexOf(10);

        return JSON.parse(start.subarray(0, end === -1 ? bytesRead : end).toString("utf8"));
    } catch {
        return undefined;
    } finally {
        await handle.close();
    }
}

/** Whether a session file's header is one this Pi Pocket reads; why not, in words for people. */
export function checkHeader(header: FileEntry | undefined): asserts header is SessionHeader {
    if (header?.type !== "session" || typeof header.id !== "string") {
        throw new PiSessionError("This is not a Pi session file.");
    }

    if ((header.version ?? 1) > CURRENT_SESSION_VERSION) {
        throw new PiSessionError("A newer Pi wrote this session. Update Pi Pocket to continue it.");
    }
}

/** What a preview shows of a session's current branch: its model, and its last messages with text, in order. */
export type Tail = {
    model: { provider: string; modelId: string } | null;
    last: { role: "user" | "assistant"; text: string }[];
};

/**
 * A session's tail, read from the end of its file: its current branch goes back from the last entry along
 * `parentId`, and a parent is always written before its children, so a walk back through the file finds the branch
 * in order and stops at the last few messages. Files from before entries had ids (version 1) are read whole.
 */
export async function readPiTail(path: string): Promise<Tail> {
    const header = await firstEntry(path);

    checkHeader(header);

    if ((header.version ?? 1) < 2) {
        const session = piSessionOf(await readSessionEntries(path));

        return { model: session.model, last: lastTexts(session.entries) };
    }

    let want: string | undefined;
    let model: Tail["model"] = null;
    const last: Tail["last"] = [];

    for await (const line of linesFromEnd(path)) {
        if (line.trim() === "") {
            continue;
        }

        let entry: SessionEntry | { type: "session" };

        try {
            entry = JSON.parse(line);
        } catch {
            // A line cut off, as a `pi` still writing it leaves it: as Pi reads it, it is not there.
            continue;
        }

        if (entry.type === "session") {
            break;
        }

        want ??= entry.id;

        if (entry.id !== want) {
            continue;
        }

        if (model === null && entry.type === "model_change") {
            model = { provider: entry.provider, modelId: entry.modelId };
        } else if (
            model === null &&
            entry.type === "message" &&
            entry.message.role === "assistant"
        ) {
            model = { provider: entry.message.provider, modelId: entry.message.model };
        }

        if (
            last.length < PREVIEW_MESSAGES &&
            (entry.type === "message" ||
                entry.type === "custom_message" ||
                entry.type === "branch_summary")
        ) {
            const texts = lastTexts(
                forModel(sessionEntryToContextMessages(entry)).map((message) => ({
                    kind: message.role as PiEntry["kind"],
                    message,
                })) as PiEntry[],
            );

            last.unshift(...texts.slice(-(PREVIEW_MESSAGES - last.length)));
        }

        if ((last.length >= PREVIEW_MESSAGES && model !== null) || entry.parentId === null) {
            break;
        }

        want = entry.parentId;
    }

    return { model, last };
}

/** The last messages of people and the agent with text, for a preview. */
export function lastTexts(entries: readonly PiEntry[]): Tail["last"] {
    return entries
        .flatMap((entry) => {
            if (entry.kind !== "user" && entry.kind !== "assistant") {
                return [];
            }

            const text = textOf(entry.message);

            return text === "" ? [] : [{ role: entry.kind, text: text.slice(0, PREVIEW_TEXT) }];
        })
        .slice(-PREVIEW_MESSAGES);
}

/** A Pi session's file, read: the conversation on its current branch, and what Pi's context of it is. */
export function readPiSession(text: string): PiSession {
    return piSessionOf(parseSessionEntries(text));
}

/** A Pi session from its file's entries, header first; they are changed (migrated) in place. */
export function piSessionOf(file: FileEntry[]): PiSession {
    const header = file[0];

    checkHeader(header);

    // In memory only: older files get the current format, as Pi gives them when it opens one.
    migrateSessionEntries(file);
    const all = file.slice(1) as SessionEntry[];
    const leaf = all.at(-1);
    const path = leaf === undefined ? [] : branchTo(all, leaf.id);
    const projection = buildSessionProjection(all, leaf?.id);
    const entries: PiEntry[] = [];
    // Where each entry is on the branch, and where those that became messages here are (in order): a compaction finds
    // the first it keeps without a scan, so a file with many compactions reads in time that grows with its length.
    const at = new Map(path.map((entry, index) => [entry.id, index]));
    const copied: number[] = [];
    // Tool calls of the last assistant message without a result yet.
    const open = new Map<string, { name: string; timestamp: number }>();

    const closeOpen = () => {
        for (const [toolCallId, call] of open) {
            entries.push({
                kind: "toolResult",
                message: {
                    role: "toolResult",
                    toolCallId,
                    toolName: call.name,
                    content: [{ type: "text", text: NOT_RUN }],
                    isError: true,
                    timestamp: call.timestamp,
                },
            });
        }

        open.clear();
    };

    for (const [index, entry] of path.entries()) {
        if (entry.type === "compaction") {
            const summary = forModel(sessionEntryToContextMessages(entry))[0];
            const start = at.get(entry.firstKeptEntryId) ?? -1;
            // The first of the kept entries that is a message here, as Pi keeps them up to the compaction.
            const first = start === -1 || start > index ? undefined : firstFrom(copied, start);
            const kept = first === undefined || first >= index ? undefined : path[first];

            if (summary !== undefined) {
                entries.push({
                    kind: "compaction",
                    from: entry.id,
                    head: kept?.id ?? null,
                    message: summary,
                });
            }

            continue;
        }

        if (
            entry.type !== "message" &&
            entry.type !== "custom_message" &&
            entry.type !== "branch_summary"
        ) {
            continue;
        }

        for (const message of forModel(sessionEntryToContextMessages(entry))) {
            if (copied.at(-1) !== index) {
                copied.push(index);
            }

            if (message.role === "toolResult") {
                open.delete(message.toolCallId);
                entries.push({ kind: "toolResult", from: entry.id, message });
                continue;
            }

            closeOpen();

            if (message.role === "assistant") {
                for (const part of message.content) {
                    if (part.type === "toolCall") {
                        open.set(part.id, { name: part.name, timestamp: message.timestamp });
                    }
                }

                entries.push({ kind: "assistant", from: entry.id, message });
            } else if (message.role === "user") {
                entries.push({ kind: "user", from: entry.id, message });
            }
        }
    }

    closeOpen();

    // Where Pi's context of an entry differs from the entry, a context edit changed it: the copy edits it the same way.
    const edits = projection.entries.flatMap(({ sourceEntry, messages }) => {
        if (sourceEntry.type === "compaction") {
            return [];
        }

        const own = forModel(sessionEntryToContextMessages(sourceEntry));
        const seen = forModel(messages);

        return own.length === 0 || JSON.stringify(own) === JSON.stringify(seen)
            ? []
            : [{ target: sourceEntry.id, messages: seen }];
    });
    // As `pi -r` names it: its latest name, or what it was first asked.
    const named = all.findLast((entry) => entry.type === "session_info");
    const firstAsked = path.find(
        (entry) => entry.type === "message" && entry.message.role === "user",
    );
    const firstText =
        firstAsked?.type === "message" ? textOf(firstAsked.message as Message).split("\n")[0]! : "";
    const title =
        (named?.type === "session_info" ? named.name?.trim() : undefined) ||
        firstText.slice(0, TITLE_LENGTH).trim() ||
        "Pi session";

    return {
        id: header.id,
        cwd: header.cwd,
        title,
        count: all.filter((entry) => entry.type === "message").length,
        model: projection.model,
        thinkingLevel: projection.thinkingLevel,
        entries,
        edits,
    };
}

/** A session's title as `pi -r` shows it: its name, or the first line of what it was first asked. */
export function titleOf(info: SessionInfo): string {
    const first = info.firstMessage.split("\n")[0]!.slice(0, TITLE_LENGTH).trim();

    return info.name ?? (first || "Pi session");
}
