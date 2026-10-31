import type { SystemProblem } from "./system-types.ts";
import { LIMITS } from "./tokens-base.ts";

export class Report {
    list: SystemProblem[] = [];
    private keys = new Set<string>();
    private dropped = 0;

    add(
        level: SystemProblem["level"],
        message: string,
        file?: string,
        token?: string,
        fix?: string,
    ): void {
        const key = `${level}|${file ?? ""}|${token ?? ""}|${message}`;

        if (this.keys.has(key)) {
            return;
        }

        this.keys.add(key);

        if (this.list.length >= LIMITS.problems) {
            this.dropped += 1;

            return;
        }

        const problem: SystemProblem = { level, message };

        if (file !== undefined) {
            problem.file = file;
        }

        if (token !== undefined) {
            problem.token = token;
        }

        if (fix !== undefined) {
            problem.fix = fix;
        }

        this.list.push(problem);
    }

    error(message: string, file?: string, token?: string): undefined {
        this.add("error", message, file, token);
    }

    warn(message: string, file?: string, token?: string, fix?: string): void {
        this.add("warning", message, file, token, fix);
    }

    /** A note that needs no action. It is kept apart from the problems, so nothing that counts problems counts it. */
    notes: SystemProblem[] = [];

    info(message: string, file?: string, token?: string): void {
        if (this.notes.length < 100) {
            this.notes.push({
                level: "info",
                message,
                ...(file === undefined ? {} : { file }),
                ...(token === undefined ? {} : { token }),
            });
        }
    }

    done(): SystemProblem[] {
        const sorted = [
            ...this.list.filter((problem) => problem.level === "error"),
            ...this.list.filter((problem) => problem.level === "warning"),
        ];

        if (this.dropped > 0) {
            sorted.push({
                level: "warning",
                message: `${this.dropped} more problems are not shown.`,
            });
        }

        return sorted;
    }
}

export interface SuggestionBudget {
    remaining: number;
}

function distance(a: string, b: string): number {
    if (Math.abs(a.length - b.length) > 4) {
        return 99;
    }

    let row = Array.from({ length: b.length + 1 }, (_, at) => at);

    for (let i = 1; i <= a.length; i++) {
        const next = [i];

        for (let j = 1; j <= b.length; j++) {
            next[j] = Math.min(
                row[j]! + 1,
                next[j - 1]! + 1,
                row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }

        row = next;
    }

    return row[b.length]!;
}

export function nearest(
    name: string,
    names: Iterable<string>,
    budget: SuggestionBudget,
): string | undefined {
    let best: string | undefined;
    let bestDistance = Math.max(2, Math.floor(name.length / 4)) + 1;

    for (const candidate of names) {
        if (Math.abs(name.length - candidate.length) > 4) {
            continue;
        }

        const cost = name.length * candidate.length;

        if (cost > budget.remaining) {
            break;
        }

        budget.remaining -= cost;

        const gap = distance(name, candidate);

        if (gap < bestDistance) {
            best = candidate;
            bestDistance = gap;
        }
    }

    return best;
}
