/**
 * Actions that reached no waiting call and must reach the session as a message. `act.ts` writes the mark in the same
 * commit that records the action; the delivery follows, and the mark goes when it succeeds. A delivery that fails (the
 * session is busy, a limit, a restart) leaves the mark, and `PendingActions` tries again: after a delay, at startup,
 * and when a run ends. The inbox's key (`surface-<id>-<rev>`) makes a second delivery of the same action harmless.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import { SurfacesDoc } from "../docs.ts";
import { describe, HttpError } from "../errors.ts";
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
    const marks = [
        ...((await app.harness.snapshot(SurfacesDoc, id, context))?.items[sid]?.pending ?? []),
    ].sort((a, b) => a.rev - b.rev);

    for (const mark of marks) {
        const owner = app.config.users.find((each) => each.role === "owner");
        const asked = mark.by === "" ? undefined : app.config.userById(mark.by);
        const by =
            asked !== undefined && asked.role !== "viewer" && app.canSee(asked, id) ? asked : owner;

        try {
            await app.inbox.deliver(id, {
                by: by?.id ?? "",
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

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** A surfaces document changed: schedule a retry when it holds a mark, forget the conversation when not. */
    note(id: ConversationId, items: Record<string, Surface> | undefined): void {
        if (Object.values(items ?? {}).some((surface) => (surface.pending?.length ?? 0) > 0)) {
            this.#schedule(id, this.#delays.get(id) ?? FIRST_MS);
        } else {
            clearTimeout(this.#timers.get(id));
            this.#timers.delete(id);
            this.#delays.delete(id);
        }
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
