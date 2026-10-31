/** Read-only usage for an extension route's source and its visible descendants. */
import { UsageDoc, type ConversationId, type Cursor } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { ExtensionRequest } from "./extension-request.ts";
import { HttpError } from "./errors.ts";
import type { ConversationUsage, UsageTotals } from "./host.ts";

function emptyTotals(): UsageTotals {
    return {
        requests: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        cost: 0,
        lastPrompt: 0,
    };
}

function add(sum: UsageTotals, value: UsageTotals): void {
    for (const field of [
        "requests",
        "input",
        "cacheRead",
        "cacheWrite",
        "output",
        "cost",
        "lastPrompt",
    ] as const) {
        sum[field] += value[field];
    }

    if (value.reasoning !== undefined) {
        sum.reasoning = (sum.reasoning ?? 0) + value.reasoning;
    }
}

export async function conversationUsage(
    app: PocketApp,
    source: ConversationId,
    scope: ExtensionRequest,
): Promise<ConversationUsage> {
    const current = () => {
        const user = scope.current();
        const meta = app.sessionMeta(app.rootOf(source));

        if (
            !Number.isSafeInteger(source) ||
            Number(source) < 1 ||
            meta === undefined ||
            meta.pip !== undefined
        ) {
            throw new HttpError(404, "No such usage conversation.");
        }

        app.requireSee(user, source);

        return user;
    };

    current();

    if ((await app.harness.conversation(source, scope.context)) === undefined) {
        throw new HttpError(404, "No such usage conversation.");
    }

    const children = new Map<ConversationId, ConversationId[]>();

    for (const [key, meta] of Object.entries(app.sessionCatalogue())) {
        const root = Number(key) as ConversationId;

        for (const id of app.conversationsOf(root)) {
            const parent = app.parentOf(id) ?? (id === root ? meta.linkedFrom?.id : undefined);

            if (parent !== undefined) {
                const from = parent as ConversationId;
                const list = children.get(from) ?? [];

                list.push(id);
                children.set(from, list);
            }
        }
    }

    const ids = new Set<ConversationId>([source]);

    for (const id of ids) {
        for (const child of children.get(id) ?? []) {
            ids.add(child);
        }
    }

    const values = new Map<ConversationId, UsageTotals>();

    for (const id of ids) {
        if (!app.canSee(current(), id)) {
            continue;
        }

        const totals = emptyTotals();
        const usage = await app.harness.snapshot(UsageDoc, id, scope.context);

        for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
            for (const used of Object.values(bucket)) {
                for (const field of ["input", "cacheRead", "cacheWrite", "output"] as const) {
                    totals[field] += used[field] ?? 0;
                }

                totals.cost += used.cost?.total ?? 0;

                if (used.reasoning !== undefined) {
                    totals.reasoning = (totals.reasoning ?? 0) + used.reasoning;
                }
            }
        }

        const conversation = await app.harness.conversation(id, scope.context);
        let cursor: Cursor | undefined;
        let latest = -1;

        if (conversation !== undefined) {
            do {
                current();

                const page = await conversation.entries({}, 256, cursor, scope.context);

                for (const entry of page.items) {
                    // Forks inherit entries, but their usage ledger starts empty.
                    if (entry.conversationId !== id || entry.kind !== "pi.assistant") {
                        continue;
                    }

                    for (const message of entry.model ?? []) {
                        if (message.role !== "assistant") {
                            continue;
                        }

                        totals.requests++;

                        if (Number(entry.id) > latest) {
                            const used = message.usage;

                            totals.lastPrompt =
                                (used.input ?? 0) + (used.cacheRead ?? 0) + (used.cacheWrite ?? 0);
                            latest = Number(entry.id);
                        }
                    }
                }

                cursor = page.next;
            } while (cursor !== undefined);
        }

        values.set(id, totals);
    }

    // Access can change while the document and entry reads wait.
    const user = current();
    const descendants = emptyTotals();
    let count = 0;

    for (const [id, totals] of values) {
        if (id !== source && app.canSee(user, id)) {
            add(descendants, totals);
            count++;
        }
    }

    return { own: values.get(source) ?? emptyTotals(), children: { ...descendants, count } };
}
