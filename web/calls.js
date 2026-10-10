// A tool call in one line, as transcripts and peek tiles show it.
import { t } from "./i18n.js";

const short = (text, max = 90) => {
    const flat = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A tool call in one line: an icon, a label, and what it acts on. Peek tiles describe calls this way too. */
export function describeCall(call) {
    const args = call.args ?? {};

    switch (call.name) {
        case "read": {
            const range = args.offset ? `:${args.offset}${args.limit ? `+${args.limit}` : ""}` : "";

            return {
                icon: "▤",
                label: t("Read"),
                subject: `${args.path ?? ""}${range}`,
                mono: true,
            };
        }

        case "write":
            return { icon: "✎", label: t("Write"), subject: args.path ?? "", mono: true };
        case "edit":
            return { icon: "✎", label: t("Edit"), subject: args.path ?? "", mono: true };
        case "bash":
            return { icon: ">_", label: "", subject: short(args.command, 140), mono: true };
        case "artifact":
            return {
                icon: "✦",
                label: t("Artifact"),
                subject: args.title ?? args.id ?? "",
                mono: false,
            };

        case "codemode": {
            // The first line that does something: not the options line, a comment, or blank.
            const line = String(args.code ?? "")
                .split("\n")
                .map((each) => each.trim())
                .find((each) => each !== "" && !each.startsWith("//"));

            return {
                icon: "{}",
                label: t("Codemode"),
                subject: short(line ?? "", 140),
                mono: true,
            };
        }

        case "browser": {
            const firstLine = String(args.script ?? "")
                .split("\n")
                .find((each) => each.trim() !== "");
            const what =
                args.url ??
                (args.ref ? `[${String(args.ref).replace(/^\[|\]$/g, "")}]` : undefined) ??
                args.selector ??
                (args.label ? `“${args.label}”` : undefined) ??
                args.key ??
                args.viewport ??
                firstLine ??
                (args.text !== undefined ? `“${args.text}”` : "");
            const typed =
                args.action === "type" && args.text !== undefined && what !== `“${args.text}”`
                    ? ` ← “${args.text}”`
                    : "";

            return {
                icon: "◎",
                label: `Browser ${args.action ?? ""}`,
                subject: short(`${what}${typed}`, 120),
                mono: true,
            };
        }

        case "subagent":
            return {
                icon: "⧉",
                label: `Subagent ${args.action ?? ""}`,
                subject: [args.name, args.message && short(args.message, 60)]
                    .filter(Boolean)
                    .join(" · "),
                mono: true,
            };
        default:
            return {
                icon: "⚙",
                label: call.name,
                subject: short(JSON.stringify(args), 100),
                mono: true,
            };
    }
}
