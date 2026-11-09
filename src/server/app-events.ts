/**
 * What happens in the app, for extensions (`host.on`, since 0.22.0, experimental): sessions made, renamed, and
 * archived, messages people send to Pi, and runs that start and end. Each comes after its commit, so what it names is
 * stored. PiP's conversations are private and send none.
 *
 * A listener runs after the change, never in its way: one that throws or rejects is logged, and the others run.
 */

/** Each event's name, and what its listener gets. */
export interface AppEvents {
    /** A session was made: by a person, a fork, a linked start, or a resend. */
    "session.created": {
        conversationId: number;
        cwd: string;
        createdBy?: string;
        forkedFrom?: number;
        linkedFrom?: number;
    };
    "session.renamed": { conversationId: number; title: string };
    "session.archived": { conversationId: number; archived: boolean };
    /**
     * A person sent Pi a message (also a steer or a queued one): who, and its words as stored (hidden values hidden,
     * attachments left out). `via` names what sent it for them: PiP, a schedule, a webhook.
     */
    "message.sent": {
        conversationId: number;
        by: string;
        submissionId: string;
        text: string;
        via?: string;
    };
    /** Pi started to work in a conversation: a session's or a subagent's (`session` is its session). */
    "run.started": { conversationId: number; session: number };
    /**
     * Pi stopped working. `outcome` is `done` when the run finished, `failed` when it gave up (a model error, no model,
     * or a broken run), or `aborted` when it was stopped. `failure` is why, the same short line the session list shows,
     * and only when `outcome` is `failed`. A session's failure stands until a later run starts.
     */
    "run.ended": {
        conversationId: number;
        session: number;
        outcome: "done" | "failed" | "aborted";
        failure?: string;
    };
}

export type AppEventName = keyof AppEvents;

export const APP_EVENTS: readonly AppEventName[] = [
    "session.created",
    "session.renamed",
    "session.archived",
    "message.sent",
    "run.started",
    "run.ended",
];

type Listener = (data: never) => unknown;

export class AppEventBus {
    readonly #listeners = new Map<AppEventName, Set<Listener>>();
    readonly #log: (line: string) => void;

    constructor(log: (line: string) => void) {
        this.#log = log;
    }

    /** Listen to an event until the returned function is called. An unknown name throws. */
    on<E extends AppEventName>(event: E, listener: (data: AppEvents[E]) => unknown): () => void {
        if (!APP_EVENTS.includes(event)) {
            throw new Error(
                `host.on: no event ${String(event)}; the events are ${APP_EVENTS.join(", ")}`,
            );
        }

        if (typeof listener !== "function") {
            throw new Error("host.on: give it a function");
        }

        let set = this.#listeners.get(event);

        if (set === undefined) {
            set = new Set();
            this.#listeners.set(event, set);
        }

        set.add(listener as Listener);

        return () => {
            set.delete(listener as Listener);
        };
    }

    /** Tell each listener, after the current work: a copy each, frozen, so no listener changes what another gets. */
    emit<E extends AppEventName>(event: E, data: AppEvents[E]): void {
        const set = this.#listeners.get(event);

        if (set === undefined || set.size === 0) {
            return;
        }

        for (const listener of [...set]) {
            const copy = Object.freeze(structuredClone(data)) as AppEvents[E];

            queueMicrotask(() => {
                try {
                    const result = (listener as (value: AppEvents[E]) => unknown)(copy);

                    if (result instanceof Promise) {
                        result.catch((error: unknown) => this.#failed(event, error));
                    }
                } catch (error) {
                    this.#failed(event, error);
                }
            });
        }
    }

    #failed(event: string, error: unknown): void {
        this.#log(
            `host.on(${event}): a listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
