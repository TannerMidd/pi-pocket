/**
 * What browsers get: compact, display-ready JSON derived from the committed conversation view. Big strings (file
 * contents in tool arguments, long tool output) are clipped; a client asks for the full entry when the user expands it.
 */
import type { EntryRecord, LiveState, UsageState } from "@earendil-works/pi-durable";
import {
    ATTACHMENTS_HEADING,
    COMMAND_ENTRY,
    type CommandData,
    FILE_BLOCK,
    FROM_PREFIX,
    NOTE_ENTRY,
    SHELL_ENTRY,
    type ShellData,
} from "./entry-format.ts";

export type ClientBlock =
    | { type: "text"; text: string }
    | { type: "thinking"; text: string; redacted?: boolean }
    | {
          type: "toolCall";
          id: string;
          name: string;
          args: Record<string, unknown>;
          clipped?: Record<string, number>;
      };

export type ClientEntry =
    | { id: number; kind: "user"; text: string; images: number; from?: string; files?: string[] }
    | {
          id: number;
          kind: "assistant";
          blocks: ClientBlock[];
          stopReason?: string;
          error?: string;
          model?: string;
          provider?: string;
      }
    | {
          id: number;
          kind: "toolResult";
          callId: string;
          name: string;
          text: string;
          isError: boolean;
          details?: unknown;
          clipped?: number;
          /** Image parts in the result; browsers load them from `/api/c/:id/image/:entry/:index`. */
          images?: number;
      }
    | { id: number; kind: "compaction"; summary: string }
    | { id: number; kind: "reset"; text?: string }
    | ({ id: number; kind: "shell"; truncated?: number } & ShellData)
    | ({ id: number; kind: "command"; truncated?: number } & CommandData)
    | { id: number; kind: "note"; text: string; name: string }
    | { id: number; kind: "other"; entryKind: string };

export type ClientToolSlot = {
    callId: string;
    taskId?: number;
    name: string;
    status: "pending" | "running" | "done";
    output?: string;
    details?: unknown;
};

export type ClientLive = {
    busy: boolean;
    generation?: {
        attempt: number;
        message?: { blocks: ClientBlock[] };
        retry?: { at: number; error: string };
    };
    tools?: ClientToolSlot[];
    compactions?: {
        reason: string;
        blocking: boolean;
        attempt: number;
        retry?: { at: number; error: string };
    }[];
};

const ARG_LIMIT = 1500;
const OUTPUT_LIMIT = 8000;
const LIVE_OUTPUT_LIMIT = 4000;

type ContentPart = {
    type: string;
    text?: string;
    thinking?: string;
    redacted?: boolean;
    data?: string;
};

function textOfContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return (content as ContentPart[])
        .flatMap((part) =>
            part.type === "text" && typeof part.text === "string" ? [part.text] : [],
        )
        .join("\n");
}

function countImages(content: unknown): number {
    return Array.isArray(content)
        ? (content as ContentPart[]).filter((part) => part.type === "image").length
        : 0;
}

function clip(text: string, limit: number): { text: string; clipped?: number } {
    if (text.length <= limit) {
        return { text };
    }

    const half = Math.floor(limit / 2);

    return {
        text: `${text.slice(0, half)}\n\n… ${text.length - limit} characters not shown …\n\n${text.slice(-half)}`,
        clipped: text.length,
    };
}

function tail(text: string, limit: number): string {
    return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

function projectArgs(
    args: unknown,
    full: boolean,
): { args: Record<string, unknown>; clipped?: Record<string, number> } {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return { args: {} };
    }

    const out: Record<string, unknown> = {};
    const clipped: Record<string, number> = {};

    for (const [key, value] of Object.entries(args)) {
        if (!full && typeof value === "string" && value.length > ARG_LIMIT) {
            out[key] = value.slice(0, ARG_LIMIT);
            clipped[key] = value.length;
        } else if (!full && Array.isArray(value) && JSON.stringify(value).length > ARG_LIMIT * 2) {
            // edits: keep the shape but clip each string
            out[key] = value.map((item) =>
                typeof item === "object" && item !== null
                    ? Object.fromEntries(
                          Object.entries(item).map(([k, v]) => [
                              k,
                              typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v,
                          ]),
                      )
                    : item,
            );
            clipped[key] = JSON.stringify(value).length;
        } else {
            out[key] = value;
        }
    }

    return Object.keys(clipped).length === 0 ? { args: out } : { args: out, clipped };
}

function projectBlocks(content: unknown, full = false): ClientBlock[] {
    if (!Array.isArray(content)) {
        return [];
    }

    const blocks: ClientBlock[] = [];

    for (const part of content as (ContentPart & {
        id?: string;
        name?: string;
        arguments?: unknown;
    })[]) {
        if (part.type === "text" && typeof part.text === "string") {
            if (part.text !== "") {
                blocks.push({ type: "text", text: part.text });
            }
        } else if (part.type === "thinking") {
            const text = part.thinking ?? "";

            if (text.trim() !== "" || part.redacted) {
                blocks.push({
                    type: "thinking",
                    text,
                    ...(part.redacted ? { redacted: true } : {}),
                });
            }
        } else if (part.type === "toolCall") {
            blocks.push({
                type: "toolCall",
                id: part.id ?? "",
                name: part.name ?? "?",
                ...projectArgs(part.arguments, full),
            });
        }
    }

    return blocks;
}

function projectDetails(details: unknown, full: boolean): unknown {
    if (details === undefined || details === null) {
        return undefined;
    }

    if (typeof details !== "object") {
        return details;
    }

    const record = details as Record<string, unknown>;

    if (typeof record.diff === "string") {
        const { patch: _patch, ...rest } = record;

        return full ? rest : { ...rest, diff: clip(record.diff, 20000).text };
    }

    const json = JSON.stringify(details);

    if (full || json.length < 4000) {
        return details;
    }

    // A long codemode script keeps its list of calls, without their errors: the transcript shows it, and the Changes
    // sheet finds the script's writes in it.
    if (Array.isArray(record.calls)) {
        return {
            calls: (record.calls as Record<string, unknown>[]).map(({ name, status, path }) => ({
                name,
                status,
                ...(typeof path === "string" ? { path } : {}),
            })),
        };
    }

    return undefined;
}

/** One entry for the browser, or undefined for bookkeeping entries the UI does not show. */
export function projectEntry(entry: EntryRecord, full = false): ClientEntry | undefined {
    const message = entry.model?.[0] as Record<string, unknown> | undefined;
    const id = entry.id as unknown as number;

    switch (entry.kind) {
        case "pi.user": {
            const content = message?.content;
            const images = countImages(content);
            // Files sent along (parts after the message's own text) show by name: their contents would only weigh down
            // every browser's view.
            const parts = Array.isArray(content) ? (content as ContentPart[]) : undefined;
            const isFile = (part: ContentPart, index: number) =>
                index > 0 &&
                part.type === "text" &&
                typeof part.text === "string" &&
                part.text.startsWith(FILE_BLOCK);
            const files = (parts ?? [])
                .filter(isFile)
                .map((part) => String(part.text).slice(FILE_BLOCK.length).split('"', 1)[0]!);
            const text = textOfContent(
                parts === undefined ? content : parts.filter((part, index) => !isFile(part, index)),
            );
            const named = files.length === 0 ? {} : { files };
            const prefixed = FROM_PREFIX.exec(text);

            return prefixed === null
                ? { id, kind: "user", text, images, ...named }
                : {
                      id,
                      kind: "user",
                      text: text.slice(prefixed[0].length),
                      images,
                      from: prefixed[1]!,
                      ...named,
                  };
        }

        case "pi.assistant": {
            const blocks = projectBlocks(message?.content, full);
            const stopReason =
                typeof message?.stopReason === "string" ? message.stopReason : undefined;
            const error =
                typeof message?.errorMessage === "string" ? message.errorMessage : undefined;

            return {
                id,
                kind: "assistant",
                blocks,
                ...(stopReason === undefined ? {} : { stopReason }),
                ...(error === undefined ? {} : { error }),
                ...(typeof message?.model === "string" ? { model: message.model } : {}),
                ...(typeof message?.provider === "string" ? { provider: message.provider } : {}),
            };
        }

        case "pi.tool-result": {
            const { text, clipped } = full
                ? { text: textOfContent(message?.content), clipped: undefined }
                : clip(textOfContent(message?.content), OUTPUT_LIMIT);
            const details = projectDetails(message?.details, full);
            const images = countImages(message?.content);

            return {
                id,
                kind: "toolResult",
                callId: String(message?.toolCallId ?? ""),
                name: String(message?.toolName ?? "?"),
                text,
                isError: message?.isError === true,
                ...(details === undefined ? {} : { details }),
                ...(clipped === undefined ? {} : { clipped }),
                ...(images === 0 ? {} : { images }),
            };
        }

        case "pi.compaction":
            return { id, kind: "compaction", summary: textOfContent(message?.content) };

        case "pi.reset": {
            const text = textOfContent(message?.content);

            return text === "" ? { id, kind: "reset" } : { id, kind: "reset", text };
        }

        case "pi.system":
            return undefined;

        case NOTE_ENTRY: {
            const data = entry.data as { text?: unknown; name?: unknown } | undefined;

            return {
                id,
                kind: "note",
                text: String(data?.text ?? ""),
                name: String(data?.name ?? "Someone"),
            };
        }

        case COMMAND_ENTRY: {
            const data = entry.data as CommandData;
            const { text, clipped } = full
                ? { text: data.output, clipped: undefined }
                : clip(data.output, OUTPUT_LIMIT);

            return {
                id,
                kind: "command",
                ...data,
                output: text,
                ...(clipped === undefined ? {} : { truncated: clipped }),
            };
        }

        case SHELL_ENTRY: {
            const data = entry.data as ShellData;
            const { text, clipped } = full
                ? { text: data.output, clipped: undefined }
                : clip(data.output, OUTPUT_LIMIT);

            return {
                id,
                kind: "shell",
                ...data,
                output: text,
                ...(clipped === undefined ? {} : { truncated: clipped }),
            };
        }

        default:
            return { id, kind: "other", entryKind: entry.kind };
    }
}

export function projectLive(live: LiveState | undefined): ClientLive {
    if (live === undefined) {
        return { busy: false };
    }

    const out: ClientLive = { busy: live.run !== undefined };

    if (live.generation !== undefined) {
        const message = live.generation.message as { content?: unknown } | undefined;

        out.generation = {
            attempt: live.generation.attempt,
            ...(message === undefined
                ? {}
                : { message: { blocks: projectBlocks(message.content) } }),
            ...(live.generation.retry === undefined ? {} : { retry: live.generation.retry }),
        };
    }

    if (live.tools !== undefined) {
        out.tools = live.tools.map((slot) => ({
            callId: slot.callId,
            name: slot.name,
            status: slot.status,
            ...(slot.taskId === undefined ? {} : { taskId: slot.taskId as unknown as number }),
            ...(slot.output === undefined ? {} : { output: tail(slot.output, LIVE_OUTPUT_LIMIT) }),
            ...(slot.details === undefined ? {} : { details: projectDetails(slot.details, false) }),
        }));
    }

    if (live.compactions !== undefined) {
        out.compactions = live.compactions.map((compaction) => ({
            reason: compaction.reason,
            blocking: compaction.blocking,
            attempt: compaction.attempt,
            ...(compaction.retry === undefined ? {} : { retry: compaction.retry }),
        }));
    }

    return out;
}

export type ClientStats = {
    cost: number;
    /** Share of prompt tokens served from the provider's cache, 0..1; undefined before the first response. */
    cacheRate?: number;
    /** Tokens of the newest response's prompt plus answer: roughly what the context holds. */
    contextTokens?: number;
};

type UsageNumbers = {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
};

/** What a conversation's model responses and tools cost, in dollars, from its `pi.usage`. */
export function usageCost(usage: UsageState | undefined): number {
    let cost = 0;

    for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
        for (const value of Object.values(bucket) as UsageNumbers[]) {
            cost += value.cost?.total ?? 0;
        }
    }

    return cost;
}

export function projectStats(
    usage: UsageState | undefined,
    entries: readonly EntryRecord[],
): ClientStats {
    const cost = usageCost(usage);
    let input = 0;
    let cacheRead = 0;
    let cacheWrite = 0;

    for (const value of Object.values(usage?.models ?? {}) as UsageNumbers[]) {
        input += value.input ?? 0;
        cacheRead += value.cacheRead ?? 0;
        cacheWrite += value.cacheWrite ?? 0;
    }

    const prompt = input + cacheRead + cacheWrite;
    let contextTokens: number | undefined;

    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!;

        if (entry.kind !== "pi.assistant") {
            continue;
        }

        const message = entry.model?.[0] as
            { usage?: UsageNumbers; stopReason?: string } | undefined;
        const used = message?.usage;

        if (
            used === undefined ||
            message?.stopReason === "error" ||
            message?.stopReason === "aborted"
        ) {
            continue;
        }

        const total =
            (used.input ?? 0) + (used.output ?? 0) + (used.cacheRead ?? 0) + (used.cacheWrite ?? 0);

        if (total > 0) {
            contextTokens = total;
            break;
        }
    }

    return {
        cost,
        ...(prompt > 0 ? { cacheRate: cacheRead / prompt } : {}),
        ...(contextTokens === undefined ? {} : { contextTokens }),
    };
}

/** Markdown as plain text, for snippets in quotes, pins, and notifications: no emphasis, code ticks, or markers. */
export function plainText(markdown: string): string {
    return markdown
        .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/gm, "$1$2")
        .replace(/^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)/gm, "");
}

/** A short single-line snippet of a message. */
export function snippet(text: string, max = 280): string {
    const flat = text.replace(/\s+/g, " ").trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The visible text of a projected entry, as plain text: what a person or Pi wrote. */
export function entryText(entry: ClientEntry): string {
    if (entry.kind === "user") {
        return entry.text.split(ATTACHMENTS_HEADING)[0] ?? "";
    }

    if (entry.kind === "assistant") {
        return plainText(
            entry.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
        );
    }

    return "";
}

// ─── Peek tiles ─────────────────────────────────────────────────────────────────

/** One line of a peek tile: a session's recent work, small enough to send for many sessions at once. */
export type PeekLine =
    | { kind: "user"; text: string; from?: string }
    | { kind: "text"; text: string }
    | {
          kind: "tool";
          name: string;
          args: Record<string, string | number | boolean>;
          status: "running" | "done" | "error";
      }
    | { kind: "shell"; command: string; status: "done" | "error" }
    | { kind: "note"; text: string; name: string }
    | { kind: "error"; text: string }
    | { kind: "event"; text: string };

/** How many lines a peek tile gets, and how long each text may run. */
export const PEEK_LINES = 8;
const PEEK_TEXT = 200;
const PEEK_ARG = 300;

/** A tool call's arguments for a peek line: short scalars only, which is all a one-line description needs. */
function peekArgs(args: Record<string, unknown>): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};

    for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string") {
            out[key] = value.slice(0, PEEK_ARG);
        } else if (typeof value === "number" || typeof value === "boolean") {
            out[key] = value;
        }
    }

    return out;
}

/**
 * A session's last few steps as peek lines: what was asked, what Pi said, and its tool calls with how they went, ending
 * with what it is doing now. `entries` are the newest projected entries, oldest first; a call's result may follow it.
 */
export function peekLines(
    entries: readonly ClientEntry[],
    live: ClientLive,
    count = PEEK_LINES,
): PeekLine[] {
    const results = new Map<string, boolean>();
    const lines: PeekLine[] = [];

    for (const entry of entries) {
        if (entry.kind === "toolResult") {
            results.set(entry.callId, entry.isError);
        }
    }

    const blocks = (list: readonly ClientBlock[], streaming: boolean) => {
        for (const block of list) {
            if (block.type === "text" && block.text.trim() !== "") {
                lines.push({ kind: "text", text: snippet(plainText(block.text), PEEK_TEXT) });
            } else if (block.type === "toolCall") {
                const failed = results.get(block.id);

                // A call without a result yet runs while Pi does; once Pi stopped, it was cut off.
                lines.push({
                    kind: "tool",
                    name: block.name,
                    args: peekArgs(block.args),
                    status:
                        failed === undefined
                            ? streaming || live.busy
                                ? "running"
                                : "done"
                            : failed
                              ? "error"
                              : "done",
                });
            }
        }
    };

    for (const entry of entries) {
        switch (entry.kind) {
            case "user": {
                const text = snippet(entryText(entry), PEEK_TEXT);

                if (text !== "" || entry.images > 0 || (entry.files?.length ?? 0) > 0) {
                    lines.push({
                        kind: "user",
                        text: text === "" ? "(attachments)" : text,
                        ...(entry.from === undefined ? {} : { from: entry.from }),
                    });
                }

                break;
            }

            case "assistant":
                blocks(entry.blocks, false);

                if (entry.stopReason === "aborted") {
                    lines.push({ kind: "event", text: "Stopped" });
                } else if (entry.error !== undefined) {
                    lines.push({ kind: "error", text: snippet(entry.error, PEEK_TEXT) });
                }

                break;
            case "shell":
                lines.push({
                    kind: "shell",
                    command: entry.command.slice(0, PEEK_ARG),
                    status: entry.status === "done" && (entry.code ?? 0) === 0 ? "done" : "error",
                });
                break;
            case "note":
                lines.push({
                    kind: "note",
                    text: snippet(entry.text, PEEK_TEXT),
                    name: entry.name,
                });
                break;
            case "compaction":
                lines.push({ kind: "event", text: "Context compacted" });
                break;
            case "reset":
                lines.push({ kind: "event", text: "Context cleared" });
                break;
            default:
                break;
        }
    }

    if (live.generation?.message !== undefined) {
        blocks(live.generation.message.blocks, true);
    }

    return lines.slice(-count);
}
