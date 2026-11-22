// The pure parts of the surface card (web/surfaces-model.js): table cell paths, who may use a control, optimistic
// values, images and links, and the footer.
import assert from "node:assert/strict";
import { test } from "node:test";

type Surface = Record<string, unknown>;
type Model = {
    cellPath: (rows: string, index: number, field: string) => string;
    controlState: (surface: Surface, id: string) => { enabled: boolean; why: string };
    withPending: (data: unknown, pending: Record<string, { value: unknown }>) => unknown;
    prunePending: (
        pending: Record<string, { value: unknown; until?: number }>,
        rev: number,
    ) => Record<string, unknown>;
    imageKind: (url: unknown) => { kind: string; src?: string; href?: string; host?: string };
    httpsUrl: (url: unknown) => URL | undefined;
    footerOf: (surface: Surface) => string | undefined;
    actBody: (surface: Surface, what: { set?: unknown; event?: string }) => unknown;
    toggled: (current: unknown, options: unknown, value: string, on: boolean) => string[];
    bodyOfText: (text: string, title: string) => string;
};

const model = (await import(new URL("../web/surfaces-model.js", import.meta.url).href)) as Model;

const surface = (extra: Surface = {}): Surface => ({
    id: "s1",
    status: "open",
    who: "owner",
    by: "Maria",
    pv: 3,
    rev: 5,
    waiting: true,
    components: { go: { type: "Button" }, tick: { type: "CheckBox", who: "requester" } },
    can: { go: true, tick: false },
    ...extra,
});

test("a table cell's path is the rows' path, the index, and the field", () => {
    assert.equal(model.cellPath("/rows", 0, "picked"), "/rows/0/picked");
    assert.equal(model.cellPath("/a/b/", 12, "name"), "/a/b/12/name");
});

test("a control is live only on an open surface and when the server says the person may", () => {
    assert.equal(model.controlState(surface(), "go").enabled, true);
    assert.deepEqual(model.controlState(surface(), "tick"), {
        enabled: false,
        why: "Only Maria and the owner can use this",
    });
    assert.equal(model.controlState(surface(), "none").enabled, false);
    assert.equal(
        model.controlState(surface({ status: "done", can: {} }), "go").why,
        "This card has ended",
    );
});

test("what a person set shows over the data, along its path only, until the revision catches up", () => {
    const data = { rows: [{ picked: false }, { picked: false }], other: { x: 1 } };
    const shown = model.withPending(data, { "/rows/1/picked": { value: true } }) as typeof data;

    assert.equal(shown.rows[1]!.picked, true);
    assert.equal(data.rows[1]!.picked, false, "the stored data is never changed");
    assert.equal(shown.other, data.other, "the rest is shared");
    assert.equal(model.withPending(data, { "/nope/1": { value: 1 } }), data);

    const pending = {
        "/a": { value: 1 },
        "/b": { value: 2, until: 7 },
        "/c": { value: 3, until: 5 },
    };

    assert.deepEqual(Object.keys(model.prunePending(pending, 5)), ["/a", "/b"]);
});

test("an https image is a link chip, a small data image loads, anything else is nothing", () => {
    assert.deepEqual(model.imageKind("https://example.com/a.png"), {
        kind: "link",
        href: "https://example.com/a.png",
        host: "example.com",
    });
    assert.equal(model.imageKind("data:image/png;base64,iVBORw0KGgo=").kind, "img");
    assert.equal(model.imageKind("data:image/svg+xml;base64,PHN2Zz4=").kind, "none");
    assert.equal(model.imageKind("http://example.com/a.png").kind, "none");
    assert.equal(model.imageKind("javascript:alert(1)").kind, "none");
    assert.equal(model.httpsUrl("https://user:pw@example.com/"), undefined);
});

test("the footer, the action body, and a multiple choice", () => {
    assert.equal(model.footerOf(surface()), "Pi is waiting for you");
    assert.equal(model.footerOf(surface({ waiting: false })), undefined);
    assert.equal(
        model.footerOf(surface({ status: "done", final: { text: "Maria pressed delete" } })),
        "Done: Maria pressed delete",
    );
    assert.equal(model.footerOf(surface({ status: "expired" })), "Expired");
    assert.deepEqual(model.actBody(surface(), { event: "go" }), { pv: 3, event: "go" });
    assert.deepEqual(model.actBody(surface(), { set: { "/x": 1 } }), { pv: 3, set: { "/x": 1 } });
    assert.deepEqual(model.toggled(["b"], ["a", { label: "B", value: "b" }, "c"], "a", true), [
        "a",
        "b",
    ]);
    assert.equal(model.bodyOfText("Title\nline", "Title"), "line");
});
