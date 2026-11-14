/**
 * Deliver signed replies for exact durable submissions. Root receipts exist before admission. Derived receipts exist
 * before a background or subagent notification enters the conversation. Sweeps read only their named submission.
 */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { type Hook, HooksDoc, type ReplyOrigin, type ReplyOrigins } from "./docs.ts";
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

/** The durable result of reserving all derived receipts for one source submission. */
export type ReplyReservation = "reserved" | "suppressed" | "capacity";

export function backoffMs(attempts: number): number {
    return Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.min(attempts, 20));
}

/** A safe object key for one source submission under one root receipt. */
function derivedKey(origin: ReplyOrigin, request: string): string {
    return `reply-${createHash("sha256")
        .update(`${origin.key}\0${request}`)
        .digest("base64url")
        .slice(0, 32)}`;
}

/** The root origin of a receipt with the authenticated follow-up capability. */
function originOf(hook: Hook, key: string, receipt: Receipt): ReplyOrigin | undefined {
    if (receipt.followUp !== true) {
        return undefined;
    }

    return { hookId: hook.id, key: receipt.root ?? key, request: receipt.request, followUp: true };
}

function originKey(origin: ReplyOrigin): string {
    return `${origin.hookId}\0${origin.key}\0${origin.request}`;
}

/** Drop duplicate roots and give every durable root set one stable order. */
function canonicalOrigins(origins: readonly ReplyOrigin[]): ReplyOrigins {
    return [...new Map(origins.map((origin) => [originKey(origin), origin])).entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, origin]) => origin);
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

    /**
     * Find trusted hook roots while a model tool call runs. Every input must name one or more eligible roots.
     * A mixed run or an unrooted owner input is deliberately not attributable.
     */
    async originForTool(
        conversationId: ConversationId,
        taskId: TaskId,
    ): Promise<ReplyOrigins | undefined> {
        const [live, tool, hooks] = await Promise.all([
            this.#app.harness.snapshot(LiveDoc, conversationId, context),
            this.#app.harness.commit((tx) => tx.task(taskId), context),
            this.#app.harness.snapshot(HooksDoc, context),
        ]);

        if (
            live?.run === undefined ||
            tool?.conversationId !== conversationId ||
            tool.kind !== "pi.tool" ||
            tool.owner !== live.run.taskId
        ) {
            return undefined;
        }

        const records = await Promise.all(
            live.run.inputs.map(async (id) => {
                const submission = await this.#app.harness.submission(id, context);

                return submission?.status(context);
            }),
        );
        const all = Object.values(hooks?.items ?? {});
        const found: ReplyOrigin[] = [];

        for (const record of records) {
            if (record?.type !== "input" || record.requestId === undefined) {
                return undefined;
            }

            const matches = all.flatMap((hook) =>
                hook.target !== Number(conversationId)
                    ? []
                    : Object.entries(hook.reply?.requests ?? {})
                          .filter(([, receipt]) => receipt.submissionRequest === record.requestId)
                          .map(([key, receipt]) => originOf(hook, key, receipt))
                          .filter((origin): origin is ReplyOrigin => origin !== undefined),
            );

            if (matches.length === 0) {
                return undefined;
            }

            found.push(...matches);
        }

        const roots = canonicalOrigins(found);

        return roots.length === 0 ? undefined : roots;
    }

    /**
     * Save one derived receipt before its notification submission. Its deterministic key makes a retry retain the
     * original bridge request, source request, and sequence.
     */
    async reserve(
        conversationId: ConversationId,
        submissionRequest: string,
        origins: ReplyOrigins | undefined,
    ): Promise<ReplyReservation> {
        const roots = canonicalOrigins(origins ?? []);

        if (roots.length === 0) {
            return "suppressed";
        }

        return this.#app.harness.commit(async (tx) => {
            const items = (await tx.doc(HooksDoc)).items;
            const planned = new Map<string, number>();

            // Check every root before writing any receipt. One full or removed hook leaves this source unreserved.
            for (const origin of roots) {
                const hook = items[origin.hookId];

                if (hook?.target !== Number(conversationId) || hook.reply === undefined) {
                    return "suppressed";
                }

                const receipts = hook.reply.requests ?? {};
                const key = derivedKey(origin, submissionRequest);

                if (receipts[key] !== undefined) {
                    continue;
                }

                const active = Object.values(receipts).filter((receipt) => !receipt.done).length;
                const count = planned.get(origin.hookId) ?? 0;

                if (active + count >= 1000) {
                    return "capacity";
                }

                planned.set(origin.hookId, count + 1);
            }

            for (const origin of roots) {
                const hook = items[origin.hookId]!;
                const receipts = (hook.reply!.requests ??= {});
                const key = derivedKey(origin, submissionRequest);

                if (receipts[key] !== undefined) {
                    continue;
                }

                if (Object.keys(receipts).length >= 1000) {
                    for (const [oldKey, receipt] of Object.entries(receipts)) {
                        if (receipt.done) {
                            delete receipts[oldKey];
                        }
                    }
                }

                const sequence =
                    Math.max(
                        0,
                        ...Object.values(receipts)
                            .filter((receipt) => receipt.request === origin.request)
                            .map((receipt) => receipt.sequence ?? 0),
                    ) + 1;

                receipts[key] = {
                    request: origin.request,
                    submissionRequest,
                    root: origin.key,
                    followUp: true,
                    sequence,
                };
            }

            return "reserved";
        }, context);
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
                    if (receipt.done || this.#waitsForEarlier(hook, key, receipt)) {
                        continue;
                    }

                    const pending = receipt.pending ?? (await this.#collect(hook, key, receipt));

                    if (pending !== undefined && pending.nextAt <= Date.now()) {
                        await this.#send(
                            hook,
                            key,
                            receipt.request,
                            receipt.root !== undefined,
                            pending,
                        );
                    }
                }
            }
        } finally {
            this.#busy = false;
        }
    }

    /** A later receipt cannot overtake an earlier pending receipt for one original bridge request. */
    #waitsForEarlier(hook: Hook, key: string, receipt: Receipt): boolean {
        const sequence = receipt.sequence ?? 0;

        return Object.entries(hook.reply?.requests ?? {}).some(
            ([otherKey, other]) =>
                otherKey !== key &&
                other.request === receipt.request &&
                !other.done &&
                (other.sequence ?? 0) < sequence,
        );
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

    async #send(
        hook: Hook,
        key: string,
        request: string,
        derived: boolean,
        pending: Pending,
    ): Promise<void> {
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
            ...(derived ? { protocol: 2 as const } : {}),
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
