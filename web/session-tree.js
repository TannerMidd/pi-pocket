// Index only the session list supplied for this person. Pins and filters do not change relationships.
const indices = new WeakMap();

export function familyIndex(sessions) {
    if (indices.has(sessions)) {
        return indices.get(sessions);
    }

    const nodes = new Map(
        sessions.map((session) => [
            session.id,
            { session, parent: null, children: [], start: 0, end: 0 },
        ]),
    );

    for (const node of nodes.values()) {
        node.parent = nodes.get(node.session.linkedFrom?.id) ?? null;
    }

    // Cut one edge per cycle. Each parent chain is visited once, even for a very deep family.
    const done = new Set();

    for (const first of nodes.values()) {
        const path = new Set();
        let node = first;

        while (node && !done.has(node)) {
            if (path.has(node)) {
                node.parent = null;
                break;
            }

            path.add(node);
            node = node.parent;
        }

        for (const item of path) {
            done.add(item);
        }
    }

    const roots = [];

    for (const node of nodes.values()) {
        (node.parent?.children ?? roots).push(node);
    }

    const order = [];
    const stack = [...roots].reverse();

    while (stack.length) {
        const node = stack.pop();

        node.start = order.length;
        order.push(node);

        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push(node.children[i]);
        }
    }

    for (let i = order.length - 1; i >= 0; i--) {
        const node = order[i];

        node.end = node.children.at(-1)?.end ?? i + 1;
    }

    const index = { nodes, roots, order };

    indices.set(sessions, index);

    return index;
}

export const descendantCount = (node) => (node ? node.end - node.start - 1 : 0);
export const belongsTo = (node, lead) => lead && node.start > lead.start && node.start < lead.end;

export function familyAttention(index, needOf) {
    const counts = new Map();

    for (let i = index.order.length - 1; i >= 0; i--) {
        const node = index.order[i];

        if (!node.parent) {
            continue;
        }

        const parent = counts.get(node.parent) ?? { waiting: 0, failed: 0 };
        const kids = counts.get(node);
        const need = !node.session.archived && needOf(node.session);

        parent.waiting += (kids?.waiting ?? 0) + Number(need === "ask");
        parent.failed += (kids?.failed ?? 0) + Number(need === "failed" || need === "agents");
        counts.set(node.parent, parent);
    }

    return counts;
}

export function ancestorMatches(index, needle) {
    const matched = new Set();

    for (const node of index.order) {
        if (
            node.parent &&
            (matched.has(node.parent) ||
                (node.parent.session.title ?? "New session").toLowerCase().includes(needle))
        ) {
            matched.add(node);
        }
    }

    return matched;
}

export function breadcrumb(node) {
    const names = [];
    let parent = node?.parent;

    while (parent && names.length < 4) {
        names.unshift(parent.session.title ?? "New session");
        parent = parent.parent;
    }

    return [...(parent ? ["…"] : []), ...names].join(" › ");
}

export function atWork(session) {
    const counts = session.subagents ?? {};

    return (
        session.busy ||
        session.limited !== undefined ||
        (counts.working ?? 0) + (counts.waiting ?? 0) > 0 ||
        session.background > 0
    );
}

// The first two shortcuts, plus a selected child not already shown. Keep all ordinary roots.
export function recentRows(shown, index, pins, open) {
    const pinned = new Set(pins);
    const linked = shown.filter((s) => index.nodes.get(s.id)?.parent);
    const candidates = linked.filter((s) => pinned.has(s.id) || atWork(s));
    const shortcuts = candidates.slice(0, 2);
    const current = linked.find((s) => s.id === open);

    if (current && !shortcuts.includes(current)) {
        shortcuts.push(current);
    }

    return { shortcuts, candidates, roots: shown.filter((s) => !index.nodes.get(s.id)?.parent) };
}
