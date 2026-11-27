import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishFetchedFile } from "../src/server/extensions/pocket-relay/files.ts";
import { Hostfs } from "../src/server/hostfs.ts";

test("the fetched file is published in the same turn as the last check, so a change after it cannot be raced", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-relay-publish-"));
    const path = join(dir, "a.png");

    t.after(() => rmSync(dir, { recursive: true, force: true }));

    let checks = 0;
    let seenAfterLastCheck: boolean | undefined;

    await publishFetchedFile(new Hostfs(), path, Buffer.from("data"), () => {
        // The third check is the last one. A route that changes right after it (a microtask later) must find the file
        // already published: nothing was awaited between the check and the rename.
        if (++checks === 3) {
            queueMicrotask(() => {
                seenAfterLastCheck = existsSync(path);
            });
        }
    });
    assert.equal(checks, 3);
    assert.equal(seenAfterLastCheck, true);
    assert.equal(readFileSync(path, "utf8"), "data");
});

test("a route that changes before the last check publishes nothing and leaves no staged file", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-relay-publish-"));
    const path = join(dir, "a.png");

    t.after(() => rmSync(dir, { recursive: true, force: true }));

    let checks = 0;

    await assert.rejects(
        publishFetchedFile(new Hostfs(), path, Buffer.from("data"), () => {
            if (++checks === 3) {
                throw new Error("revoked");
            }
        }),
        /revoked/,
    );
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(dir), []);
});
