import assert from "node:assert/strict";
import { test } from "node:test";

type Session = { id: number; cwd: string; updatedAt: number; linkedFrom?: { id: number } };
type Row = { session: Session; branches: boolean[] };
const { sessionForest } = (await import(
    new URL("../web/session-tree.js", import.meta.url).href
)) as {
    sessionForest: (
        shown: Session[],
        options?: { pinned?: number[]; folders?: boolean },
    ) => { roots: Session[]; rows: Map<number, Row[]> };
};
const chat = (id: number, parent?: number, updatedAt = id): Session => ({
    id,
    cwd: "/project",
    updatedAt,
    ...(parent === undefined ? {} : { linkedFrom: { id: parent } }),
});

const flatten = (shown: Session[], options = {}) => {
    const tree = sessionForest(shown, options);

    return tree.roots.flatMap((root) => tree.rows.get(root.id)!);
};

test("linked families use preorder and continuous branches without mutating server rows", () => {
    const shown = [chat(3, 1), chat(4, 3), chat(2, 1), chat(5), chat(1)];
    const original = structuredClone(shown);

    assert.deepEqual(
        flatten(shown).map(({ session, branches }) => [session.id, branches]),
        [
            [5, []],
            [1, []],
            [3, [true]],
            [4, [true, false]],
            [2, [false]],
        ],
    );
    assert.deepEqual(shown, original);
});

test("a today's child moves yesterday's family ahead of unrelated older activity", () => {
    const today = Date.now();
    const yesterday = today - 86_400_000;
    const shown = [
        chat(2, 1, today),
        chat(3, undefined, today - 100),
        chat(1, undefined, yesterday),
    ];
    const tree = sessionForest(shown);

    assert.deepEqual(
        tree.roots.map((root) => [root.id, root.updatedAt]),
        [
            [1, today],
            [3, today - 100],
        ],
    );
    assert.equal(tree.rows.get(1)![0]!.session.updatedAt, yesterday);
});

test("filtered, archived-away or private origins are not synthesized", () => {
    assert.deepEqual(
        flatten([chat(2, 1)]).map((row) => row.branches),
        [[]],
    );
    assert.deepEqual(
        flatten([chat(1)]).map((row) => row.session.id),
        [1],
    );
});

test("pinned children stay roots; folder boundaries apply only in Folders", () => {
    const shown = [chat(2, 1), chat(1)];

    assert.deepEqual(
        flatten(shown, { pinned: [2] }).map((row) => row.branches),
        [[], []],
    );
    shown[0]!.cwd = "/elsewhere";
    assert.deepEqual(
        flatten(shown, { folders: true }).map((row) => row.branches),
        [[], []],
    );
    assert.deepEqual(
        flatten(shown).map((row) => row.branches),
        [[], [false]],
    );
});

test("cycles and self-links neither lose nor duplicate chats", () => {
    const shown = [chat(1, 2), chat(2, 1), chat(3, 3), chat(4, 2)];
    const rows = flatten(shown);

    assert.equal(rows.length, shown.length);
    assert.deepEqual(rows.map((row) => row.session.id).sort(), [1, 2, 3, 4]);
});

test("deep families retain their full logical depth", () => {
    const shown = Array.from({ length: 100 }, (_, index) => chat(index + 1, index || undefined));
    const rows = flatten(shown);

    assert.equal(rows.length, 100);
    assert.equal(rows[99]!.branches.length, 99);
});
