/**
 * Deliver signed replies for exact durable submissions. Receipts exist before admission, so fast completion and
 * missed events are safe. Sweeps recover answers from submission records, never from the session's latest answer.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { type Hook, HooksDoc } from "./docs.ts";
import { projectEntry } from "./projection.ts";
import { createPublicFetch } from "./public-fetch.ts";
import { replyBody, signReply } from "./reply-hooks.ts";

const context = BACKGROUND_CONTEXT;
export const SWEEP_MS = 1_000;
export const MAX_ATTEMPTS = 10;
export const MAX_BACKOFF_MS = 10 * 60_000;
export const SEND_TIMEOUT_MS = 10_000;

type Receipt = NonNullable<NonNullable<Hook["reply"]>["requests"]>[string];
type Pending = NonNullable<Receipt["pending"]>;

export function backoffMs(attempts: number): number {
    return Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.min(attempts, 20));
}

export class ReplyDelivery {
    readonly #app: PocketApp;
    readonly #fetchPublic = createPublicFetch();
    #busy = false;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    start(): () => void {
        const stop = this.#app.events.on("run.ended", () => this.#wake());
        const timer = setInterval(() => this.#wake(), SWEEP_MS);
        timer.unref();
        this.#wake();

        return () => {
            stop();
            clearInterval(timer);
        };
    }

    #wake(): void {
        void this.sweep().catch((error: unknown) => {
            this.#app.log(
                `reply hook: ${error instanceof Error ? error.constructor.name : "error"} during delivery`,
            );
        });
    }

    /** Recover exact completed submissions, then send due replies. Only one sweep can run. */
    async sweep(): Promise<void> {
        if (this.#busy) {
            return;
        }

        this.#busy = true;

        try {
            const hooks = Object.values(
                (await this.#app.harness.snapshot(HooksDoc, context))?.items ?? {},
            );

            for (const hook of hooks) {
                for (const [key, receipt] of Object.entries(hook.reply?.requests ?? {})) {
                    if (receipt.done) {
                        continue;
                    }

                    const pending = receipt.pending ?? (await this.#collect(hook, key, receipt));

                    if (pending !== undefined && pending.nextAt <= Date.now()) {
                        await this.#send(hook, key, receipt.request, pending);
                    }
                }
            }
        } finally {
            this.#busy = false;
        }
    }

    async #collect(hook: Hook, key: string, receipt: Receipt): Promise<Pending | undefined> {
        const session = hook.target as unknown as ConversationId;
        const submission = await this.#app.harness.commit(
            (tx) => tx.submissionByRequest(session, receipt.submissionRequest),
            context,
        );

        if (
            submission?.type !== "input" ||
            (submission.status !== "done" && submission.status !== "unanswered")
        ) {
            return undefined;
        }

        let entry = `unanswered:${submission.id}`;
        let text = "[Pi could not answer this message. Try again later.]";

        if (submission.status === "done") {
            const stored = await this.#app.harness.commit(
                (tx) => tx.entry(submission.answer),
                context,
            );
            const answer = stored === undefined ? undefined : projectEntry(stored);

            entry = String(submission.answer);

            if (
                answer?.kind === "assistant" &&
                answer.stopReason !== "aborted" &&
                answer.error === undefined
            ) {
                text = answer.blocks
                    .flatMap((block) => (block.type === "text" ? [block.text] : []))
                    .join("\n")
                    .trim();

                if (text === "") {
                    text = "[Pi finished without a text answer.]";
                }
            }
        }

        const pending: Pending = { entry, text, attempts: 0, nextAt: 0 };
        let saved: Pending | undefined;

        await this.#app.harness.commit(async (tx) => {
            const item = (await tx.doc(HooksDoc)).items[hook.id]?.reply?.requests?.[key];

            if (item !== undefined && !item.done) {
                item.pending ??= pending;
                saved = { ...item.pending };
            }
        }, context);

        return saved;
    }

    async #send(hook: Hook, key: string, request: string, pending: Pending): Promise<void> {
        const current = (await this.#app.harness.snapshot(HooksDoc, context))?.items[hook.id];
        const receipt = current?.reply?.requests?.[key];

        if (
            current?.reply === undefined ||
            receipt?.done ||
            receipt?.pending?.entry !== pending.entry
        ) {
            return;
        }

        const person = this.#app.config.userById(current.by);

        if (
            !this.#app.hooks.running ||
            person?.role !== "owner" ||
            !this.#app.canSee(person, current.target as unknown as ConversationId)
        ) {
            return;
        }

        const timestamp = Date.now();
        const body = replyBody({
            hook: hook.id,
            request,
            session: hook.target,
            entry: pending.entry,
            text: pending.text,
        });
        let ok = false;

        try {
            const url = new URL(current.reply.url);
            const local =
                url.protocol === "http:" &&
                ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);

            // The owner-only local exception cannot resolve DNS or follow redirects.
            if (local && url.hostname === "localhost") {
                url.hostname = "127.0.0.1";
            }

            const send = local ? fetch : this.#fetchPublic;
            const response = await send(url, {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
                headers: {
                    "content-type": "application/json",
                    "x-pocket-hook": hook.id,
                    "x-pocket-timestamp": String(timestamp),
                    "x-pocket-signature": signReply(current.reply.secret, timestamp, body),
                },
                body,
            });
            await response.body?.cancel();
            ok = response.status >= 200 && response.status < 300;
        } catch {
            this.#app.log(`reply hook ${hook.id}: the receiver could not be reached`);
        }

        await this.#app.harness.commit(async (tx) => {
            const item = (await tx.doc(HooksDoc)).items[hook.id]?.reply?.requests?.[key];

            if (item?.pending?.entry !== pending.entry || item.done) {
                return;
            }

            const attempts = pending.attempts + 1;

            if (ok || attempts >= MAX_ATTEMPTS) {
                item.done = true;
                delete item.pending;

                if (!ok) {
                    this.#app.log(`reply hook ${hook.id}: gave up after ${attempts} attempts`);
                }

                return;
            }

            item.pending = { ...pending, attempts, nextAt: Date.now() + backoffMs(attempts) };
        }, context);
    }
}
