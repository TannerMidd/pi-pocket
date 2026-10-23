/** The facts that help an agent choose a model from the owner's list, one short line each, for prompt sections. */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** What `host.modelInfo` gives; the fields after `thinkingLevels` are left out when unknown. */
type Info = {
    thinkingLevels: ModelThinkingLevel[];
    contextWindow?: number;
    cost?: { input: number; output: number };
};

/** A price without trailing zeros: 3, 0.3, 0.25. */
const price = (dollars: number) => String(Number(dollars.toFixed(dollars < 0.1 ? 3 : 2)));

/** "200k ctx", "1M ctx". */
function window(tokens: number): string {
    return tokens >= 995_000
        ? `${String(Number((tokens / 1_000_000).toFixed(1)))}M ctx`
        : `${String(Math.max(1, Math.round(tokens / 1000)))}k ctx`;
}

/**
 * One line for a listed model: whether and how far it thinks, its context window, and its price per million input and
 * output tokens, each only when known. `mine` marks the session's own model; `problem` says why it cannot be used now.
 */
export function modelLine(
    spec: string,
    info: Info | undefined,
    mine: boolean,
    problem?: string,
): string {
    const facts: string[] = [];

    if (info !== undefined) {
        const top = info.thinkingLevels.at(-1);

        facts.push(
            info.thinkingLevels.every((level) => level === "off")
                ? "no thinking"
                : `thinks up to ${top}`,
        );

        if (info.contextWindow !== undefined && info.contextWindow > 0) {
            facts.push(window(info.contextWindow));
        }

        if (info.cost !== undefined) {
            facts.push(`$${price(info.cost.input)} in/$${price(info.cost.output)} out per 1M`);
        }
    }

    if (mine) {
        facts.push("your model");
    }

    if (problem !== undefined) {
        facts.push(`not now: ${problem}`);
    }

    return facts.length === 0 ? `- ${spec}` : `- ${spec}: ${facts.join(", ")}`;
}
