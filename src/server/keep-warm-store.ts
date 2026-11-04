import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IDLE_FAILURES } from "./idle-plan.ts";

/**
 * The options a saved entry keeps, and the only ones a restored entry takes: what shapes the payload, never where it
 * goes or how it signs in (`apiKey`, `headers`, `baseUrl`, `env`), which a file on disk must not decide.
 */
const SAVED_OPTIONS = new Set([
    "sessionId",
    "cacheRetention",
    "reasoning",
    "thinkingBudgets",
    "temperature",
    "maxTokens",
    "maxRetryDelayMs",
    "timeoutMs",
    "toolChoice",
    "transport",
    "identity",
    "metadata",
]);

export function savedOptions(options: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(options).filter(([key]) => SAVED_OPTIONS.has(key)));
}

const isCount = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;

/** A record read from disk as the keeper wrote it, or undefined: a damaged or edited file is never warmed. */
function idleRecordFrom(
    state: unknown,
    messages: unknown,
    name: string,
    now: number,
): IdleRecord | undefined {
    if (typeof state !== "object" || state === null || !Array.isArray(messages)) {
        return undefined;
    }

    const r = state as Record<string, unknown>;

    if (
        r.version !== 1 ||
        typeof r.key !== "string" ||
        name !== idleFileName(r.key) ||
        !Number.isSafeInteger(r.conversationId) ||
        typeof r.provider !== "string" ||
        typeof r.modelId !== "string" ||
        typeof r.payloadHash !== "string" ||
        typeof r.options !== "object" ||
        r.options === null ||
        // The provider session id it was sent under: the key it is filed by, and the conversation `restore` checks.
        (r.options as Record<string, unknown>).sessionId !== r.key ||
        !isCount(r.promptTokens) ||
        (r.ttlMs !== undefined && !isCount(r.ttlMs)) ||
        !isCount(r.since, now) ||
        !isCount(r.lastTouch, now) ||
        !isCount(r.warms) ||
        !isCount(r.spent) ||
        !isCount(r.failures, IDLE_FAILURES)
    ) {
        return undefined;
    }

    return {
        ...(r as unknown as Omit<IdleRecord, "messages">),
        options: savedOptions(r.options as Record<string, unknown>),
        messages,
    };
}

/** The file name of an idle entry: a hash of its key, so a key never names a path. */
function idleFileName(key: string): string {
    return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** One idle entry as saved, so that a restart can go on warming it. */
export type IdleRecord = {
    version: 1;
    key: string;
    conversationId: number;
    provider: string;
    modelId: string;
    messages: unknown[];
    options: Record<string, unknown>;
    promptTokens: number;
    ttlMs?: number;
    payloadHash: string;
    lastTouch: number;
    since: number;
    warms: number;
    spent: number;
    failures: number;
};

/** Where idle entries are kept between restarts. */
export type IdleStore = {
    save: (record: IdleRecord, withContext: boolean) => void;
    delete: (key: string) => void;
    load: () => Promise<IdleRecord[]>;
    /** Completed spend of each session's idle stretch. Reservations are not saved. */
    saveBudgets: (budgets: Record<string, number>) => void;
    loadBudgets: () => Promise<Record<string, number>>;
    /** Wait for the writes on their way. */
    flush: () => Promise<void>;
};

/** Idle entries in a folder: a small state file and the request's messages for each, written atomically, mode 0600. */
export function idleFiles(
    folder: string,
    log: (line: string) => void = () => {},
    now: () => number = Date.now,
): IdleStore {
    let line = Promise.resolve();
    const budgetsFile = join(folder, "budgets.json");

    const write = async (file: string, text: string) => {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(`${file}.tmp`, text, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
    };

    const queue = (work: () => Promise<void>) => {
        line = line
            .then(work)
            .catch((error: unknown) => log(`Keep warm: not saved: ${String(error)}`));
    };

    return {
        save: (record, withContext) => {
            const { messages, ...state } = record;
            const base = join(folder, idleFileName(record.key));

            queue(async () => {
                if (withContext) {
                    await write(`${base}.context.json`, JSON.stringify(messages));
                }

                await write(`${base}.json`, JSON.stringify(state));
            });
        },
        delete: (key) => {
            const base = join(folder, idleFileName(key));

            queue(async () => {
                await rm(`${base}.json`, { force: true });
                await rm(`${base}.context.json`, { force: true });
            });
        },
        load: async () => {
            await line;
            const names = await readdir(folder).catch(() => [] as string[]);
            const records: IdleRecord[] = [];
            const states = new Set(
                names.filter(
                    (file) =>
                        file !== "budgets.json" &&
                        file.endsWith(".json") &&
                        !file.endsWith(".context.json"),
                ),
            );
            const remove = (file: string) =>
                rm(join(folder, file), { force: true }).catch(() => {});

            for (const file of names) {
                // A write a crash cut off, or a context whose state is gone: nothing warms it.
                if (
                    file.endsWith(".tmp") ||
                    (file.endsWith(".context.json") &&
                        !states.has(file.replace(/\.context\.json$/, ".json")))
                ) {
                    await remove(file);
                }
            }

            for (const file of states) {
                const context = file.replace(/\.json$/, ".context.json");
                let record: IdleRecord | undefined;

                try {
                    record = idleRecordFrom(
                        JSON.parse(await readFile(join(folder, file), "utf8")),
                        JSON.parse(await readFile(join(folder, context), "utf8")),
                        file.replace(/\.json$/, ""),
                        now(),
                    );
                } catch {
                    record = undefined;
                }

                if (record === undefined) {
                    // A damaged, edited, or older entry is not warmed, and its conversation is not left on disk.
                    await remove(file);
                    await remove(context);
                } else {
                    records.push(record);
                }
            }

            return records;
        },
        saveBudgets: (budgets) => {
            const text = JSON.stringify(budgets);

            queue(async () => {
                await write(budgetsFile, text);
            });
        },
        loadBudgets: async () => {
            await line;

            try {
                const budgets: unknown = JSON.parse(await readFile(budgetsFile, "utf8"));

                if (
                    typeof budgets === "object" &&
                    budgets !== null &&
                    !Array.isArray(budgets) &&
                    Object.values(budgets).every(
                        (value) =>
                            typeof value === "number" && Number.isFinite(value) && value >= 0,
                    )
                ) {
                    return budgets as Record<string, number>;
                }
            } catch {
                // A missing or damaged file contributes no saved spend.
            }

            return {};
        },
        flush: () => line,
    };
}
