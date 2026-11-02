// Which sessions the tab strip shows (web/session-tabs.js, web/tab-order.js): the first nine in workspace order, with the
// open session kept in view, and each tab's state.
import assert from "node:assert/strict";
import { test } from "node:test";

type Session = { id: string; busy?: boolean; waiting?: boolean; background?: number };

const { TAB_MAX, tabSessions, tabState } = (await import(
    new URL("../web/tab-order.js", import.meta.url).href
)) as {
    TAB_MAX: number;
    tabSessions: (
        order: Session[],
        openId: string | null,
        max?: number,
        all?: Session[],
    ) => Session[];
    tabState: (session: Session, open: boolean, unread: boolean) => string;
};

const many = (count: number): Session[] =>
    Array.from({ length: count }, (_, index) => ({ id: `s${index}` }));

test("the strip shows the first nine sessions, in order", () => {
    const order = many(12);

    assert.equal(TAB_MAX, 9);
    assert.deepEqual(
        tabSessions(order, "s2").map((session) => session.id),
        order.slice(0, 9).map((session) => session.id),
    );
    assert.equal(tabSessions(many(3), null).length, 3);
});

test("a session further down takes the last place, so the strip shows where you are", () => {
    const order = many(12);
    const shown = tabSessions(order, "s11").map((session) => session.id);

    assert.equal(shown.length, 9);
    assert.deepEqual(shown.slice(0, 8), ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    assert.equal(shown[8], "s11");
    // A session that is not in the list (archived, gone) changes nothing.
    assert.equal(tabSessions(order, "gone").length, 9);
    assert.equal(order.length, 12);
});

test("an archived session you are in is not in the order, and still gets a tab", () => {
    const order = many(12);
    const archived: Session = { id: "old" };
    const shown = tabSessions(order, "old", 9, [...order, archived]).map((session) => session.id);

    assert.equal(shown.length, 9);
    assert.equal(shown[8], "old");
});

test("a tab's state: waiting beats working, and the open one is never unread", () => {
    assert.equal(tabState({ id: "a", waiting: true, busy: true }, false, true), "waiting");
    assert.equal(tabState({ id: "a", busy: true }, false, false), "working");
    assert.equal(tabState({ id: "a", background: 2 }, false, false), "working");
    assert.equal(tabState({ id: "a" }, false, true), "unread");
    assert.equal(tabState({ id: "a" }, true, true), "idle");
    assert.equal(tabState({ id: "a" }, false, false), "idle");
});
