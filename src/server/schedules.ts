/**
 * Messages to Pi that go out later, or on repeat. Each schedule is a durable task that sleeps until its time, sends
 * its message, and for a repeat goes back to sleep until the next time. A restart while it sleeps continues the
 * sleep, and one that comes after the time sends at once. Each sending has its own request id, so a restart in the
 * middle of one never sends twice. A schedule goes out only while its person may still steer the session and no
 * spend limit is reached; otherwise it is cancelled, with a line in the chat saying why. The schedules extension
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
import { HttpError } from "./errors.ts";
import { FROM_PREFIX, snippet } from "./projection.ts";
import { ownRequest, requestFor } from "./requests.ts";
import { nextRepeat, parseWhen } from "./when.ts";

const context = BACKGROUND_CONTEXT;

/** How a scheduled message starts, so Pi (and people reading along) know it was set up earlier. */
export const SCHEDULED_PREFIX = "[scheduled] ";
/** The extension that runs schedules; while it is off, none go out and none can be set up. */
export const SCHEDULES_EXTENSION = "pocket-schedules";
const MAX_SCHEDULES = 50;
const MAX_TEXT = 4000;

type ScheduleInput = { scheduleId: string };
type ScheduleState = { phase: "wait" } | { phase: "send" };
type Runtime = TaskRuntime<ScheduleInput, ScheduleState, null, object>;

/** The schedule as stored now; undefined once it was cancelled. */
async function stored(
    runtime: Runtime,
    scheduleId: string,
    context: Context,
): Promise<Schedule | undefined> {
    return (await runtime.snapshot(ScheduleDoc, runtime.conversationId, context))?.items[
        scheduleId
    ];
}

const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;

export type ScheduleRequest = {
    /** When it goes out (`in 30m`, `every weekday 8:00`, …), followed by the message unless `text` is given. */
    when: string;
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

                    await runtime.sleep(schedule.next, context);
                    await runtime.commit(
                        () => ({ status: "running", checkpoint: { phase: "send" } }),
                        context,
                    );
                },
                send: (task, runtime, context) =>
                    this.#send(task.input.scheduleId, runtime, context),
            },
            abort: (task, runtime, context) =>
                runtime.commit(async (tx) => {
                    delete (await tx.doc(ScheduleDoc, runtime.conversationId)).items[
                        task.input.scheduleId
                    ];

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

        if (stopped === undefined) {
            await conversation.submit(
                { type: "input", content: schedule.content, whenBusy: "followUp", requestId },
                context,
            );
        }

        await runtime.commit(async (tx) => {
            const doc = await tx.doc(ScheduleDoc, conversationId);
            const item = doc.items[id];

            if (item === undefined) {
                return finished;
            }

            // Run again after a crash, this phase may find a limit that the message it sent already crossed: the message
            // went out all the same, and the schedule goes on to its next time, where it is checked again.
            if (
                stopped !== undefined &&
                (await tx.submissionByRequest(conversationId, requestId)) === undefined
            ) {
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

        const zone = request.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        let parsed: ReturnType<typeof parseWhen>;

        try {
            parsed = parseWhen(request.when, app.now(), zone);
        } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
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

        if (text.length > MAX_TEXT) {
            throw new HttpError(413, `Scheduled messages are limited to ${MAX_TEXT} characters.`);
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

            if (Object.keys(doc.items).length >= MAX_SCHEDULES) {
                throw new HttpError(
                    409,
                    `A session can have ${MAX_SCHEDULES} scheduled messages at most.`,
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

    /** Stop a schedule: it sends nothing more. Returns it; undefined when there is no such schedule. */
    async cancel(
        conversationId: ConversationId,
        scheduleId: string,
    ): Promise<Schedule | undefined> {
        const schedule = (await this.list(conversationId)).find((item) => item.id === scheduleId);

        if (schedule === undefined) {
            return undefined;
        }

        // The task's abort removes the schedule; one already gone (or never run) is removed here.
        await this.#app.harness.abortTask(schedule.taskId, context).catch(() => undefined);
        await this.#app.harness.commit(async (tx) => {
            delete (await tx.doc(ScheduleDoc, conversationId)).items[scheduleId];
        }, context);

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
