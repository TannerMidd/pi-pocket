/**
 * What can make work later, read from the documents that hold it (`sandbox.ts`, invariant I3): schedules, hooks, repo
 * watches, PR watches, background tasks and the processes they leave. A tree with any of them is live even when it is
 * archived, so it stays in its folder's group. The app calls `workFromDoc` as documents commit and while it recovers.
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    type BackgroundTask,
    type Hook,
    type PrWatch,
    type RepoWatch,
    type Schedule,
    BackgroundDoc,
    HooksDoc,
    RepoWatchesDoc,
    ScheduleDoc,
    WatchDoc,
} from "./docs.ts";

export type WorkKind = "schedule" | "watch" | "task" | "daemon" | "hook" | "repo-watch";

export type WorkEntry = {
    /** The session the work belongs to. */
    root: number;
    kind: WorkKind;
    key: string;
    /** In words, for a refusal that names it. */
    what: string;
    /** The folder the work is bound to, when its record says: a background task's. Else its tree's, when first seen. */
    folder?: string;
};

const short = (text: string) => (text.length > 40 ? `${text.slice(0, 37)}...` : text);

/**
 * The work a document holds, replacing what its source held before; undefined for a kind of document that holds none.
 * `rootOf` says which session a conversation belongs to.
 */
export function workFromDoc(
    kind: string,
    id: ConversationId | undefined,
    value: unknown,
    rootOf: (conversation: number) => number,
): { source: string; entries: (WorkEntry & { folder?: string })[] } | undefined {
    if (kind === ScheduleDoc.definition.kind && id !== undefined) {
        const items = (value as { items?: Record<string, Schedule> } | null)?.items ?? {};

        return {
            source: `${kind}:${String(id)}`,
            entries: Object.values(items)
                // A paused schedule sends nothing: resuming it is a new item (`work-add`).
                .filter((item) => item.paused === undefined)
                .map((item) => ({
                    root: rootOf(Number(id)),
                    kind: "schedule" as const,
                    key: item.id,
                    what: `the schedule “${short(item.text)}”`,
                })),
        };
    }

    if (kind === WatchDoc.definition.kind && id !== undefined) {
        const watch = (value as { watch?: PrWatch } | null)?.watch;

        return {
            source: `${kind}:${String(id)}`,
            entries:
                watch?.status === "watching"
                    ? [
                          {
                              root: rootOf(Number(id)),
                              kind: "watch" as const,
                              key: `${watch.repo}#${String(watch.number)}`,
                              what: `the watch of ${watch.repo}#${String(watch.number)}`,
                          },
                      ]
                    : [],
        };
    }

    if (kind === BackgroundDoc.definition.kind && id !== undefined) {
        const items = (value as { items?: Record<string, BackgroundTask> } | null)?.items ?? {};
        const entries: (WorkEntry & { folder?: string })[] = [];

        for (const item of Object.values(items)) {
            const running = item.status === "starting" || item.status === "running";
            const left = (item.left?.length ?? 0) > 0;

            if (running || left) {
                entries.push({
                    root: rootOf(Number(id)),
                    kind: running ? "task" : "daemon",
                    key: item.id,
                    what: `a background task (${short(item.command)})${running ? "" : ", which left a process running"}`,
                    folder: item.cwd,
                });
            }
        }

        return { source: `${kind}:${String(id)}`, entries };
    }

    if (kind === HooksDoc.definition.kind) {
        const items = (value as { items?: Record<string, Hook> } | null)?.items ?? {};

        return {
            source: kind,
            entries: Object.values(items).map((hook) => ({
                root: rootOf(hook.target),
                kind: "hook" as const,
                key: hook.id,
                what: `the webhook “${short(hook.name)}”`,
            })),
        };
    }

    if (kind === RepoWatchesDoc.definition.kind) {
        const items = (value as { items?: Record<string, RepoWatch> } | null)?.items ?? {};

        return {
            source: kind,
            entries: Object.values(items).map((watch) => ({
                root: rootOf(watch.target),
                kind: "repo-watch" as const,
                key: watch.id,
                what: `the watch of ${watch.repo}`,
            })),
        };
    }

    return undefined;
}
