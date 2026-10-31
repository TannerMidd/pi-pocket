/**
 * GitLab, as far as it can be checked without the service: reading what `glab` prints, and knowing
 * before a watch is set up that the environment cannot reach GitLab at all.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { gitlabReady, parsePages } from "../src/server/gitlab.ts";

test("each page glab prints is read, and its items joined", () => {
    // `glab api --paginate` prints one array for each page, back to back, with nothing between them:
    // the whole thing is not one array, and reading it as one throws.
    const printed = JSON.stringify([{ id: 1 }, { id: 2 }]) + JSON.stringify([{ id: 3 }]);

    assert.deepEqual(
        parsePages<{ id: number }>(printed).map((each) => each.id),
        [1, 2, 3],
    );
});

test("one page, no page, and a lone object are read too", () => {
    assert.equal(parsePages(JSON.stringify([{ id: 1 }])).length, 1);
    assert.equal(parsePages("[]").length, 0);
    assert.deepEqual(parsePages<{ a: number }>('{"a":1}'), [{ a: 1 }]);
});

test("a bracket or a quote inside a string does not end the page", () => {
    const item = { body: 'a ",]} brace and quote' };
    const printed = JSON.stringify([item]) + JSON.stringify([{ body: "second" }]);
    const items = parsePages<{ body: string }>(printed);

    assert.equal(items.length, 2);
    assert.equal(items[0]?.body, item.body);
    assert.equal(items[1]?.body, "second");
});

test("a GitHub token in GITLAB_TOKEN is named, not left to a bare 401", () => {
    const saved = process.env.GITLAB_TOKEN;

    try {
        process.env.GITLAB_TOKEN = "github_pat_11AIQ7J2A0OuQmJLmoqJF8_x";

        const ready = gitlabReady();

        assert.equal(ready.ready, false);
        assert.match(ready.why ?? "", /holds a GitHub token/);

        process.env.GITLAB_TOKEN = "";
        assert.match(gitlabReady().why ?? "", /GITLAB_TOKEN is not set/);

        process.env.GITLAB_TOKEN = "glpat-LpERxxxxxxxxxxxx";
        assert.equal(gitlabReady().ready, true);
    } finally {
        if (saved === undefined) {
            delete process.env.GITLAB_TOKEN;
        } else {
            process.env.GITLAB_TOKEN = saved;
        }
    }
});
