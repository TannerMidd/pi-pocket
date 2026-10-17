/**
 * How a subagent's run ended, in the words its record keeps: shared by the subagent tool's reports of Pi's work
 * (`extensions/subagents.ts`) and a person's own messages to a failed subagent (`commands.ts`).
 */
import { STOPPED } from "./docs.ts";

/** Why a subagent did not answer, for its report and its row: what went wrong, in a line, or that it was stopped. */
export function whyUnanswered(reason: string, detail: unknown): string {
    if (reason === "aborted") {
        return STOPPED;
    }

    if (reason === "no_model") {
        return "its model is not available here";
    }

    const text = typeof detail === "string" && detail.trim() !== "" ? detail : reason;

    // One line, and no "]", which ends a report's head.
    return text.replace(/\s+/g, " ").replace(/]/g, ")").trim().slice(0, 200);
}
