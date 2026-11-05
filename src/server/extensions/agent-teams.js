// Agent Teams' browser module: how calls of its team tool show, in a line in transcripts and peek tiles, and in
// the summary of a group of calls. It only describes; it adds no routes.
export const pocketApi = 1;

const labels = (t) => ({
    start: t("server.extensions.agent-teams.start", "start session"),
    send: t("server.extensions.agent-teams.send", "message session"),
    list: t("server.extensions.agent-teams.list", "list sessions"),
    stop: t("server.extensions.agent-teams.stop", "stop session"),
    archive: t("server.extensions.agent-teams.archive", "archive session"),
});

const text = (value) => (typeof value === "string" ? value : "");

export default function setup(pocket) {
    const t = pocket.t;

    pocket.toolCall({
        tool: "team",
        icon: "fork",
        label: (args) =>
            labels(t)[args.action] ?? t("server.extensions.agent-teams.linked", "linked sessions"),
        subject: (args) =>
            [args.action === "start" ? text(args.title) : "", text(args.message)]
                .filter((part) => part !== "")
                .join(" · "),
        summary: (args) =>
            args.action === "start"
                ? {
                      verb: t("server.extensions.agent-teams.started", "started"),
                      noun: t("server.extensions.agent-teams.session", "session"),
                  }
                : args.action === "send"
                  ? {
                        verb: t("server.extensions.agent-teams.messaged", "messaged"),
                        noun: t("server.extensions.agent-teams.session", "session"),
                        by: t("server.extensions.agent-teams.to", "to"),
                    }
                  : args.action === "stop"
                    ? {
                          verb: t("server.extensions.agent-teams.stopped", "stopped"),
                          noun: t("server.extensions.agent-teams.session", "session"),
                      }
                    : args.action === "archive"
                      ? {
                            verb: t("server.extensions.agent-teams.archived", "archived"),
                            noun: t("server.extensions.agent-teams.session", "session"),
                        }
                      : {
                            verb: t(
                                "server.extensions.agent-teams.checked",
                                "checked linked sessions",
                            ),
                        },
    });
}
