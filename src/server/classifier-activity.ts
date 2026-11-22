import type { ClassifierAnswer } from "@earendil-works/pi-ai";
import { type ClassifyRequest, withDeadline } from "./classify.ts";

type Answers = Record<string, ClassifierAnswer>;
type Classify = (request: ClassifyRequest) => Promise<Answers>;

// Never put arbitrary provider output in the Hub, even if a provider returns it as a choice.
const choices = {
    "relay-inbound": ["question", "bug", "feature", "chat", "spam", "injection"],
    "relay-outbound": ["clean", "secret"],
    "agent-teams": ["progressing", "looping", "stuck"],
    "pip-search": [],
    "browser-screenshots": ["content", "loading", "error", "broken-layout"],
    "memory-suggestions": ["yes", "no"],
    "run-outcomes": ["completed", "needs_input", "blocked", "unclear"],
} as const satisfies Record<string, readonly string[]>;

type Source = keyof typeof choices;
type Status = "answered" | "failed" | "timed-out";
type Event = { source: Source; at: number; elapsedMs: number; status: Status; verdicts: string[] };
type Totals = { answered: number; failed: number; timedOut: number };

const sources = Object.keys(choices) as Source[];
const MAX_RECENT = 60;

class Activity {
    #startedAt = Date.now();
    #recent: Event[] = [];
    #counts = new Map<Source, Totals>();
    users = 0;

    record(source: Source, elapsedMs: number, status: Status, answers?: Answers): void {
        const counts = this.#counts.get(source) ?? { answered: 0, failed: 0, timedOut: 0 };

        counts[status === "timed-out" ? "timedOut" : status] += 1;
        this.#counts.set(source, counts);

        const allowed: readonly string[] = choices[source];
        const values = Object.values(answers ?? {});
        // Use the known values, not the response strings, and do not keep question IDs or the order of scores.
        const verdicts = allowed.filter((choice) =>
            values.some((answer) => answer?.type === "choice" && answer.choice === choice),
        );

        if (source === "pip-search") {
            const scores = values.filter((answer) => answer?.type === "score").length;

            if (scores > 0) {
                verdicts.push(`${scores} ${scores === 1 ? "score" : "scores"}`);
            }
        }

        this.#recent.unshift({ source, at: Date.now(), elapsedMs, status, verdicts });
        this.#recent.length = Math.min(this.#recent.length, MAX_RECENT);
    }

    snapshot() {
        return {
            startedAt: this.#startedAt,
            totals: sources.map((source) => ({
                source,
                answered: 0,
                failed: 0,
                timedOut: 0,
                ...this.#counts.get(source),
            })),
            recent: [...this.#recent],
        };
    }
}

// The host's classifier function identifies one PocketApp. A reload can overlap two versions of the Hub.
const active = new WeakMap<Classify, Activity>();

export function trackClassifier(classify: Classify) {
    const activity = active.get(classify) ?? new Activity();

    activity.users += 1;
    active.set(classify, activity);

    return {
        snapshot: () => activity.snapshot(),
        stop: () => {
            activity.users -= 1;

            if (activity.users === 0) {
                active.delete(classify);
            }
        },
    };
}

/** Classify with the integration's existing deadline. Record only the status that the caller received. */
export async function classifyFor(
    classify: Classify,
    source: Source,
    request: ClassifyRequest,
    timeoutMs: number,
): Promise<Answers | undefined> {
    const activity = active.get(classify);
    const started = performance.now();
    const result = await withDeadline(async () => {
        try {
            return { answers: await classify(request) };
        } catch {
            return { answers: undefined };
        }
    }, timeoutMs);

    // A failure and a timeout both yield no answers to the integration, but the Hub must distinguish them.
    activity?.record(
        source,
        Math.round(performance.now() - started),
        result === undefined ? "timed-out" : result.answers === undefined ? "failed" : "answered",
        result?.answers,
    );

    return result?.answers;
}
