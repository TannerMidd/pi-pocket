/**
 * Sends answers to reply hooks. A hook with a reply address and `asked` set gets the session's answer when its run
 * ends. The answer is stored as `pending` before it is sent, so a restart sends the same entry again, never a new one.
 * A failed send is retried with a growing delay, and given up after `MAX_ATTEMPTS`. Only a 2xx answer counts as sent.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { type Hook, HooksDoc } from "./docs.ts";
import { projectEntry } from "./projection.ts";
import { replyBody, signReply } from "./reply-hooks.ts";

const context = BACKGROUND_CONTEXT;

/** How often pending answers are looked at again, in milliseconds. */
export const SWEEP_MS = 15_000;
/** Attempts before a reply is given up. Its text is then dropped; the log names only the hook. */
export const MAX_ATTEMPTS = 10;
/** The longest wait between two attempts. */
export const MAX_BACKOFF_MS = 10 * 60_000;
/** How long a receiver may take to answer one reply. */
export const SEND_TIMEOUT_MS = 10_000;

/** Waiting time before attempt `attempts + 1`: 2 s, 4 s, 8 s, and so on, up to `MAX_BACKOFF_MS`. */
export function backoffMs(attempts: number): number {
    return Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.min(attempts, 20));
}

export class ReplyDelivery {
    readonly #app: PocketApp;
    #timer: ReturnType<typeof setInterval> | undefined;
    #busy = false;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Begin: answers when runs end, and a sweep of pending replies. Returns how to stop. */
    start(): () => void {
        const stop = this.#app.events.on("run.ended", ({ conversationId }) => {
            void this.#runEnded(conversationId);
        });

        this.#timer = setInterval(() => void this.sweep(), SWEEP_MS);
        this.#timer.unref();

        return () => {
            stop();
            clearInterval(this.#timer);
        };
    }

    async #runEnded(conversationId: number): Promise<void> {
        try {
            await this.#collect(conversationId);
            await this.sweep();
        } catch (error) {
            this.#app.log(`reply hook: ${error instanceof Error ? error.constructor.name : "error"} after a run`);
        }
    }

    /** Hooks whose session has just answered and that were asked: store the answer as pending. */
    async #collect(session: number): Promise<void> {
        const hooks = await this.#hooks((hook) => hook.target === session && hook.reply?.asked === true);

        if (hooks.length === 0) {
            return;
        }

        const answer = await this.#lastAnswer(session as unknown as ConversationId);

        if (answer === undefined) {
            return;
        }

        for (const hook of hooks) {
            await this.#app.harness.commit(async (tx) => {
                const item = (await tx.doc(HooksDoc)).items[hook.id];

                if (item?.reply === undefined || item.reply.pending !== undefined || item.reply.sent === answer.entry) {
                    return;
                }

                item.reply.pending = { entry: answer.entry, text: answer.text, attempts: 0, nextAt: 0 };
            }, context);
        }
    }

    /** Sends every pending answer that is due. Only one sweep runs at a time. */
    async sweep(): Promise<void> {
        if (this.#busy) {
            return;
        }

        this.#busy = true;

        try {
            const hooks = await this.#hooks((hook) => hook.reply?.pending !== undefined);

            for (const hook of hooks) {
                const pending = hook.reply?.pending;

                if (pending !== undefined && pending.nextAt <= Date.now()) {
                    await this.#send(hook.id, pending);
                }
            }
        } finally {
            this.#busy = false;
        }
    }

    async #send(id: string, pending: { entry: string; text: string; attempts: number }): Promise<void> {
        const hook = await this.#read(id);

        if (hook?.reply === undefined) {
            return;
        }

        const timestamp = Date.now();
        const body = replyBody({ hook: hook.id, session: hook.target, entry: pending.entry, text: pending.text });
        let ok = false;

        try {
            const response = await fetch(hook.reply.url, {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
                headers: {
                    "content-type": "application/json",
                    "x-pocket-hook": hook.id,
                    "x-pocket-timestamp": String(timestamp),
                    "x-pocket-signature": signReply(hook.reply.secret, timestamp, body),
                },
                body,
            });

            await response.body?.cancel();
            ok = response.status >= 200 && response.status < 300;

            if (!ok) {
                this.#app.log(`reply hook ${hook.id}: the receiver answered ${response.status}`);
            }
        } catch {
            this.#app.log(`reply hook ${hook.id}: the receiver could not be reached`);
        }

        await this.#app.harness.commit(async (tx) => {
            const item = (await tx.doc(HooksDoc)).items[id];

            if (item?.reply?.pending?.entry !== pending.entry) {
                return;
            }

            if (ok) {
                item.reply.sent = pending.entry;
                item.reply.asked = false;
                delete item.reply.pending;

                return;
            }

            const attempts = pending.attempts + 1;

            if (attempts >= MAX_ATTEMPTS) {
                this.#app.log(`reply hook ${id}: gave up after ${attempts} attempts`);
                item.reply.asked = false;
                delete item.reply.pending;

                return;
            }

            item.reply.pending = {
                entry: pending.entry,
                text: pending.text,
                attempts,
                nextAt: Date.now() + backoffMs(attempts),
            };
        }, context);
    }

    async #read(id: string): Promise<Hook | undefined> {
        const items = (await this.#app.harness.snapshot(HooksDoc, context))?.items ?? {};

        return Object.hasOwn(items, id) ? items[id] : undefined;
    }

    async #hooks(keep: (hook: Hook) => boolean): Promise<Hook[]> {
        const items = (await this.#app.harness.snapshot(HooksDoc, context))?.items ?? {};

        return Object.values(items).filter((hook) => hook.reply !== undefined && keep(hook));
    }

    /** The session's last answer, as its text and entry id; undefined when it did not finish with words. */
    async #lastAnswer(id: ConversationId): Promise<{ entry: string; text: string } | undefined> {
        const conversation = await this.#app.conversation(id);
        const page = await conversation.entries({}, 16, undefined, context);
        const last = page.items.map((entry) => projectEntry(entry)).find((entry) => entry?.kind === "assistant");

        if (last?.kind !== "assistant" || last.stopReason === "aborted" || last.error !== undefined) {
            return undefined;
        }

        const text = last.blocks
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n")
            .trim();

        return text === "" ? undefined : { entry: String(last.id), text };
    }
}
