/** A top row's branches: none. One array for all of them, so a memoized row sees the same value each time. */
const NO_BRANCHES = Object.freeze([]);

// Presentation only: linked sessions stay independent sessions, never subagents of the one that started them.
export function sessionForest(shown, { pinned = [], folders = false } = {}) {
    const byId = new Map(shown.map((session) => [session.id, session]));
    const pins = new Set(pinned);
    const parents = new Map();

    for (const session of shown) {
        const parent = byId.get(session.linkedFrom?.id);

        if (
            parent &&
            parent.id !== session.id &&
            !pins.has(session.id) &&
            (!folders || parent.cwd === session.cwd)
        ) {
            parents.set(session.id, parent.id);
        }
    }

    // Stored links should be acyclic, but malformed input must not hide rows or loop forever.
    for (const session of shown) {
        const seen = new Set([session.id]);
        let at = parents.get(session.id);

        while (at !== undefined) {
            if (seen.has(at)) {
                parents.delete(session.id);
                break;
            }

            seen.add(at);
            at = parents.get(at);
        }
    }

    const children = new Map(shown.map((session) => [session.id, []]));

    for (const session of shown) {
        const parent = parents.get(session.id);

        if (parent !== undefined) {
            children.get(parent).push(session);
        }
    }

    const rows = new Map();
    const roots = [];

    for (const session of shown) {
        if (parents.has(session.id)) {
            continue;
        }

        const family = [];
        const pending = [{ session, branches: NO_BRANCHES }];
        let updatedAt = session.updatedAt;

        while (pending.length > 0) {
            const row = pending.pop();
            const descendants = children.get(row.session.id);

            family.push(row);
            updatedAt = Math.max(updatedAt, row.session.updatedAt);

            for (let index = descendants.length - 1; index >= 0; index--) {
                pending.push({
                    session: descendants[index],
                    branches: [...row.branches, index < descendants.length - 1],
                });
            }
        }

        rows.set(session.id, family);
        roots.push({ ...session, updatedAt });
    }

    roots.sort((a, b) => b.updatedAt - a.updatedAt);

    return { roots, rows };
}
