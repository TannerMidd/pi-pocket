// A tool call in one line, as transcripts and peek tiles show it.

const short = (text, max = 90) => {
    const flat = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * How extensions' browser modules show their own tools' calls (`pocket.toolCall`): `extension-ui.js` sets it, and it
 * gives `{ label, subject, iconPath? }` in text, or undefined for the default display.
 */
let ownDescription = () => undefined;
/** Goes up when what extensions describe changes, so that calls drawn before draw again. */
let ownRevision = 0;

export function setCallDescriber(describe) {
    ownDescription = describe;
}

export function describersChanged() {
    ownRevision++;
}

export const describersRevision = () => ownRevision;

/**
 * A tool call in one line: an icon, a label, and what it acts on. Peek tiles describe calls this way too. `own` marks a
 * call an extension described.
 */
export function describeCall(call) {
    const args = call.args ?? {};

    switch (call.name) {
        case "read": {
            const range = args.offset ? `:${args.offset}${args.limit ? `+${args.limit}` : ""}` : "";

            return { icon: "▤", label: "Read", subject: `${args.path ?? ""}${range}`, mono: true };
        }

        case "write":
            return { icon: "✎", label: "Write", subject: args.path ?? "", mono: true };
        case "edit":
            return { icon: "✎", label: "Edit", subject: args.path ?? "", mono: true };
        case "bash":
            return { icon: ">_", label: "", subject: short(args.command, 140), mono: true };
        case "artifact":
        case "artifact_inline":
            return {
                icon: "✦",
                label: "Artifact",
                subject: args.title ?? args.id ?? "",
                mono: false,
            };

        case "codemode": {
            // The first line that does something: not the options line, a comment, or blank.
            const line = String(args.code ?? "")
                .split("\n")
                .map((each) => each.trim())
                .find((each) => each !== "" && !each.startsWith("//"));

            return { icon: "{}", label: "Codemode", subject: short(line ?? "", 140), mono: true };
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

        case "ask": {
            const questions = Array.isArray(args.questions) ? args.questions : [];

            return {
                icon: "?",
                label: "Ask",
                // A peek line's call carries only short scalar arguments (`peekArgs`): no questions, no subject.
                subject:
                    questions.length === 0
                        ? ""
                        : questions.length === 1
                          ? short(String(questions[0]?.question ?? ""), 120)
                          : questions
                                .map((each) => each?.header)
                                .filter(Boolean)
                                .join(" · "),
                mono: false,
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

        default: {
            const own = ownDescription(call.name, args);

            if (own !== undefined) {
                return { icon: "⚙", mono: false, own: true, ...own };
            }

            return {
                icon: "⚙",
                label: call.name,
                subject: short(JSON.stringify(args), 100),
                mono: true,
            };
        }
    }
}
