// Menu → Restart server, for the owner: what the button does as the owner's setting says (`restart` in config.json),
// and, while a restart waits for calls it would cut off (`src/server/restart.ts`), what it waits for, Restart now, and
// Cancel. The menu sheet and the launcher both show these items.
import { fromServer } from "./seen.js";
import { api, attempt, notify, store } from "./store.js";

const minutes = (ms) => {
    const total = Math.max(0, Math.round(ms / 60_000));

    return total < 60 ? `${total} min` : `${Math.floor(total / 60)} h ${total % 60} min`;
};

/** What a restart that waits waits for, in words: "bash in Fix login (3 min)", the rest counted. */
export function restartWaitsFor(pending, sessions = store.state.sessions) {
    if (!pending) {
        return "";
    }

    const blockers = pending.blockers ?? [];

    if (blockers.length === 0) {
        return "checking what runs…";
    }

    const first = blockers[0];
    const session = sessions.find((each) => each.id === first.conversationId);
    const where = session ? ` in ${session.title ?? "New session"}` : "";
    const more = blockers.length > 1 ? ` and ${blockers.length - 1} more` : "";
    const since = minutes(Date.now() - fromServer(pending.since));
    const deadline =
        pending.deadline === undefined
            ? ""
            : ` · at the latest in ${minutes(fromServer(pending.deadline) - Date.now())}`;

    return `${first.tool}${where}${more} (${since})${deadline}`;
}

async function ask(mode, done) {
    await attempt(async () => {
        const answer = await api("restart", mode === undefined ? {} : { mode });

        done?.();

        if (answer?.restarting) {
            notify("info", "Restarting. Running work continues after the restart.");
        } else {
            notify(
                "info",
                `The server restarts once nothing runs that it would cut off: ${restartWaitsFor(answer?.pending)}. New model requests wait until then.`,
            );
        }
    });
}

/**
 * The restart items for the owner of a server under its launcher, or none: `{ key, label, hint, run }` each. `done`
 * closes what opened them.
 */
export function restartItems({ done } = {}) {
    const server = store.state.server;

    if (store.state.me?.role !== "owner" || !server?.supervised) {
        return [];
    }

    const pending = server.restartPending;

    if (pending) {
        return [
            {
                key: "restart-now",
                label: "Restart now",
                hint: `waits for ${restartWaitsFor(pending)}`,
                run: () => ask("now", done),
            },
            {
                key: "restart-cancel",
                label: "Cancel restart",
                hint: "held model requests go on",
                run: () =>
                    attempt(async () => {
                        await api("restart/cancel", {});
                        done?.();
                        notify("info", "Restart cancelled. Waiting requests go on.");
                    }),
            },
        ];
    }

    return [
        {
            key: "restart",
            label: "Restart server",
            hint:
                server.restart === "when-safe"
                    ? "once nothing runs that it would cut off"
                    : "running work resumes",
            run: () => ask(undefined, done),
        },
    ];
}
