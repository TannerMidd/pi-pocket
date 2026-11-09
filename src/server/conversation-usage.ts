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

/** A conversation's request count and newest prompt, kept until a newer entry comes, so a module can ask often. */
const counted = new Map<ConversationId, { newest: number; requests: number; lastPrompt: number }>();

/**
 * The conversations that `source` started, at any depth: its subagents, which live in its session's own list, and the
 * linked sessions it started, which are sessions of their own. Only the sessions the walk reaches are listed, so a
 * server with many sessions and subagents does not pay for all of them.
 */
function descendantsOf(app: PocketApp, source: ConversationId): Set<ConversationId> {
    const linked = new Map<ConversationId, ConversationId[]>();

    for (const [key, meta] of Object.entries(app.sessionCatalogue())) {
        const from = meta.linkedFrom?.id as ConversationId | undefined;

        if (from !== undefined) {
            linked.set(from, [...(linked.get(from) ?? []), Number(key) as ConversationId]);
        }
    }

    const agents = new Map<ConversationId, Map<ConversationId, ConversationId[]>>();

    const agentsIn = (root: ConversationId) => {
        let byParent = agents.get(root);

        if (byParent === undefined) {
            byParent = new Map();

            for (const id of app.conversationsOf(root)) {
                const parent = id === root ? undefined : app.parentOf(id);

                if (parent !== undefined) {
                    byParent.set(parent, [...(byParent.get(parent) ?? []), id]);
                }
            }

            agents.set(root, byParent);
        }

        return byParent;
    };

    const ids = new Set<ConversationId>([source]);

    for (const id of ids) {
        for (const child of [
            ...(agentsIn(app.rootOf(id)).get(id) ?? []),
            ...(linked.get(id) ?? []),
        ]) {
            ids.add(child);
        }
    }

    return ids;
}

/**
 * A conversation's model responses, and the prompt size of the newest one that sent a prompt (a failed request with no
 * usage leaves the one before). Entries come newest first: those up to the newest one read last time are not read again.
 */
async function requestsOf(
    app: PocketApp,
    id: ConversationId,
    scope: ExtensionRequest,
    check: () => unknown,
): Promise<{ requests: number; lastPrompt: number }> {
    const conversation = await app.harness.conversation(id, scope.context);

    if (conversation === undefined) {
        return { requests: 0, lastPrompt: 0 };
    }

    const kept = counted.get(id);
    let requests = 0;
    let lastPrompt: number | undefined;
    let newest: number | undefined;
    let cursor: Cursor | undefined;

    scan: do {
        check();

        const page = await conversation.entries({}, 256, cursor, scope.context);

        for (const entry of page.items) {
            const at = Number(entry.id);

            newest ??= at;

            if (kept !== undefined && at <= kept.newest) {
                requests += kept.requests;
                lastPrompt ??= kept.lastPrompt;
                break scan;
            }

            // Forks inherit entries, but their usage ledger starts empty.
            if (entry.conversationId !== id || entry.kind !== "pi.assistant") {
                continue;
            }

            for (const message of entry.model ?? []) {
                if (message.role !== "assistant") {
                    continue;
                }

                requests++;

                const used = message.usage;
                const prompt =
                    (used?.input ?? 0) + (used?.cacheRead ?? 0) + (used?.cacheWrite ?? 0);

                if (lastPrompt === undefined && prompt > 0) {
                    lastPrompt = prompt;
                }
            }
        }

        cursor = page.next;
    } while (cursor !== undefined);

    const result = { newest: newest ?? kept?.newest ?? 0, requests, lastPrompt: lastPrompt ?? 0 };

    counted.set(id, result);

    return { requests: result.requests, lastPrompt: result.lastPrompt };
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

    const ids = descendantsOf(app, source);

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

        Object.assign(totals, await requestsOf(app, id, scope, current));
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
