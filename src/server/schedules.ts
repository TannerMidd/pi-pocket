/**
 * Messages to Pi that go out later, or on repeat. Each schedule is a durable task that sleeps until its time, sends
 * its message, and for a repeat goes back to sleep until the next time. A restart while it sleeps continues the
 * sleep, and one that comes after the time sends at once. Each sending has its own request id, so a restart in the
 * middle of one never sends twice. A schedule goes out only while its person may still steer the session and no
 * spend limit is reached; otherwise it is cancelled, with a line in the chat saying why. One in PiP's conversation
 * waits while PiP is turned off, and goes out once it is back. The schedules extension
 * (`extensions/schedules.ts`) installs the task and gives Pi a tool to schedule its own follow-ups; while it is off,
 * nothing goes out.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type ConversationId,
    defineTask,
    type Task,
    type TaskRuntime,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { addActivity } from "./collab.ts";
import { ChatDoc, type Schedule, ScheduleDoc } from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { FROM_PREFIX } from "./entry-format.ts";
import { snippet } from "./projection.ts";
import { ownRequest, requestFor } from "./requests.ts";
import { checkMoment, nextRepeat, parseWhen, type Repeat } from "./when.ts";

const context = BACKGROUND_CONTEXT;

/** How a scheduled message starts, so Pi (and people reading along) know it was set up earlier. */
export const SCHEDULED_PREFIX = "[scheduled] ";
/** The extension that runs schedules; while it is off, none go out and none can be set up. */
export const SCHEDULES_EXTENSION = "pocket-schedules";

/** What bounds scheduled messages; the schedules extension sets them from the owner's settings. */
export type ScheduleLimits = {
    /** How many schedules a session can have. */
    perSession: number;
    /** The longest message, in characters. */
    chars: number;
    /** The shortest time between two sendings of a repeat, in minutes: a runaway loop of model calls costs money. */
    repeatMinutes: number;
    /** How far ahead a one-time message may go, in days. */
    aheadDays: number;
};

export const DEFAULT_SCHEDULE_LIMITS: Readonly<ScheduleLimits> = {
    perSession: 50,
    chars: 4000,
    repeatMinutes: 10,
    aheadDays: 366,
};

type ScheduleInput = { scheduleId: string };
type ScheduleState = { phase: "wait" } | { phase: "send" };
type Runtime = TaskRuntime<ScheduleInput, ScheduleState, null, object>;

/** The schedule as stored now; undefined once it was cancelled. */
async function stored(
    runtime: Runtime,
    scheduleId: string,
    context: Context,
): Promise<Schedule | undefined> {
    const schedule = (await runtime.snapshot(ScheduleDoc, runtime.conversationId, context))?.items[
        scheduleId
    ];

    // An edit gives the schedule a new task: the one it replaced finds it no longer its own, and ends.
    return ownedBy(schedule, runtime) ? schedule : undefined;
}

/** Whether `runtime`'s task is the one that sends `schedule` now: an edit hands it to a new task. */
const ownedBy = (schedule: Schedule | undefined, runtime: Runtime): schedule is Schedule =>
    schedule !== undefined && String(schedule.taskId) === String(runtime.taskId);

/** A schedule by the id someone gave: only one of its own, never an object's built-in (`__proto__`, `constructor`). */
const own = (items: Record<string, Schedule>, id: string): Schedule | undefined =>
    Object.hasOwn(items, id) ? items[id] : undefined;

const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;

export type ScheduleRequest = {
    /** When it goes out (`in 30m`, `every weekday 8:00`, …), followed by the message unless `text` is given. */
    when: string;
    /**
     * When it goes out, as data instead of `when` (the Schedules sheet's editor): `next` for one that goes out once,
     * `every` for a repeat, with `next` as its first time for one every so many minutes. Needs `text`.
     */
    at?: { next?: number; every?: Repeat };
    text?: string;
    /** The time zone its clock times mean; the server's when absent. */
    zone?: string;
    /** Who sets it up; absent for Pi. */
    by?: { id: string; name: string };
    /** When Pi sets it up: whom Pi works for. */
    requestedBy?: string;
    /** The same key sets up the same schedule once: a tool call replayed after a restart finds the one it made. */
    key?: string;
};

export class Schedules {
    readonly #app: PocketApp;
    /** How long a schedule of PiP's waits before it looks again whether PiP is back. */
    holdMs = 60_000;
    /** The limits in force; the schedules extension changes them when the owner does. */
    readonly limits: ScheduleLimits = { ...DEFAULT_SCHEDULE_LIMITS };
    /** The durable task behind each schedule; the schedules extension installs it. */
    readonly task: Task<ScheduleInput, ScheduleState, null, object>;

    constructor(app: PocketApp) {
        this.#app = app;
        this.task = defineTask<ScheduleInput, ScheduleState, null>({
            name: "pocket.schedule",
            version: 1,
            initial: () => ({ phase: "wait" }),
            phases: {
                wait: async (task, runtime, context) => {
                    const schedule = await stored(runtime, task.input.scheduleId, context);

                    if (schedule === undefined) {
                        return runtime.commit(() => finished, context);
                    }

                    return runtime.sleepUntil(schedule.next, { phase: "send" }, context);
                },
                send: (task, runtime, context) =>
                    this.#send(task.input.scheduleId, runtime, context),
            },
            abort: (task, runtime, context) =>
                runtime.commit(async (tx) => {
                    const doc = await tx.doc(ScheduleDoc, runtime.conversationId);

                    // Replaced by an edit: the schedule is the new task's, and stays.
                    if (ownedBy(doc.items[task.input.scheduleId], runtime)) {
                        delete doc.items[task.input.scheduleId];
                    }

                    return { status: "terminal", outcome: { status: "aborted" } };
                }, context),
        });
    }

    /** Send a schedule's message, unless it may not go out anymore; then wait for the next time, or finish. */
    async #send(id: string, runtime: Runtime, context: Context): Promise<void> {
        const conversationId = runtime.conversationId;
        const schedule = await stored(runtime, id, context);
        const conversation = await runtime.conversation(conversationId, context);

        if (schedule === undefined || conversation === undefined) {
            return runtime.commit(() => finished, context);
        }

        // PiP's conversation while PiP is off would run without PiP's rules: its schedule waits, and goes out once PiP
        // is back. Its `runs` stays, so a sending this replaces keeps its request id.
        if (this.#waitsForPip(conversationId)) {
            return runtime.commit(async (tx) => {
                const item = (await tx.doc(ScheduleDoc, conversationId)).items[id];

                if (!ownedBy(item, runtime)) {
                    return finished;
                }

                item.next = runtime.now() + this.holdMs;

                return { status: "running", checkpoint: { phase: "wait" } } as const;
            }, context);
        }

        // Sent as the person who set it up, so it shows as theirs. Pi's own are sent as Pi's, but as the work of whom Pi
        // worked for when it set them up.
        const sending = `${String(schedule.taskId)}-${schedule.runs}`;
        const requestId =
            schedule.by !== undefined
                ? ownRequest(schedule.by, `schedule-${sending}`)
                : schedule.requestedBy !== undefined
                  ? requestFor(schedule.requestedBy, `schedule-${sending}`)
                  : `schedule:${sending}`;
        const stopped = this.#stopped(conversationId, schedule);

        // Sent in the commit that reads the schedule again, so an edit or cancel either comes first, and nothing goes
        // out, or after, and the message went out as it was. The request id makes a run again after a crash send once.
        await runtime.commit(async (tx) => {
            const doc = await tx.doc(ScheduleDoc, conversationId);
            const item = doc.items[id];

            if (!ownedBy(item, runtime)) {
                return finished;
            }

            if (stopped === undefined) {
                await conversation.submit(tx, {
                    type: "input",
                    content: item.content,
                    whenBusy: "followUp",
                    requestId,
                });
            } else {
                delete doc.items[id];
                addActivity(
                    await tx.doc(ChatDoc, conversationId),
                    stopped.who,
                    `scheduled “${snippet(item.text, 60)}”, which was cancelled: ${stopped.why}.`,
                    runtime.now(),
                );

                return finished;
            }

            if (item.every === undefined) {
                delete doc.items[id];

                return finished;
            }

            item.runs += 1;
            item.next = nextRepeat(item.every, runtime.now(), item.zone);

            return { status: "running", checkpoint: { phase: "wait" } };
        }, context);
    }

    /** Whether a conversation is a PiP whose person cannot have it now (its extension is off). */
    #waitsForPip(conversationId: ConversationId): boolean {
        const app = this.#app;
        const userId = app.sessionMeta(conversationId)?.pip;

        if (userId === undefined) {
            return false;
        }

        const person = app.config.userById(userId);

        return person === undefined || !app.pip.available(person);
    }

    /**
     * Why a schedule may not go out anymore, and who set it up: the person it is for can no longer steer here, or a
     * spend limit is reached. Undefined when it may go out.
     */
    #stopped(
        conversationId: ConversationId,
        schedule: Schedule,
    ): { who: { id: string; name: string }; why: string } | undefined {
        const app = this.#app;
        const pi = { id: "pi", name: "Pi" };
        const userId = schedule.by ?? schedule.requestedBy;

        if (userId === undefined) {
            const why = app.spend.heldBack(conversationId);

            return why === undefined ? undefined : { who: pi, why };
        }

        const person = app.config.userById(userId);
        // Someone removed since is named as the message names them.
        const named = person ?? {
            id: userId,
            name: FROM_PREFIX.exec(schedule.content)?.[1] ?? "Someone",
        };
        const who = schedule.by === undefined ? pi : named;

        if (
            person === undefined ||
            person.role === "viewer" ||
            !app.canSee(person, conversationId)
        ) {
            return {
                who,
                why: `${schedule.by === undefined ? named.name : "they"} can no longer steer here`,
            };
        }

        const why = app.spend.heldBack(conversationId, person.id);

        return why === undefined ? undefined : { who, why };
    }

    /** Why a schedule would not go out now, were it its time: a spend limit, or nobody left to steer. */
    held(conversationId: ConversationId, schedule: Schedule): string | undefined {
        return this.#stopped(conversationId, schedule)?.why;
    }

    /** Whether schedules run now: their extension is on. */
    get running(): boolean {
        return this.#app.loader.extensionNames().includes(SCHEDULES_EXTENSION);
    }

    /** Set up a message to Pi. Throws an HttpError a person can act on when the time or the message will not do. */
    async add(conversationId: ConversationId, request: ScheduleRequest): Promise<Schedule> {
        const app = this.#app;

        if (!this.running) {
            throw new HttpError(409, "Schedules are turned off in Extensions.");
        }

        // A subagent's would show in no session's list.
        if (app.sessionMeta(conversationId) === undefined) {
            throw new HttpError(400, "Only sessions can have scheduled messages.");
        }

        const limits = this.limits;
        const zone = request.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        let parsed: ReturnType<typeof parseWhen>;

        try {
            parsed =
                request.at === undefined
                    ? parseWhen(request.when, app.now(), zone, {
                          repeatMinutes: limits.repeatMinutes,
                          aheadMs: limits.aheadDays * 24 * 60 * 60_000,
                      })
                    : { ...this.#timeOf(request.at, zone), rest: "" };
        } catch (error) {
            throw new HttpError(400, describe(error));
        }

        if (request.text !== undefined && parsed.rest !== "") {
            throw new HttpError(
                400,
                `“${parsed.rest}” is not part of a time. ${request.when.trim()}?`,
            );
        }

        const text = (request.text ?? parsed.rest).trim();

        if (text === "") {
            throw new HttpError(400, "Say what Pi should get, after when.");
        }

        if (text.length > limits.chars) {
            throw new HttpError(
                413,
                `Scheduled messages are limited to ${limits.chars} characters.`,
            );
        }

        const by = request.by;
        const content =
            by === undefined
                ? `${SCHEDULED_PREFIX}${text}`
                : app.commands.messageText(by, `${SCHEDULED_PREFIX}${text}`);

        return app.harness.commit(async (tx) => {
            const doc = await tx.doc(ScheduleDoc, conversationId);
            const same =
                request.key === undefined
                    ? undefined
                    : Object.values(doc.items).find((item) => item.key === request.key);

            if (same !== undefined) {
                return JSON.parse(JSON.stringify(same)) as Schedule;
            }

            if (Object.keys(doc.items).length >= limits.perSession) {
                throw new HttpError(
                    409,
                    `A session can have ${limits.perSession} scheduled messages at most.`,
                );
            }

            let id = randomUUID().slice(0, 6);

            while (Object.hasOwn(doc.items, id)) {
                id = randomUUID().slice(0, 6);
            }

            const taskId = await tx.createTask(
                this.task,
                { scheduleId: id },
                { ownership: { kind: "conversation" }, background: true, conversationId },
            );
            const schedule: Schedule = {
                id,
                text,
                content,
                next: parsed.next,
                ...(parsed.every === undefined ? {} : { every: parsed.every }),
                zone,
                ...(by === undefined ? {} : { by: by.id }),
                ...(by !== undefined || request.requestedBy === undefined
                    ? {}
                    : { requestedBy: request.requestedBy }),
                createdAt: app.now(),
                runs: 0,
                taskId,
                ...(request.key === undefined ? {} : { key: request.key }),
            };

            doc.items[id] = schedule;

            return schedule;
        }, context);
    }

    /**
     * Change a schedule: what Pi gets, and when (a moment for one that goes out once, a repeat, or a repeat with its first
     * time). It goes out as the work of `by`, who changed it last. Its task sleeps until the old time, so a new task takes
     * it over, and the old one, aborted, finds the schedule no longer its own. Throws an HttpError a person can act on.
     */
    async update(
        conversationId: ConversationId,
        scheduleId: string,
        change: {
            text: string;
            next?: number;
            every?: Repeat;
            zone?: string;
            /** The version the change was made from (its `taskId`): one changed since is refused. */
            version?: string;
            by: { id: string; name: string };
        },
    ): Promise<Schedule> {
        const app = this.#app;

        if (!this.running) {
            throw new HttpError(409, "Schedules are turned off in Extensions.");
        }

        const limits = this.limits;
        const text = change.text.trim();

        if (text === "") {
            throw new HttpError(400, "Say what Pi should get.");
        }

        if (text.length > limits.chars) {
            throw new HttpError(
                413,
                `Scheduled messages are limited to ${limits.chars} characters.`,
            );
        }

        const content = app.commands.messageText(change.by, `${SCHEDULED_PREFIX}${text}`);
        let replaced: Schedule["taskId"] | undefined;

        const updated = await app.harness.commit(async (tx) => {
            const doc = await tx.doc(ScheduleDoc, conversationId);
            const item = own(doc.items, scheduleId);

            if (item === undefined) {
                throw new HttpError(404, "No such scheduled message");
            }

            if (change.version !== undefined && change.version !== String(item.taskId)) {
                throw new HttpError(409, "Someone changed this schedule while you edited it.");
            }

            const zone = change.zone ?? item.zone;
            let next: number;

            try {
                next = this.#timeOf(change, zone).next;
            } catch (error) {
                throw new HttpError(400, describe(error));
            }

            replaced = item.taskId;
            item.taskId = await tx.createTask(
                this.task,
                { scheduleId },
                { ownership: { kind: "conversation" }, background: true, conversationId },
            );
            item.text = text;
            item.content = content;
            item.next = next;
            item.zone = zone;
            item.by = change.by.id;
            delete item.requestedBy;

            if (change.every === undefined) {
                delete item.every;
            } else {
                item.every = change.every;
            }

            return JSON.parse(JSON.stringify(item)) as Schedule;
        }, context);

        // The old task finds the schedule no longer its own and ends.
        if (replaced !== undefined) {
            await app.harness.abortTask(replaced, context).catch(() => undefined);
        }

        return updated;
    }

    /**
     * When a schedule given as data goes out first: `next` for one that goes out once, or for a repeat every so many
     * minutes when given; else the repeat's next time. Throws with a short explanation when `next` will not do.
     */
    #timeOf(at: { next?: number; every?: Repeat }, zone: string): { next: number; every?: Repeat } {
        const now = this.#app.now();
        const aheadMs = this.limits.aheadDays * 24 * 60 * 60_000;

        if (at.every === undefined) {
            return { next: checkMoment(at.next, now, { aheadMs }) };
        }

        const next =
            at.next !== undefined && "minutes" in at.every
                ? checkMoment(at.next, now, { aheadMs })
                : nextRepeat(at.every, now, zone);

        return { next, every: at.every };
    }

    /** Stop a schedule: it sends nothing more. Returns it; undefined when there is no such schedule. */
    async cancel(
        conversationId: ConversationId,
        scheduleId: string,
    ): Promise<Schedule | undefined> {
        // Removed and read in one commit, so an edit that hands it to a new task in between cannot leave that task
        // behind: the task stopped is the one it had when it was removed. The task, finding it gone, sends nothing more.
        const schedule = await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(ScheduleDoc, conversationId);
            const item = own(doc.items, scheduleId);

            if (item === undefined) {
                return undefined;
            }

            delete doc.items[scheduleId];

            return JSON.parse(JSON.stringify(item)) as Schedule;
        }, context);

        if (schedule !== undefined) {
            await this.#app.harness.abortTask(schedule.taskId, context).catch(() => undefined);
        }

        return schedule;
    }

    /** A conversation's schedules, soonest first. */
    async list(conversationId: ConversationId): Promise<Schedule[]> {
        const items = Object.values(
            (await this.#app.harness.snapshot(ScheduleDoc, conversationId, context))?.items ?? {},
        );

        return items.sort((a, b) => a.next - b.next);
    }
}
