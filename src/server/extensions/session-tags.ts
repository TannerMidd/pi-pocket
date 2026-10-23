/** Session tags: shared labels on sessions, shown on their rows, found by search, and used to filter the session list. */
import { defineDoc } from "@earendil-works/pi-durable";
// Types only: at run time this module uses nothing of Pi Pocket's but the host and web, as a drop-in would.
import type { ExtensionWeb, PocketHost, WebRequest } from "../host.ts";

/** Each session's tags, by session id. A session with no tags has no key. Stored data: never rename the kind. */
const Tags = defineDoc<{ tags: Record<string, string[]> }>({
    kind: "x.session-tags.tags",
    version: 1,
    scope: "session",
    initial: () => ({ tags: {} }),
});

const MAX_TAGS = 10;
const MAX_LENGTH = 32;
const MAX_IDS = 500;

/** Whether Pi Pocket `version` is 0.20.0 or newer: a server started before then has none of what this module uses. */
function supported(version: string | undefined): boolean {
    const [major = 0, minor = 0] = (version ?? "0.0.0").split(".").map(Number);

    return major > 0 || minor >= 20;
}

export default function createSessionTags(host: PocketHost, web?: ExtensionWeb) {
    // A server that runs older code, which loaded this file as its checkout changed, has no session list extension
    // points, nor `request.sessions()`, and would turn this module on: it then adds nothing, until a restart.
    if (web === undefined || !supported(host.pocketVersion)) {
        return;
    }

    // Everyone who sees every session sees the tags; people invited to one session do not load it.
    web.client("session-tags", { access: "view" });

    /** The sessions this person can see, by id. Before a restart gives routes `sessions()`, nothing can be checked. */
    const visible = (request: WebRequest): Set<number> => {
        if (typeof request.sessions !== "function") {
            throw web.error(503, "Session tags needs a server restart before it can be used.");
        }

        return new Set(request.sessions().map((session) => session.id));
    };

    /** Tag names as stored: trimmed and lowercased, 1 to 32 characters, no control characters, each once. */
    const names = (value: unknown): string[] => {
        if (value === undefined) {
            return [];
        }

        if (!Array.isArray(value) || value.length > MAX_TAGS * 2) {
            throw web.error(400, "Tags are a list of names.");
        }

        const out = new Set<string>();

        for (const item of value) {
            const name = typeof item === "string" ? item.trim().toLowerCase() : "";

            if (
                name === "" ||
                [...name].length > MAX_LENGTH ||
                /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(name)
            ) {
                throw web.error(400, `A tag is 1 to ${MAX_LENGTH} characters, on one line.`);
            }

            out.add(name);
        }

        return [...out];
    };

    // The tags of the sessions this person can see.
    web.route(
        "GET",
        "tags",
        async (request) => {
            const shown = visible(request);
            const doc = await request.snapshot(Tags, request.context);

            return {
                tags: Object.fromEntries(
                    Object.entries(doc?.tags ?? {}).filter(([id]) => shown.has(Number(id))),
                ),
            };
        },
        { access: "view" },
    );

    // Add and remove tags on sessions, all of them or none: the other tags they have stay.
    web.route(
        "POST",
        "tags",
        async (request) => {
            const { ids, add: added, remove: removed } = request.body;

            if (
                !Array.isArray(ids) ||
                ids.length === 0 ||
                !ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
            ) {
                throw web.error(400, "Choose the sessions to tag.");
            }

            if (ids.length > MAX_IDS) {
                throw web.error(400, `Tag ${MAX_IDS} sessions at most at once.`);
            }

            const add = names(added);
            const remove = new Set(names(removed));

            if (add.some((name) => remove.has(name))) {
                throw web.error(400, "A tag cannot be added and removed at once.");
            }

            const shown = visible(request);

            if (!ids.every((id) => shown.has(id))) {
                throw web.error(404, "A session to tag is not there anymore.");
            }

            const changed = await request.commit(async (tx) => {
                const doc = await tx.doc(Tags);
                const next = new Map<string, string[]>();

                // Every session first, then the change: one over the limit changes none.
                for (const id of new Set(ids as number[])) {
                    const key = String(id);
                    const tags = [
                        ...new Set([
                            ...(doc.tags[key] ?? []).filter((name) => !remove.has(name)),
                            ...add,
                        ]),
                    ].sort();

                    if (tags.length > MAX_TAGS) {
                        throw web.error(
                            409,
                            `A session can have ${MAX_TAGS} tags at most. Nothing was saved.`,
                        );
                    }

                    next.set(key, tags);
                }

                for (const [key, tags] of next) {
                    if (tags.length === 0) {
                        delete doc.tags[key];
                    } else {
                        doc.tags[key] = tags;
                    }
                }

                return Object.fromEntries(next);
            });

            // Each tab asks again, for the sessions its person can see.
            web.send("changed");

            return { tags: changed };
        },
        { access: "steer" },
    );
}
