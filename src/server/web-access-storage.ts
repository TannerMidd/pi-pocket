/** Atomic web configuration and observed request counters, shared by all manager instances. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

const writes = new Map<string, Promise<unknown>>();
// shortcut: one server per directory; add a file lock if multiple processes share it.

export async function readWebFile<T>(path: string, fallback: T): Promise<T> {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (error: any) {
        if (error.code === "ENOENT") {
            return structuredClone(fallback);
        }

        if (error instanceof SyntaxError) {
            throw new Error(`Invalid JSON in ${basename(path)}; file left unchanged`);
        }

        throw error;
    }
}

export async function updateWebFile<T>(path: string, fallback: T, update: (data: T) => void) {
    const task = (writes.get(path) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
            const data = await readWebFile(path, fallback);

            update(data);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(`${path}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
            await rename(`${path}.tmp`, path);

            return data;
        });

    writes.set(path, task);

    try {
        return await task;
    } finally {
        if (writes.get(path) === task) {
            writes.delete(path);
        }
    }
}

export interface UsageCounter {
    provider: string;
    operation: string;
    mode: string;
    purpose: string;
    requests: number;
    successes: number;
    failures: number;
    unknown: number;
    fallback: number;
    credits: number;
    dollars: number;
    creditReports: number;
    dollarReports: number;
}
export interface ResearchJob {
    id: string;
    mode: string;
    status: string;
    createdAt: string;
    credits: number;
    usageReported?: boolean;
}
export interface WebUsage {
    since: string;
    days: Record<string, Record<string, UsageCounter>>;
    jobs: Record<string, ResearchJob>;
}

export function emptyWebUsage(): WebUsage {
    return { since: new Date().toISOString(), days: {}, jobs: {} };
}

export function incrementUsage(
    data: WebUsage,
    info: Pick<UsageCounter, "provider" | "operation" | "mode" | "purpose">,
    changes: Partial<UsageCounter>,
    date = new Date().toISOString().slice(0, 10),
) {
    const day = (data.days[date] ??= {});
    const key = [info.provider, info.operation, info.mode, info.purpose].join(":");
    const counter = (day[key] ??= {
        ...info,
        requests: 0,
        successes: 0,
        failures: 0,
        unknown: 0,
        fallback: 0,
        credits: 0,
        dollars: 0,
        creditReports: 0,
        dollarReports: 0,
    });

    for (const [field, amount] of Object.entries(changes)) {
        if (typeof amount === "number") {
            (counter as unknown as Record<string, number>)[field]! += amount;
        }
    }
}
