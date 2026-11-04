// Which panel each session shows (web/panel-layout.js): read from what a state shows, shown again from what was kept,
// kept for the sessions shown last, and taken over from the one panel a tab kept before layouts were a session's.
import assert from "node:assert/strict";
import { test } from "node:test";

type Ext = { module: string; id: string };
type Layout = { panel: string | null; ext?: Ext; filesTab: string };
type Pair = [number, Layout];
type State = {
    browserOpen: boolean;
    filesOpen: boolean;
    filesTab: string;
    extPanel: Ext | null;
    peopleOpen: boolean;
};

const layouts = (await import(new URL("../web/panel-layout.js", import.meta.url).href)) as {
    LAYOUT_MAX: number;
    NO_LAYOUT: Layout;
    readLayout: (kept: unknown) => Layout | null;
    layoutOf: (state: State) => Layout;
    layoutPatch: (layout: Layout | null) => State;
    sameLayout: (a: Layout, b: Layout) => boolean;
    remember: (
        pairs: Pair[],
        id: number,
        layout: Layout,
        options?: { keepNone?: boolean; max?: number },
    ) => Pair[];
    keptLayout: (pairs: Pair[], id: number) => Layout | null;
    layoutPairs: (kept: unknown) => Pair[];
    legacyLayout: (get: (key: string) => string | null) => Layout | null;
};

const design: Layout = { panel: "ext", ext: { module: "design", id: "design" }, filesTab: "files" };
const files: Layout = { panel: "files", filesTab: "changes" };

test("a state's layout shows again as the same state", () => {
    for (const layout of [
        design,
        files,
        { panel: "browser", filesTab: "files" },
        { panel: "people", filesTab: "files" },
        layouts.NO_LAYOUT,
    ]) {
        assert.deepEqual(layouts.layoutOf(layouts.layoutPatch(layout)), layout);
    }

    assert.deepEqual(layouts.layoutPatch(null), layouts.layoutPatch(layouts.NO_LAYOUT));
});

test("of panels asked for together, the layout is the one the app draws", () => {
    const state = {
        browserOpen: false,
        filesOpen: true,
        filesTab: "files",
        extPanel: { module: "design", id: "design" },
        peopleOpen: true,
    };

    assert.equal(layouts.layoutOf(state).panel, "files");
    assert.equal(layouts.layoutOf({ ...state, filesOpen: false }).panel, "ext");
    assert.equal(layouts.layoutOf({ ...state, browserOpen: true }).panel, "browser");
});

test("each session keeps its own layout, the one shown last newest", () => {
    let pairs: Pair[] = [];

    pairs = layouts.remember(pairs, 1, design);
    pairs = layouts.remember(pairs, 2, files);
    assert.deepEqual(layouts.keptLayout(pairs, 1), design);
    assert.deepEqual(layouts.keptLayout(pairs, 2), files);
    assert.equal(layouts.keptLayout(pairs, 3), null);

    pairs = layouts.remember(pairs, 1, files);
    assert.deepEqual(
        pairs.map(([id]) => id),
        [2, 1],
    );
    assert.deepEqual(layouts.keptLayout(pairs, 1), files);
});

test("a tab keeps a panel closed; the device forgets the session instead", () => {
    const pairs = layouts.remember([], 1, design);

    assert.deepEqual(layouts.keptLayout(layouts.remember(pairs, 1, layouts.NO_LAYOUT), 1), {
        panel: null,
        filesTab: "files",
    });
    assert.equal(
        layouts.keptLayout(layouts.remember(pairs, 1, layouts.NO_LAYOUT, { keepNone: false }), 1),
        null,
    );
});

test("only the sessions shown last are kept", () => {
    let pairs: Pair[] = [];

    for (let id = 1; id <= 5; id++) {
        pairs = layouts.remember(pairs, id, design, { max: 3 });
    }

    assert.deepEqual(
        pairs.map(([id]) => id),
        [3, 4, 5],
    );
});

test("what another version kept, or broken, counts as nothing", () => {
    assert.deepEqual(layouts.layoutPairs("nope"), []);
    assert.deepEqual(layouts.layoutPairs([[1, design], ["2", design], 3]), [[1, design]]);
    assert.equal(layouts.readLayout({ panel: "sideways" }), null);
    assert.equal(layouts.readLayout({ panel: "ext", ext: { module: "design" } }), null);
    assert.equal(layouts.readLayout(null), null);
    assert.deepEqual(layouts.readLayout({ panel: "files", filesTab: "odd" }), {
        panel: "files",
        filesTab: "files",
    });
});

test("the one panel a tab kept before is read once, as it was", () => {
    const from = (kept: Record<string, string>) => layouts.legacyLayout((key) => kept[key] ?? null);

    assert.deepEqual(from({ "pocket.extPanel": JSON.stringify(design.ext) }), design);
    assert.deepEqual(from({ "pocket.files": "1", "pocket.filesTab": "changes" }), files);
    assert.deepEqual(from({ "pocket.browser": "1", "pocket.extPanel": "{" }), {
        panel: "browser",
        filesTab: "files",
    });
    assert.deepEqual(from({ "pocket.people": "1" }), { panel: "people", filesTab: "files" });
    assert.equal(from({}), null);
});
