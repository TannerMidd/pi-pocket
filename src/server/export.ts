/**
 * A session as one Markdown file: every message in order, who wrote it, and each tool call folded into a
 * `<details>` block, so it reads well on GitHub or in any Markdown viewer. Pi's thinking is left out.
 */
import type { ClientBlock, ClientEntry } from "./projection.ts";
import { ATTACHMENTS_HEADING, FROM_PREFIX } from "./entry-format.ts";

/** Tool output beyond this keeps its start and end. */
const MAX_OUTPUT = 4000;

export type ExportInput = {
    title: string;
    cwd: string;
    model?: string;
    exportedAt: Date;
    /** The whole history, oldest first, as `projectEntry(entry, true)` makes it. */
    entries: readonly ClientEntry[];
    /** The name of whoever wrote each message to Pi, by entry id. */
    authors: Readonly<Record<number, string>>;
};

/** A fenced code block that no backtick run inside `text` can close early. */
export function fence(text: string, language = ""): string {
    let longest = 2;

    for (const run of text.matchAll(/`+/g)) {
        longest = Math.max(longest, run[0].length);
    }

    const marks = "`".repeat(longest + 1);

    return `${marks}${language}\n${text.replace(/\n$/, "")}\n${marks}`;
}

function clipped(text: string): string {
    if (text.length <= MAX_OUTPUT) {
        return text;
    }

    const half = MAX_OUTPUT / 2;

    return `${text.slice(0, half)}\n… ${text.length - MAX_OUTPUT} characters left out …\n${text.slice(-half)}`;
}

/** One line naming a tool call, for its `<summary>`. HTML-escaped: summaries are HTML. */
function summary(call: Extract<ClientBlock, { type: "toolCall" }>): string {
    const args = call.args;
    const subject =
        typeof args.command === "string"
            ? args.command
            : typeof args.path === "string"
              ? args.path
              : typeof args.title === "string"
                ? args.title
                : typeof args.name === "string"
                  ? args.name
                  : "";
    const line = `${call.name}${subject === "" ? "" : `: ${subject.replace(/\s+/g, " ")}`}`;
    const short = line.length > 120 ? `${line.slice(0, 119)}…` : line;

    return short.replace(/[&<>]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** What a tool call did: its arguments as they matter to a reader, then its result. */
function callBody(
    call: Extract<ClientBlock, { type: "toolCall" }>,
    result: Extract<ClientEntry, { kind: "toolResult" }> | undefined,
): string {
    const args = call.args;
    const parts: string[] = [];

    if (call.name === "bash" && typeof args.command === "string") {
        parts.push(fence(`$ ${args.command}`, "sh"));
    } else if (call.name === "write" && typeof args.content === "string") {
        parts.push(fence(clipped(args.content)));
    } else if (call.name === "codemode" && typeof args.code === "string") {
        parts.push(fence(args.code, "js"));
    } else if (call.name !== "read" && call.name !== "edit") {
        parts.push(fence(JSON.stringify(args, null, 2), "json"));
    }

    const diff = (result?.details as { diff?: unknown } | undefined)?.diff;

    if (call.name === "edit" && typeof diff === "string") {
        parts.push(fence(clipped(diff), "diff"));
    } else if (result !== undefined && result.text.trim() !== "") {
        parts.push(`${result.isError ? "Failed:\n\n" : ""}${fence(clipped(result.text))}`);
    } else if (result === undefined) {
        parts.push("_No result: the call did not finish._");
    }

    return parts.join("\n\n");
}

/** A person's message: who wrote it, what they wrote, and the names of the files they attached. */
function userMarkdown(
    entry: Extract<ClientEntry, { kind: "user" }>,
    author: string | undefined,
): string {
    const [written = "", files] = entry.text.split(ATTACHMENTS_HEADING);
    const body = written.replace(FROM_PREFIX, "").trim();
    const names = (files ?? "")
        .split("\n")
        .map((line) => /\((.*?), /.exec(line)?.[1])
        .filter((name): name is string => name !== undefined);
    const lines = [
        `**${author ?? entry.from ?? "Someone"}**`,
        "",
        body === "" ? "_(files only)_" : body,
    ];

    if (names.length > 0) {
        lines.push("", `Attached: ${names.map((name) => `\`${name}\``).join(", ")}`);
    }

    return lines.join("\n");
}

export function transcriptMarkdown(input: ExportInput): string {
    const results = new Map<string, Extract<ClientEntry, { kind: "toolResult" }>>();

    for (const entry of input.entries) {
        if (entry.kind === "toolResult") {
            results.set(entry.callId, entry);
        }
    }

    const when = input.exportedAt.toISOString().slice(0, 16).replace("T", " ");
    const sections: string[] = [
        `# ${input.title}`,
        `_Exported from Pi Pocket on ${when} UTC. Folder \`${input.cwd}\`${input.model === undefined ? "" : `, model \`${input.model}\``}._`,
    ];
    // One answer is often several model responses with tool calls between them: one "Pi" heading for all of them.
    let piSpeaking = false;

    for (const entry of input.entries) {
        if (entry.kind === "assistant") {
            const parts: string[] = [];

            for (const block of entry.blocks) {
                if (block.type === "text") {
                    parts.push(block.text);
                } else if (block.type === "toolCall") {
                    parts.push(
                        `<details><summary>${summary(block)}</summary>\n\n${callBody(block, results.get(block.id))}\n\n</details>`,
                    );
                }
            }

            if (entry.stopReason === "error") {
                parts.push(`> Error: ${entry.error ?? "the model request failed."}`);
            }

            if (entry.stopReason === "aborted") {
                parts.push("_Stopped._");
            }

            if (parts.length > 0) {
                sections.push([...(piSpeaking ? [] : ["**Pi**"]), ...parts].join("\n\n"));
                piSpeaking = true;
            }

            continue;
        }

        if (entry.kind === "user") {
            sections.push(userMarkdown(entry, input.authors[entry.id]));
        } else if (entry.kind === "compaction") {
            sections.push(
                `<details><summary>Context compacted</summary>\n\n${entry.summary}\n\n</details>`,
            );
        } else if (entry.kind === "reset") {
            sections.push(
                ["---", "_New context._", entry.text ?? ""]
                    .filter((line) => line !== "")
                    .join("\n\n"),
            );
        } else if (entry.kind === "note") {
            sections.push(`_${entry.name} ${entry.text}._`);
        } else if (entry.kind === "command") {
            sections.push(
                `**${entry.name}** ran \`/${entry.command}\` (not shown to Pi):\n\n${fence(entry.output)}`,
            );
        } else if (entry.kind === "shell") {
            const fence = entry.output.includes("```") ? "````" : "```";

            sections.push(
                `**${entry.name}** ran \`${entry.command}\`${entry.context ? "" : " (not shown to Pi)"}:\n\n${fence}\n${entry.output.replace(/\s+$/, "")}\n${fence}`,
            );
        }
        // Tool results show inside their calls; system entries are not for people.
        else {
            continue;
        }

        piSpeaking = false;
    }

    return `${sections.join("\n\n")}\n`;
}
