import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: browser module without declarations.
import * as families from "../web/session-tree.js";
const {
    familyIndex,
    ancestorMatches,
    breadcrumb,
    belongsTo,
    descendantCount,
    familyAttention,
    recentRows,
} = families;

const record = (id: number, parent?: number) => ({
    id,
    title: "Record " + id,
    updatedAt: id,
    ...(parent === undefined ? {} : { linkedFrom: { id: parent } }),
});

test("nested families count each visible session once and cap recent shortcuts independently of the family size", () => {
    const sessions = Array.from({ length: 1478 }, (_, i) => ({
        ...record(i, i === 0 || i === 1477 ? undefined : i % 3 === 0 ? 1 : 0),
        archived: i === 3,
        busy: i === 6,
        limited: i === 4 ? 100 : undefined,
    }));
    const tree = familyIndex(sessions);

    assert.equal(familyIndex(sessions), tree);
    assert.equal(descendantCount(tree.nodes.get(0)), 1475);
    assert.equal(belongsTo(tree.nodes.get(3), tree.nodes.get(1)), true);
    assert.equal(belongsTo(tree.nodes.get(1477), tree.nodes.get(0)), false);
    assert.equal(breadcrumb(tree.nodes.get(3)), "Record 0 › Record 1");
    assert.equal(ancestorMatches(tree, "record 1").has(tree.nodes.get(3)), true);
    const counts = familyAttention(tree, (s: { id: number }) =>
        [3, 6].includes(s.id) ? "ask" : s.id === 9 ? "failed" : null,
    );

    assert.deepEqual(counts.get(tree.nodes.get(0)), { waiting: 1, failed: 1 });
    const active = sessions.filter((s) => !s.archived);
    const rows = recentRows(active, tree, [4, 8, 10], 1466);

    assert.deepEqual(
        rows.shortcuts.map((s: { id: number }) => s.id),
        [4, 6, 1466],
    );
    assert.deepEqual(
        rows.candidates.map((s: { id: number }) => s.id),
        [4, 6, 8, 10],
    );
    assert.equal(rows.roots.length, 2);
});

test("counts skip archived sessions but keep active descendants of archived parents", () => {
    const tree = familyIndex([
        record(0),
        { ...record(1, 0), archived: true },
        record(2, 1),
        { ...record(3, 1), archived: true },
    ]);
    const counts = familyAttention(tree, (s: {id:number}) => s.id === 1 ? "failed" : "ask");

    assert.equal(descendantCount(tree.nodes.get(0)), 1);
    assert.equal(descendantCount(tree.nodes.get(1)), 1);
    assert.deepEqual(counts.get(tree.nodes.get(0)), {waiting:1, failed:0});
});

test("a missing parent has no breadcrumb; cycles and deep chains do not lose rows or recurse", () => {
    const sessions = Array.from({ length: 10000 }, (_, i) => record(i, i ? i - 1 : 1));

    sessions.push(record(10000, -1));
    const index = familyIndex(sessions);

    assert.equal(index.roots.length, 2);
    assert.equal(index.order.length, sessions.length);
    assert.equal(breadcrumb(index.nodes.get(10000)), "");
    assert.equal(descendantCount(index.nodes.get(0)), 9999);
    assert.match(breadcrumb(index.nodes.get(9999)), /^… › /);
});
