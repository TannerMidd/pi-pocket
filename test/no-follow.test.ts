import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openNoFollow, openNoFollowSync, own } from "../src/server/hostfs.ts";

test("a file opens, and a link to one is refused", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-no-follow-"));
    const file = join(dir, "file.txt");
    const link = join(dir, "link.txt");

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(file, "inside");
    symlinkSync(file, link);

    const opened = openNoFollowSync(own(file));

    assert.equal(opened.readAll().toString("utf8"), "inside");
    opened.close();
    await (await openNoFollow(own(file))).close();
    assert.throws(() => openNoFollowSync(own(link)), { code: "ELOOP" });
    await assert.rejects(openNoFollow(own(link)), { code: "ELOOP" });
    assert.equal(readFileSync(file, "utf8"), "inside");
});
