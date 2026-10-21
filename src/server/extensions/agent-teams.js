// Agent Teams' browser module: how calls of its team tool show, in a line in transcripts and peek tiles, and in
// the summary of a group of calls. It only describes; it adds no routes.
export const pocketApi = 1;

const LABELS = {
    start: "start session",
    send: "message session",
    list: "list sessions",
};

const text = (value) => (typeof value === "string" ? value : "");

export default function setup(pocket) {
    pocket.toolCall({
        tool: "team",
        icon: "fork",
        label: (args) => LABELS[args.action] ?? "linked sessions",
        subject: (args) =>
            [args.action === "start" ? text(args.title) : "", text(args.message)]
                .filter((part) => part !== "")
                .join(" · "),
        summary: (args) =>
            args.action === "start"
                ? { verb: "started", noun: "session" }
                : args.action === "send"
                  ? { verb: "messaged", noun: "session", by: "to" }
                  : { verb: "checked linked sessions" },
    });
}
