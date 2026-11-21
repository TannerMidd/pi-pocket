import assert from "node:assert/strict";
import { closeSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openNoFollow, openNoFollowSync } from "../src/server/no-follow.ts";

test("a file opens, and a link to one is refused", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-no-follow-"));
    const file = join(dir, "file.txt");
    const link = join(dir, "link.txt");

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(file, "inside");
    symlinkSync(file, link);

    const fd = openNoFollowSync(file);

    assert.equal(readFileSync(fd, "utf8"), "inside");
    closeSync(fd);
    await (await openNoFollow(file)).close();
    assert.throws(() => openNoFollowSync(link), { code: "ELOOP" });
    await assert.rejects(openNoFollow(link), { code: "ELOOP" });
});
