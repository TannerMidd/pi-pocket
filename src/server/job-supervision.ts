/** One read-only view of a session's jobs and the jobs of workers it directly leads. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { type BackgroundJobSummary, LinkedSessionPeersDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";

const MAX_WORKERS = 3;
const MAX_CURRENT = 20;
const MAX_FAILURES = 10;
const FRESH_PROCESS_MS = 30_000;

type Row = BackgroundJobSummary & {
    worker: string;
    processFreshness: "fresh" | "stale" | "unknown";
};
export type JobSupervision = { current: Row[]; failures: Row[]; truncated: boolean; next?: string };

function row(worker: string, item: BackgroundJobSummary, now: number): Row {
    const age = now - (item.processObservedAt ?? NaN);
    const processFreshness =
        typeof item.processAlive !== "boolean" || !Number.isFinite(age) || age < 0
            ? "unknown"
            : age <= FRESH_PROCESS_MS
              ? "fresh"
              : "stale";

    // A retained history row can outlive the code that wrote it. Never spread stored data here.
    return {
        worker,
        jobId: item.jobId,
        attemptId: item.attemptId,
        attempt: item.attempt,
        resumedFrom: item.resumedFrom,
        startedAt: item.startedAt,
        status: item.status,
        outcome: item.outcome,
        endedAt: item.endedAt,
        code: item.code,
        processObservedAt: item.processObservedAt,
        processFreshness,
        ...(processFreshness === "unknown" ? {} : { processAlive: item.processAlive }),
        lastOutputAt: item.lastOutputAt,
        outputBytes: item.outputBytes,
    };
}

/** The HTTP route supplies the signed-in person. A tool call must use the session's live requester. */
export async function readJobSupervision(
    app: PocketApp,
    source: ConversationId,
    human?: User,
    after?: string,
): Promise<JobSupervision> {
    const by = human?.id ?? app.attribution.requesterOf(source);

    const person = () => {
        const user =
            human === undefined ? app.steeringUser(source, by) : app.config.userById(human.id);
        const meta = app.sessionMeta(source);

        if (
            user === undefined ||
            meta === undefined ||
            meta.pip !== undefined ||
            !app.canSee(user, source) ||
            (human === undefined && app.attribution.requesterOf(source) !== by)
        ) {
            throw new HttpError(
                human === undefined ? 403 : 404,
                "Job status is not available here.",
            );
        }

        return user;
    };

    const leads = () => {
        const meta = app.sessionMeta(source);

        return meta !== undefined && meta.linkedFrom === undefined;
    };

    const visible = (target: ConversationId) => {
        const user = person();

        if (target === source) {
            return true;
        }

        const meta = app.sessionMeta(target);

        return (
            leads() &&
            meta?.linkedFrom?.id === Number(source) &&
            meta.pip === undefined &&
            app.canSee(user, target) &&
            (human !== undefined ||
                app.config.users.every(
                    (each) => !app.canSee(each, source) || app.canSee(each, target),
                ))
        );
    };

    person();

    if (after !== undefined && !/^session-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(after)) {
        throw new HttpError(400, "Invalid job status cursor.");
    }

    const targets = new Map<ConversationId, string>();
    let overflow: ConversationId | undefined;

    if (after === undefined) {
        targets.set(source, "self");
    }

    if (leads()) {
        const peers =
            (await app.harness.snapshot(LinkedSessionPeersDoc, source, BACKGROUND_CONTEXT))
                ?.peers ?? {};

        // Stable address order resumes even if the worker at the page boundary disappears or loses access.
        for (const address of Object.keys(peers).sort()) {
            if (after !== undefined && address <= after) {
                continue;
            }

            const target = peers[address] as ConversationId;

            if (target === source || targets.has(target) || !visible(target)) {
                continue;
            }

            if (targets.size === MAX_WORKERS + Number(after === undefined)) {
                overflow = target;
                break;
            }

            targets.set(target, address);
        }
    }

    const results = await Promise.all(
        [...targets].map(async ([id, worker]) => {
            return visible(id) ? { id, worker, data: await app.background.jobs(id) } : undefined;
        }),
    );

    // A new requester, changed share, removed person, or detached worker while a snapshot waited must take effect now.
    person();
    const now = app.now();
    const current: Row[] = [];
    const failures: Row[] = [];
    let last: string | undefined;
    let truncated = false;

    for (const result of results) {
        if (result === undefined || !visible(result.id)) {
            continue;
        }

        const { worker, data } = result;

        truncated ||= data.truncated;

        if (result.id !== source) {
            last = worker;
        }

        current.push(...data.jobs.slice(0, MAX_CURRENT).map((item) => row(worker, item, now)));
        failures.push(
            ...data.recentAdverse.slice(0, MAX_FAILURES).map((item) => row(worker, item, now)),
        );
    }

    const active = (r: Row) => Number(r.status === "starting" || r.status === "running");
    const newest = (a: Row, b: Row) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);

    current.sort((a, b) => active(b) - active(a) || newest(a, b));
    failures.sort(newest);

    if (overflow !== undefined && (!visible(overflow) || last === undefined)) {
        throw new HttpError(409, "Worker access changed. Refresh job status.");
    }

    return {
        current,
        failures,
        truncated: truncated || overflow !== undefined,
        ...(overflow === undefined ? {} : { next: last }),
    };
}
