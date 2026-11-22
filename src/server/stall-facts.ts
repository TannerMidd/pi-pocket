/**
 * Pure helpers of the stall watches (`extensions/subagents.ts`, `extensions/agent-teams.ts`, `linked-sessions.ts`): what
 * changes while a conversation at work makes progress, what it waits on, and times in words. No model calls, no I/O.
 */
import type { LiveState } from "@earendil-works/pi-durable";

/** How often the stall watches look at what is at work; tests make it quick. Here, as extension modules reload. */
export const STALL_LOOK = { ms: 60_000 };

/** What changes while a conversation makes progress: its run, its answer as it streams, its calls and their output. */
export function progressOf(live: LiveState): string {
    const calls = (
        slots: readonly {
            callId: string;
            status: string;
            output?: string;
            droppedBytes?: number;
        }[],
    ) =>
        slots.map((slot) => [
            slot.callId,
            slot.status,
            (slot.output?.length ?? 0) + (slot.droppedBytes ?? 0),
        ]);

    return JSON.stringify([
        live.run?.taskId,
        live.run?.turns,
        live.generation?.attempt,
        JSON.stringify(live.generation?.message ?? null).length,
        calls(live.tools ?? []),
        calls(live.nestedTools ?? []),
        (live.compactions ?? []).length,
    ]);
}

/** The most tool calls, and characters of each one's arguments and of the last output, a stall verdict reads. */
const RECENT_CALLS = 5;
const RECENT_ARGUMENTS = 300;
const RECENT_OUTPUT = 800;

/** What a classifier reads of a session's recent work: its last calls with trimmed arguments, and the output's tail. */
export type RecentWork = {
    calls: { tool: string; arguments: string }[];
    /** The tail of the running call's output so far, else of the last call's result. */
    output?: string;
};

const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);
const head = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A call's arguments in one trimmed line: each value cut, the whole capped. */
function trimmedArguments(args: unknown, hide: (text: string) => string): string {
    if (typeof args !== "object" || args === null) {
        return "";
    }

    const parts = Object.entries(args).map(([key, value]) => {
        const text = hide(typeof value === "string" ? value : (JSON.stringify(value) ?? ""));

        return `${key}: ${head(text.replace(/\s+/g, " "), 120)}`;
    });

    return head(parts.join("; "), RECENT_ARGUMENTS);
}

/**
 * What a stall verdict reads: from the newest `messages` (newest first), the last few tool calls with their arguments
 * trimmed, and a trimmed tail of the output so far, which is the running call's, or else the last result's. Capped in
 * size; `live` is the session's live state, `hide` takes out values the owner hid.
 */
export function recentWork(
    messages: readonly unknown[],
    live: LiveState,
    hide: (text: string) => string = (text) => text,
): RecentWork {
    const calls: RecentWork["calls"] = [];
    let output: string | undefined;

    for (const message of messages as {
        role?: string;
        content?: unknown;
    }[]) {
        const parts = Array.isArray(message.content)
            ? (message.content as {
                  type?: string;
                  name?: string;
                  arguments?: unknown;
                  text?: string;
              }[])
            : [];

        if (message.role === "toolResult" && output === undefined) {
            const text = parts.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []));

            output = text.join("\n");
        }

        if (message.role === "assistant") {
            for (const part of [...parts].reverse()) {
                if (part.type === "toolCall" && calls.length < RECENT_CALLS) {
                    calls.unshift({
                        tool: String(part.name ?? ""),
                        arguments: trimmedArguments(part.arguments, hide),
                    });
                }
            }
        }
    }

    const running = (live.tools ?? []).find((tool) => tool.status === "running");
    const latest = running?.output ?? output;

    return {
        calls,
        ...(latest === undefined || latest.trim() === ""
            ? {}
            : { output: tail(hide(latest).trim(), RECENT_OUTPUT) }),
    };
}

/** What a conversation at work waits on: its running call, a retry of its model request, or its model. */
export function waitingOn(live: LiveState): { what: string; callId?: string } {
    const call = (live.tools ?? []).find((tool) => tool.status === "running");

    if (call !== undefined) {
        return { what: `its ${call.name} call`, callId: call.callId };
    }

    return {
        what: live.generation?.retry === undefined ? "its model" : "a retry of its model request",
    };
}

/**
 * The `timeout` (in ms) that a call gave itself, from the messages of its transcript: a call with its own limit runs
 * until that limit, also past the hard limit of a stall watch. Undefined when it gave none.
 */
export function callTimeoutMs(messages: readonly unknown[], callId: string): number | undefined {
    for (const message of messages) {
        const content = (message as { role?: string; content?: unknown }).content;

        if ((message as { role?: string }).role !== "assistant" || !Array.isArray(content)) {
            continue;
        }

        for (const part of content as { type?: string; id?: string; arguments?: unknown }[]) {
            const timeout = (part.arguments as { timeout?: unknown } | undefined)?.timeout;

            if (part.type === "toolCall" && part.id === callId) {
                return typeof timeout === "number" && timeout > 0 ? timeout * 1000 : undefined;
            }
        }
    }

    return undefined;
}

/** The hard limit of a call: the watch's, or past the call's own `timeout` with a minute to spare. */
export const hardLimitOf = (hard: number, timeoutMs: number | undefined) =>
    timeoutMs === undefined ? hard : Math.max(hard, timeoutMs + 60_000);

/** A time of day, for messages to Pi: in UTC, as servers and people's zones differ. */
export const clock = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;

/** A length of time in words: 45 s, 12 min, 3 h, 2 d. */
export function span(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));

    if (seconds < 60) {
        return `${seconds} s`;
    }

    const minutes = Math.round(seconds / 60);

    if (minutes < 60) {
        return `${minutes} min`;
    }

    const hours = Math.round(minutes / 60);

    return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}
