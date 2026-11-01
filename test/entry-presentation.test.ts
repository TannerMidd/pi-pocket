// A module's presentation exists only while that module is on. A failed load leaves the registry empty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePresentations, queuePresentation } from "../src/server/entry-presentation.ts";
import { ExtensionWebs } from "../src/server/extension-web.ts";

test("presentEntry is on only while the module is", () => {
    let changes = 0;
    const webs = new ExtensionWebs({
        presentationsChanged: () => {
            changes++;
        },
    });
    const staged = webs.stage("quiet-input.ts", "/tmp", "Quiet input");

    assert.throws(
        () => staged.web.presentEntry({ kind: "pi.user", label: "Nope" }),
        /x\.quiet-input\./,
    );
    staged.web.presentEntry({
        kind: "x.quiet-input.note",
        label: "Note",
        userPrefix: "NOTE ",
    });
    assert.throws(
        () => staged.web.presentEntry({ kind: "x.quiet-input.note", label: "Again" }),
        /registered twice/,
    );
    assert.equal(webs.presentations().byKind.size, 0);
    webs.commit(staged.part);
    assert.equal(changes, 1);
    assert.equal(webs.presentations().byKind.get("x.quiet-input.note")?.label, "Note");
    assert.equal(webs.presentations().prefixes[0]?.userPrefix, "NOTE ");
    webs.remove("quiet-input.ts");
    assert.equal(changes, 2);
    assert.equal(webs.presentations().byKind.size, 0);
});

test("a failed load keeps the registry empty", () => {
    let changes = 0;
    const webs = new ExtensionWebs({
        presentationsChanged: () => {
            changes++;
        },
    });
    const staged = webs.stage("quiet-input.ts", "/tmp", "Quiet input");

    staged.web.presentEntry({ kind: "x.quiet-input.note", label: "Note" });
    webs.discard(staged.part);
    assert.equal(changes, 0);
    assert.equal(webs.presentations().byKind.size, 0);
});

test("another module cannot take the same prefix", () => {
    const webs = new ExtensionWebs();
    const first = webs.stage("quiet-input.ts", "/tmp", "Quiet input");

    first.web.presentEntry({
        kind: "x.quiet-input.note",
        label: "Note",
        userPrefix: "NOTE ",
    });
    webs.commit(first.part);

    const second = webs.stage("other-input.ts", "/tmp", "Other input");

    assert.throws(
        () =>
            second.web.presentEntry({
                kind: "x.other-input.note",
                label: "Other",
                userPrefix: "NOTE ",
            }),
        /already matches messages that userPrefix would/,
    );

    // One that starts the other would take some of its messages: refused either way round.
    for (const userPrefix of ["NOTE", "NOTE  extra"]) {
        assert.throws(
            () =>
                second.web.presentEntry({ kind: "x.other-input.note", label: "Other", userPrefix }),
            /already matches messages that userPrefix would/,
        );
    }

    second.web.presentEntry({ kind: "x.other-input.note", label: "Other", userPrefix: "MEMO " });
});

test("a prefix is long enough, not the app's own, and does not overlap the module's others", () => {
    const webs = new ExtensionWebs();
    const staged = webs.stage("quiet-input.ts", "/tmp", "Quiet input");
    const present = (userPrefix: string, name = "note") =>
        staged.web.presentEntry({ kind: `x.quiet-input.${name}`, label: "Note", userPrefix });

    for (const short of ["", "N", "NO ", "  N  O "]) {
        assert.throws(() => present(short), /3 of them not spaces/, JSON.stringify(short));
    }

    // The app's own inputs nobody typed start with "[": reports, linked sessions, schedules, background tasks.
    for (const core of ["[subagent ", "[from: ", "[scheduled] ", " [background] ", "[x]"]) {
        assert.throws(() => present(core), /cannot start with "\["/, core);
    }

    present("NOTE ");
    assert.throws(() => present("NOTE  more", "memo"), /starts, or starts with/);
    assert.throws(() => present("NOT", "memo"), /starts, or starts with/);
    present("MEMO ", "memo");

    // A label is one line: no control characters, no line or paragraph separators.
    for (const label of ["a\tb", "a\u0007b", "a\u2028b", "a\nb"]) {
        assert.throws(
            () => staged.web.presentEntry({ kind: "x.quiet-input.other", label }),
            /one line/,
        );
    }
});

test("the registry is compiled once for each change of the modules", () => {
    const webs = new ExtensionWebs();
    const empty = webs.presentations();

    assert.equal(webs.presentations(), empty, "the same registry until something changes");

    const staged = webs.stage("quiet-input.ts", "/tmp", "Quiet input");

    staged.web.presentEntry({ kind: "x.quiet-input.note", label: "Note" });
    assert.equal(webs.presentations(), empty, "a module that is still loading counts for nothing");
    webs.commit(staged.part);

    const on = webs.presentations();

    assert.notEqual(on, empty);
    assert.equal(on.byKind.get("x.quiet-input.note")?.label, "Note");
    assert.equal(webs.presentations(), on);

    // A reload with the same presentations is a new registry all the same: compiled again, and equal.
    const again = webs.stage("quiet-input.ts", "/tmp", "Quiet input");

    again.web.presentEntry({ kind: "x.quiet-input.note", label: "Note again" });
    webs.commit(again.part);
    assert.equal(webs.presentations().byKind.get("x.quiet-input.note")?.label, "Note again");

    webs.remove("quiet-input.ts");
    assert.equal(webs.presentations().byKind.size, 0);
});

test("the queue shows a label instead of the body", () => {
    const presentations = compilePresentations([
        {
            presentations: [{ kind: "x.quiet-input.note", label: "Note", userPrefix: "NOTE " }],
        },
    ]);

    assert.deepEqual(
        queuePresentation(
            "x.quiet-input.note",
            "the whole message",
            { summary: "saved" },
            presentations,
            false,
        ),
        { label: "Note", summary: "saved" },
    );
    assert.equal(
        queuePresentation("x.quiet-input.other", "the whole message", {}, presentations, false),
        undefined,
    );
    assert.deepEqual(queuePresentation(undefined, "NOTE hello", undefined, presentations, false), {
        label: "Note",
    });
    assert.equal(
        queuePresentation(undefined, "NOTE hello", undefined, presentations, true),
        undefined,
    );
});
