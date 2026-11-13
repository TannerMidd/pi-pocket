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
