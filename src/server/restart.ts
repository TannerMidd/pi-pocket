/**
 * Restart when safe: a restart that waits until no call runs that a restart would cut off, so nothing comes back to the
 * model as interrupted. The owner's setting (`restart` in config.json) picks it for Menu → Restart server; a restart Pi
 * asks for always waits, as Pi's own call would be the first thing it cut off.
 *
 * While a restart waits, it drains: each new model request waits inside its stream, as at a closed limit gate
 * (`limit-gate.ts`), so no answer can start a new call. A request that waits has not gone out, so it costs nothing, and
 * after the restart Pi Durable sends it again. Requests that never wait for a limit (`noWait`: titles, summaries) go out
 * as before. Each `intervalMs` the planner asks the app what blocks (`blockers`): a running call of a tool that is not
 * replay-safe, nested ones too. None, or the owner's deadline passed: the server restarts. Cancel lets the held requests
 * go on, one at a time.
 *
 * Nothing of it is stored: the restart ends the process, and after a crash there is nothing to wait for.
 */
import {
    type Api,
    type AssistantMessageEventStream,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { failure, NO_WAIT } from "./limit-gate.ts";

/** What Menu → Restart server does: restart at once, or wait for the calls a restart would cut off. */
export type RestartMode = "immediate" | "when-safe";

export const RESTART_MODES: readonly RestartMode[] = ["immediate", "when-safe"];

/** The minutes a restart that waits waits at most, as the owner may pick them; 0: until it is safe, however long. */
export const RESTART_DEADLINE_CHOICES: readonly number[] = [0, 5, 10, 15, 30, 60, 120, 240];

/** A call that a restart now would cut off. */
export type RestartBlocker = {
    conversationId: number;
    callId: string;
    tool: string;
    /** When the call started, when it is known. */
    since?: number;
};

/** A restart that waits, as the owner's tabs show it. */
export type RestartPending = {
    since: number;
    /** When it restarts anyway; absent: only once it is safe. */
    deadline?: number;
    /** The person who asked, or the person Pi worked for. */
    by: string;
    /** Pi asked for it, with its tool. */
    agent?: true;
    /** What it waits for, as of the last look. */
    blockers: RestartBlocker[];
    /** How many model requests wait for it. */
    held: number;
};

export type RestartAsk = {
    /** `now`: restart at once, also over one that waits. */
    mode: RestartMode | "now";
    /** Minutes; 0 or absent: no deadline. */
    deadlineMinutes?: number;
    by: string;
    agent?: boolean;
    /** Why, for the log. */
    reason?: string;
};

export type RestartDeps = {
    /** End the process with the launcher's restart code. */
    restart: () => void;
    /** The calls a restart now would cut off. */
    blockers: () => Promise<RestartBlocker[]>;
    /** The conversation that sends model requests under a provider session id, if it is known. */
    conversationOf: (sessionId: string) => Promise<number | undefined> | number | undefined;
    /** The pending restart began, changed, or ended (undefined): tell the owner's tabs. */
    changed: (pending: RestartPending | undefined) => void;
    /** The conversations whose requests wait, or waited until now: their live lines change. */
    heldChanged: (conversationIds: number[]) => void;
    log: (line: string) => void;
    intervalMs?: number;
    /** Between two held requests let go after a cancel. */
    spacingMs?: number;
    /** From the decision to the restart, so the answer that says so gets out. */
    delayMs?: number;
    now?: () => number;
};

type StreamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

type Held = {
    conversationId?: number;
    release: () => void;
};

type Pending = Omit<RestartPending, "held">;

export class Restarts {
    readonly #deps: RestartDeps;
    readonly #now: () => number;
    readonly #intervalMs: number;
    readonly #spacingMs: number;
    readonly #delayMs: number;
    readonly #held = new Set<Held>();
    #pending: Pending | undefined;
    #timer: NodeJS.Timeout | undefined;
    #checking = false;
    #restarting = false;
    #closed = false;

    constructor(deps: RestartDeps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#intervalMs = deps.intervalMs ?? 1500;
        this.#spacingMs = deps.spacingMs ?? 500;
        this.#delayMs = deps.delayMs ?? 100;
    }

    /** Wrap the runtime's `streamSimple` in place: outside the limit gate, so a held request has not met a limit yet. */
    install(models: { streamSimple: StreamSimple }): void {
        const underlying = models.streamSimple.bind(models);

        models.streamSimple = (model, context, options) => {
            const marked = options as (SimpleStreamOptions & { [NO_WAIT]?: true }) | undefined;

            if (this.#pending === undefined || marked?.[NO_WAIT] === true) {
                return underlying(model, context, options);
            }

            return this.#hold(underlying, model, context, options);
        };
    }

    /**
     * Ask for a restart. `restarting`: it goes now (nothing blocks, or `now`). Otherwise it waits, and `pending` says
     * for what. A second ask while one waits keeps the first, unless it is `now`.
     */
    async ask(ask: RestartAsk): Promise<{ restarting: boolean; pending?: RestartPending }> {
        if (this.#restarting) {
            return { restarting: true };
        }

        if (ask.mode === "immediate" || ask.mode === "now") {
            this.#go(
                `asked by ${ask.by}${ask.agent ? " (Pi)" : ""}${ask.reason ? `: ${ask.reason}` : ""}`,
            );

            return { restarting: true };
        }

        if (this.#pending === undefined) {
            const since = this.#now();
            const minutes = ask.deadlineMinutes ?? 0;

            this.#pending = {
                since,
                ...(minutes > 0 ? { deadline: since + minutes * 60_000 } : {}),
                by: ask.by,
                ...(ask.agent ? { agent: true as const } : {}),
                blockers: [],
            };
            this.#deps.log(
                `Restart when safe: asked by ${ask.by}${ask.agent ? " (Pi)" : ""}${minutes > 0 ? `, at most ${minutes} min` : ""}${ask.reason ? `: ${ask.reason}` : ""}`,
            );
        }

        await this.#check();

        if (this.#restarting) {
            return { restarting: true };
        }

        const pending = this.pending();

        return pending === undefined ? { restarting: false } : { restarting: false, pending };
    }

    /** End the wait: held requests go on, one at a time. False: no restart waited. */
    cancel(): boolean {
        if (this.#pending === undefined || this.#restarting) {
            return false;
        }

        this.#pending = undefined;
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#deps.log("Restart when safe: cancelled");
        this.#deps.changed(undefined);
        this.#releaseAll();

        return true;
    }

    /** The restart that waits, if one does. */
    pending(): RestartPending | undefined {
        if (this.#pending === undefined) {
            return undefined;
        }

        return { ...this.#pending, blockers: [...this.#pending.blockers], held: this.#held.size };
    }

    /** Whether a model request of this conversation waits for the restart. */
    holds(conversationId: number): boolean {
        for (const held of this.#held) {
            if (held.conversationId === conversationId) {
                return true;
            }
        }

        return false;
    }

    /** Stop the timer; what waits stays held, as the process ends. */
    close(): void {
        this.#closed = true;
        clearTimeout(this.#timer);
        this.#timer = undefined;
    }

    // ─── The wait ───────────────────────────────────────────────────────────

    async #check(): Promise<void> {
        const pending = this.#pending;

        if (pending === undefined || this.#checking || this.#restarting || this.#closed) {
            return;
        }

        this.#checking = true;
        clearTimeout(this.#timer);
        this.#timer = undefined;

        let blockers: RestartBlocker[];

        try {
            blockers = await this.#deps.blockers();
        } catch (error) {
            // Not knowing is not safe: look again at the next turn.
            this.#deps.log(`Restart when safe: could not look at running calls: ${String(error)}`);
            blockers = pending.blockers;
        } finally {
            this.#checking = false;
        }

        // Cancelled, or asked again from scratch, while it looked.
        if (this.#pending !== pending || this.#restarting || this.#closed) {
            return;
        }

        // The call that asked blocks too, until its result is stored: a restart before would cut it off, and Pi would
        // get it back as interrupted, and ask again. It ends at once, and its run's next request waits here.
        const left = blockers;

        if (left.length === 0) {
            this.#go("nothing runs that a restart would cut off");

            return;
        }

        if (pending.deadline !== undefined && this.#now() >= pending.deadline) {
            this.#go(
                `the deadline passed, with ${left.map((each) => each.tool).join(", ")} still running`,
            );

            return;
        }

        if (JSON.stringify(left) !== JSON.stringify(pending.blockers)) {
            pending.blockers = left;
            this.#deps.changed(this.pending());
        }

        this.#timer = setTimeout(() => void this.#check(), this.#intervalMs);
        this.#timer.unref?.();
    }

    #go(why: string): void {
        if (this.#restarting) {
            return;
        }

        this.#restarting = true;
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#deps.log(`Restarting: ${why}`);
        // A moment later: the answer to the request that asked gets out first.
        setTimeout(() => this.#deps.restart(), this.#delayMs);
    }

    #releaseAll(): void {
        const held = [...this.#held];
        const ids = new Set<number>();

        this.#held.clear();

        held.forEach((each, index) => {
            if (each.conversationId !== undefined) {
                ids.add(each.conversationId);
            }

            // One at a time, as after a limit: not every session sends at the same second.
            setTimeout(each.release, index * this.#spacingMs).unref?.();
        });

        this.#deps.heldChanged([...ids]);
    }

    #hold(
        underlying: StreamSimple,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
    ): AssistantMessageEventStream {
        const out = createAssistantMessageEventStream();
        const started = this.#now();
        const signal = options?.signal;

        const run = async () => {
            const held: Held = { release: () => {} };
            const released = new Promise<void>((resolve) => {
                held.release = resolve;
            });
            let onAbort: (() => void) | undefined;
            const aborted = new Promise<"aborted">((resolve) => {
                if (signal?.aborted) {
                    resolve("aborted");

                    return;
                }

                onAbort = () => resolve("aborted");
                signal?.addEventListener("abort", onAbort, { once: true });
            });

            this.#held.add(held);

            const sessionId = options?.sessionId;

            if (sessionId !== undefined) {
                held.conversationId = await this.#deps.conversationOf(sessionId);
            }

            // Still held (a cancel while it found its conversation let it go): its session says why it waits.
            if (this.#held.has(held) && held.conversationId !== undefined) {
                this.#deps.heldChanged([held.conversationId]);
                this.#deps.changed(this.pending());
            }

            const turn = await Promise.race([released.then(() => "go" as const), aborted]);

            if (onAbort !== undefined) {
                signal?.removeEventListener("abort", onAbort);
            }

            if (turn === "aborted") {
                if (this.#held.delete(held)) {
                    if (held.conversationId !== undefined) {
                        this.#deps.heldChanged([held.conversationId]);
                    }

                    if (this.#pending !== undefined) {
                        this.#deps.changed(this.pending());
                    }
                }

                const message = failure(model, started, "aborted", "Request was aborted");

                out.push({ type: "error", reason: "aborted", error: message });
                out.end(message);

                return;
            }

            const inner = underlying(model, context, options);

            for await (const event of inner) {
                out.push(event);
            }

            out.end(await inner.result());
        };

        void run().catch((error: unknown) => {
            const message = failure(model, this.#now(), "error", String(error));

            out.push({ type: "error", reason: "error", error: message });
            out.end(message);
        });

        return out;
    }
}
