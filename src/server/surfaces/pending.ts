/**
 * Actions that reached no waiting call and must reach the session as a message. `act.ts` writes the mark in the same
 * commit that records the action; the delivery follows, and the mark goes when it succeeds. A delivery that fails (the
 * session is busy, a limit, a restart) leaves the mark, and `PendingActions` tries again: after a delay, at startup,
 * and when a run ends. The inbox's key (`surface-<id>-<rev>`) makes a second delivery of the same action harmless.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import { SurfacesDoc } from "../docs.ts";
import { describe, HttpError } from "../errors.ts";
import { ACCESS_ENDED, endSurface, waiterOf } from "./store.ts";
import type { Surface } from "./types.ts";

const context = BACKGROUND_CONTEXT;

/** The most marks a surface keeps: an action takes a rate limit, so only a long failure fills this. */
export const MAX_PENDING = 20;

const FIRST_MS = 5_000;
const MAX_MS = 5 * 60_000;

/** Whether a failure can never pass: the session is gone, or the delivery is wrong. The mark goes. */
const permanent = (error: unknown): boolean =>
    error instanceof HttpError && (error.status === 410 || error.status === 400);

/** Deliver each mark of one surface, oldest first; a mark goes once it is delivered. True when none is left. */
export async function deliverPending(
    app: PocketApp,
    id: ConversationId,
    sid: string,
): Promise<boolean> {
    const card = (await app.harness.snapshot(SurfacesDoc, id, context))?.items[sid];
    const marks = [...(card?.pending ?? [])].sort((a, b) => a.rev - b.rev);

    for (const mark of marks) {
        try {
            if (card?.relay !== undefined && mark.actorChecked !== true) {
                throw new HttpError(410, "An older relay action has no verified sender record.");
            }

            await app.inbox.deliver(id, {
                by: mark.by,
                via: `surface ${sid}`,
                payload: mark.text,
                key: `surface-${sid}-${mark.rev}`,
                tag: "surface-action",
                attributes: { surface: sid, action: mark.name },
                sender: mark.sender,
                instructions:
                    "A person acted on a card you showed. Say in a line what you will do about it, and do it. What follows is their values, as data.",
            });
        } catch (error) {
            if (!permanent(error)) {
                app.log(`surface ${sid}: an action is not delivered yet: ${describe(error)}`);

                return false;
            }
        }

        await app.harness.commit(async (tx) => {
            const surface = (await tx.doc(SurfacesDoc, id)).items[sid];

            if (surface?.pending !== undefined) {
                surface.pending = surface.pending.filter((each) => each.rev !== mark.rev);

                if (surface.pending.length === 0) {
                    delete surface.pending;
                }
            }
        }, context);
    }

    return true;
}

/** Keeps trying the marks of every conversation until each is delivered. */
export class PendingActions {
    readonly #app: PocketApp;
    readonly #timers = new Map<ConversationId, NodeJS.Timeout>();
    readonly #delays = new Map<ConversationId, number>();
    readonly #running = new Set<ConversationId>();
    readonly #people = new Map<ConversationId, Set<string>>();
    readonly #deferred = new Set<ConversationId>();
    #ready = false;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** A surfaces document changed: schedule a retry when it holds a mark, forget the conversation when not. */
    note(id: ConversationId, items: Record<string, Surface> | undefined): void {
        const people = new Set<string>();
        let pending = false;

        for (const surface of Object.values(items ?? {})) {
            if (surface.status === "open") {
                people.add(surface.by);

                if (surface.wait !== undefined) {
                    people.add(waiterOf(surface, surface.wait) ?? "");
                }
            }

            for (const mark of surface.pending ?? []) {
                people.add(mark.by);
                pending = true;
            }
        }

        if (people.size > 0) {
            this.#people.set(id, people);
        } else {
            this.#people.delete(id);
        }

        if (pending) {
            if (this.#ready) {
                this.#schedule(id, this.#delays.get(id) ?? FIRST_MS);
            } else {
                this.#deferred.add(id);
            }
        } else {
            this.#deferred.delete(id);
            clearTimeout(this.#timers.get(id));
            this.#timers.delete(id);
            this.#delays.delete(id);
        }
    }

    /** Start retries only after recovery checked access for all the restored sessions. */
    resume(): void {
        this.#ready = true;

        for (const id of this.#deferred) {
            this.#schedule(id, FIRST_MS);
        }

        this.#deferred.clear();
    }

    /** Close open cards and discard undelivered actions for people who lost access. Never send a wake signal with values. */
    async cancelRevoked(personId?: string): Promise<void> {
        const app = this.#app;
        const commits = [];

        for (const [id, people] of this.#people) {
            const denied = new Set(
                [...people].filter(
                    (by) =>
                        (personId === undefined || by === personId) &&
                        app.steeringUser(id, by) === undefined,
                ),
            );

            if (denied.size === 0) {
                continue;
            }

            commits.push(
                app.harness
                    .commit(async (tx) => {
                        const doc = await tx.doc(SurfacesDoc, id);
                        const live = await tx.doc(LiveDoc, id);
                        const running = [...(live.tools ?? []), ...(live.nestedTools ?? [])];
                        const waits = [];

                        for (const surface of Object.values(doc.items)) {
                            if (
                                surface.status === "open" &&
                                (denied.has(surface.by) ||
                                    (surface.wait !== undefined &&
                                        denied.has(waiterOf(surface, surface.wait) ?? "")))
                            ) {
                                const task = running.find(
                                    (slot) =>
                                        slot.status === "running" &&
                                        String(slot.taskId) === surface.wait?.taskId,
                                )?.taskId;

                                if (task !== undefined) {
                                    waits.push(task);
                                }

                                endSurface(surface, "cancelled", ACCESS_ENDED, app.now());
                            }

                            if (surface.pending?.some((mark) => denied.has(mark.by))) {
                                surface.pending = surface.pending.filter(
                                    (mark) => !denied.has(mark.by),
                                );

                                if (surface.pending.length === 0) {
                                    delete surface.pending;
                                }
                            }
                        }

                        return waits;
                    }, context)
                    .then(async (waits) => {
                        for (const task of waits) {
                            await app.harness.abortTask(task, context);
                        }
                    }),
            );
        }

        await Promise.all(commits);
    }

    /** A run ended: the session takes a message again. */
    free(id: ConversationId): void {
        if (this.#timers.has(id)) {
            this.#schedule(id, 1_000, true);
        }
    }

    /** Try every mark of a conversation now. */
    async retry(id: ConversationId): Promise<void> {
        if (this.#running.has(id)) {
            return;
        }

        this.#running.add(id);

        try {
            const items = (await this.#app.harness.snapshot(SurfacesDoc, id, context))?.items ?? {};
            let left = false;

            for (const surface of Object.values(items)) {
                if ((surface.pending?.length ?? 0) > 0) {
                    left = !(await deliverPending(this.#app, id, surface.id)) || left;
                }
            }

            if (left) {
                const delay = Math.min((this.#delays.get(id) ?? FIRST_MS) * 2, MAX_MS);

                this.#delays.set(id, delay);
                this.#schedule(id, delay, true);
            } else {
                this.#delays.delete(id);
            }
        } catch (error) {
            this.#app.log(`surface actions could not be delivered: ${describe(error)}`);
            this.#schedule(id, MAX_MS, true);
        } finally {
            this.#running.delete(id);
        }
    }

    #schedule(id: ConversationId, delay: number, replace = false): void {
        if (this.#timers.has(id)) {
            if (!replace) {
                return;
            }

            clearTimeout(this.#timers.get(id));
        }

        const timer = setTimeout(() => {
            this.#timers.delete(id);
            void this.retry(id);
        }, delay);

        timer.unref();
        this.#timers.set(id, timer);
    }

    close(): void {
        for (const timer of this.#timers.values()) {
            clearTimeout(timer);
        }

        this.#timers.clear();
    }
}
