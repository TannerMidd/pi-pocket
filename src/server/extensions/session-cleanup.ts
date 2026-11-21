/** Session cleanup: the owner removes the worktrees of archived sessions, or takes archived sessions out of the app with Pocket's own files. */
// Types only: what it does is core's (`session-cleanup.ts`), through the host's internal `sessionCleanup`.
import type { ExtensionWeb, PocketHost, WebRequest } from "../host.ts";

const DAY = 24 * 60 * 60 * 1000;

export default function createSessionCleanup(host: PocketHost, web?: ExtensionWeb) {
    // A server that runs older code, which loaded this file as its checkout changed, has no cleanup: nothing until a
    // restart.
    const cleanup = (host as Partial<PocketHost>).sessionCleanup;

    if (web === undefined || typeof cleanup?.plan !== "function") {
        return;
    }

    // The owner's alone: the browser module and every route (`access` is the owner by default).
    web.client("session-cleanup");

    /** The sessions a request names by id. A change acts only on those its confirm showed. */
    const named = (request: WebRequest): unknown[] => {
        const { ids } = request.body;

        if (!Array.isArray(ids) || ids.length === 0) {
            throw web.error(400, "Choose the sessions.");
        }

        return ids;
    };

    /** The sessions a plan is for: `ids`, or every archived one not used for `olderThanDays` days. */
    const chosen = (request: WebRequest): unknown[] => {
        const { ids, olderThanDays } = request.body;

        if (ids !== undefined) {
            return named(request);
        }

        if (
            typeof olderThanDays !== "number" ||
            !Number.isInteger(olderThanDays) ||
            olderThanDays < 0 ||
            olderThanDays > 3650
        ) {
            throw web.error(400, "Say how many days old, 0 to 3650.");
        }

        const before = Date.now() - olderThanDays * DAY;

        return request
            .sessions()
            .filter((session) => session.archived && session.updatedAt <= before)
            .map((session) => session.id);
    };

    web.route("POST", "plan", async (request) => ({
        sessions: await cleanup.plan(request.user.id, chosen(request)),
    }));

    web.route("POST", "clean-up", async (request) => ({
        outcomes: await cleanup.cleanUp(request.user.id, named(request)),
    }));

    web.route("POST", "remove", async (request) => ({
        outcomes: await cleanup.remove(request.user.id, named(request)),
    }));
}
